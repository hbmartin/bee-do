import { MAX_IMAGE_BYTES } from "../../src/shared/limits";
import type { ImageMimeType } from "../../src/shared/capture";

export const JPEG_QUALITIES = [0.92, 0.85, 0.75, 0.65, 0.55] as const;
export const MIN_IMAGE_WIDTH = 800;
export const DOWNSCALE_FACTOR = 0.75;

export type ImageEncodingRequest = {
  mimeType: ImageMimeType;
  scale: number;
  quality?: number;
};

export type BudgetedImage = ImageEncodingRequest & { blob: Blob };
export type ImageEncoder = (request: ImageEncodingRequest) => Promise<Blob>;

/**
 * Searches for the highest-quality image under budget. If even the 800px floor is too large,
 * the smallest completed attempt is returned so the caller never discards the Capture.
 */
export async function fitImageToBudget(
  sourceWidth: number,
  encode: ImageEncoder,
  maxBytes = MAX_IMAGE_BYTES,
): Promise<BudgetedImage> {
  const pngRequest: ImageEncodingRequest = { mimeType: "image/png", scale: 1 };
  const png = await encode(pngRequest);
  let best: BudgetedImage = { ...pngRequest, blob: png };
  if (png.size <= maxBytes) return best;

  const minimumScale = Math.min(1, MIN_IMAGE_WIDTH / Math.max(1, sourceWidth));
  let scale = 1;
  while (true) {
    for (const quality of JPEG_QUALITIES) {
      const request: ImageEncodingRequest = { mimeType: "image/jpeg", scale, quality };
      const blob = await encode(request);
      const attempt: BudgetedImage = { ...request, blob };
      if (blob.size < best.blob.size) best = attempt;
      if (blob.size <= maxBytes) return attempt;
    }

    if (scale <= minimumScale) break;
    const nextScale = Math.max(minimumScale, scale * DOWNSCALE_FACTOR);
    if (nextScale === scale) break;
    scale = nextScale;
  }

  return best;
}
