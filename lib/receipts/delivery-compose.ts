// Delivery composer — the single composition authority for a month's pack
// delivery (delivery-composer §1).
//
// The send route (POST /api/receipts/export/{month}/send), the preview endpoint
// (GET .../delivery-preview), and the composer page (/receipts/export/{month}/
// send) ALL build the delivery through this function. A preview that re-derives
// recipients / subject / body / preflight separately WILL drift from the send —
// the exact §7 failure mode this codebase was burned by twice (the notice named
// files that weren't in the ZIP). Funneling every surface through composeDelivery
// makes preview/send disagreement impossible by construction: there is one
// recipient-resolution path, one address validation, one buildDeliveryEmail call,
// one preflight run. Do not duplicate any of them.
//
// The send path passes its already-fetched sealed bytes IN (opts.zipBytes) so
// composeDelivery runs the preflight + sha on the EXACT bytes that will be
// delivered and the send path does not fetch twice. The preview/page path omits
// zipBytes and composeDelivery performs the B-2 R2 HEAD size check ahead of the
// GET itself.

import {
  getLatestFinalizedExport,
  listDeliveriesForMonth,
} from "@/lib/receipts/db";
import {
  getReceiptsArchiveBucket,
  getResendApiKeyOrNull,
  getDeliveryFromAddress,
  getAccountantEmail,
} from "@/lib/cloudflare-runtime";
import { getComplianceSettings } from "@/lib/receipts/settings";
import {
  resolveNotificationRecipient,
  isValidDeliveryAddress,
} from "@/lib/receipts/notify";
import { computeSha256Hex } from "@/lib/receipts/storage";
import { nowIso } from "@/lib/receipts/db-utils";
import {
  decideSendAction,
  type AttemptState,
  type DeliveryState,
} from "@/lib/receipts/delivery-state";
import {
  buildDeliveryEmail,
  MAX_DELIVERY_ZIP_BYTES,
  assertDeliverySize,
} from "@/lib/receipts/delivery-send";
import { runPreflightOnSealedZip } from "@/lib/receipts/delivery-preflight";
import { packZipName } from "@/lib/receipts/pack-naming";

/** Thrown when a month has no sealed (finalized + proofs) export to deliver.
 *  Callers translate: the preview endpoint → 404, the composer page →
 *  notFound(), the send route already 409s before calling compose. */
export class NoSealedExportError extends Error {
  constructor(public month: string) {
    super(`No sealed export for ${month}. Finalize before sending.`);
    this.name = "NoSealedExportError";
  }
}

