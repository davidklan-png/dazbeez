import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord, updateReceiptRecord, listAttendees, createAttendees, softDeleteReceipt } from "@/lib/receipts/db";
import type { CreateAttendeeInput, ExpenseType, PaymentPath, ReceiptStatus } from "@/lib/receipts/types";
import {
  validateAmountMinor,
  validateCurrency,
  validateReceiptDate,
} from "@/lib/receipts/validation";
import { isCanonicalCode } from "@/lib/receipts/categories";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createAuditEntry } from "@/lib/receipts/audit";
import { loadSealedExportMonths } from "@/lib/receipts/membership";
import {
  runComplianceChecksForReceipt,
  listChecksForObject,
} from "@/lib/receipts/compliance";
import { getComplianceSettings } from "@/lib/receipts/settings";
import {
  validateInvoiceRegistrationNumber,
} from "@/lib/receipts/invoice";
import { ExportFinalizedError } from "@/lib/receipts/month-lock";
import type {
  QualifiedInvoiceStatus,
  SourceType,
} from "@/lib/receipts/types";
import { VALID_SOURCE_TYPES } from "@/lib/receipts/upload-policy";

type RouteContext = { params: Promise<{ id: string }> };

const VALID_PAYMENT_PATHS: PaymentPath[] = ["AMEX", "CASH", "DIGITAL", "UNKNOWN"];
const VALID_EXPENSE_TYPES: ExpenseType[] = [
  "meeting-no-alcohol",
  "entertainment-alcohol",
  "transportation",
  "books",
  "research",
  "insurance",
  "software",
  "telecom",
  "office_supplies",
  "travel",
  "business_trip",
  "misc",
  "UNKNOWN",
];
const VALID_RECEIPT_STATUSES: ReceiptStatus[] = [
  "captured",
  "needs_review",
  "reviewed",
  "reconciled",
  "exported",
  "archived",
];

