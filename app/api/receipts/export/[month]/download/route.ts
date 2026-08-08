import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import { getExport, getLatestFinalizedExport } from "@/lib/receipts/db";
import {
  EXPORT_DOWNLOAD_FILES,
  contentDispositionAttachment,
  isExportDownloadFile,
  resolveBundleDownload,
} from "@/lib/receipts/export";
import type { ReceiptExport } from "@/lib/receipts/types";
import {
  getReceiptsArchiveBucket,
  getReceiptsDb,
} from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ month: string }> };

/**
 * GET /api/receipts/export/[month]/download?file=receipts|manifest|summary|readme|proofs[&draft=true]
 *
 * Streams one of the bundle artifacts from the archive bucket, byte-for-byte —
 * no transform (the SHA-256 in the manifest must match the bytes served).
 *
 * - Default (no `draft`): the latest FINALIZED revision's sealed artifact
 *   (getLatestFinalizedExport — so an open revision draft never makes the
 *   sealed package undownloadable). 404 if no finalized revision exists.
 * - `?draft=true`: the open draft revision's STAGED artifact, for the operator's
 *   verify-before-finalize workflow. 404 if there's no draft, the draft hasn't
 *   been rebuilt, or the file isn't staged. Filename is prefixed `DRAFT-` so a
 *   draft file is unmistakable; the finalized path keeps clean names.
 *
 * Byte-identity: a draft's staged bytes are bit-identical to what finalize
 * seals (finalize re-uses the staged R2 objects — it does not rebuild). Draft
 * labeling lives ONLY in the filename prefix, the audit entry, and the UI —
 * nothing is marked inside any artifact.
 */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { month } = await params;

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Invalid month format." }, { status: 400 });
    }

    const url = new URL(request.url);
    const file = url.searchParams.get("file");
    if (!file || !isExportDownloadFile(file)) {
      return NextResponse.json(
        {
          error: `Missing or invalid "file" parameter. Expected one of: ${EXPORT_DOWNLOAD_FILES.join(", ")}.`,
        },
        { status: 400 },
      );
    }
    const draft = url.searchParams.get("draft") === "true";

    // Draft path needs the OPEN draft (the highest-revision row when it's a
    // draft). Default path needs the latest FINALIZED revision — NOT getExport,
    // which returns the open draft when one exists and would 409 the sealed
    // package (the mid-revision gap this fixes).
    let draftRecord: ReceiptExport | null = null;
    if (draft) {
      const latest = await getExport(month);
      draftRecord = latest?.status === "draft" ? latest : null;
    }
    const finalizedRecord = !draft ? await getLatestFinalizedExport(month) : null;

    // The AMEX 照合CSV download is named from the payment-due date snapshotted
    // onto the served revision at bundle-build time (0035) — carried on the
    // record itself, so no live lookup of the current statement artifact (which
    // could rename a sealed export's download away from its sealed ZIP, or 404
    // a sealed object when the artifact was later replaced). Codex review #160.
    const resolution = resolveBundleDownload({
      month,
      file,
      draft,
      draftRecord,
      finalizedRecord,
    });
    if (!resolution.ok) {
      return NextResponse.json({ error: resolution.message }, { status: resolution.status });
    }

    const bucket = getReceiptsArchiveBucket();
    const object = await bucket.get(resolution.r2Key);
    if (!object) {
      return NextResponse.json(
        { error: `Archived ${file} file not found in storage.` },
        { status: 404 },
      );
    }

    await createAuditEntry(getReceiptsDb(), {
      actor,
      action: "export.downloaded",
      objectType: "export",
      objectId: resolution.exportId,
      newValueJson: stringifyJson({ month, file, draft: resolution.draft }),
    });

    // Stream the bytes VERBATIM. For a draft, the only outward signal that it
    // isn't sealed is the DRAFT- filename prefix — the bytes themselves are the
    // candidate seal (identical to what finalize will seal).
    return new Response(object.body, {
      headers: {
        "Content-Type": resolution.contentType,
        "Content-Disposition": contentDispositionAttachment(resolution.filename),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/export/[month]/download] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to download export file." },
      { status: 500 },
    );
  }
}