export interface ComposedPreflightResult {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ComposedDelivery {
  month: string;
  exportId: string;
  /** Plain SHA-256 fingerprint of this composition ({exportId, zipSha256, to,
   *  cc, subject, text}; Item 2). The composer posts it back on Send; the send
   *  route recomposes, recomputes, and returns 409 on mismatch so a stale render
   *  (Settings edited, or a new revision finalized after the page loaded) can
   *  never silently send a different body / recipient / pack than the operator
   *  reviewed. NOT the ZIP bytes (zipSha256 already pins the pack); NOT content
   *  the client controls — it is a fingerprint the server recomputes. */
  compositionHash: string;
  /** When the latest finalized revision was sealed (receipt_exports.finalized_at).
   *  The composer header renders "sealed on {date}, NOT yet delivered" — sealing
   *  is the midpoint, not completion (decision 5). Added beyond the spec'd
   *  interface to avoid a second getLatestFinalizedExport fetch in the page. */
  sealedAt: string | null;
  to: string | null;
  cc: string | null;
  /** Resolved From address (the delivery sender — DELIVERY_FROM_ADDRESS, falling
   *  back to NOTIFY_FROM_ADDRESS). null when both are unset (also a configError).
   *  Distinct from the intake address so an accountant's Reply is not parsed as
   *  a receipt submission (delivery-composer §B). */
  from: string | null;
  /** Resolved Reply-To (Settings → Compliance → delivery_reply_to). null/empty →
   *  omitted from the Resend payload. Where an accountant's reply lands. */
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  /** The email-only signature actually applied (delivery-composer decision 3).
   *  null when unset/empty — what buildDeliveryEmail received. */
  signature: string | null;
  zipFilename: string;
  zipSha256: string;
  /** Pack size in bytes (display). The raw bytes are NOT on this object — the
   *  send path keeps its own reference and passes them in via opts.zipBytes. */
  zipBytes: number;
  /** Preflight results on the sealed bytes — the SAME run the send performs. */
  preflight: {
    passed: boolean;
    results: ComposedPreflightResult[];
  };
  /** Config problems that make sending impossible (missing To, invalid address,
   *  no Resend key / From, missing/oversized sealed ZIP). Empty = sendable. */
  configErrors: string[];
  /** What the Send button should offer, from decideSendAction(forceNew:false).
   *  The send route re-decides with the real forceNew from the query; this is
   *  the display verdict (the natural-state action the operator first sees).
   *  `redelivery` = a different, earlier revision's mail MAY have reached the
   *  accountant (sent / pending / ambiguous) and this is the first send of the
   *  current revision — a primary action (no force_new), but the composer
   *  surfaces the possible-second-email consequence explicitly. */
  action: "new" | "resume" | "redelivery" | "blocked";
  /** Present only when action === "blocked". The real enum from
   *  decideSendAction is "sent" | "stale" (the spec wrote "stale_pending";
   *  the code's authority is "stale" — same case, the 24h-window-expired
   *  pending). */
  blockedReason?: "sent" | "stale";
  /** For `resume` the resumeable attempt id; for `redelivery` the earlier
   *  revision's attempt id; for `blocked` the blocking attempt id. */
  priorAttemptId?: string;
  /** Present only when action === "redelivery": the earlier attempt's state.
   *  `sent` ⇒ that pack was delivered; `pending`/`ambiguous` ⇒ it may have been.
   *  The composer copy branches on this so it never claims the earlier pack WAS
   *  delivered when the evidence is uncertain. */
  priorAttemptState?: AttemptState;
}

/**
 * Plain SHA-256 fingerprint of a delivery composition — the identity of exactly
 * what the operator reviewed on the composer page. Over {exportId, zipSha256,
 * to, cc, subject, text} (the signature is part of the body, so it is included
 * via `text`). NOT the ZIP bytes (the pack's sha already pins it).
 *
 * This is a CONCURRENCY / staleness check, NOT an auth boundary: plain SHA-256,
 * no HMAC, no signing. The threat is a second tab or a new revision finalized
 * after the page rendered — not a hostile client (the send route recomposes
 * server-side and trusts nothing from the body but this fingerprint, which it
 * recomputes). The composer posts { compositionHash } and nothing else; the
 * route recomposes, hashes its own result, and on mismatch returns 409 with the
 * fresh composition so the UI re-renders and asks for re-confirmation. Reject,
 * never warn — a click-through warning is the failure mode being fixed.
 *
 * Determinism is the whole point: the page render and the send route both call
 * {@link composeDelivery}, so both arrive at this hash via the same field set ⇒
 * a matching hash proves the reviewed composition equals the one about to ship.
 * The canonical form is a fixed-key-order JSON object (with a `v` tag so a
 * future field-set change forces re-confirmation instead of silently colliding).
 */
export async function computeCompositionHash(input: {
  exportId: string;
  zipSha256: string;
  to: string | null;
  cc: string | null;
  subject: string;
  text: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    v: 1,
    exportId: input.exportId,
    zipSha256: input.zipSha256,
    to: input.to,
    cc: input.cc,
    subject: input.subject,
    text: input.text,
  });
  return computeSha256Hex(new TextEncoder().encode(canonical));
}

/**
 * Compose a month's delivery — recipients, subject, body, attachment metadata,
 * preflight, and the send decision. Single-sourced; called by the send route,
 * the preview endpoint, and the composer page.
 *
 * `opts.zipBytes`: the sealed proofs-ZIP bytes, when the caller already has
 * them (the send path fetches once and passes them in so compose runs the
*  preflight on the exact bytes that ship). When omitted, compose fetches from R2
 *  itself (HEAD size check → GET), which is what the preview/page path uses.
 */
