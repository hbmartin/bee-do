import {
  CAPTURE_IMAGE_PART,
  CAPTURE_METADATA_PART,
  captureV1Schema,
  isCaptureId,
  MAX_CAPTURE_REQUEST_BYTES,
  MAX_IMAGE_BYTES,
  MAX_METADATA_BYTES,
  type CaptureError,
  type CaptureResponse,
} from "../shared/capture";
import { publishCapture, type DeliveryDependencies, type DeliveryLog } from "./delivery";
import { WorkerError } from "./errors";
import { validateCaptureImage } from "./image";
import { describeSlackError, SlackClient } from "./slack";
import type { Env, Fetcher } from "./types";

export type WorkerDependencies = {
  fetcher?: Fetcher;
  makeAttempt?: DeliveryDependencies["makeAttempt"];
  log?: DeliveryDependencies["log"];
};

function jsonResponse(body: CaptureResponse | Record<string, unknown>, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

function errorResponse(error: WorkerError, captureId?: string): Response {
  const body: CaptureError = {
    ok: false,
    ...(captureId !== undefined ? { captureId } : {}),
    ...(error.slack !== undefined ? { slack: error.slack } : {}),
    error: {
      code: error.code,
      stage: error.stage,
      message: error.message,
      retryable: error.retryable,
    },
  };
  return jsonResponse(body, error.status);
}

function safeEqual(left: string, right: string): boolean {
  const maxLength = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < maxLength; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function authenticate(request: Request, expectedSecret: string | undefined): void {
  if (!expectedSecret) {
    throw new WorkerError({
      code: "SERVICE_MISCONFIGURED",
      stage: "configuration",
      status: 500,
      message: "Capture service is not configured",
      retryable: false,
    });
  }

  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  if (!match || !safeEqual(match[1] ?? "", expectedSecret)) {
    throw new WorkerError({
      code: "UNAUTHORIZED",
      stage: "authentication",
      status: 401,
      message: "A valid capture ingest token is required",
      retryable: false,
    });
  }
}

function requestTooLarge(): WorkerError {
  return new WorkerError({
    code: "REQUEST_TOO_LARGE",
    stage: "request",
    status: 413,
    message: "Capture payload exceeds the 10 MB limit",
    retryable: false,
  });
}

/**
 * Rebuilds the request behind a counting stream so the size cap is enforced while the body is
 * still arriving. `formData()` buffers everything it is given, so the limit has to sit in
 * front of it rather than after.
 */
function limitBody(request: Request): {
  request: Request;
  overflowed: () => boolean;
} {
  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader !== null) {
    const declaredLength = Number(lengthHeader);
    if (!Number.isSafeInteger(declaredLength) || declaredLength < 0) {
      throw new WorkerError({
        code: "INVALID_CONTENT_LENGTH",
        stage: "request",
        status: 400,
        message: "Content-Length is invalid",
        retryable: false,
      });
    }
    if (declaredLength > MAX_CAPTURE_REQUEST_BYTES) throw requestTooLarge();
  }

  if (request.body === null) {
    throw new WorkerError({
      code: "EMPTY_BODY",
      stage: "request",
      status: 400,
      message: "Capture request body is required",
      retryable: false,
    });
  }

  let total = 0;
  let overflowed = false;
  const limiter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > MAX_CAPTURE_REQUEST_BYTES) {
        overflowed = true;
        controller.error(requestTooLarge());
        return;
      }
      controller.enqueue(chunk);
    },
  });

  return {
    request: new Request(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body.pipeThrough(limiter),
    }),
    overflowed: () => overflowed,
  };
}

async function readCaptureForm(request: Request): Promise<FormData> {
  const bounded = limitBody(request);
  try {
    return await bounded.request.formData();
  } catch (error) {
    if (bounded.overflowed()) throw requestTooLarge();
    if (error instanceof WorkerError) throw error;
    throw new WorkerError({
      code: "MALFORMED_MULTIPART",
      stage: "request",
      status: 400,
      message: "Request body must be valid multipart/form-data",
      retryable: false,
    });
  }
}

function readMetadata(form: FormData): unknown {
  const part = form.get(CAPTURE_METADATA_PART);
  if (typeof part !== "string") {
    throw new WorkerError({
      code: "MISSING_CAPTURE_METADATA",
      stage: "request",
      status: 400,
      message: `A "${CAPTURE_METADATA_PART}" JSON part is required`,
      retryable: false,
    });
  }
  if (new TextEncoder().encode(part).byteLength > MAX_METADATA_BYTES) {
    throw new WorkerError({
      code: "METADATA_TOO_LARGE",
      stage: "request",
      status: 413,
      message: "Capture metadata exceeds the supported size",
      retryable: false,
    });
  }

  try {
    return JSON.parse(part) as unknown;
  } catch {
    throw new WorkerError({
      code: "MALFORMED_JSON",
      stage: "validation",
      status: 400,
      message: "Capture metadata must be valid JSON",
      retryable: false,
    });
  }
}

function readImagePart(form: FormData): Blob {
  const part = form.get(CAPTURE_IMAGE_PART);
  if (part === null || typeof part === "string") {
    throw new WorkerError({
      code: "MISSING_CAPTURE_IMAGE",
      stage: "request",
      status: 400,
      message: `An "${CAPTURE_IMAGE_PART}" file part is required`,
      retryable: false,
    });
  }
  if (part.size > MAX_IMAGE_BYTES) {
    throw new WorkerError({
      code: "IMAGE_TOO_LARGE",
      stage: "validation",
      status: 413,
      message: "Capture image exceeds the 9 MB limit",
      retryable: false,
    });
  }
  return part;
}

