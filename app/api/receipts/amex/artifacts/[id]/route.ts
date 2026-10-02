import { NextResponse } from "next/server";
import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getAmexArtifactById } from "@/lib/receipts/db";
import { contentDispositionInline } from "@/lib/receipts/export";
import { getReceiptsBucket, getReceiptsDb } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * GET /api/receipts/amex/artifacts/[id] — stream the original uploaded AMEX
 * statement CSV from R2, byte-for-byte. View affordance for the upload-history
 * table on /receipts/amex; no transform, no transcode (the stored encoding —
 * e.g. shift_jis for SAISON exports — is declared in Content-Type so browsers
 * render the raw bytes correctly). Read-only: no audit entry, like the other
 * GET routes.
 */
export async function GET(request: Request, { params }: RouteContext) {
  try {
    await requireReceiptsActor(request.headers);
    const { id } = await params;

    const artifact = await getAmexArtifactById(getReceiptsDb(), id);
    if (!artifact) {
      return NextResponse.json({ error: "Artifact not found." }, { status: 404 });
    }

    const object = await getReceiptsBucket().get(artifact.r2_key);
    if (!object) {
      return NextResponse.json(
        { error: "Artifact file not found in storage." },
        { status: 404 },
      );
    }

    return new Response(object.body, {
      headers: {
        "Content-Type": `${artifact.mime_type ?? "text/csv"}; charset=${artifact.encoding ?? "utf-8"}`,
        "Content-Disposition": contentDispositionInline(
          artifact.original_filename ?? `amex-statement-${id}.csv`,
        ),
      },
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }
    console.error("[api/receipts/amex/artifacts/[id]] GET failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load artifact." },
      { status: 500 },
    );
  }
}
