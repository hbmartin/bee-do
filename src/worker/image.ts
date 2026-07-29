import { MAX_IMAGE_BYTES } from "../shared/capture";
import { WorkerError } from "./errors";

export type DecodedImage = {
  bytes: ArrayBuffer;
  mimeType: "image/png" | "image/jpeg";
  extension: "png" | "jpg";
};

const DATA_URL_PATTERN = /^data:(image\/(png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/;

function hasPngSignature(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return signature.every((value, index) => bytes[index] === value);
}

function hasJpegSignature(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff &&
    bytes.at(-2) === 0xff &&
    bytes.at(-1) === 0xd9
  );
}

export function decodeCaptureImage(dataUrl: string): DecodedImage {
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match) {
    throw new WorkerError({
      code: "INVALID_IMAGE",
      stage: "validation",
      status: 400,
      message: "Capture image is not a valid PNG or JPEG data URL",
      retryable: false,
    });
  }

  const mimeType = match[1] as DecodedImage["mimeType"];
  const subtype = match[2];
  const encoded = match[3] ?? "";
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0;
  const decodedLength = Math.floor((encoded.length * 3) / 4) - padding;

  if (decodedLength > MAX_IMAGE_BYTES) {
    throw new WorkerError({
      code: "IMAGE_TOO_LARGE",
      stage: "validation",
      status: 413,
      message: "Capture image exceeds the 5 MiB decoded-image limit",
      retryable: false,
    });
  }

  let binary: string;
  try {
    binary = atob(encoded);
  } catch {
    throw new WorkerError({
      code: "INVALID_IMAGE",
      stage: "validation",
      status: 400,
      message: "Capture image contains invalid base64 data",
      retryable: false,
    });
  }

  if (binary.length !== decodedLength || binary.length > MAX_IMAGE_BYTES) {
    throw new WorkerError({
      code: binary.length > MAX_IMAGE_BYTES ? "IMAGE_TOO_LARGE" : "INVALID_IMAGE",
      stage: "validation",
      status: binary.length > MAX_IMAGE_BYTES ? 413 : 400,
      message:
        binary.length > MAX_IMAGE_BYTES
          ? "Capture image exceeds the 5 MiB decoded-image limit"
          : "Capture image contains invalid base64 data",
      retryable: false,
    });
  }

  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const hasExpectedSignature =
    mimeType === "image/png" ? hasPngSignature(bytes) : hasJpegSignature(bytes);
  if (!hasExpectedSignature) {
    throw new WorkerError({
      code: "INVALID_IMAGE",
      stage: "validation",
      status: 400,
      message: "Capture image data does not match its declared type",
      retryable: false,
    });
  }

  return {
    bytes: bytes.buffer,
    mimeType,
    extension: subtype === "jpeg" ? "jpg" : "png",
  };
}
