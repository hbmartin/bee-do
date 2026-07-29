import { describe, expect, it, vi } from "vitest";

import {
  fitImageToBudget,
  type ImageEncoder,
  type ImageEncodingRequest,
} from "../extension/src/image-budget";

function blob(size: number, type: string): Blob {
  return new Blob([new Uint8Array(size)], { type });
}

describe("image budget policy", () => {
  it("keeps a PNG that fits on the first try", async () => {
    const encode = vi.fn<ImageEncoder>(async (request) => blob(80, request.mimeType));

    const result = await fitImageToBudget(1_600, encode, 100);

    expect(result).toMatchObject({ mimeType: "image/png", scale: 1 });
    expect(result.blob.size).toBe(80);
    expect(encode).toHaveBeenCalledTimes(1);
  });

  it("drops JPEG quality before changing dimensions", async () => {
    const encode = vi.fn<ImageEncoder>(async (request) => {
      if (request.mimeType === "image/png") return blob(160, request.mimeType);
      return blob(request.quality === 0.92 ? 120 : 90, request.mimeType);
    });

    const result = await fitImageToBudget(1_600, encode, 100);

    expect(result).toMatchObject({ mimeType: "image/jpeg", scale: 1, quality: 0.85 });
    expect(encode.mock.calls.map(([request]) => request)).toEqual([
      { mimeType: "image/png", scale: 1 },
      { mimeType: "image/jpeg", scale: 1, quality: 0.55 },
      { mimeType: "image/jpeg", scale: 1, quality: 0.92 },
      { mimeType: "image/jpeg", scale: 1, quality: 0.85 },
    ]);
  });

  it("downscales immediately when the lowest quality cannot fit", async () => {
    const encode = vi.fn<ImageEncoder>(async (request) => {
      if (request.mimeType === "image/png") return blob(180, request.mimeType);
      return blob(request.scale < 1 ? 90 : 140, request.mimeType);
    });

    const result = await fitImageToBudget(1_600, encode, 100);

    expect(result).toMatchObject({ mimeType: "image/jpeg", scale: 0.75, quality: 0.92 });
    expect(encode.mock.calls.map(([request]) => request)).toEqual([
      { mimeType: "image/png", scale: 1 },
      { mimeType: "image/jpeg", scale: 1, quality: 0.55 },
      { mimeType: "image/jpeg", scale: 0.75, quality: 0.55 },
      { mimeType: "image/jpeg", scale: 0.75, quality: 0.92 },
    ]);
  });

  it("returns the smallest floor attempt when nothing fits", async () => {
    const requests: ImageEncodingRequest[] = [];
    const encode: ImageEncoder = async (request) => {
      requests.push(request);
      if (request.mimeType === "image/png") return blob(400, request.mimeType);
      return blob(Math.round(250 * request.scale + 20 * (request.quality ?? 1)), request.mimeType);
    };

    const result = await fitImageToBudget(1_600, encode, 100);

    expect(result).toMatchObject({ mimeType: "image/jpeg", scale: 0.5, quality: 0.55 });
    expect(result.blob.size).toBeGreaterThan(100);
    expect(Math.min(...requests.map((request) => request.scale))).toBe(0.5);
  });
});