export async function composeDelivery(
  month: string,
  opts: { zipBytes?: Uint8Array } = {},
): Promise<ComposedDelivery> {
  // ── Load the sealed export (D1: send is post-seal) ───────────────────────
  const exportRecord = await getLatestFinalizedExport(month);
  if (!exportRecord || !exportRecord.proofs_r2_key) {
    throw new NoSealedExportError(month);
  }
  const proofsKey = exportRecord.proofs_r2_key;

  // ── Recipients + transport config (Settings/config — not pack state) ─────
  // To: accountant (settings.notification_recipient → ACCOUNTANT_EMAIL
  // fallback). Cc: business manager (settings.notification_cc_recipient — no
  // fallback); unset → null → omitted from the Resend payload.
  const settings = await getComplianceSettings();
  const to = resolveNotificationRecipient(
    settings.notification_recipient,
    getAccountantEmail(),
  ).email;
  const cc = (settings.notification_cc_recipient ?? "").trim() || null;
  const signature = (settings.delivery_signature ?? "").trim() || null;
  const replyTo = (settings.delivery_reply_to ?? "").trim() || null;
  const apiKey = getResendApiKeyOrNull();
  const from = getDeliveryFromAddress();

  const configErrors = computeDeliveryConfigErrors({
    to,
    cc,
    replyTo,
    from,
    hasResendKey: !!apiKey,
  });

  // ── The sealed bytes: caller-provided (send path, already HEAD-checked) or
  //    fetched here (preview/page) with the B-2 size check ahead of the GET.
  let zipBytes: Uint8Array;
  if (opts.zipBytes) {
    zipBytes = opts.zipBytes;
  } else {
    const bucket = getReceiptsArchiveBucket();
    const head = await bucket.head(proofsKey);
    if (!head) {
      configErrors.push(`Sealed proofs ZIP "${proofsKey}" is missing from storage.`);
      // No bytes ⇒ no sha, no preflight. Return early with the configError; the
      // composer disables Send. Use a placeholder sha so the shape is satisfied
      // (the composer won't render the attachment block when configErrors block
      // the ZIP — but the field is non-optional on the interface).
      return noBytesResult(month, exportRecord.id, to, cc, from, replyTo, signature, configErrors);
    }
    try {
      assertDeliverySize(head.size); // B-2 — guards the isolate before the GET
    } catch (err) {
      configErrors.push(
        err instanceof Error ? err.message : "Pack exceeds the delivery ceiling.",
      );
      return noBytesResult(month, exportRecord.id, to, cc, from, replyTo, signature, configErrors);
    }
    const object = await bucket.get(proofsKey);
    if (!object) {
      configErrors.push("Sealed proofs ZIP vanished between HEAD and GET.");
      return noBytesResult(month, exportRecord.id, to, cc, from, replyTo, signature, configErrors);
    }
    zipBytes = new Uint8Array(await new Response(object.body).arrayBuffer());
  }

  const zipSha256 = await computeSha256Hex(zipBytes);
  const zipFilename = packZipName(month); // ASCII container name (B-4)

  // ── Change 3: preflight on the ACTUAL sealed bytes. A gate that checks a
  //    different object than the one being sent is not a gate. The send route
  //    reads this same `preflight` from the composed result — no re-run.
  const { report: preflightReport, summary } = await runPreflightOnSealedZip({
    zipBytes,
    month,
    paymentDueDate: exportRecord.payment_due_date ?? null,
    maxPackBytes: MAX_DELIVERY_ZIP_BYTES,
    operatorMessage: exportRecord.operator_message ?? null,
  });

  // ── Email body — sealed values only (B-5). SINGLE path (buildDeliveryEmail).
  const email = buildDeliveryEmail({
    month,
    operatorMessage: exportRecord.operator_message ?? null, // 0037: same stored value the pack notice carries (O7)
    summary,
    signature,
  });

  // ── Decide new vs resume vs blocked for DISPLAY (forceNew:false). The send
  //    route re-decides with the real forceNew from the query.
  const deliveries = (await listDeliveriesForMonth(month)).map((d) => ({
    id: d.id,
    exportId: d.export_id,
    attemptId: d.attempt_id,
    state: d.state,
    createdAt: d.created_at,
  }));
  const decision = decideSendAction({
    latestExportId: exportRecord.id,
    deliveries,
    now: nowIso(),
    forceNew: false,
  });

  let action: ComposedDelivery["action"];
  let blockedReason: ComposedDelivery["blockedReason"];
  let priorAttemptId: string | undefined;
  let priorAttemptState: AttemptState | undefined;
  if (decision.action === "new") {
    action = "new";
  } else if (decision.action === "redelivery") {
    action = "redelivery";
    priorAttemptId = decision.priorAttemptId;
    priorAttemptState = decision.priorAttemptState;
  } else if (decision.action === "resume") {
    action = "resume";
    priorAttemptId = decision.attemptId;
  } else {
    action = "blocked";
    blockedReason = decision.reason; // "sent" | "stale"
    priorAttemptId = decision.priorAttemptId;
  }

  const compositionHash = await computeCompositionHash({
    exportId: exportRecord.id,
    zipSha256,
    to,
    cc,
    subject: email.subject,
    text: email.text,
  });

  return {
    month,
    exportId: exportRecord.id,
    compositionHash,
    sealedAt: exportRecord.finalized_at ?? null,
    to,
    cc,
    from,
    replyTo,
    subject: email.subject,
    text: email.text,
    html: email.html,
    signature,
    zipFilename,
    zipSha256,
    zipBytes: zipBytes.byteLength,
    preflight: {
      passed: preflightReport.passed,
      results: preflightReport.results.map((r) => ({
        name: r.check,
        passed: r.passed,
        ...(r.detail ? { detail: r.detail } : {}),
      })),
    },
    configErrors,
    action,
    ...(blockedReason ? { blockedReason } : {}),
    ...(priorAttemptId ? { priorAttemptId } : {}),
    ...(priorAttemptState ? { priorAttemptState } : {}),
  };
}