function validationError(
  issues: ReadonlyArray<{ path: PropertyKey[]; code: string }>,
): WorkerError {
  const imageIssue = issues.find((issue) => issue.path[0] === "image");
  const tooLarge = imageIssue?.path[1] === "byteLength" && imageIssue.code === "too_big";

  if (tooLarge) {
    return new WorkerError({
      code: "IMAGE_TOO_LARGE",
      stage: "validation",
      status: 413,
      message: "Capture image exceeds the 9 MB limit",
      retryable: false,
    });
  }
  if (imageIssue) {
    return new WorkerError({
      code: "INVALID_IMAGE",
      stage: "validation",
      status: 400,
      message: "Capture image metadata is not valid",
      retryable: false,
    });
  }
  const firstIssue = issues[0];
  const field =
    firstIssue && firstIssue.path.length > 0 ? firstIssue.path.map(String).join(".") : undefined;
  return new WorkerError({
    code: "INVALID_CAPTURE",
    stage: "validation",
    status: 400,
    message: field
      ? `Capture payload failed validation at ${field}`
      : "Capture payload failed validation",
    retryable: false,
  });
}

function structuredLog(entry: DeliveryLog): void {
  console.log(JSON.stringify(entry));
}

export function createWorker(dependencies: WorkerDependencies = {}) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const requestStartedAt = Date.now();
      const url = new URL(request.url);

      if (url.pathname === "/healthz" && request.method === "GET") {
        return jsonResponse({ ok: true }, 200);
      }
      if (url.pathname !== "/v1/captures") {
        return errorResponse(
          new WorkerError({
            code: "NOT_FOUND",
            stage: "routing",
            status: 404,
            message: "Route not found",
            retryable: false,
          }),
        );
      }
      if (request.method !== "POST") {
        return errorResponse(
          new WorkerError({
            code: "METHOD_NOT_ALLOWED",
            stage: "routing",
            status: 405,
            message: "POST is required for this route",
            retryable: false,
          }),
        );
      }

      let captureId: string | undefined;
      try {
        authenticate(request, env.CAPTURE_INGEST_SECRET);

        const contentType =
          request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
        if (contentType !== "multipart/form-data") {
          throw new WorkerError({
            code: "UNSUPPORTED_MEDIA_TYPE",
            stage: "request",
            status: 415,
            message: "Content-Type must be multipart/form-data",
            retryable: false,
          });
        }

        const form = await readCaptureForm(request);
        const candidate = readMetadata(form);

        if (typeof candidate === "object" && candidate !== null && "captureId" in candidate) {
          if (isCaptureId(candidate.captureId)) captureId = candidate.captureId;
        }
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "schemaVersion" in candidate &&
          candidate.schemaVersion !== 1
        ) {
          throw new WorkerError({
            code: "UNSUPPORTED_SCHEMA_VERSION",
            stage: "validation",
            status: 400,
            message: "Capture schema version is not supported",
            retryable: false,
          });
        }

        const parsed = captureV1Schema.safeParse(candidate);
        if (!parsed.success) throw validationError(parsed.error.issues);

        // Validate the bytes against their declared metadata before any Slack side effects.
        const imagePart = readImagePart(form);
        if (imagePart.type !== parsed.data.image.mimeType) {
          throw new WorkerError({
            code: "INVALID_IMAGE",
            stage: "validation",
            status: 400,
            message: "Capture image part type does not match its metadata",
            retryable: false,
          });
        }
        const decodedImage = validateCaptureImage(await imagePart.arrayBuffer(), parsed.data.image);

        if (!env.SLACK_BOT_TOKEN) {
          throw new WorkerError({
            code: "SERVICE_MISCONFIGURED",
            stage: "configuration",
            status: 500,
            message: "Capture service is not configured",
            retryable: false,
          });
        }

        const slack = new SlackClient(env.SLACK_BOT_TOKEN, dependencies.fetcher ?? fetch);
        const result = await publishCapture(parsed.data, {
          slack,
          ...(env.SLACK_REVIEWER_IDS !== undefined ? { reviewerIds: env.SLACK_REVIEWER_IDS } : {}),
          ...(dependencies.makeAttempt !== undefined
            ? { makeAttempt: dependencies.makeAttempt }
            : {}),
          decodedImage,
          log: dependencies.log ?? structuredLog,
        });
        return jsonResponse(result, 201);
      } catch (error) {
        const normalized =
          error instanceof WorkerError
            ? error
            : new WorkerError({
                code: "INTERNAL_ERROR",
                stage: "internal",
                status: 500,
                message: "Capture delivery failed unexpectedly",
                retryable: true,
                cause: error,
              });
        (dependencies.log ?? structuredLog)({
          captureId: captureId ?? "unknown",
          stage: normalized.stage,
          durationMs: Date.now() - requestStartedAt,
          outcome: "error",
          code: normalized.code,
          ...describeSlackError(normalized.cause),
          ...(normalized.slack !== undefined ? normalized.slack : {}),
        });
        return errorResponse(normalized, captureId);
      }
    },
  };
}

export default createWorker();

export type { Env } from "./types";