function normalizeOptionalText(
  value: string | null | undefined,
  maxLength: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : null;
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireReceiptsActor(request.headers);
    const { id } = await params;

    const receipt = await getReceiptRecord(id);
    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    const attendees = await listAttendees(id);
    const checks = await listChecksForObject(getReceiptsDb(), "receipt", id);
    return NextResponse.json({ receipt, attendees, complianceChecks: checks }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/[id]] GET failed", error);
    return NextResponse.json({ error: "Failed to load receipt." }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;

    const receipt = await getReceiptRecord(id);
    if (!receipt) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }

    if (receipt.status === "exported" || receipt.status === "archived") {
      // Surface the revision endpoint when the receipt shipped in a
      // finalized export — the operator can't edit it directly and must
      // open a correction. exported_month tells us which month's revision
      // endpoint to point at (audit A5 split-lock model).
      const revisionHint =
        receipt.status === "exported" && receipt.exported_month
          ? ` POST /api/receipts/export/${receipt.exported_month}?correction=true to create a revision.`
          : "";
      return NextResponse.json(
        {
          error: `Receipt is ${receipt.status} and cannot be edited.${revisionHint}`,
        },
        { status: 409 },
      );
    }

    const body = (await request.json()) as {
      paymentPath?: string;
      expenseType?: string;
      transactionDate?: string | null;
      merchant?: string | null;
      amountMinor?: number | null;
      currency?: string;
      taxAmountMinor?: number | null;
      businessPurpose?: string | null;
      expenseCategoryCode?: string | null;
      exportStatementMonth?: string | null;
      status?: string;
      attendees?: string[];
      // Compliance fields
      sourceType?: string | null;
      invoiceRegistrationNumber?: string | null;
      counterpartyName?: string | null;
      taxRate?: string | null;
    };

    if (
      body.paymentPath !== undefined &&
      !VALID_PAYMENT_PATHS.includes(body.paymentPath as PaymentPath)
    ) {
      return NextResponse.json({ error: "Invalid paymentPath." }, { status: 400 });
    }
    if (
      body.expenseType !== undefined &&
      !VALID_EXPENSE_TYPES.includes(body.expenseType as ExpenseType)
    ) {
      return NextResponse.json({ error: "Invalid expenseType." }, { status: 400 });
    }
    if (
      body.status !== undefined &&
      !VALID_RECEIPT_STATUSES.includes(body.status as ReceiptStatus)
    ) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    if (
      body.transactionDate !== undefined &&
      body.transactionDate !== null &&
      !validateReceiptDate(body.transactionDate)
    ) {
      return NextResponse.json({ error: "Invalid transactionDate." }, { status: 400 });
    }
    if (
      body.amountMinor !== undefined &&
      body.amountMinor !== null &&
      validateAmountMinor(body.amountMinor) === null
    ) {
      return NextResponse.json({ error: "Invalid amountMinor." }, { status: 400 });
    }
    if (
      body.taxAmountMinor !== undefined &&
      body.taxAmountMinor !== null &&
      validateAmountMinor(body.taxAmountMinor) === null
    ) {
      return NextResponse.json({ error: "Invalid taxAmountMinor." }, { status: 400 });
    }
    if (
      body.currency !== undefined &&
      !validateCurrency(body.currency)
    ) {
      return NextResponse.json({ error: "Invalid currency." }, { status: 400 });
    }
    const expenseCategoryCode =
      body.expenseCategoryCode === "" ? null : body.expenseCategoryCode;
    if (
      expenseCategoryCode !== undefined &&
      expenseCategoryCode !== null &&
      !isCanonicalCode(expenseCategoryCode)
    ) {
      return NextResponse.json(
        { error: "Invalid expenseCategoryCode." },
        { status: 400 },
      );
    }

    if (
      body.merchant !== undefined &&
      body.merchant !== null &&
      typeof body.merchant !== "string"
    ) {
      return NextResponse.json({ error: "Invalid merchant." }, { status: 400 });
    }
    if (
      body.businessPurpose !== undefined &&
      body.businessPurpose !== null &&
      typeof body.businessPurpose !== "string"
    ) {
      return NextResponse.json({ error: "Invalid businessPurpose." }, { status: 400 });
    }
    const merchant = normalizeOptionalText(body.merchant, 200);
    const businessPurpose = normalizeOptionalText(body.businessPurpose, 500);
    const counterpartyName = normalizeOptionalText(body.counterpartyName, 200);
    const taxRate = normalizeOptionalText(body.taxRate, 16);

    // Validate sourceType if provided.
    let sourceType: SourceType | null | undefined = undefined;
    if ("sourceType" in body) {
      if (body.sourceType === null || body.sourceType === "") {
        sourceType = null;
      } else if (
        typeof body.sourceType === "string" &&
        VALID_SOURCE_TYPES.includes(body.sourceType as SourceType)
      ) {
        sourceType = body.sourceType as SourceType;
      } else {
        return NextResponse.json({ error: "Invalid sourceType." }, { status: 400 });
      }
    }

    // Invoice number validation drives qualified_invoice_status.
    let qualifiedInvoiceStatus: QualifiedInvoiceStatus | undefined;
    let invoiceRegistrationNumber: string | null | undefined = undefined;
    if ("invoiceRegistrationNumber" in body) {
      const raw = body.invoiceRegistrationNumber;
      if (raw === null || (typeof raw === "string" && raw.trim() === "")) {
        invoiceRegistrationNumber = null;
        qualifiedInvoiceStatus = "missing_registration_number";
      } else if (typeof raw === "string") {
        const v = validateInvoiceRegistrationNumber(raw);
        if (v.registrationStatus === "format_invalid") {
          return NextResponse.json(
            { error: v.message ?? "Invalid invoiceRegistrationNumber." },
            { status: 400 },
          );
        }
        invoiceRegistrationNumber = v.normalizedNumber;
        qualifiedInvoiceStatus = v.qualifiedInvoiceStatus;
      }
    }

    // ADR 0008 (reusing ADR 0006 §D6): discretionary export_statement_month
    // override (cash/digital only). Target must be export-open — the two-lock
    // model's EXPORT seal (loadSealedExportMonths), not the reconciliation seal.
    // A sealed month's bundle already shipped; reassigning into it would
    // silently double-ship.
    let exportStatementMonth: string | null | undefined = undefined;
    if ("exportStatementMonth" in body) {
      if (receipt.payment_path !== "CASH" && receipt.payment_path !== "DIGITAL") {
        return NextResponse.json(
          { error: "Statement-month override only applies to cash/digital receipts." },
          { status: 400 },
        );
      }
      const raw = body.exportStatementMonth;
      if (raw === null || raw === "") {
        exportStatementMonth = null;
      } else if (typeof raw === "string" && /^\d{4}-\d{2}$/.test(raw)) {
        const sealed = await loadSealedExportMonths();
        if (sealed.has(raw)) {
          return NextResponse.json(
            {
              error:
                `${raw}'s export is finalized — cannot reassign a receipt into a sealed month. ` +
                `Pick an open month, or use the export revision flow.`,
            },
            { status: 422 },
          );
        }
        exportStatementMonth = raw;
      } else {
        return NextResponse.json(
          { error: "Invalid exportStatementMonth (expected YYYY-MM or null)." },
          { status: 400 },
        );
      }
    }

    await updateReceiptRecord(
      id,
      {
        paymentPath: body.paymentPath as PaymentPath | undefined,
        expenseType: body.expenseType as ExpenseType | undefined,
        transactionDate: body.transactionDate,
        merchant,
        amountMinor: body.amountMinor,
        currency: body.currency?.toUpperCase(),
        taxAmountMinor: body.taxAmountMinor,
        businessPurpose,
        expenseCategoryCode,
        exportStatementMonth,
        status: body.status as ReceiptStatus | undefined,
        sourceType,
        invoiceRegistrationNumber,
        counterpartyName,
        taxRate,
        qualifiedInvoiceStatus,
      },
      actor,
    );

    // ADR 0006 §D6: dedicated audit for the override (old → new month + actor),
    // separate from the generic receipt.updated entry updateReceiptRecord writes.
    if ("exportStatementMonth" in body) {
      await createAuditEntry(getReceiptsDb(), {
        actor,
        action: "receipt.export_statement_month_overridden",
        objectType: "receipt",
        objectId: id,
        oldValueJson: JSON.stringify({
          export_statement_month: receipt.export_statement_month ?? null,
        }),
        newValueJson: JSON.stringify({
          export_statement_month: exportStatementMonth,
        }),
      });
    }

    if (Array.isArray(body.attendees)) {
      const attendeeInputs: CreateAttendeeInput[] = body.attendees
        .filter((name) => typeof name === "string" && name.trim())
        .map((name) => ({ attendeeName: name.trim().slice(0, 120) }));
      await createAttendees(id, attendeeInputs, actor);
    }

    // Re-run compliance checks so the review UI reflects the new state.
    // Audit B4: previously swallowed silently — a stuck failure meant the
    // compliance panel kept showing stale checks with no signal. Now we
    // surface a warning so the review UI can toast/annotate; the receipt
    // fields themselves did save successfully.
    const warnings: string[] = [];
    try {
      const settings = await getComplianceSettings();
      await runComplianceChecksForReceipt(getReceiptsDb(), id, settings);
    } catch (checkError) {
      console.error("[api/receipts/[id]] compliance check failed", checkError);
      warnings.push(
        "Saved, but compliance checks could not be recomputed — the compliance panel may be stale. Refresh to retry.",
      );
    }

    return NextResponse.json({ ok: true, warnings }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof ExportFinalizedError) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("finalized reconciliation")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    console.error("[api/receipts/[id]] PATCH failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Save failed." },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { id } = await params;

    await softDeleteReceipt(id, actor);

    return NextResponse.json({ ok: true }, { status: 200 });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    if (error instanceof Error && error.message.includes("cannot be deleted")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (error instanceof Error && error.message.includes("not found")) {
      return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
    }
    console.error("[api/receipts/[id]] DELETE failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Delete failed." },
      { status: 500 },
    );
  }
}
