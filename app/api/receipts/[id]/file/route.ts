import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import { getReceiptsBucket, getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";

type RouteContext = { params: Promise<{ id: string }> };

// Constant-time string compare so the processor key can't be probed by timing.
// Mirrors the auth pattern in /api/receipts/[id]/extract/route.ts so the Mac
// MLX consumer can fetch receipt images through this endpoint with the same
// shared secret it uses to POST extraction results (ADR 0001: all R2 reads go
// through the Worker — the consumer never touches R2 or wrangler directly).
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let mismatch = ab.length ^ bb.length;
  for (let i = 0; i < len; i += 1) mismatch |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return mismatch === 0;
}

// Returns true when the request presents the valid processor key. When false,
// the caller must fall through to human auth (CF Access / device cookie).
function isProcessorRequest(request: Request): boolean {
  const processorKey = getReceiptsProcessorKey();
  const presented = request.headers.get("x-receipts-processor-key");
  return !!processorKey && !!presented && timingSafeEqual(presented, processorKey);
}

function safeFilename(name: string | null): string {
  if (!name) return "receipt";
  // Strip characters that break Content-Disposition header value
  return name.replace(/[\x00-\x1F\x7F/\\:*?"<>|]/g, "_").slice(0, 200) || "receipt";
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
    if (!isProcessorRequest(request)) {
      await requireReceiptsActor(request.headers);
    }
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
    if (!isProcessorRequest(request)) {
      await requireReceiptsActor(request.headers);
    }
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
