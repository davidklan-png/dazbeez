import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { createAuditEntry } from "@/lib/receipts/audit";
import { stringifyJson } from "@/lib/receipts/db-utils";
import { getExport } from "@/lib/receipts/db";
import {
  EXPORT_DOWNLOAD_FILES,
  isExportDownloadFile,
  resolveExportDownload,
} from "@/lib/receipts/export";
import {
  getReceiptsArchiveBucket,
  getReceiptsDb,
} from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ month: string }> };

/**
 * GET /api/receipts/export/[month]/download?file=receipts|manifest|summary|readme
 *
 * Streams one of the four finalized-bundle artifacts from the archive bucket.
 * The body is served byte-for-byte as sealed at finalize (BOM+CRLF CSVs whose
 * SHA-256 is recorded in the manifest) — no re-encoding, or integrity
 * verification against the manifest breaks.
 */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    const actor = await requireReceiptsActor(request.headers);
    const { month } = await params;

    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Invalid month format." }, { status: 400 });
    }

    const file = new URL(request.url).searchParams.get("file");
    if (!file || !isExportDownloadFile(file)) {
      return NextResponse.json(
        {
          error: `Missing or invalid "file" parameter. Expected one of: ${EXPORT_DOWNLOAD_FILES.join(", ")}.`,
        },
        { status: 400 },
      );
    }

    const exportRecord = await getExport(month);
    if (!exportRecord) {
      return NextResponse.json(
        { error: "No export found for this month." },
        { status: 404 },
      );
    }
    // Only finalized bundles are downloadable — a draft is not sealed, its
    // artifacts can still be rebuilt, and handing it to the accountant would
    // circulate an unverified bundle.
    if (exportRecord.status !== "finalized") {
      return NextResponse.json(
        {
          error:
            "Export for this month is still a draft. Finalize the month before downloading the bundle.",
        },
        { status: 409 },
      );
    }

    const target = resolveExportDownload(month, exportRecord, file);
    if (!target.r2Key) {
      return NextResponse.json(
        { error: `No archived ${file} key recorded for this export.` },
        { status: 404 },
      );
    }

    const bucket = getReceiptsArchiveBucket();
    const object = await bucket.get(target.r2Key);
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
      objectId: exportRecord.id,
      newValueJson: stringifyJson({ month, file }),
    });

    // Stream the archived bytes as-is — do NOT transform the body.
    return new Response(object.body, {
      headers: {
        "Content-Type": target.contentType,
        "Content-Disposition": `attachment; filename="${target.filename}"`,
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
