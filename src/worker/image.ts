import { MAX_IMAGE_BYTES, type CaptureImage, type ImageMimeType } from "../shared/capture";
import { WorkerError } from "./errors";

export type DecodedImage = {
  bytes: ArrayBuffer;
  mimeType: ImageMimeType;
  extension: "png" | "jpg";
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function invalidImage(message: string): WorkerError {
  return new WorkerError({
    code: "INVALID_IMAGE",
    stage: "validation",
    status: 400,
    message,
    retryable: false,
  });
}

function startsWithSignature(header: Uint8Array, signature: number[]): boolean {
  if (header.length < signature.length) return false;
  return signature.every((value, index) => header[index] === value);
}

/**
 * Validates the raw image part against the metadata that described it. The bytes arrive
 * verbatim over multipart, so this is a header check rather than a decode — no base64, no
 * per-byte copy, and therefore negligible CPU regardless of image size.
 */
export function validateCaptureImage(bytes: ArrayBuffer, declared: CaptureImage): DecodedImage {
  if (bytes.byteLength === 0) {
    throw invalidImage("Capture image part is empty");
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new WorkerError({
      code: "IMAGE_TOO_LARGE",
      stage: "validation",
      status: 413,
      message: "Capture image exceeds the 9 MB limit",
      retryable: false,
    });
  }
  if (bytes.byteLength !== declared.byteLength) {
    throw invalidImage("Capture image size does not match the declared byte length");
  }

  // A JPEG's SOI marker is enough: requiring a trailing EOI rejects valid progressive and
  // padded encoders for no gain, since Slack re-validates the file on upload anyway.
  const header = new Uint8Array(bytes, 0, Math.min(bytes.byteLength, PNG_SIGNATURE.length));
  const matches =
    declared.mimeType === "image/png"
      ? startsWithSignature(header, PNG_SIGNATURE)
      : startsWithSignature(header, JPEG_SIGNATURE);
  if (!matches) {
    throw invalidImage("Capture image data does not match its declared type");
  }

  return {
    bytes,
    mimeType: declared.mimeType,
    extension: declared.mimeType === "image/jpeg" ? "jpg" : "png",
  };
}
