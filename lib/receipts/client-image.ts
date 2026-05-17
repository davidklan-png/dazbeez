// Browser-only image resize helper. Receipt photos straight off a phone are
// 3–12 MB which inflates the upload, R2 storage, and (most importantly) the
// base64-encoded body we POST to Google Vision during extraction. Shrinking
// in the browser keeps the worker well under its CPU budget.
//
// All DOM access lives inside maybeResizeImage so a stray server import is
// inert (the function simply isn't called server-side).

const MAX_LONG_EDGE = 1600;
const JPEG_QUALITY = 0.82;
const MIN_RESIZE_BYTES = 500 * 1024;
const MAX_CANVAS_PIXELS = 16_000_000; // iOS Safari hard cap (~4096 × 4096)

const RESIZE_ELIGIBLE_MIME = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
]);

const RESIZE_ELIGIBLE_EXT = new Set([".jpg", ".jpeg", ".png"]);

function isResizeEligible(file: File): boolean {
  if (RESIZE_ELIGIBLE_MIME.has(file.type.toLowerCase())) return true;
  // iOS Photos / some Androids hand back files with empty file.type.
  // Fall back to extension so we still resize a JPEG that lost its MIME.
  if (!file.type) {
    const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    if (ext && RESIZE_ELIGIBLE_EXT.has(ext)) return true;
  }
  return false;
}

async function decode(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === "function") {
    return createImageBitmap(file, { imageOrientation: "from-image" });
  }
  // Fallback for browsers without createImageBitmap. The browser still bakes
  // EXIF orientation into the <img> when drawn to canvas on all current
  // engines (Chrome ≥ 81, Safari ≥ 13.4).
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("decode failed"));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function dimsOf(source: ImageBitmap | HTMLImageElement): { w: number; h: number } {
  if (source instanceof HTMLImageElement) {
    return { w: source.naturalWidth, h: source.naturalHeight };
  }
  return { w: source.width, h: source.height };
}

function targetDims(srcW: number, srcH: number): { w: number; h: number } {
  const longEdge = Math.max(srcW, srcH);
  let scale = MAX_LONG_EDGE / longEdge;
  let w = Math.round(srcW * scale);
  let h = Math.round(srcH * scale);
  // Guard the iOS canvas-area cap. If the scaled image would still exceed
  // 16 MP (only possible from gigantic sources), scale further so the
  // destination canvas stays under the limit.
  if (w * h > MAX_CANVAS_PIXELS) {
    scale *= Math.sqrt(MAX_CANVAS_PIXELS / (w * h));
    w = Math.round(srcW * scale);
    h = Math.round(srcH * scale);
  }
  return { w, h };
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, q: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, q));
}

function replaceExtension(name: string, newExt: string): string {
  const stem = name.replace(/\.[^.]+$/, "");
  return (stem || name) + newExt;
}

export async function maybeResizeImage(file: File): Promise<File> {
  if (!isResizeEligible(file)) return file;
  if (file.size < MIN_RESIZE_BYTES) return file;

  let bitmap: ImageBitmap | null = null;
  try {
    const decoded = await decode(file);
    if (decoded instanceof ImageBitmap) bitmap = decoded;

    const { w: srcW, h: srcH } = dimsOf(decoded);
    if (Math.max(srcW, srcH) <= MAX_LONG_EDGE) return file;

    const { w, h } = targetDims(srcW, srcH);

    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? (new OffscreenCanvas(w, h) as unknown as HTMLCanvasElement)
        : Object.assign(document.createElement("canvas"), { width: w, height: h });

    const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
    if (!ctx) return file;
    ctx.drawImage(decoded as CanvasImageSource, 0, 0, w, h);

    const blob =
      "convertToBlob" in canvas
        ? await (canvas as unknown as OffscreenCanvas).convertToBlob({
            type: "image/jpeg",
            quality: JPEG_QUALITY,
          })
        : await canvasToBlob(canvas, "image/jpeg", JPEG_QUALITY);

    if (!blob || blob.size >= file.size) return file;

    return new File([blob], replaceExtension(file.name, ".jpg"), {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch {
    return file;
  } finally {
    bitmap?.close?.();
  }
}
