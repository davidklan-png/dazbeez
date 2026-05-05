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
