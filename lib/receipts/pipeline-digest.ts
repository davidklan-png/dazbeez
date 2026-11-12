// Operator-only daily snapshot. No app runtime, mutations, or accountant settings.
import {
  getPipelineHealth, listPipelineAttentionReceipts, buildPipelineClassQuery,
  formatAge, type PipelineHealth, type PipelineAttentionReceipt,
} from "./pipeline-health-core";
import { expectedStatementMonths, PRESENT_STATEMENT_SQL } from "./missing-statements";
import { finalizedMonthsDeliveryState, needsDeliveryAction,
  type DigestExport, type DigestDelivery } from "./delivery-status-core";
import { sendViaResend, isValidDeliveryAddress } from "./notify";

export const DIGEST_CRON = "30 23 * * *"; // 08:30 JST, next calendar day.
export const CLEANUP_CRON = "0 3 * * *";
export const DIGEST_DETAIL_CAP = 5;
const APP = "https://dazbeez.com/receipts";
export const DIGEST_EXPORTS_SQL = `SELECT id, export_month, status, export_revision, created_at
  FROM receipt_exports WHERE status = 'finalized' ORDER BY export_month DESC`;
export const DIGEST_DELIVERIES_SQL = `SELECT d.export_id, d.attempt_id, d.state, d.created_at
  FROM export_deliveries d JOIN receipt_exports e ON e.id = d.export_id
  WHERE e.status = 'finalized' ORDER BY d.created_at ASC`;

interface DigestDetails { rows: PipelineAttentionReceipt[]; total: number; unavailable?: boolean }
export interface DigestSnapshot {
  health: PipelineHealth | null;
  details: Record<string, DigestDetails>;
  missingStatements: { statementMonth: string; expectedReadyDate: string }[] | null;
  undelivered: { month: string; state: string | null }[] | null;
}

async function readRows<T>(db: D1Database, sql: string): Promise<T[]> {
  const result = await db.prepare(sql).all<T>();
  if (!result.success || !Array.isArray(result.results)) throw new Error("Digest query unavailable");
  return result.results;
}

export const MISSING_MANIFEST_DETAILS_SQL = buildPipelineClassQuery("missing_manifest", "").sql
  .replace("COUNT(*) AS n, MIN(rr.captured_at) AS oldest_at",
    "rr.id, rr.original_filename, rr.captured_at AS age_from, COUNT(*) OVER () AS total")
  + ` ORDER BY rr.captured_at ASC LIMIT ${DIGEST_DETAIL_CAP}`;

export async function loadDigestSnapshot(db: D1Database, now: number): Promise<DigestSnapshot> {
  const [healthResult, statementsResult, deliveryResult] = await Promise.allSettled([
    getPipelineHealth(db, now),
    readRows<{ statement_month: string }>(db, PRESENT_STATEMENT_SQL),
    Promise.all([
      readRows<DigestExport>(db, DIGEST_EXPORTS_SQL),
      readRows<DigestDelivery>(db, DIGEST_DELIVERIES_SQL),
    ]).then(([exports, deliveries]) => [...finalizedMonthsDeliveryState(exports, deliveries)]
      .filter(([, state]) => needsDeliveryAction(state)).map(([month, state]) => ({ month, state }))),
  ]);
  const health = healthResult.status === "fulfilled" ? healthResult.value : null;
  const details: DigestSnapshot["details"] = {};
  await Promise.all((health?.lit ?? []).map(async (report) => {
    try {
      let detail: DigestDetails;
      if (report.kind === "missing_manifest") {
        const rows = await readRows<{ id: string; original_filename: string | null; age_from: string | null; total: number }>(db, MISSING_MANIFEST_DETAILS_SQL);
        detail = { total: rows[0]?.total ?? 0, rows: rows.map((r) => ({
          id: r.id, original_filename: r.original_filename, reason: null,
          ageMs: r.age_from ? Math.max(0, now - Date.parse(r.age_from)) : NaN,
        })) };
      } else {
        detail = await listPipelineAttentionReceipts(report.kind, db, now);
      }
      // Counts/details are separate reads: a changing population is partial data.
      if (detail.total !== report.count || detail.rows.length < Math.min(report.count, DIGEST_DETAIL_CAP)) {
        throw new Error("Digest details incomplete");
      }
      details[report.kind] = detail;
    } catch {
      details[report.kind] = { rows: [], total: report.count, unavailable: true };
    }
  }));
  return {
    health, details,
    missingStatements: statementsResult.status === "fulfilled"
      ? expectedStatementMonths(new Date(now)).filter((m) => !statementsResult.value.some((r) => r.statement_month === m.statementMonth))
      : null,
    undelivered: deliveryResult.status === "fulfilled" ? deliveryResult.value : null,
  };
}

function singleLine(value: string, cap = 120): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, cap);
}

// Do not forward arbitrary exception text (paths, document text, tokens, URLs).
export function safeDigestFailureReason(reason: string | null): string {
  if (!reason) return "Failure reason unavailable; inspect review screen";
  if (/empty|zero.byte/i.test(reason)) return "Empty source or rendered file";
  if (/unidentifiedimage|undecodable|cannot identify image/i.test(reason)) return "Undecodable source image";
  if (/conversion|render/i.test(reason)) return "File rendering/conversion failed";
  return "Processing failed; inspect review screen";
}