/** Early-return shape when the sealed bytes could not be loaded (missing /
 *  oversized ZIP): there is no sha and no preflight to report, only the
 *  configError(s). The composer renders the error state and disables Send. */
function noBytesResult(
  month: string,
  exportId: string,
  to: string | null,
  cc: string | null,
  from: string | null,
  replyTo: string | null,
  signature: string | null,
  configErrors: string[],
): ComposedDelivery {
  return {
    month,
    exportId,
    // No sealed bytes ⇒ no real composition was reviewed (Send is disabled in
    // this state via configBlocked). An empty fingerprint can never match a real
    // recomposed hash, so a stray POST would 409 rather than silently send.
    compositionHash: "",
    sealedAt: null,
    to,
    cc,
    from,
    replyTo,
    subject: "",
    text: "",
    html: "",
    signature,
    zipFilename: packZipName(month),
    zipSha256: "",
    zipBytes: 0,
    preflight: { passed: false, results: [] },
    configErrors,
    action: "blocked",
    blockedReason: "stale",
  };
}

// Re-export so alert surfaces can reuse the month-state derivation without a
// second import path. (delivery-status.ts is the canonical helper for the
// multi-month Map; this is just the type.)
export type { DeliveryState };

/**
 * Pure recipient/transport config validation — the testable core of the
 * {@link ComposedDelivery.configErrors} computation. Extracted so the four
 * config-error paths (no To, invalid To, invalid Cc, no Resend key / From) are
 * unit-testable without D1/R2 bindings; {@link composeDelivery} calls this with
 * the resolved values and then appends any ZIP/storage errors separately.
 *
 * To is REQUIRED (no resolvable To = a partially-configured list → refuse). Cc
 * is OPTIONAL (null → omitted from the payload, never an error). Both addresses
 * are validated at compose time because To may arrive via the unvalidated
 * ACCOUNTANT_EMAIL fallback. Either a missing Resend key OR a missing From
 * address makes delivery impossible.
 */
export function computeDeliveryConfigErrors(opts: {
  to: string | null;
  cc: string | null;
  replyTo: string | null;
  from: string | null;
  hasResendKey: boolean;
}): string[] {
  const errors: string[] = [];
  if (!opts.to) {
    errors.push(
      "No delivery recipient (To) configured. Set it in Settings → Compliance.",
    );
  } else if (!isValidDeliveryAddress(opts.to)) {
    errors.push(
      `Delivery recipient (To) is not a valid email address: ${opts.to}`,
    );
  }
  if (opts.cc !== null && !isValidDeliveryAddress(opts.cc)) {
    errors.push(
      `Delivery Cc recipient is not a valid email address: ${opts.cc}`,
    );
  }
  if (opts.replyTo !== null && !isValidDeliveryAddress(opts.replyTo)) {
    errors.push(
      `Delivery Reply-To is not a valid email address: ${opts.replyTo}`,
    );
  }
  if (!opts.hasResendKey || !opts.from) {
    errors.push(
      "Delivery not configured (RESEND_API_KEY / DELIVERY_FROM_ADDRESS).",
    );
  }
  return errors;
}
