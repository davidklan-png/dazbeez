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
  hashCsvContent,
  buildArchiveKey,
  buildManifestKey,
  buildSummaryKey,
  buildProofsKey,
  buildManifestCsv,
  buildReadmeKey,
  buildExportReadme,
} from "@/lib/receipts/export";
import { archiveBundle, archiveManifest, getReceiptFile, computeSha256Hex } from "@/lib/receipts/storage";
import {
  assembleProofsZip,
  verifyProofFileSha256,
  deriveTransitionNoticeInput,
  type ProofZipEntry,
  type ProofPaymentPath,
} from "@/lib/receipts/proofs";
import { listFilesForObject } from "@/lib/receipts/files";
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
    const csvPure = buildMonthlyExportCsv(bundle.rows, bundle.attendeeMap);
    const csvShipped = bomPrefixedCrlf(csvPure);
    const sha256 = await hashCsvContent(csvShipped);

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

    // Upload CSV to archive bucket
    const encoder = new TextEncoder();
    await archiveBundle(
      archiveKey,
      encoder.encode(csvShipped).buffer as ArrayBuffer,
    );

    // ── Proofs ZIP (5th artifact) ─────────────────────────────────────────
    // One proof per shipped receipt, named No<NN>_<勘定科目>_<店舗>_¥<金額>,
    // where No matches the receipts CSV's first column (same bundle.rows order,
    // 1-based). Prefer the proof_copy derivative; fall back to the original if
    // absent. PDFs pass through; JPEG proofs are the already-recompressed
    // proof_copy generated by the Mac consumer (PR 1).
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
      const receiptFiles = await listFilesForObject("receipt", row.receiptId);
      const chosen =
        receiptFiles.find((f) => f.role === "proof_copy") ??
        receiptFiles.find((f) => f.role === "original");
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
      proofsEntries.push({
        no: i + 1,
        categoryJa: row.expenseCategoryJa ?? row.expenseCategoryCode ?? "",
        merchant: row.merchant ?? "",
        amountMinor: row.amountMinor ?? 0,
        currency: row.currency,
        ext: chosen.content_type === "application/pdf" ? "pdf" : "jpg",
        source: chosen.role === "proof_copy" ? "proof_copy" : "original",
        bytes: fileBytes,
        transactionDate: row.transactionDate,
        receiptId: row.receiptId,
        statementLineId: row.lineId,
        sha256: chosen.sha256_hash,
        paymentPath: (row.paymentPath === "DIGITAL"
          ? "DIGITAL"
          : row.paymentPath === "CASH"
            ? "CASH"
            : "AMEX") as ProofPaymentPath,
      });
    }

    // Transition notice (shared builder — also used by the finalize email, so
    // the notice text cannot drift between the ZIP and the notification).
    const proofsNoticeInput = deriveTransitionNoticeInput(
      month,
      bundle.rows,
      bundle.receipts,
      { rowCount: bundle.rows.length, receiptCount: proofsEntries.length },
      { exportRevision, supersedesExportId, correctionReason },
    );

    const proofsKey = buildProofsKey(month, exportId);
    const proofsZipBytes = assembleProofsZip(month, proofsEntries, proofsNoticeInput);
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
    const amexArtifact = await getAmexArtifactByMonth(month);
    const generatedAt = new Date().toISOString();

    // Generate and upload manifest
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
        exportRevision,
        supersedesExportId,
        correctionReason,
      },
    );
    const manifestBytes = encoder.encode(manifest);
    const manifestSha256 = await hashCsvContent(manifest);
    await archiveManifest(manifestKey, manifestBytes.buffer as ArrayBuffer);

    // Summary CSV (audit A5): per-category and per-PaymentPath totals for
    // a quick reconciliation check. Same BOM/CRLF treatment as the main
    // archive so the accountant can open it in Excel without mojibake.
    const summaryPure = buildExportSummaryCsv(bundle.rows, month, generatedAt);
    const summaryShipped = bomPrefixedCrlf(summaryPure);
    const summarySha256 = await hashCsvContent(summaryShipped);
    await getReceiptsArchiveBucket().put(
      summaryKey,
      encoder.encode(summaryShipped).buffer as ArrayBuffer,
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
      proofsSha256,
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
    let finalizeWarnings: string[] = [];
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
      finalizeWarnings = await computeEarlierOpenMonthWarnings(month);

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
        proofsSha256,
        archiveKey,
        manifestKey,
        summaryKey,
        readmeKey,
        proofsKey,
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
