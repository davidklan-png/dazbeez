const BYTES_PER_MEBIBYTE = 1024 * 1024;

export const MAX_BATCH_AI_IMAGE_BYTES = 4 * BYTES_PER_MEBIBYTE;

export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) {
    return `${kibibytes.toFixed(1)} KB`;
  }

  return `${(bytes / BYTES_PER_MEBIBYTE).toFixed(1)} MB`;
}

export function getImageSizeValidationError(
  args: {
    fileSize: number;
    label: string;
    maxBytes?: number;
  },
): string | null {
  const maxBytes = args.maxBytes ?? MAX_BATCH_AI_IMAGE_BYTES;

  if (args.fileSize <= maxBytes) {
    return null;
  }

  return `${args.label} is ${formatFileSize(args.fileSize)}. Maximum allowed size is ${formatFileSize(maxBytes)}. Resize or compress the image before uploading.`;
}

// Business-card capture accepts images only. Previously the route validated size
// but accepted ANY content type into the AI-vision extraction pipeline.
export const ALLOWED_BUSINESS_CARD_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
] as const;

export const ALLOWED_BUSINESS_CARD_EXTENSIONS = [
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
] as const;

export function getBusinessCardFileTypeError(file: File): string | null {
  const ext = `.${file.name.split(".").pop()?.toLowerCase() ?? ""}`;
  const mimeOk = (
    ALLOWED_BUSINESS_CARD_MIME_TYPES as readonly string[]
  ).includes(file.type);
  const extOk = (
    ALLOWED_BUSINESS_CARD_EXTENSIONS as readonly string[]
  ).includes(ext);
  if (!mimeOk && !extOk) {
    return "Business card must be an image (JPEG, PNG, or HEIC).";
  }
  return null;
}
