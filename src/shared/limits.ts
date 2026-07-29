export const MAX_CAPTURE_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_DATA_URL_CHARS = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 128;
export const MAX_REQUEST_TEXT = 3_000;
export const MAX_LABEL_TEXT = 160;

export function decodedImageBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma < 0) return Number.POSITIVE_INFINITY;
  const base64 = dataUrl.slice(comma + 1);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
