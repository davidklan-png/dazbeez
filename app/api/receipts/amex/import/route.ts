import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import {
  parseAmexNetanswer,
  netanswerLinesToImportInputs,
  detectBusinessTripCandidates,
  statementMonthFitsPaymentDue,
} from "@/lib/receipts/validation";
import {
  importAmexLines,
  createAmexArtifact,
  countAmexLinesByArtifactId,
  countCrossMonthDuplicateLines,
  getAmexArtifactBySha256,
  getAmexArtifactByMonth,
  getFinalizedReconciliationForMonth,
  classifyExistingArtifact,
  markPreviousArtifactsReplaced,
  purgeFailedAmexArtifactsByHash,
  updateAmexArtifactStatus,
  createBusinessTripReports,
} from "@/lib/receipts/db";
import {
  generateAmexArtifactKey,
  uploadAmexArtifact,
  computeSha256Hex,
} from "@/lib/receipts/storage";
import { getReceiptsDb } from "@/lib/cloudflare-runtime";
import { createReceiptFile } from "@/lib/receipts/files";
import { createAuditEntry } from "@/lib/receipts/audit";
import { getComplianceSettings } from "@/lib/receipts/settings";

/*
 * AMEX CSV Import — Dedup Contract
 * ==================================
 * AMEX line identity is stable across re-imports. The dedup key is:
 *   (statement_month, amex_reference, cardholder_name)  — when amex_reference is present
 *   (statement_month, transaction_date, amount_minor, merchant, cardholder_name)  — fallback
 *
 * On re-upload for the same month, INSERT … ON CONFLICT DO UPDATE preserves
 * the row PK (id) and all reconciliation state (matched_receipt_id,
 * match_status, receipt_status, expense_category_code, business_trip_status,
 * category_status, receipt_missing_reason, business_trip_id) while refreshing
 * CSV-sourced fields (dates, merchant, amount, raw_json, etc.).
 *
 * Prior artifact records are marked import_status='replaced' after a
 * successful re-import.
 */

const MAX_CSV_BYTES = 5 * 1024 * 1024;

