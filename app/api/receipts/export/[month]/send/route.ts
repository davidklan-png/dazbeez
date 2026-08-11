import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson, nowIso, newUuid } from "@/lib/receipts/db-utils";
import {
  getLatestFinalizedExport,
  listDeliveriesForMonth,
  createDelivery,
  markDeliverySent,
  markDeliveryFailed,
  markDeliveryAmbiguous,
} from "@/lib/receipts/db";
import {
  getReceiptsArchiveBucket,
  getReceiptsDb,
  getResendApiKeyOrNull,
} from "@/lib/cloudflare-runtime";
import {
  decideSendAction,
  findRevisionSendBlocker,
  idempotencyKeyForAttempt,
} from "@/lib/receipts/delivery-state";
import { performDelivery, assertDeliverySize } from "@/lib/receipts/delivery-send";
import { composeDelivery } from "@/lib/receipts/delivery-compose";

type RouteContext = { params: Promise<{ month: string }> };

/**
 * POST /api/receipts/export/{month}/send[?force_new=true]
 *
 * Delivers the latest SEALED export for the month to the accountant (Cc: business
 * manager — Change 5) as an attached ZIP. Fires strictly AFTER the seal commit
 * (D1); the seal is immutable and this only moves the month's delivery_state.
 *
 * Composition (recipients, subject/body, preflight, attachment sha/filename) is
 * single-sourced in {@link composeDelivery} — the SAME function the preview
 * endpoint and the composer page use — so preview and send cannot disagree by
 * construction. This handler owns only the send-specific concerns: the
 * `force_new`-aware new/resume/blocked decision, the B-2 R2 HEAD-before-GET
 * fetch, the delivery-row lifecycle, and the Resend call.
 *
 * Boundary order:
 *  - B-2 (isolate memory): R2 HEAD size check BEFORE the body is streamed in.
 *  - B-1 (Resend ceiling): defence-in-depth size check inside performDelivery,
 *    before base64. [Two call sites — both reported in the commit.]
 *  - Change 3: preflight runs on the fetched bytes BEFORE performDelivery (read
 *    from the composed result — no re-run); a preflight failure is audited and
 *    blocks before any delivery row is created.
 *
 * The POST body carries ONLY `{ compositionHash }` (Item 2) — the fingerprint of
 * the composition the operator reviewed. Subject/body/To/Cc are NEVER accepted
 * from the client (they are re-composed server-side from the sealed pack +
 * Settings via composeDelivery — delivery-composer decision 2); the hash is a
 * staleness check, not content. The route recomposes, recomputes its own hash,
 * and on mismatch 409s with the fresh composition so a stale render (Settings
 * edited, or a new revision finalized) can never silently send a different
 * body/recipient/pack. A client that posts an edited body still has no way to
 * change what is sent.
 *
 * `force_new` is the DISTINCT override for the double-send guard (D6). Without
 * it: a resumeable pending is RESUMED (same attempt_id ⇒ same key ⇒ Resend
 * replays — no duplicate); a sent or stale-pending blocks with 409.
 *
 * Auth: Clerk-protected via /api/receipts/:path*; asserted in the middleware-
 * routing test that it is NOT in PUBLIC_ROUTES.
 */
