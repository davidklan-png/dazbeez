import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson, nowIso, newUuid } from "@/lib/receipts/db-utils";
import {
  getLatestFinalizedExport,
  listDeliveriesForMonth,
  createDelivery,
  DeliveryAdmissionConflictError,
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
  isWithinResumeWindow,
  logicalAttempts,
  idempotencyKeyForAttempt,
} from "@/lib/receipts/delivery-state";
import { performDelivery, assertDeliverySize } from "@/lib/receipts/delivery-send";
import { composeDelivery, deliveryPayload } from "@/lib/receipts/delivery-compose";

type RouteContext = { params: Promise<{ month: string }> };

/** Clerk-only Send: pin the sealed revision/bytes, prepare and validate, then
 * CAS ownership + history + audits before any provider call. Unknown admission
 * acknowledgements never authorize transport. Retries use a frozen envelope/key
 * inside 23 hours of the FIRST durable admission; overrides require fresh review. */
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
    let observedGeneration: unknown;
    let observedAttemptId: unknown;
    try {
      const body = (await request.json()) as { compositionHash?: unknown; observedGeneration?: unknown; observedAttemptId?: unknown };
      observedGeneration = body?.observedGeneration;
      observedAttemptId = body?.observedAttemptId;
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
    const history = await listDeliveriesForMonth(month);
    const deliveries = history.map((d) => ({
      id: d.id,
      exportId: d.export_id,
      attemptId: d.attempt_id,
      state: d.state,
      createdAt: d.created_at,
      admissionGeneration: d.admission_generation,
    }));
    if (forceNew && (!Number.isInteger(observedGeneration) ||
      observedGeneration !== (exportRecord.delivery_generation ?? 0) ||
      observedAttemptId !== (exportRecord.current_delivery_attempt_id ?? null) || !postedCompositionHash)) {
      return NextResponse.json({ error: "Override confirmation is missing or stale. Refresh the preview and confirm again." }, { status: 409 });
    }
    const now = nowIso();
    const action = decideSendAction({
      latestExportId: exportRecord.id,
      deliveries,
      now,
      forceNew,
      currentAttemptId: exportRecord.current_delivery_attempt_id,
    });
    if (action.action === "blocked") {
      return NextResponse.json(
        {
          error:
            action.reason === "sent"
              ? "This revision has already been delivered. Refresh and deliberately confirm a resend (audited)."
              : "The earlier outcome is unknown and cannot be safely resumed (23-hour cutoff or invalid admission time). Refresh and review before explicitly resending.",
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
    const composed = await composeDelivery(month, { zipBytes, exportRecord });

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

    const payload = deliveryPayload({
      exportId: exportRecord.id, bundleBuildId: exportRecord.bundle_build_id ?? null,
      proofsKey, zipFilename: composed.zipFilename, zipSha256: composed.zipSha256,
      zipBytes: zipBytes.byteLength, from: composed.from, to: composed.to,
      cc: composed.cc, replyTo: composed.replyTo, subject: composed.subject,
      text: composed.text, html: composed.html,
    });
    let payloadJson = JSON.stringify(payload);
    const attemptId = action.action === "resume" ? action.attemptId : newUuid();
    let idempotencyKey = idempotencyKeyForAttempt(attemptId);
    let origin = nowIso();
    if (action.action === "resume") {
      const rows = history.filter((d) => d.attempt_id === attemptId);
      const first = rows.find((d) => d.id === action.deliveryId)!;
      origin = first.created_at;
      // Compare the ENTIRE envelope, not just client review. Legacy/malformed
      // snapshots fail closed; never reconstruct an uncertain old payload.
      if (!first.payload_json || first.payload_json !== payloadJson ||
        rows.some((d) => d.payload_json !== first.payload_json || d.idempotency_key !== first.idempotency_key)) {
        return NextResponse.json({ error: "The earlier delivery has a missing or different frozen envelope. Its outcome may be unknown. Refresh, review the current recipient/pack, and explicitly confirm a new send if intended." }, { status: 409 });
      }
      payloadJson = first.payload_json;
      idempotencyKey = first.idempotency_key;
    }
    const frozen = JSON.parse(payloadJson) as typeof payload;
    const deliveryId = await createDelivery({
      exportId: exportRecord.id, month,
      expectedGeneration: exportRecord.delivery_generation ?? 0,
      expectedAttemptId: exportRecord.current_delivery_attempt_id ?? null,
      bundleBuildId: exportRecord.bundle_build_id ?? null, proofsKey, payloadJson, actor,
      admissionAction: action.action === "redelivery" ? "redelivery" : forceNew ? "override" : action.action,
      priorAttemptId: action.action === "redelivery" ? action.priorAttemptId : exportRecord.current_delivery_attempt_id ?? undefined,
      attemptId, idempotencyKey,
      toAddress: frozen.to!, ccAddress: frozen.cc, subject: frozen.subject, body: frozen.text,
      operatorMessage: exportRecord.operator_message ?? null,
      zipFilename: frozen.zipFilename, zipSha256: frozen.zipSha256, zipBytes: frozen.zipBytes,
    });
    // Async R2/composition/admission may cross the cutoff. No sliding window.
    if (!isWithinResumeWindow(origin, nowIso())) {
      return NextResponse.json({ error: "Safe resume cutoff reached during preparation. Outcome remains unknown; refresh and review before explicitly resending." }, { status: 409 });
    }

    // ── Send. performDelivery re-checks size on the in-memory bytes (CALL SITE
    //    2 — defence-in-depth, B-1) then base64-encodes and calls Resend with
    //    the Idempotency-Key. Never throws across the boundary.
    const result = await performDelivery({
      apiKey,
      from: frozen.from!,
      to: frozen.to!,
      cc: frozen.cc,
      replyTo: frozen.replyTo,
      subject: frozen.subject,
      text: frozen.text,
      html: frozen.html,
      zipFilename: frozen.zipFilename,
      zipBytes,
      idempotencyKey,
    });

    const db = getReceiptsDb();
    if (result.ok) {
      await markDeliverySent(deliveryId, result.messageId ?? "", db, actor);
    } else if (result.classification === "definitive") {
      await markDeliveryFailed(deliveryId, result.error, db, actor, result);
    } else {
      await markDeliveryAmbiguous(deliveryId, result.error, db, actor, result);
    }
    const current = await getLatestFinalizedExport(month);
    if (current?.id !== exportRecord.id || current.current_delivery_attempt_id !== attemptId) {
      return NextResponse.json({ state: "superseded", deliveryId,
        error: "This result was recorded in history. A newer revision or send owns the current state; refresh before taking further action." });
    }
    const settled = current.delivery_state === "delivered";
    if (settled) return NextResponse.json({ state: "delivered", deliveryId,
      messageId: result.ok ? result.messageId ?? null : null });
    if (result.ok) return NextResponse.json({ state: "pending", deliveryId,
      error: "Delivery result recorded. Refresh to confirm current delivery state." });
    const classification = result.classification;
    return NextResponse.json({ state: settled ? "delivered" : "sealed_undelivered", deliveryId,
      error: result.error, classification,
      resumable: !settled && logicalAttempts([...deliveries, {
        id: deliveryId, exportId: exportRecord.id, attemptId, state: classification === "definitive" ? "failed" as const : "ambiguous" as const,
        createdAt: origin,
      }]).some((d) => d.attemptId === attemptId && (d.state === "pending" || d.state === "ambiguous")) });
  } catch (error) {
    if (error instanceof DeliveryAdmissionConflictError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/export/[month]/send] POST failed", error);
    return NextResponse.json(
      { error: "Delivery was not confirmed. Its outcome may be unknown. Refresh before retrying; do not assume it was unsent." },
      { status: 500 },
    );
  }
}