// ── Business trip candidate detection ───────────────────────────────────────
// Audit B3: trip-detection failure previously vanished silently. The
// import still succeeds (statement lines are already committed), but
// the operator needs to know detection didn't run so they can re-check
// manually or retry the import. Shared by the fresh-import and heal
// paths (TASK-038) so they can't drift.
async function runBusinessTripDetection(
  artifactId: string,
  actor: string,
  warnings: string[],
): Promise<number> {
  try {
    const db = getReceiptsDb();
    const inserted = await db
      .prepare(
        `SELECT id, cardholder_name, transaction_date, merchant, expense_category_code
         FROM amex_statement_lines
         WHERE statement_artifact_id = ?
         ORDER BY raw_csv_line_number ASC`,
      )
      .bind(artifactId)
      .all<{
        id: string;
        cardholder_name: string | null;
        transaction_date: string;
        merchant: string;
        expense_category_code: string | null;
      }>();

    const realLines = (inserted.results ?? []).map((r) => ({
      id: r.id,
      cardholderName: r.cardholder_name,
      transactionDate: r.transaction_date,
      merchant: r.merchant,
      expenseCategoryCode: r.expense_category_code,
    }));

    // ADR 0010 D3: homebase signals come from Settings → Compliance (was a
    // hardcoded Tokyo list). Categories aren't set at first import, so the
    // category-boost fires mainly on re-imports after the operator
    // categorizes lines — which is also when the dedupe (createBusinessTripReports)
    // matters most.
    const homebaseSignals = (await getComplianceSettings()).homebase_signals;
    const candidates = detectBusinessTripCandidates(realLines, homebaseSignals);
    if (candidates.length > 0) {
      await createBusinessTripReports(candidates, actor);
      return candidates.length;
    }
    return 0;
  } catch (tripErr) {
    console.error(
      "[amex/import] business trip detection failed (statement lines already committed)",
      tripErr,
    );
    warnings.push(
      "Statement lines imported, but business-trip candidate detection failed — re-check the month manually.",
    );
    return 0;
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const formData = await request.formData();
    const file = formData.get("file");
    const statementMonth = formData.get("statementMonth")?.toString();
    const replaceConfirmed = formData.get("replaceConfirmed") === "true";

    if (!(file instanceof File)) {
      return NextResponse.json({ error: "A CSV file is required." }, { status: 400 });
    }

    if (!statementMonth || !/^\d{4}-\d{2}$/.test(statementMonth)) {
      return NextResponse.json(
        { error: "statementMonth must be in YYYY-MM format." },
        { status: 400 },
      );
    }

    // Sanity-bound the statement month. The regex accepts 2099-12 / 1900-01
    // etc. which would land junk months in D1 and corrupt UIs that group by
    // month. Allow the current month plus one (Netアンサー sometimes posts the
    // upcoming statement a few days before the closing date) and 5 years back.
    {
      const now = new Date();
      const maxYearMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 2).padStart(2, "0")}`;
      const minYearMonth = `${now.getUTCFullYear() - 5}-01`;
      // Normalize 13 → next-year-01 for the max comparison.
      const maxNormalized = now.getUTCMonth() + 2 > 12
        ? `${now.getUTCFullYear() + 1}-01`
        : maxYearMonth;
      if (statementMonth < minYearMonth || statementMonth > maxNormalized) {
        return NextResponse.json(
          {
            error: `statementMonth ${statementMonth} is outside the accepted range (${minYearMonth} … ${maxNormalized}).`,
          },
          { status: 400 },
        );
      }
    }

    if (file.size > MAX_CSV_BYTES) {
      return NextResponse.json(
        { error: "CSV file too large (max 5 MB)." },
        { status: 413 },
      );
    }

    const finalized = await getFinalizedReconciliationForMonth(statementMonth);
    if (finalized) {
      return NextResponse.json(
        { error: `Reconciliation for ${statementMonth} is finalized; AMEX import is locked.` },
        { status: 409 },
      );
    }

    const buffer = await file.arrayBuffer();
    const sha256 = await computeSha256Hex(buffer);

    // ── Duplicate file detection ────────────────────────────────────────────
    const existingBySha = await getAmexArtifactBySha256(sha256);
    if (existingBySha) {
      const lineCount = await countAmexLinesByArtifactId(
        getReceiptsDb(),
        existingBySha.id,
      );
      const verdict = classifyExistingArtifact(existingBySha, lineCount);

      if (verdict === "incomplete") {
        // Zero imported lines: a half-completed import, not a duplicate —
        // returning duplicate:true here would mask it forever (the sha dedup
        // short-circuits before the import that would heal it). Fall through
        // to the normal flow; purgeFailedAmexArtifactsByHash (below) deletes
        // the broken row so the fresh artifact INSERT clears the sha256
        // UNIQUE constraint.
        console.warn(
          `[amex/import] artifact ${existingBySha.id} (${existingBySha.statement_month}) is ` +
            `${existingBySha.import_status} with ${existingBySha.transaction_count} transactions ` +
            `and ${lineCount} statement lines — treating as incomplete, re-importing`,
        );
      } else {
        const warnings: string[] = [];
        // TASK-038 F2: the file already lives under a DIFFERENT statement
        // month (the 2610 mis-slot shape). A bare duplicate:true reads as
        // "already imported here", which it is not — name both months.
        if (existingBySha.statement_month !== statementMonth) {
          warnings.push(
            `This file was already imported under statement month ${existingBySha.statement_month}, not ${statementMonth} — the requested month was NOT imported. If it belongs here, the earlier import needs correcting first.`,
          );
        }

        if (verdict === "duplicate") {
          return NextResponse.json(
            {
              ok: true,
              duplicate: true,
              artifactId: existingBySha.id,
              statementMonth: existingBySha.statement_month,
              message: "This AMEX statement file has already been uploaded.",
              inserted: 0,
              updated: 0,
              unchanged: 0,
              transactionCount: existingBySha.transaction_count ?? 0,
              statementTotalCents: existingBySha.statement_total_amount_cents,
              cardName: existingBySha.card_name,
              paymentDueDate: existingBySha.payment_due_date,
              warnings,
            },
            { status: 200 },
          );
        }

        // verdict === "heal": the import never finished — complete-but-
        // unflipped, or partial (chunks missing / an interrupted replace).
        // Complete it in place rather than answering duplicate:true.
        // Re-import is idempotent by the ON CONFLICT dedup contract above;
        // partial is heal-not-purge because existing lines carry
        // reconciliation state (see classifyExistingArtifact in db.ts).
        // The heal runs under the ARTIFACT's own month — never the
        // operator's requested month (which the F2 warning already flags
        // when they differ) — so lines can't land under a month the
        // artifact doesn't own. importAmexLines has no finalized-month
        // guard of its own and the route's earlier check ran against the
        // REQUESTED month, so re-check against the artifact's month here.
        if (await getFinalizedReconciliationForMonth(existingBySha.statement_month)) {
          return NextResponse.json(
            {
              ok: true,
              duplicate: true,
              artifactId: existingBySha.id,
              statementMonth: existingBySha.statement_month,
              message:
                "A prior upload of this file was found unfinished, but its statement month is finalized — the heal was refused and nothing was changed.",
              warnings,
            },
            { status: 200 },
          );
        }

        const heal = parseAmexNetanswer(buffer, existingBySha.statement_month);
        if (heal.validationErrors.length > 0) {
          return NextResponse.json(
            {
              ok: true,
              duplicate: true,
              artifactId: existingBySha.id,
              statementMonth: existingBySha.statement_month,
              message:
                "A prior upload of this file was found unfinished, but the file no longer parses cleanly — nothing was changed.",
              warnings: [
                ...warnings,
                `Prior import found unfinished (import_status '${existingBySha.import_status}'), but re-parsing failed: ${heal.validationErrors[0]}`,
              ],
            },
            { status: 200 },
          );
        }

        const healInputs = netanswerLinesToImportInputs(
          heal.lines,
          existingBySha.statement_month,
          existingBySha.id,
          sha256,
        );
        const { inserted, updated, unchanged } = await importAmexLines(
          healInputs,
          actor,
        );

        // Completes an interrupted replace (no-op when nothing to
        // supersede). Stays AFTER the import, same as the fresh path. But
        // never supersede a NEWER statement: if a later, healthy import
        // already owns this month, the artifact being healed is the OLD
        // file (two different files crashed in the same month) — deleting
        // the newer one's lines here would promote the older statement
        // without the replace-confirm the fresh path would have shown.
        const newestForMonth = await getAmexArtifactByMonth(
          existingBySha.statement_month,
        );
        if (newestForMonth?.id === existingBySha.id) {
          await markPreviousArtifactsReplaced(
            existingBySha.statement_month,
            existingBySha.id,
            actor,
          );
        } else {
          warnings.push(
            `Healed the unfinished import, but a newer statement artifact for ${existingBySha.statement_month} was left untouched — if this file should own the month, replace the statement explicitly.`,
          );
        }

        const businessTripCandidatesCount = await runBusinessTripDetection(
          existingBySha.id,
          actor,
          warnings,
        );
        await updateAmexArtifactStatus(existingBySha.id, "parsed");

        return NextResponse.json(
          {
            ok: true,
            duplicate: true,
            artifactId: existingBySha.id,
            statementMonth: existingBySha.statement_month,
            message: `A prior upload of this file was found unfinished (import_status '${existingBySha.import_status}') and has been completed in place.`,
            inserted,
            updated,
            unchanged,
            transactionCount: heal.lines.length,
            statementTotalCents: existingBySha.statement_total_amount_cents,
            cardName: existingBySha.card_name,
            paymentDueDate: existingBySha.payment_due_date,
            businessTripCandidates: businessTripCandidatesCount,
            warnings,
          },
          { status: 200 },
        );
      }
    }

    // ── Replacement check ───────────────────────────────────────────────────
    const previousArtifact = await getAmexArtifactByMonth(statementMonth);
    if (previousArtifact && !replaceConfirmed) {
      return NextResponse.json(
        {
          ok: false,
          needsReplaceConfirm: true,
          statementMonth,
          existingArtifactId: previousArtifact.id,
          message: `A statement for ${statementMonth} already exists. Replace it?`,
        },
        { status: 409 },
      );
    }

    // ── Parse CSV ───────────────────────────────────────────────────────────
    const {
      metadata,
      lines,
      skippedLines,
      validationErrors,
      parsedTotalCents,
      rowCount,
    } = parseAmexNetanswer(buffer, statementMonth);

    // TASK-038 F3: the CSV's payment due month should fall in the selected
    // statement month (ground truth: 8/8 live artifacts agree). A misfit is
    // the wrong-month signal — the 2026-10-02 2610→2026-09 mis-slot would
    // have been caught here before the replace-confirm prompt. Non-blocking.
    const warnings: string[] = [];
    if (
      statementMonthFitsPaymentDue(statementMonth, metadata.paymentDueDate) ===
      false
    ) {
      warnings.push(
        `The CSV's payment due date (${metadata.paymentDueDate}) does not fall in the selected statement month ${statementMonth} — check the month before replacing an existing statement.`,
      );
    }

    // The artifact must not claim 'parsed' until lines are committed — if the
    // import step dies after this INSERT, 'parsed' over zero lines is the
    // green-badge lie TASK-035 fixed. 'uploaded' is the honest transient
    // state; the post-import updateAmexArtifactStatus(..., "parsed") is what
    // earns the badge. The 422 path keeps 'failed'.
    const importStatus = validationErrors.length > 0 ? "failed" : "uploaded";

    // ── Upload artifact to R2 ───────────────────────────────────────────────
    const artifactId = crypto.randomUUID();
    const r2Key = generateAmexArtifactKey(statementMonth, artifactId, file.name);
    await uploadAmexArtifact(r2Key, buffer);

    // ── Purge stale failed/replaced rows for this hash ─────────────────────
    // The UNIQUE constraint on sha256_hash
    // (db/receipts/0005_amex_extended.sql:31) is a real backstop against
    // double-importing a genuinely successful statement, but it also blocks
    // re-uploading the identical file after a prior failed/replaced artifact
    // has been purged from the application-layer dedup check. Clean those
    // rows out (plus their receipt_files manifest entries + R2 objects) right
    // before the fresh INSERT. No-op DELETE when nothing matches.
    await purgeFailedAmexArtifactsByHash(sha256, actor);

    // ── Save artifact record ────────────────────────────────────────────────
    const savedArtifactId = await createAmexArtifact({
      statementMonth,
      paymentDueDate: metadata.paymentDueDate,
      cardName: metadata.cardName,
      originalFilename: file.name,
      r2Key,
      encoding: metadata.encoding,
      sha256Hash: sha256,
      fileSizeBytes: file.size,
      uploadedBy: actor,
      statementTotalAmountCents: metadata.statementTotalCents,
      parsedTotalAmountCents: parsedTotalCents,
      transactionCount: lines.length,
      rowCount,
      validationErrors,
      importStatus,
    });

    // File manifest row for the AMEX CSV — same preservation contract as a
    // receipt original. Failure here is non-fatal: the artifact row already
    // carries the hash and key.
    try {
      const db = getReceiptsDb();
      await createReceiptFile(db, {
        objectType: "amex_statement_artifact",
        objectId: savedArtifactId,
        role: "statement",
        r2Bucket: "receipts",
        r2Key,
        originalFilename: file.name,
        contentType: "text/csv",
        fileSizeBytes: file.size,
        sha256Hash: sha256,
        uploadedBy: actor,
        isOriginal: true,
      });
      await createAuditEntry(db, {
        actor,
        action: "amex_statement.uploaded",
        objectType: "amex_statement_artifact",
        objectId: savedArtifactId,
        newValueJson: JSON.stringify({ statementMonth, sha256, fileSize: file.size }),
      });
    } catch (manifestErr) {
      console.error("[amex/import] file manifest write failed", manifestErr);
    }

    // ── Return validation errors without importing lines ────────────────────
    if (validationErrors.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          artifactId: savedArtifactId,
          statementMonth,
          importStatus: "failed",
          validationErrors,
          skippedLines,
          transactionCount: 0,
          inserted: 0,
          updated: 0,
          unchanged: 0,
        },
        { status: 422 },
      );
    }

    // ── Import line items ───────────────────────────────────────────────────
    const importInputs = netanswerLinesToImportInputs(
      lines,
      statementMonth,
      savedArtifactId,
      sha256,
    );

    // TASK-037: a charge never appears on two AMEX statement months — incoming
    // tuples already imported under a DIFFERENT month mean this file was
    // probably slotted into the wrong month (the 2610 double import). Advisory
    // only; runs against other months, so it is unaffected by the import below.
    const crossMonth = await countCrossMonthDuplicateLines(importInputs, statementMonth);
    if (crossMonth.count > 0) {
      warnings.push(
        `${crossMonth.count} incoming charge(s) match lines already imported under ` +
          `statement month(s) ${crossMonth.months.join(", ")} — verify this file ` +
          `belongs to ${statementMonth}.`,
      );
    }

    const { inserted, updated, unchanged } = await importAmexLines(importInputs, actor);

    await updateAmexArtifactStatus(savedArtifactId, "parsed");

    // ── Mark previous artifact replaced (after successful import) ──────────
    // Also deletes the replaced artifact's superseded lines (TASK-037).
    if (previousArtifact) {
      await markPreviousArtifactsReplaced(statementMonth, savedArtifactId, actor);
    }

    // ── Business trip candidate detection ───────────────────────────────────
    const businessTripCandidatesCount = await runBusinessTripDetection(
      savedArtifactId,
      actor,
      warnings,
    );

    // ADR 0008: AMEX import no longer touches CASH/DIGITAL membership. Under the
    // calendar-month rule a cash receipt's export month is fixed by its
    // transaction_date (assigned at capture / date-set), so importing a statement
    // changes nothing about cash membership — the ADR 0006 import sweep and drift
    // detection are retired. (Statement lines and reconciliation are unaffected.)

    return NextResponse.json(
      {
        ok: true,
        artifactId: savedArtifactId,
        statementMonth,
        importStatus: "parsed",
        cardName: metadata.cardName,
        paymentDueDate: metadata.paymentDueDate,
        statementTotalCents: metadata.statementTotalCents,
        parsedTotalCents,
        transactionCount: lines.length,
        inserted,
        updated,
        unchanged,
        skippedLines,
        replaced: previousArtifact !== null,
        businessTripCandidates: businessTripCandidatesCount,
        warnings,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/amex/import] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Import failed." },
      { status: 500 },
    );
  }
}
