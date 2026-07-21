import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { recommendRetention } from "@/lib/receipts/duplicate-resolution-policy";
import {
  completeness,
  type DuplicateMemberInput,
  type ScoreField,
} from "@/lib/receipts/duplicate-resolution-policy";
import type { ReceiptRecord } from "@/lib/receipts/types";

// GET /api/receipts/duplicates/cluster?ids=a,b,c
// Returns the server-computed comparison + retention recommendation for a set of
// possible-duplicate receipts. The modal renders this; the operator visually
// confirms and submits to /api/receipts/duplicates/purge. Server is
// authoritative — the client never scores.

function toInput(r: ReceiptRecord, signals: {
  claimedByConfirmedAmexLine: boolean;
  businessTripLinked: boolean;
  emailIntakePromoted: boolean;
  attendeesCount: number;
  hasProofFile: boolean;
}): DuplicateMemberInput {
  return {
    id: r.id,
    captured_at: r.captured_at,
    updated_at: r.updated_at,
    status: r.status,
    exported: r.status === "exported",
    archived: r.status === "archived",
    claimedByConfirmedAmexLine: signals.claimedByConfirmedAmexLine,
    businessTripLinked: signals.businessTripLinked,
    emailIntakePromoted: signals.emailIntakePromoted,
    transaction_date: r.transaction_date,
    merchant: r.merchant,
    amount_minor: r.amount_minor,
    currency: r.currency,
    expense_category_code: r.expense_category_code,
    business_purpose: r.business_purpose,
    tax_amount_minor: r.tax_amount_minor,
    tax_rate: r.tax_rate ?? null,
    invoice_registration_number: r.invoice_registration_number ?? null,
    qualified_invoice_status: r.qualified_invoice_status ?? null,
    counterparty_name: r.counterparty_name ?? null,
    attendeesRequired: false,
    attendeesCount: signals.attendeesCount,
    extractionState: r.extraction_state ?? null,
    hasOriginalFile: Boolean(r.original_r2_key),
    hasProofFile: signals.hasProofFile,
  };
}

export async function GET(request: Request) {
  try {
    await requireReceiptsActor(request.headers);
    const db = getReceiptsDb();
    const ids = new URL(request.url).searchParams.get("ids")?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    if (ids.length < 2) {
      return NextResponse.json({ error: "Provide at least 2 ids." }, { status: 400 });
    }

    const members: Array<{
      input: DuplicateMemberInput;
      row: ReceiptRecord;
      attendees: string[];
      amexClaim: { month: string; lineId: string } | null;
      exportMonths: string[];
      businessTripIds: string[];
      emailIntakePromoted: boolean;
      completedFields: ScoreField[];
      missingFields: ScoreField[];
      completenessScore: number;
    }> = [];

    for (const id of ids) {
      const row = await db.prepare(`SELECT * FROM receipt_records WHERE id = ?`).bind(id).first<ReceiptRecord>();
      if (!row || row.deleted_at) continue;

      const claim = await db
        .prepare(`SELECT statement_month, id FROM amex_statement_lines WHERE matched_receipt_id = ? AND match_status IN ('matched','confirmed') LIMIT 1`)
        .bind(id)
        .first<{ statement_month: string; id: string }>();
      const exportRows = await db
        .prepare(`SELECT DISTINCT e.export_month FROM receipt_export_items i JOIN receipt_exports e ON e.id = i.export_id WHERE i.item_type='receipt' AND i.item_id = ?`)
        .bind(id)
        .all<{ export_month: string }>();
      const tripRows = await db
        .prepare(`SELECT DISTINCT business_trip_report_id FROM business_trip_report_receipts WHERE receipt_id = ?`)
        .bind(id)
        .all<{ business_trip_report_id: string }>();
      const email = await db
        .prepare(`SELECT 1 AS ok FROM email_receipt_intake WHERE promoted_receipt_id = ? LIMIT 1`)
        .bind(id)
        .first();
      const att = await db
        .prepare(`SELECT attendee_name FROM receipt_attendees WHERE receipt_id = ? ORDER BY created_at`)
        .bind(id)
        .all<{ attendee_name: string }>();
      const attCount = (att.results ?? []).length;
      const proof = await db
        .prepare(`SELECT 1 AS ok FROM receipt_files WHERE object_type='receipt' AND object_id=? AND role='proof_copy' LIMIT 1`)
        .bind(id)
        .first();

      const input = toInput(row, {
        claimedByConfirmedAmexLine: !!claim,
        businessTripLinked: (tripRows.results ?? []).length > 0,
        emailIntakePromoted: !!email,
        attendeesCount: attCount,
        hasProofFile: !!proof,
      });
      // completeness derived from the input via the policy module (reuse).
      const comp = completeness(input);
      members.push({
        input,
        row,
        attendees: (att.results ?? []).map((a) => a.attendee_name),
        amexClaim: claim ? { month: claim.statement_month, lineId: claim.id } : null,
        exportMonths: (exportRows.results ?? []).map((e) => e.export_month),
        businessTripIds: (tripRows.results ?? []).map((t) => t.business_trip_report_id),
        emailIntakePromoted: !!email,
        completedFields: comp.completed,
        missingFields: comp.missing,
        completenessScore: comp.score,
      });
    }

    if (members.length < 2) {
      return NextResponse.json({ error: "Fewer than 2 live receipts in the cluster." }, { status: 404 });
    }

    const recommendation = recommendRetention(members.map((m) => m.input));

    const memberView = members.map((m) => {
      const a = recommendation.assessments.get(m.input.id)!;
      const reasons: string[] = [];
      if (a.tier === "protected") reasons.push("Protected — cannot purge");
      if (m.amexClaim) reasons.push(`Registered to AMEX (${m.amexClaim.month})`);
      if (m.exportMonths.length) reasons.push(`Exported (${m.exportMonths.join(",")})`);
      if (m.businessTripIds.length) reasons.push("Business-trip linkage");
      if (m.emailIntakePromoted) reasons.push("Email-intake promotion");
      return {
        id: m.input.id,
        isRetained: m.input.id === recommendation.retainedId,
        captured_at: m.row.captured_at,
        captured_by: m.row.captured_by,
        source: m.row.source,
        original_content_type: m.row.original_content_type,
        original_filename: m.row.original_filename,
        transaction_date: m.row.transaction_date,
        merchant: m.row.merchant,
        amount_minor: m.row.amount_minor,
        currency: m.row.currency,
        expense_category_code: m.row.expense_category_code,
        business_purpose: m.row.business_purpose,
        tax_amount_minor: m.row.tax_amount_minor,
        tax_rate: m.row.tax_rate ?? null,
        invoice_registration_number: m.row.invoice_registration_number ?? null,
        counterparty_name: m.row.counterparty_name ?? null,
        attendees: m.attendees,
        status: m.row.status,
        extraction_state: m.row.extraction_state ?? null,
        updated_at: m.row.updated_at,
        tier: a.tier,
        canPurge: a.canPurge,
        completenessScore: m.completenessScore,
        completedFields: m.completedFields,
        missingFields: m.missingFields,
        registrationReasons: reasons,
        amexClaim: m.amexClaim,
        exportMonths: m.exportMonths,
      };
    });

    return NextResponse.json({ recommendation, members: memberView }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/duplicates/cluster] GET failed", error);
    return NextResponse.json({ error: "Failed to load duplicate cluster." }, { status: 500 });
  }
}