export async function POST(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { month } = await params;
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Invalid month format." }, { status: 400 });
    }
    const forceNew = new URL(request.url).searchParams.get("force_new") === "true";
    // The request body carries ONLY the compositionHash fingerprint (Item 2) —
    // never subject/body/To/Cc (decision 2 stands: those are recomposed
    // server-side from the sealed pack + Settings via composeDelivery below).
    // The hash is a staleness check, not content; an absent/invalid hash (direct
    // POST, pre-hash client) simply skips the check.
    let postedCompositionHash: string | undefined;
    try {
      const body = (await request.json()) as { compositionHash?: unknown };
      if (typeof body?.compositionHash === "string") {
        postedCompositionHash = body.compositionHash;
      }
    } catch {
      // No JSON body — pre-hash caller; the integrity check is skipped.
    }

    // ── Load the sealed export (D1: send is post-seal) ───────────────────────
    const exportRecord = await getLatestFinalizedExport(month);
    if (!exportRecord || !exportRecord.proofs_r2_key) {
      return NextResponse.json(
        { error: "No sealed export for this month. Finalize before sending." },
        { status: 409 },
      );
    }

    // ── Decide new vs resume vs redelivery vs blocked (D6 + the stuck-pending
    //    guard). This is the send-specific, force_new-aware decision;
    //    composeDelivery runs a forceNew:false decision for DISPLAY only. Kept
    //    BEFORE the R2 fetch so a duplicate 409 rejects cheaply.
    const deliveries = (await listDeliveriesForMonth(month)).map((d) => ({
      id: d.id,
      exportId: d.export_id,
      attemptId: d.attempt_id,
      state: d.state,
      createdAt: d.created_at,
    }));
    const now = nowIso();
    const action = decideSendAction({
      latestExportId: exportRecord.id,
      deliveries,
      now,
      forceNew,
    });
    if (action.action === "blocked") {
      return NextResponse.json(
        {
          error:
            action.reason === "sent"
              ? "This month's current revision has already been delivered. Pass force_new=true to re-send (audited)."
              : "This month has a pending delivery that can no longer be safely resumed (past Resend's 24h idempotency window). Pass force_new=true to send anew (audited).",
          reason: action.reason,
          priorAttemptId: action.priorAttemptId,
        },
        { status: 409 },
      );
    }

    // ── B-2: size check via R2 HEAD BEFORE streaming the body into memory ────
    const bucket = getReceiptsArchiveBucket();
    const proofsKey = exportRecord.proofs_r2_key;
    const head = await bucket.head(proofsKey);
    if (!head) {
      return NextResponse.json(
        { error: `Sealed proofs ZIP "${proofsKey}" is missing from storage.` },
        { status: 422 },
      );
    }
    try {
      assertDeliverySize(head.size); // CALL SITE 1 — orchestration; guards the isolate (B-2)
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : "Pack exceeds the delivery ceiling." },
        { status: 422 },
      );
    }

    // ── Stream the sealed ZIP (now known to be under the ceiling) ────────────
    const object = await bucket.get(proofsKey);
    if (!object) {
      return NextResponse.json(
        { error: "Sealed proofs ZIP vanished between HEAD and GET." },
        { status: 422 },
      );
    }
    const zipBytes = new Uint8Array(await new Response(object.body).arrayBuffer());

    // ── Compose (recipients / subject / body / preflight / sha / filename).
    //    Pass the already-fetched bytes IN so compose runs the preflight on the
    //    EXACT bytes that ship and does not fetch a second time. This is the
    //    single composition path — the preview endpoint and composer page call
    //    the same function, so preview/send cannot drift.
    const composed = await composeDelivery(month, { zipBytes });

    // Config problems (missing To, invalid address, no Resend key / From, missing
    // ZIP) make sending impossible. The composer surfaces these BEFORE the
    // operator clicks Send; this is the defensive guard for a race/direct POST.
    const apiKey = getResendApiKeyOrNull();
    if (
      composed.configErrors.length > 0 ||
      !composed.to ||
      !composed.from ||
      !apiKey
    ) {
      return NextResponse.json(
        {
          error: composed.configErrors[0] ?? "Delivery not configured.",
          configErrors: composed.configErrors,
        },
        { status: 422 },
      );
    }

    // ── Item 2: composition-integrity check. If the client posted a
    //    compositionHash, the composition it reviewed must equal the one we just
    //    recomposed. A mismatch means To/Cc/signature changed in Settings, or a
    //    new revision was finalized, after the page rendered — Send would
    //    deliver a different body / recipient / pack than the operator reviewed.
    //    REJECT (409) with the FRESH composition so the UI re-renders and asks
    //    for re-confirmation. Never silently proceed; never warn-and-continue.
    if (postedCompositionHash && postedCompositionHash !== composed.compositionHash) {
      return NextResponse.json(
        {
          error:
            "Composition changed since you reviewed it. Please re-confirm the updated delivery.",
          compositionStale: true,
          composition: composed,
        },
        { status: 409 },
      );
    }

    // ── Change 3: preflight gate on the sealed bytes. Read from the composed
    //    result — compose already ran it on these exact bytes (no re-run). A
    //    failing check rejects the pack at the gate, audited, BEFORE any
    //    delivery row is created (so there is no pending row to get stuck).
    if (!composed.preflight.passed) {
      const failedChecks = composed.preflight.results
        .filter((r) => !r.passed)
        .map((r) => r.name)
        .join(", ");
      await createAuditEntry(getReceiptsDb(), {
        actor,
        action: "export.delivery_blocked",
        objectType: "export",
        objectId: exportRecord.id,
        newValueJson: stringifyJson({ month, blockedBy: "preflight", failedChecks }),
      });
      return NextResponse.json(
        { error: "Pre-send preflight failed.", preflight: composed.preflight },
        { status: 422 },
      );
    }

    // ── attempt_id: resume reuses the pending one; a new/redelivery send mints one.
    const attemptId = action.action === "resume" ? action.attemptId : newUuid();
    // Audit the send's nature. A `redelivery` is the first send of a corrected
    // revision AFTER an earlier revision was already delivered — legitimate, and
    // it records as a re-delivery (the accountant gets a second email), NOT as
    // the force_new override. force_new overriding a genuine duplicate guard for
    // THIS revision still records as an override; the revision-scoped blocker
    // (findRevisionSendBlocker) is what force_new actually overrode, replacing
    // the old month-wide SENT/PENDING capture that mislabelled a redelivery as
    // an override. `redelivery` and `override` are mutually exclusive: a
    // sent-for-this-revision that force_new collapses returns `new` (override),
    // never `redelivery`.
    if (action.action === "redelivery") {
      await createAuditEntry(getReceiptsDb(), {
        actor,
        action: "export.delivery_redelivery",
        objectType: "export",
        objectId: exportRecord.id,
        newValueJson: stringifyJson({
          month,
          priorAttemptId: action.priorAttemptId,
        }),
      });
    } else if (forceNew) {
      const overrode = findRevisionSendBlocker(deliveries, exportRecord.id, now);
      if (overrode) {
        await createAuditEntry(getReceiptsDb(), {
          actor,
          action: "export.delivery_override",
          objectType: "export",
          objectId: exportRecord.id,
          newValueJson: stringifyJson({
            month,
            reason: overrode.reason,
            priorAttemptId: overrode.priorAttemptId,
          }),
        });
      }
    }

    // ── Record the delivery attempt (pending) with the now-known bytes + sha ─
    const operatorMessage = exportRecord.operator_message ?? null; // 0037: same stored value the pack notice carries (O7)
    const deliveryId = await createDelivery({
      exportId: exportRecord.id,
      attemptId,
      idempotencyKey: idempotencyKeyForAttempt(attemptId),
      toAddress: composed.to,
      ccAddress: composed.cc,
      subject: composed.subject,
      body: composed.text,
      operatorMessage,
      zipFilename: composed.zipFilename,
      zipSha256: composed.zipSha256,
      zipBytes: zipBytes.byteLength,
    });

    // ── Send. performDelivery re-checks size on the in-memory bytes (CALL SITE
    //    2 — defence-in-depth, B-1) then base64-encodes and calls Resend with
    //    the Idempotency-Key. Never throws across the boundary.
    const result = await performDelivery({
      apiKey,
      from: composed.from,
      to: composed.to,
      cc: composed.cc,
      replyTo: composed.replyTo,
      subject: composed.subject,
      text: composed.text,
      html: composed.html,
      zipFilename: composed.zipFilename,
      zipBytes,
      idempotencyKey: idempotencyKeyForAttempt(attemptId),
    });

    const db = getReceiptsDb();
    if (result.ok) {
      await markDeliverySent(deliveryId, result.messageId ?? "");
      await createAuditEntry(db, {
        actor,
        action: "export.delivery_sent",
        objectType: "export",
        objectId: exportRecord.id,
        newValueJson: stringifyJson({
          month,
          attemptId,
          to: composed.to,
          messageId: result.messageId ?? null,
        }),
      });
      return NextResponse.json({
        state: "delivered",
        deliveryId,
        messageId: result.messageId ?? null,
      });
    }
    // Resend failure is retryable: the seal stands and the month is
    // sealed_undelivered (not 5xx — D2; a 5xx risks infra auto-retry starting a
    // new attempt with a new idempotency key). Classify so an ambiguous failure
    // (timeout/5xx/network — mail may have been accepted) stays resumable: the
    // operator's retry reuses this attempt_id and Resend deduplicates, rather
    // than minting a new key and sending twice. A definitive 4xx rejection is
    // terminal-failed — a retry is a clean new send.
    const classification = result.classification;
    if (classification === "definitive") {
      await markDeliveryFailed(deliveryId, result.error);
    } else {
      await markDeliveryAmbiguous(deliveryId, result.error);
    }
    await createAuditEntry(db, {
      actor,
      action: "export.delivery_failed",
      objectType: "export",
      objectId: exportRecord.id,
      newValueJson: stringifyJson({
        month,
        attemptId,
        error: result.error,
        classification,
      }),
    });
    return NextResponse.json(
      {
        state: "sealed_undelivered",
        deliveryId,
        error: result.error,
        classification,
        // The composer renders "resume" (reuse the attempt) vs "retry" (new
        // attempt) from this — ambiguous within 24h is resumable.
        resumable: classification === "ambiguous",
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/export/[month]/send] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to send delivery." },
      { status: 500 },
    );
  }
}
