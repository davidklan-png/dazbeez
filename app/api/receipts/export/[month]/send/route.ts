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
  getNotifyFromAddress,
  getAccountantEmail,
} from "@/lib/cloudflare-runtime";
import { getComplianceSettings } from "@/lib/receipts/settings";
import { resolveNotificationRecipient } from "@/lib/receipts/notify";
import { computeSha256Hex } from "@/lib/receipts/storage";
import {
  decideSendAction,
  idempotencyKeyForAttempt,
  ATTEMPT_STATE,
} from "@/lib/receipts/delivery-state";
import {
  performDelivery,
  assertDeliverySize,
  buildDeliveryEmail,
} from "@/lib/receipts/delivery-send";
import { packZipName } from "@/lib/receipts/pack-naming";

type RouteContext = { params: Promise<{ month: string }> };

/**
 * POST /api/receipts/export/{month}/send[?force_new=true]
 *
 * Delivers the latest SEALED export for the month to the accountant (Cc: business
 * manager — Change 5) as an attached ZIP. Fires strictly AFTER the seal commit
 * (D1); the seal is immutable and this only moves the month's delivery_state.
 *
 * Boundary order:
 *  - B-2 (isolate memory): R2 HEAD size check BEFORE the body is streamed in.
 *  - B-1 (Resend ceiling): defence-in-depth size check inside performDelivery,
 *    before base64. [Two call sites — both reported in the commit.]
 *  - Change 3: preflight runs on the fetched bytes AFTER the delivery row exists
 *    and BEFORE performDelivery; a preflight failure marks the row failed (never
 *    leaves it pending, or a blocked send becomes the stuck-pending duplicate).
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

    // ── Load the sealed export (D1: send is post-seal) ───────────────────────
    const exportRecord = await getLatestFinalizedExport(month);
    if (!exportRecord || !exportRecord.proofs_r2_key) {
      return NextResponse.json(
        { error: "No sealed export for this month. Finalize before sending." },
        { status: 409 },
      );
    }

    // ── Decide new vs resume vs blocked (D6 + the stuck-pending guard) ───────
    const deliveries = (await listDeliveriesForMonth(month)).map((d) => ({
      id: d.id,
      exportId: d.export_id,
      attemptId: d.attempt_id,
      state: d.state,
      createdAt: d.created_at,
    }));
    // Capture the prior blocker (if any) for the override audit BEFORE the
    // decision collapses it to "new" on forceNew.
    const priorBlocker = deliveries.find(
      (d) => d.state === ATTEMPT_STATE.SENT || d.state === ATTEMPT_STATE.PENDING,
    );
    const action = decideSendAction({
      latestExportId: exportRecord.id,
      deliveries,
      now: nowIso(),
      forceNew,
    });
    if (action.action === "blocked") {
      return NextResponse.json(
        {
          error:
            action.reason === "sent"
              ? "This month is already delivered. Pass force_new=true to re-send (audited)."
              : "This month has a pending delivery that can no longer be safely resumed (past Resend's 24h idempotency window). Pass force_new=true to send anew (audited).",
          reason: action.reason,
          priorAttemptId: action.priorAttemptId,
        },
        { status: 409 },
      );
    }

    // ── Recipients + transport config (Settings/config — not pack state) ─────
    const settings = await getComplianceSettings();
    const to = resolveNotificationRecipient(
      settings.notification_recipient,
      getAccountantEmail(),
    ).email;
    const cc: string | null = null; // Change 5: the new Cc compliance setting.
    if (!to) {
      return NextResponse.json(
        { error: "No delivery recipient configured (set it in Settings → Compliance)." },
        { status: 422 },
      );
    }
    const apiKey = getResendApiKeyOrNull();
    const from = getNotifyFromAddress();
    if (!apiKey || !from) {
      return NextResponse.json(
        { error: "Delivery not configured (RESEND_API_KEY / NOTIFY_FROM_ADDRESS)." },
        { status: 422 },
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
    const zipSha256 = await computeSha256Hex(zipBytes);
    const zipFilename = packZipName(month); // ASCII container name (B-4, asserted in performDelivery)

    // ── Email body — sealed values only (B-5). SINGLE path (Change 4 replaces). ──
    const operatorMessage = null; // Change 4: from receipt_exports.operator_message
    const email = buildDeliveryEmail({ month, operatorMessage });

    // ── attempt_id: resume reuses the pending one; a new send mints one ──────
    const attemptId = action.action === "resume" ? action.attemptId : newUuid();
    if (forceNew && priorBlocker) {
      await createAuditEntry(getReceiptsDb(), {
        actor,
        action: "export.delivery_override",
        objectType: "export",
        objectId: exportRecord.id,
        newValueJson: stringifyJson({ month, priorAttemptId: priorBlocker.attemptId }),
      });
    }

    // ── Record the delivery attempt (pending) with the now-known bytes + sha ─
    const deliveryId = await createDelivery({
      exportId: exportRecord.id,
      attemptId,
      idempotencyKey: idempotencyKeyForAttempt(attemptId),
      toAddress: to,
      ccAddress: cc,
      subject: email.subject,
      body: email.text,
      operatorMessage,
      zipFilename,
      zipSha256,
      zipBytes: zipBytes.byteLength,
    });

    // ── [Change 3 insertion point] preflight runs HERE — after the delivery row
    //    exists (so a failure marks it failed, never pending) and before the
    //    send. Sketch:
    //      const report = await runPreflightOnSealedZip(zipBytes, { month, ... });
    //      if (!report.passed) {
    //        await markDeliveryFailed(deliveryId, `preflight: ${report.results.filter(r=>!r.passed).map(r=>r.check).join(", ")}`);
    //        return NextResponse.json({ error: "Pre-send preflight failed.", report }, { status: 422 });
    //      }

    // ── Send. performDelivery re-checks size on the in-memory bytes (CALL SITE
    //    2 — defence-in-depth, B-1) then base64-encodes and calls Resend with
    //    the Idempotency-Key. Never throws across the boundary.
    const result = await performDelivery({
      apiKey,
      from,
      to,
      cc,
      subject: email.subject,
      text: email.text,
      html: email.html,
      zipFilename,
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
          to,
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
        // Phase C renders "resume" (reuse the attempt) vs "retry" (new attempt)
        // from this — ambiguous within 24h is resumable.
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
