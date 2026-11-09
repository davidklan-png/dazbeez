import { requireReceiptsActor } from "@/lib/receipts/auth";
import { getReceiptRecord } from "@/lib/receipts/db";
import { getReceiptsBucket, getReceiptsProcessorKey } from "@/lib/cloudflare-runtime";
import {
  contentDispositionAttachment,
  contentDispositionInline,
} from "@/lib/receipts/export";

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
// the caller must fall through to a Clerk-authenticated operator.
function isProcessorRequest(request: Request): boolean {
  const processorKey = getReceiptsProcessorKey();
  const presented = request.headers.get("x-receipts-processor-key");
  return !!processorKey && !!presented && timingSafeEqual(presented, processorKey);
}

// Content types this route may render INLINE. Everything else is served as a
// sandboxed download. The served bytes are raw evidence — a promoted email
// body is text/html and an email attachment's MIME type is chosen by the
// sender — so a hostile HTML/SVG original served inline with the operator's
// session would execute on the signed-in app origin (audit 2026-11-09,
// finding 1). Fail-closed: unknown types download too. PDF, plain text, and
// non-SVG images cannot execute when rendered with their declared type.
function isPassiveContentType(contentType: string): boolean {
  const base = contentType.split(";")[0].trim().toLowerCase();
  if (base === "application/pdf" || base === "text/plain") return true;
  return base.startsWith("image/") && base !== "image/svg+xml";
}

function buildFileHeaders(
  receipt: { original_content_type: string; original_filename: string | null },
  object: { httpMetadata?: { contentType?: string }; size: number },
  preferObjectContentType = false,
): Headers {
  // When serving the rendered derivative (extraction_r2_key), the object's own
  // content type (e.g. application/pdf) is authoritative — the receipt's
  // original_content_type is the raw body (text/html), which is wrong for the
  // served bytes. Otherwise the original_content_type wins as before.
  const contentType = preferObjectContentType
    ? object.httpMetadata?.contentType ||
      receipt.original_content_type ||
      "application/octet-stream"
    : receipt.original_content_type ||
      object.httpMetadata?.contentType ||
      "application/octet-stream";

  // Audit 2026-11-09, findings 1 + 7. Non-ASCII filenames (領収書.pdf) go
  // through the shared RFC 5987 helper — a raw UTF-8 name in a Headers value
  // throws in the Response constructor and returned 500. Active-content or
  // unknown types get `attachment` plus a response-level sandbox CSP + nosniff
  // so even a direct navigation to the URL runs in an opaque origin with
  // script execution disabled; safe PDF/image derivatives stay inline.
  const passive = isPassiveContentType(contentType);
  // 200-code-point cap keeps a hostile attachment name from blowing the header
  // size limit. Array.from truncates by code point — String.slice counts UTF-16
  // units and can split a surrogate pair (𠮷), which would hand the shared
  // encoder a malformed string (cross-review 2026-11-10). The helper handles
  // ByteString/RFC 5987 encoding from here.
  const filename = Array.from(receipt.original_filename || "receipt")
    .slice(0, 200)
    .join("");

  const headers = new Headers({
    "Content-Type": contentType,
    "Content-Disposition": passive
      ? contentDispositionInline(filename)
      : contentDispositionAttachment(filename),
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "private, max-age=300",
    "X-Robots-Tag": "noindex, nofollow",
  });

  if (!passive) {
    headers.set("Content-Security-Policy", "sandbox");
  }

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

    // ADR 0011 Phase B: serve the rendered derivative once it exists (the
    // MLX-consumable PDF/PNG of an email_body receipt's raw body); otherwise
    // the true original. The MLX consumer and the review image pane both hit
    // this endpoint, so both transparently get the rendered bytes once /render
    // has deposited them — zero change to consumer fetch logic.
    const servingDerivative = !!receipt.extraction_r2_key;
    const servedKey = receipt.extraction_r2_key ?? receipt.original_r2_key;

    // Get the R2ObjectBody directly — do not wrap body in an intermediate object.
    // Keeping the R2ObjectBody in scope here lets the Cloudflare runtime stream
    // the object directly to the response without buffering it into memory.
    const object = await getReceiptsBucket().get(servedKey);
    if (!object?.body) {
      return Response.json({ error: "Receipt file not found in storage." }, { status: 404 });
    }

    return new Response(object.body, {
      status: 200,
      headers: buildFileHeaders(receipt, object, servingDerivative),
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

    const object = await getReceiptsBucket().head(
      receipt.extraction_r2_key ?? receipt.original_r2_key,
    );
    if (!object) {
      return new Response(null, { status: 404 });
    }

    return new Response(null, {
      status: 200,
      headers: buildFileHeaders(receipt, object, !!receipt.extraction_r2_key),
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Unauthorized")) {
      return new Response(null, { status: 401 });
    }
    return new Response(null, { status: 500 });
  }
}
