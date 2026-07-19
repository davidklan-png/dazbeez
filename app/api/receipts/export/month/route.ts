import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import {
  createExport,
  finalizeExport,
  getExport,
  getFinalizedReconciliationForMonth,
  recordExportBundle,
  replaceExportItems,
} from "@/lib/receipts/db";
import {
  bomPrefixedCrlf,
  buildMonthlyExportCsv,
  buildExportSummaryCsv,
  buildAttendeesExportCsv,
  resolveRowAttendees,
  hashCsvContent,
  buildArchiveKey,
  buildManifestKey,
  buildSummaryKey,
  buildAttendeesKey,
  buildProofsKey,
  buildManifestCsv,
  buildReadmeKey,
  buildExportReadme,
  buildAmexReconciliationKey,
  buildCashReconciliationKey,
  buildDigitalReconciliationKey,
} from "@/lib/receipts/export";
import {
  buildEvidenceAssignments,
  buildAmexReconciliationCsv,
  buildPaymentPathReconciliationCsv,
  attendeeIdCells,
  missingReceiptCell,
  type EvidenceUnit,
  type AmexLineAppend,
} from "@/lib/receipts/reconciliation-files";
import { decodeAmexBuffer } from "@/lib/receipts/validation";
import { archiveBundle, archiveManifest, getReceiptFile, computeSha256Hex } from "@/lib/receipts/storage";
import {
  assembleProofsZip,
  verifyProofFileSha256,
  deriveTransitionNoticeInput,
  type ProofZipEntry,
  type ProofPaymentPath,
} from "@/lib/receipts/proofs";
import { listFilesForObject } from "@/lib/receipts/files";
import { requiresAttendees } from "@/lib/receipts/categories";
import { composeFinalizeNoticeData, notifyAccountantOfFinalize } from "@/lib/receipts/notify";
import {
  buildExportBundle,
  validateMonthReadyForExport,
  computeEarlierOpenMonthWarnings,
} from "@/lib/receipts/month-closing";
import { getReceiptsDb, getReceiptsArchiveBucket } from "@/lib/cloudflare-runtime";
import { getAmexArtifactByMonth } from "@/lib/receipts/db";
import { retentionMetadata } from "@/lib/receipts/retention";
import type { AmexReconciliation, ReceiptFile } from "@/lib/receipts/types";

