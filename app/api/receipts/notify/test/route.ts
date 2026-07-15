import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import { getLatestFinalizedExport, listExports } from "@/lib/receipts/db";
import { buildExportBundle } from "@/lib/receipts/month-closing";
import {
  authorizeNotifyTest,
  composeFinalizeNoticeData,
  notifyAccountantOfFinalize,
} from "@/lib/receipts/notify";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";

/**
 * POST /api/receipts/notify/test[?month=YYYY-MM]
 *
 * Exercises the FULL production notification path (binding + template +
 * destination) WITHOUT finalizing anything — so the operator can verify Email
 * Routing end to end before a real close. Auth is Clerk-session ONLY (an
 * operator action); a processor key alone is rejected (the Mac consumer must
 * never trigger a notification).
 *
 * Reads the real bundle for the month (read-only) so the body reflects an actual
 * close, but the subject is prefixed 【テスト送信】 and the body opens with a
 * "this is a channel test, not a close notification" banner. Returns the notify
 * result verbatim — {ok:true} or {ok:false, error} with the raw Cloudflare
 * rejection text so the operator can diagnose (unverified destination, bad
 * from-domain, missing binding) without log-diving.
 */
export async function POST(request: Request) {
  try {
    // Clerk session ONLY — resolve the actor without throwing so a
    // processor-key-only request (no session) is caught by authorizeNotifyTest.
    let clerkActor: string | null = null;
    try {
      clerkActor = await requireReceiptsActor(request.headers);
    } catch {
      clerkActor = null;
    }
    const actor = authorizeNotifyTest(clerkActor);

    const url = new URL(request.url);
    let month = url.searchParams.get("month") ?? "";
    if (!month) {
      // Accept month from a JSON body as well (?month= takes precedence).
      const body = (await request.json().catch(() => ({}))) as { month?: string };
      month = body.month?.trim() ?? "";
    }
    if (!month) {
      // Default: the most-recent finalized month.
      const all = await listExports();
      const finalized = all
        .filter((e) => e.status === "finalized")
        .sort((a, b) => (b.finalized_at ?? "").localeCompare(a.finalized_at ?? ""));
      if (finalized.length === 0) {
        return NextResponse.json(
          { ok: false, error: "No finalized month to test against." },
          { status: 404 },
        );
      }
      month = finalized[0]!.export_month;
    }

    const exportRecord = await getLatestFinalizedExport(month);
    if (!exportRecord) {
      return NextResponse.json(
        { ok: false, error: `No finalized export for ${month}.` },
        { status: 404 },
      );
    }
    const bundle = await buildExportBundle(month);
    const data = composeFinalizeNoticeData(month, bundle, exportRecord);

    const result = await notifyAccountantOfFinalize(data, { test: true });

    await createAuditEntry(getReceiptsDb(), {
      actor,
      action: "export.notification_test",
      objectType: "export",
      objectId: exportRecord.id,
      newValueJson: stringifyJson(
        result.ok ? { month, ok: true } : { month, ok: false, error: result.error },
      ),
    });

    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/notify/test] POST failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Test send failed." },
      { status: 500 },
    );
  }
}
