import { assertReceiptsAccessFromHeaders } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import { getReceiptsBucket } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

function safeFilename(name: string | null): string {
  if (!name) return "receipt";
  // Strip characters that break Content-Disposition header value
  return name.replace(/[/\\:*?"<>|]/g, "_").slice(0, 200) || "receipt";
}

function buildFileHeaders(
  receipt: { original_content_type: string; original_filename: string | null },
  object: { httpMetadata?: { contentType?: string }; size: number },
): Headers {
  const contentType =
    receipt.original_content_type ||
    object.httpMetadata?.contentType ||
    "application/octet-stream";

  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Disposition": `inline; filename="${safeFilename(receipt.original_filename)}"`,
    "Cache-Control": "private, max-age=300",
    "X-Robots-Tag": "noindex, nofollow",
  });

  if (object.size !== undefined) {
    headers.set("Content-Length", String(object.size));
  }

  return headers;
}

export async function GET(request: Request, { params }: RouteContext) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const { id } = await params;

    const receipt = await getReceiptRecord(id);
    if (!receipt) {
      return Response.json({ error: "Receipt not found." }, { status: 404 });
    }

    // Get the R2ObjectBody directly — do not wrap body in an intermediate object.
    // Keeping the R2ObjectBody in scope here lets the Cloudflare runtime stream
    // the object directly to the response without buffering it into memory.
    const object = await getReceiptsBucket().get(receipt.original_r2_key);
    if (!object?.body) {
      return Response.json({ error: "Receipt file not found in storage." }, { status: 404 });
    }

    return new Response(object.body, {
      status: 200,
      headers: buildFileHeaders(receipt, object),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return new Response("Unauthorized.", { status: 401 });
    }
    console.error("[api/receipts/[id]/file] GET failed", error);
    return new Response("Failed to retrieve file.", { status: 500 });
  }
}

export async function HEAD(request: Request, { params }: RouteContext) {
  try {
    await assertReceiptsAccessFromHeaders(request.headers);
    const { id } = await params;

    const receipt = await getReceiptRecord(id);
    if (!receipt) {
      return new Response(null, { status: 404 });
    }

    const object = await getReceiptsBucket().head(receipt.original_r2_key);
    if (!object) {
      return new Response(null, { status: 404 });
    }

    return new Response(null, {
      status: 200,
      headers: buildFileHeaders(receipt, object),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return new Response(null, { status: 401 });
    }
    return new Response(null, { status: 500 });
  }
}