export function digestDate(now: number): string {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function composePipelineDigest(snapshot: DigestSnapshot, now: number) {
  const unavailable = snapshot.health === null || snapshot.missingStatements === null || snapshot.undelivered === null
    || Object.values(snapshot.details).some((d) => d.unavailable)
    || (snapshot.health?.lit ?? []).some((r) => !snapshot.details[r.kind]);
  const attention = (snapshot.health?.lit.length ?? 0) > 0
    || (snapshot.missingStatements?.length ?? 0) > 0 || (snapshot.undelivered?.length ?? 0) > 0;
  const status = unavailable ? "DATA UNAVAILABLE" : attention ? "ATTENTION" : "ALL CLEAR";
  const lines = [`Receipt health — ${digestDate(now)} JST — ${status}`, `Snapshot: ${new Date(now).toISOString()}`, ""];
  if (unavailable) lines.push("Some checks/details are unavailable or incomplete. Health cannot be confirmed.", "");
  if (snapshot.health === null) lines.push("Pipeline checks: unavailable.");
  else if (snapshot.health.ok) lines.push("Pipeline checks: no attention classes detected.");
  else for (const report of snapshot.health.lit) {
    lines.push(`[${report.severity.toUpperCase()}] ${report.kind}: ${report.count}; oldest ${report.oldestAgeMs == null || !Number.isFinite(report.oldestAgeMs) ? "unknown" : formatAge(report.oldestAgeMs)}`);
    const detail = snapshot.details[report.kind];
    if (!detail || detail.unavailable) { lines.push("  Receipt details unavailable — open dashboard."); continue; }
    const rows = detail.rows.slice(0, DIGEST_DETAIL_CAP);
    lines.push(`  Showing oldest ${rows.length} of ${detail.total} (cap ${DIGEST_DETAIL_CAP} per class; classes may overlap).`);
    for (const row of rows) {
      lines.push(`  - ${singleLine(row.original_filename || "Unnamed receipt")}; age ${Number.isFinite(row.ageMs) ? formatAge(row.ageMs) : "unknown"}`);
      if (report.kind === "render_failed" || report.kind === "extraction_failed") lines.push(`    ${safeDigestFailureReason(row.reason)}`);
      lines.push(`    ${APP}/review/${encodeURIComponent(row.id)}`);
    }
  }
  lines.push("", snapshot.missingStatements === null ? "Missing statements: unavailable."
    : `Missing statements: ${snapshot.missingStatements.length} (global; dashboard dismissals ignored).`);
  for (const m of snapshot.missingStatements ?? []) lines.push(`  ${m.statementMonth} — expected ready ${m.expectedReadyDate}; ${APP}/amex?month=${encodeURIComponent(m.statementMonth)}`);
  lines.push("", snapshot.undelivered === null ? "Finalized delivery checks: unavailable."
    : `Finalized months needing delivery action: ${snapshot.undelivered.length}.`);
  for (const m of snapshot.undelivered ?? []) lines.push(`  ${m.month} — ${m.state ?? "never attempted"}; ${APP}/export?month=${encodeURIComponent(m.month)}`);
  if (!unavailable && !attention) lines.push("", "All checks completed: no pipeline attention, missing statements, or finalized months awaiting delivery.");
  lines.push("", `Dashboard (sign-in required): ${APP}`, "Daily heartbeat; absence of this email is not an independently monitored outage signal.");
  return { subject: `[Dazbeez receipts] ${status} — ${digestDate(now)} JST`, text: lines.join("\n"), unavailable };
}

export interface DigestConfig {
  DIGEST_ENABLED?: string;
  DIGEST_TO?: string;
  NOTIFY_FROM_ADDRESS?: string;
  RESEND_API_KEY?: string;
}
export type DigestResult =
  | { status: "disabled"; reason: string }
  | { status: "misconfigured"; reason: string }
  | { status: "send_failed"; reason: string }
  | { status: "accepted"; dataUnavailable: boolean };

export async function digestIdempotencyKey(now: number, recipient: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(recipient.trim().toLowerCase()));
  return `dazbeez-receipt-health-v1-${digestDate(now)}-${Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("")}`;
}

export async function runPipelineDigest(db: D1Database, config: DigestConfig, now: number, fetchImpl: typeof fetch): Promise<DigestResult> {
  const to = config.DIGEST_TO?.trim();
  if (config.DIGEST_ENABLED !== "true") return { status: "disabled", reason: `DIGEST_ENABLED is not true${!to ? "; DIGEST_TO unset" : ""}` };
  if (!to) return { status: "disabled", reason: "DIGEST_TO unset; recipient confirmation pending" };
  if (!isValidDeliveryAddress(to) || /[,;<>]/.test(to)) return { status: "misconfigured", reason: "DIGEST_TO must be one operator email address" };
  if (!config.RESEND_API_KEY?.trim() || !config.NOTIFY_FROM_ADDRESS?.trim()) return { status: "misconfigured", reason: "Missing RESEND_API_KEY or NOTIFY_FROM_ADDRESS on intake worker" };
  const snapshot = await loadDigestSnapshot(db, now);
  const message = composePipelineDigest(snapshot, now);
  const result = await sendViaResend(fetchImpl, config.RESEND_API_KEY, config.NOTIFY_FROM_ADDRESS, to,
    message.subject, message.text, undefined, null, await digestIdempotencyKey(now, to));
  // Transport text can echo request fields/secrets; keep cron logs diagnostic but redacted.
  if (!result.ok) return { status: "send_failed", reason: "Resend did not confirm acceptance; outcome may be ambiguous" };
  return { status: "accepted", dataUnavailable: message.unavailable };
}