export async function POST(request: Request) {
  try {
    const actor = await requireReceiptsActor(request.headers);

    const body = (await request.json()) as { month?: string; finalize?: boolean };
    const month = body.month?.trim();

    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json(
        { error: "month must be in YYYY-MM format." },
        { status: 400 },
      );
    }

    // Build the bundle ONCE — single shared row-assembly authority
    // (lib/receipts/month-closing.ts buildExportBundle). The route and the
    // validator both consume the same rows so a draft the operator previews
    // is bit-identical to the bundle that ships on finalize. Audit A4.
    const bundle = await buildExportBundle(month);

    if (bundle.rows.length === 0) {
      return NextResponse.json(
        { error: `No exportable activity found for ${month}.` },
        { status: 400 },
      );
    }

    // Export blocking validation — single authority is validateMonthReadyForExport
    // (lib/receipts/month-closing.ts). Do NOT inline a second finalize gate here;
    // any divergence between this route and /api/receipts/export/[month] reopens
    // the audit-9 drift where one path could finalize a month the other blocks.
    //
    // Fetch the reconciliation ONCE so we can both pass it into the validator
    // (avoiding its internal round-trip) and use the same row for the manifest
    // pointer below. Pre-1102-storm profiling showed finalize did two identical
    // SELECTs against amex_reconciliations; this collapses them to one.
    let reconciliation: AmexReconciliation | null = null;
    if (body.finalize) {
      reconciliation = await getFinalizedReconciliationForMonth(month);
      const blockers = await validateMonthReadyForExport(
        month,
        bundle,
        reconciliation,
      );
      if (blockers.length > 0) {
        return NextResponse.json(
          { error: "Export blocked — resolve these issues first.", blockers },
          { status: 422 },
        );
      }
    }

    // Generate CSV. The pure form is what tests assert against; the route
    // applies UTF-8 BOM + CRLF (audit A5) before hashing and upload so the
    // SHA-256 in the manifest matches the bytes in R2 exactly. The
    // accountant opens this CSV in Excel on Windows — without BOM/CRLF the
    // Japanese merchant names render as mojibake.
    const csvPure = buildMonthlyExportCsv(
      bundle.rows,
      bundle.attendeeMap,
      bundle.attendeeDirectory,
      bundle.amexAttendees,
    );
    const csvShipped = bomPrefixedCrlf(csvPure);
    const sha256 = await hashCsvContent(csvShipped);

    // generatedAt is baked into the summary, manifest, and README — compute it
    // once here so every artifact shares the same timestamp.
    const generatedAt = new Date().toISOString();
    // Summary (集計) is built up front: its shipped bytes (BOM+CRLF) are also
    // embedded in the proofs ZIP as 集計.csv — same bytes, so the accountant who
    // only opens the ZIP still gets the breakdown.
    const summaryPure = buildExportSummaryCsv(bundle.rows, month, generatedAt);
    const summaryShipped = bomPrefixedCrlf(summaryPure);
    const summarySha256 = await hashCsvContent(summaryShipped);

    // 参加者一覧 (attendees) — maps the receipts CSV's AttendeeIds column to
    // name/company/title. Built from the union of attendee names referenced
    // across the bundle's rows (receipt attendees + the line-attendee fallback
    // in resolveRowAttendees). Same BOM+CRLF bytes are embedded in the proofs
    // ZIP as 参加者一覧.csv next to 集計.csv.
    const referencedAttendeeNames = [
      ...new Set(
        bundle.rows.flatMap((r) =>
          resolveRowAttendees(r, bundle.attendeeMap, bundle.amexAttendees),
        ),
      ),
    ];
    const attendeesPure = buildAttendeesExportCsv(
      referencedAttendeeNames,
      bundle.attendeeDirectory,
    );
    const attendeesShipped = bomPrefixedCrlf(attendeesPure);
    const attendeesSha256 = await hashCsvContent(attendeesShipped);

    // Create or retrieve export record, then reload to pick up revision
    // metadata (export_revision / supersedes_export_id / correction_reason).
    // createExport() returns just the id; the row's revision fields are needed
    // to label the manifest and README correctly when reusing a draft created
    // by createExportRevision() — otherwise revision N ships with a README
    // claiming "Revision: 1 (initial)".
    const exportId = await createExport(month, actor);
    const exportRecord = await getExport(month);
    const exportRevision = exportRecord?.export_revision ?? 1;
    const supersedesExportId = exportRecord?.supersedes_export_id ?? null;
    const correctionReason = exportRecord?.correction_reason ?? null;

    // Record exactly which receipts and AMEX lines ship in this bundle. The
    // one-draft-per-month invariant means an existing draft's items get
    // replaced on rebuild — the (export_id, item_type, item_id) UNIQUE on
    // receipt_export_items makes this idempotent.
    await replaceExportItems(exportId, bundle.items);

    const archiveKey = buildArchiveKey(month, exportId);
    const manifestKey = buildManifestKey(month, exportId);
    const summaryKey = buildSummaryKey(month, exportId);
    const attendeesKey = buildAttendeesKey(month, exportId);

    // Upload CSV to archive bucket
    const encoder = new TextEncoder();
    await archiveBundle(
      archiveKey,
      encoder.encode(csvShipped).buffer as ArrayBuffer,
    );

    // ── Evidence numbering (review #2) ────────────────────────────────────
    // Single numbering authority: one 科目＆No per receipt, assigned per
    // category in statement order (raw_csv_line_number) for AMEX-matched
    // receipts, then CASH rows, then DIGITAL rows in bundle order. The
    // assignments feed the AMEX/CASH/DIGITAL reconciliation CSVs AND the
    // proofs ZIP entry names, so the join key cannot drift.
    //
    // Pass A resolves each receipt's proof file meta (ext is part of the
    // evidence filename); bytes are fetched in the proofs loop below.
    const receiptById = new Map(bundle.receipts.map((r) => [r.id, r]));
    const chosenFileByReceiptId = new Map<string, ReceiptFile>();
    {
      const seen = new Set<string>();
      for (const row of bundle.rows) {
        if (!row.receiptId || seen.has(row.receiptId)) continue;
        seen.add(row.receiptId);
        const receiptFiles = await listFilesForObject("receipt", row.receiptId);
        const chosen =
          receiptFiles.find((f) => f.role === "proof_copy") ??
          receiptFiles.find((f) => f.role === "original");
        if (chosen) chosenFileByReceiptId.set(row.receiptId, chosen);
      }
    }

    const amexRowsInStatementOrder = bundle.rows
      .filter((r) => r.rowType === "amex_line")
      .slice()
      .sort(
        (a, b) =>
          (a.rawCsvLineNumber ?? Number.MAX_SAFE_INTEGER) -
          (b.rawCsvLineNumber ?? Number.MAX_SAFE_INTEGER),
      );
    const receiptRowsByPath = (path: "CASH" | "DIGITAL") =>
      bundle.rows.filter((r) => r.rowType === "receipt" && r.paymentPath === path);

    const evidenceUnits: EvidenceUnit[] = [];
    for (const row of [
      ...amexRowsInStatementOrder,
      ...receiptRowsByPath("CASH"),
      ...receiptRowsByPath("DIGITAL"),
    ]) {
      if (!row.receiptId) continue;
      const chosen = chosenFileByReceiptId.get(row.receiptId);
      if (!chosen) continue; // gate 7 blocks zero-file receipts; skip defensively
      const receipt = receiptById.get(row.receiptId);
      evidenceUnits.push({
        receiptId: row.receiptId,
        categoryJa: row.expenseCategoryJa ?? row.expenseCategoryCode ?? "",
        merchant: row.merchant ?? receipt?.merchant ?? "",
        // Receipt total, not the line amount — a receipt paying two statement
        // lines is named by its full amount (manual-close convention).
        amountMinor: receipt?.amount_minor ?? row.amountMinor ?? 0,
        currency: receipt?.currency ?? row.currency,
        ext: chosen.content_type === "application/pdf" ? "pdf" : "jpg",
      });
    }
    const evidenceAssignments = buildEvidenceAssignments(month, evidenceUnits);

    // ── Proofs ZIP (5th artifact) ─────────────────────────────────────────
    // One proof per shipped receipt, named by its 科目＆No evidence filename
    // (`会議費Jun2026③小田原みなと食堂¥6,490.jpg`) — the same key shown in the
    // reconciliation CSVs and 目次.csv. Prefer the proof_copy derivative; fall
    // back to the original if absent. PDFs pass through; JPEG proofs are the
    // already-recompressed proof_copy generated by the Mac consumer (PR 1).
    //
    // Layer-2 R2 check (lives here, NOT in the gate): a receipt whose
    // receipt_files row exists but whose R2 object is gone fails the rebuild
    // loudly — re-run the proof backfill rather than seal a bundle missing a
    // proof. (Gate 7 handles the no-row-at-all case; this handles gone-from-R2.)
    const proofsEntries: ProofZipEntry[] = [];
    const seenProofReceiptIds = new Set<string>();
    for (let i = 0; i < bundle.rows.length; i += 1) {
      const row = bundle.rows[i];
      if (!row.receiptId || seenProofReceiptIds.has(row.receiptId)) continue;
      seenProofReceiptIds.add(row.receiptId);
      const chosen = chosenFileByReceiptId.get(row.receiptId);
      if (!chosen) continue; // gate 7 blocks zero-file receipts; skip defensively
      const fetched = await getReceiptFile(chosen.r2_key);
      if (!fetched) {
        throw new Error(
          `Receipt ${row.receiptId}: proof file "${chosen.r2_key}" is missing from storage — cannot build the proofs bundle. Re-run backfill_proof_copies.py or re-ingest.`,
        );
      }
      const fileBytes = new Uint8Array(await new Response(fetched.body).arrayBuffer());
      // Layer-2 integrity (review fix for #102): the fetched bytes must hash to
      // the value recorded on the receipt_files row at capture. Zero extra I/O
      // (bytes already in memory); refuses to seal a bundle whose proof object
      // was corrupted or overwritten since capture. Same doctrine as the
      // missing-object check above.
      await verifyProofFileSha256(
        fileBytes,
        chosen.sha256_hash,
        `Receipt ${row.receiptId}: proof file "${chosen.r2_key}"`,
      );
      // 出席者 (目次 only): meeting/entertainment categories list attendees,
      // from the same attendeeMap the receipts CSV uses ("; "-joined). Blank
      // for other categories. No new gate — emit what the bundle provides.
      const attendees = requiresAttendees(row.expenseCategoryCode)
        ? (bundle.attendeeMap.get(row.receiptId) ?? row.attendees ?? []).join("; ")
        : "";
      const assignment = evidenceAssignments.get(row.receiptId);
      proofsEntries.push({
        no: i + 1,
        categoryJa: row.expenseCategoryJa ?? row.expenseCategoryCode ?? "",
        merchant: row.merchant ?? "",
        amountMinor: row.amountMinor ?? 0,
        currency: row.currency,
        ext: chosen.content_type === "application/pdf" ? "pdf" : "jpg",
        bytes: fileBytes,
        transactionDate: row.transactionDate,
        attendees,
        paymentPath: (row.paymentPath === "DIGITAL"
          ? "DIGITAL"
          : row.paymentPath === "CASH"
            ? "CASH"
            : "AMEX") as ProofPaymentPath,
        filename: assignment?.filename,
      });
    }

    // ── Reconciliation CSVs (review #2) ───────────────────────────────────
    // AMEX: the ORIGINAL statement CSV (sealed artifact, SHA in manifest),
    // decoded and passed through line-for-line with 科目＆No./会議-出席者ID/
    // 人数/領収書ファイル名 appended on charge rows. CASH/DIGITAL: receipt rows
    // in the existing receipts-CSV format + the evidence columns, one file per
    // payment path, only emitted when the path has rows.
    const reconciliationWarnings: string[] = [];
    const amexArtifact = await getAmexArtifactByMonth(month);

    let amexReconShipped: string | null = null;
    if (amexArtifact) {
      const statementObject = await getReceiptFile(amexArtifact.r2_key);
      if (!statementObject) {
        // The statement artifact row exists but the R2 object is gone — same
        // doctrine as missing proofs: fail the rebuild loudly rather than ship
        // a bundle whose primary document cannot be built.
        throw new Error(
          `AMEX statement artifact "${amexArtifact.r2_key}" is missing from storage — cannot build the AMEX reconciliation file. Re-upload the statement CSV.`,
        );
      }
      const statementBuffer = await new Response(statementObject.body).arrayBuffer();
      const { text: statementText } = decodeAmexBuffer(statementBuffer);

      const appends = new Map<number, AmexLineAppend>();
      for (const row of amexRowsInStatementOrder) {
        if (row.rawCsvLineNumber === null || row.rawCsvLineNumber === undefined) {
          reconciliationWarnings.push(
            `AMEX line ${row.lineId ?? "?"} (${row.merchant ?? "?"}) has no raw_csv_line_number — re-import the statement CSV to include it in the AMEX reconciliation file.`,
          );
          continue;
        }
        const assignment = row.receiptId
          ? evidenceAssignments.get(row.receiptId)
          : undefined;
        const attendees = resolveRowAttendees(
          row,
          bundle.attendeeMap,
          bundle.amexAttendees,
        );
        const { ids, count } = attendeeIdCells(attendees, bundle.attendeeDirectory);
        appends.set(row.rawCsvLineNumber, {
          kamokuNo:
            assignment?.label ??
            row.expenseCategoryJa ??
            row.expenseCategoryCode ??
            "",
          attendeeIds: ids,
          attendeeCount: count,
          receiptFileCell:
            assignment?.filename ?? missingReceiptCell(row.missingReceiptReason),
        });
      }
      amexReconShipped = bomPrefixedCrlf(
        buildAmexReconciliationCsv(statementText, appends),
      );
    }
    const amexReconKey = buildAmexReconciliationKey(month, exportId);
    const amexReconSha256 = amexReconShipped
      ? await hashCsvContent(amexReconShipped)
      : null;
    if (amexReconShipped) {
      await getReceiptsArchiveBucket().put(
        amexReconKey,
        encoder.encode(amexReconShipped).buffer as ArrayBuffer,
        {
          httpMetadata: { contentType: "text/csv; charset=utf-8" },
          customMetadata: retentionMetadata(),
        },
      );
    }

    const buildPathFile = (path: "CASH" | "DIGITAL") => {
      const rows = receiptRowsByPath(path);
      if (rows.length === 0) return null;
      return bomPrefixedCrlf(
        buildPaymentPathReconciliationCsv(
          rows,
          bundle.attendeeMap,
          bundle.attendeeDirectory,
          bundle.amexAttendees,
          evidenceAssignments,
        ),
      );
    };
    const cashReconShipped = buildPathFile("CASH");
    const digitalReconShipped = buildPathFile("DIGITAL");
    const cashReconKey = buildCashReconciliationKey(month, exportId);
    const digitalReconKey = buildDigitalReconciliationKey(month, exportId);
    const cashReconSha256 = cashReconShipped
      ? await hashCsvContent(cashReconShipped)
      : null;
    const digitalReconSha256 = digitalReconShipped
      ? await hashCsvContent(digitalReconShipped)
      : null;
    for (const [key, shipped] of [
      [cashReconKey, cashReconShipped],
      [digitalReconKey, digitalReconShipped],
    ] as const) {
      if (!shipped) continue;
      await getReceiptsArchiveBucket().put(
        key,
        encoder.encode(shipped).buffer as ArrayBuffer,
        {
          httpMetadata: { contentType: "text/csv; charset=utf-8" },
          customMetadata: retentionMetadata(),
        },
      );
    }

    // ── Proofs ZIP assembly ───────────────────────────────────────────────
    // Assembled AFTER the reconciliation CSVs so their shipped bytes can be
    // embedded at ZIP root (AMEX{month}_Reconciliation.csv etc.) — the ZIP
    // alone is the complete accountant package. Transition notice via the
    // shared builder (also used by the finalize email, so the notice text
    // cannot drift between the ZIP and the notification).
    const proofsNoticeInput = deriveTransitionNoticeInput(
      month,
      bundle.rows,
      bundle.receipts,
      { rowCount: bundle.rows.length, receiptCount: proofsEntries.length },
      { exportRevision, supersedesExportId, correctionReason },
    );

    const proofsKey = buildProofsKey(month, exportId);
    const proofsZipBytes = assembleProofsZip(
      month,
      proofsEntries,
      proofsNoticeInput,
      summaryShipped,
      attendeesShipped,
      {
        amex: amexReconShipped,
        cash: cashReconShipped,
        digital: digitalReconShipped,
      },
    );
    const proofsSha256 = await computeSha256Hex(proofsZipBytes);
    await getReceiptsArchiveBucket().put(proofsKey, proofsZipBytes, {
      httpMetadata: { contentType: "application/zip" },
      customMetadata: retentionMetadata(),
    });

    // Gather all file-manifest entries for receipts included in this export
    // plus the AMEX statement artifact. This builds the per-file SHA-256
    // section of the manifest so an accountant can verify every artifact.
    const db = getReceiptsDb();
    const includedReceiptIds = bundle.receipts.map((r) => r.id);
    const fileRows: ReceiptFile[] = [];
    if (includedReceiptIds.length > 0) {
      const CHUNK_SIZE = 90;
      for (let i = 0; i < includedReceiptIds.length; i += CHUNK_SIZE) {
        const chunk = includedReceiptIds.slice(i, i + CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(",");
        const result = await db
          .prepare(
            `SELECT * FROM receipt_files
             WHERE object_type = 'receipt' AND object_id IN (${placeholders})`,
          )
          .bind(...chunk)
          .all<ReceiptFile>();
        fileRows.push(...(result.results ?? []));
      }
    }
    // Generate and upload manifest (amexArtifact fetched above for the
    // reconciliation passthrough — same row feeds the manifest pointer here)
    const manifest = buildManifestCsv(
      exportId,
      month,
      archiveKey,
      sha256,
      bundle.rows.length,
      generatedAt,
      reconciliation
        ? {
            id: reconciliation.id,
            manifestR2Key: reconciliation.manifest_r2_key ?? "",
            manifestSha256: reconciliation.manifest_sha256 ?? "",
          }
        : null,
      {
        files: fileRows,
        amexArtifact: amexArtifact
          ? {
              r2Key: amexArtifact.r2_key,
              sha256Hash: amexArtifact.sha256_hash,
              originalFilename: amexArtifact.original_filename ?? "",
            }
          : null,
        proofsArtifact: {
          r2Key: proofsKey,
          sha256Hash: proofsSha256,
          originalFilename: `${exportId}-proofs.zip`,
        },
        amexReconciliation: amexReconSha256
          ? { r2Key: amexReconKey, sha256Hash: amexReconSha256 }
          : null,
        cashReconciliation: cashReconSha256
          ? { r2Key: cashReconKey, sha256Hash: cashReconSha256 }
          : null,
        digitalReconciliation: digitalReconSha256
          ? { r2Key: digitalReconKey, sha256Hash: digitalReconSha256 }
          : null,
        exportRevision,
        supersedesExportId,
        correctionReason,
      },
    );
    const manifestBytes = encoder.encode(manifest);
    const manifestSha256 = await hashCsvContent(manifest);
    await archiveManifest(manifestKey, manifestBytes.buffer as ArrayBuffer);

    // Summary CSV (集計) — same bytes embedded in the proofs ZIP. Uploaded as
    // the standalone summary artifact; BOM+CRLF for Excel on Windows.
    await getReceiptsArchiveBucket().put(
      summaryKey,
      encoder.encode(summaryShipped).buffer as ArrayBuffer,
      {
        httpMetadata: { contentType: "text/csv; charset=utf-8" },
        customMetadata: retentionMetadata(),
      },
    );

    // Attendees CSV (参加者一覧) — same bytes embedded in the proofs ZIP. Derived
    // key like summary (no column on receipt_exports); csv content type +
    // retention metadata, mirroring the summary block.
    await getReceiptsArchiveBucket().put(
      attendeesKey,
      encoder.encode(attendeesShipped).buffer as ArrayBuffer,
      {
        httpMetadata: { contentType: "text/csv; charset=utf-8" },
        customMetadata: retentionMetadata(),
      },
    );

    // README accompanies every bundle. Disclaimer text + revision context.
    const readme = buildExportReadme({
      exportId,
      month,
      rowCount: bundle.rows.length,
      generatedAt,
      exportRevision,
      supersedesExportId,
      correctionReason,
      archiveSha256: sha256,
      manifestSha256,
      summarySha256,
      attendeesSha256,
      proofsSha256,
      amexReconciliationSha256: amexReconSha256,
      cashReconciliationSha256: cashReconSha256,
      digitalReconciliationSha256: digitalReconSha256,
    });
    const readmeKey = buildReadmeKey(month, exportId);
    await getReceiptsArchiveBucket().put(
      readmeKey,
      encoder.encode(readme).buffer as ArrayBuffer,
      {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: retentionMetadata(),
      },
    );

    // Persist the staged bundle, then finalize if requested. On the rebuild
    // path (finalize=false) recordExportBundle is the only row write — it
    // stores the R2 keys + SHAs + bundle_built_at so the finalize-only route
    // (/api/receipts/export/[month]) finds them present and "Last draft built"
    // advances on every rebuild. On the finalize path finalizeExport calls
    // recordExportBundle internally, so we do NOT call it here again (that
    // would double-write the bundle columns).
    const finalizeWarnings: string[] = [...reconciliationWarnings];
    if (body.finalize) {
      await finalizeExport(
        exportId,
        archiveKey,
        manifestKey,
        sha256,
        actor,
        manifestSha256,
        proofsKey,
        proofsSha256,
      );
      // A7: non-blocking warning when an earlier statement month is still
      // open. Surfaced in the finalize response so the operator's toast on
      // "Finalize succeeded" can also say "but March is still open."
      finalizeWarnings.push(...(await computeEarlierOpenMonthWarnings(month)));

      // Notification email (PR 3). Failure never fails finalize — it becomes a
      // warning in the response + a notification_failed audit entry.
      if (exportRecord) {
        const notifyData = composeFinalizeNoticeData(month, bundle, exportRecord);
        const notifyResult = await notifyAccountantOfFinalize(notifyData);
        if (notifyResult.ok) {
          await createAuditEntry(getReceiptsDb(), {
            actor,
            action: "export.notification_sent",
            objectType: "export",
            objectId: exportId,
            newValueJson: stringifyJson({ month }),
          });
        } else {
          finalizeWarnings.push(`Finalize notification email not sent: ${notifyResult.error}`);
          await createAuditEntry(getReceiptsDb(), {
            actor,
            action: "export.notification_failed",
            objectType: "export",
            objectId: exportId,
            newValueJson: stringifyJson({ month, error: notifyResult.error }),
          });
        }
      }
    } else {
      await recordExportBundle(
        exportId,
        archiveKey,
        manifestKey,
        sha256,
        manifestSha256,
        proofsKey,
        proofsSha256,
      );
      // Audit the rebuild (finalize:false) — "export.generated" was defined
      // for this. The finalize:true path is audited by finalizeExport
      // ("export.finalized"); recordExportBundle runs inside it there, so we
      // only audit the standalone rebuild here.
      await createAuditEntry(getReceiptsDb(), {
        actor,
        action: "export.generated",
        objectType: "export",
        objectId: exportId,
        newValueJson: stringifyJson({
          archiveKey,
          sha256,
          manifestSha256,
          rowCount: bundle.rows.length,
        }),
      });
    }

    return NextResponse.json(
      {
        exportId,
        month,
        rowCount: bundle.rows.length,
        sha256,
        manifestSha256,
        summarySha256,
        attendeesSha256,
        proofsSha256,
        archiveKey,
        manifestKey,
        summaryKey,
        attendeesKey,
        readmeKey,
        proofsKey,
        amexReconciliationKey: amexReconSha256 ? amexReconKey : null,
        amexReconciliationSha256: amexReconSha256,
        cashReconciliationKey: cashReconSha256 ? cashReconKey : null,
        cashReconciliationSha256: cashReconSha256,
        digitalReconciliationKey: digitalReconSha256 ? digitalReconKey : null,
        digitalReconciliationSha256: digitalReconSha256,
        finalized: body.finalize ?? false,
        warnings: finalizeWarnings,
      },
      { status: 200 },
    );
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/export/month] failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Export failed." },
      { status: 500 },
    );
  }
}
