import {
  captureV1Schema,
  MAX_CAPTURE_BODY_BYTES,
  type CaptureError,
  type CaptureResponse,
} from "../shared/capture";
import { publishCapture, type DeliveryDependencies, type DeliveryLog } from "./delivery";
import { WorkerError } from "./errors";
import { decodeCaptureImage } from "./image";
import { SlackClient } from "./slack";
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

async function readBoundedBody(request: Request): Promise<Uint8Array> {
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
    if (declaredLength > MAX_CAPTURE_BODY_BYTES) {
      throw new WorkerError({
        code: "REQUEST_TOO_LARGE",
        stage: "request",
        status: 413,
        message: "Capture payload exceeds the 8 MiB limit",
        retryable: false,
      });
    }
  }

  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CAPTURE_BODY_BYTES) {
      await reader.cancel();
      throw new WorkerError({
        code: "REQUEST_TOO_LARGE",
        stage: "request",
        status: 413,
        message: "Capture payload exceeds the 8 MiB limit",
        retryable: false,
      });
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function parseCapture(request: Request): Promise<unknown> {
  const bytes = await readBoundedBody(request);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkerError({
      code: "MALFORMED_JSON",
      stage: "validation",
      status: 400,
      message: "Request body must be valid UTF-8 JSON",
      retryable: false,
    });
  }

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkerError({
      code: "MALFORMED_JSON",
      stage: "validation",
      status: 400,
      message: "Request body must be valid JSON",
      retryable: false,
    });
  }
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
        if (contentType !== "application/json") {
          throw new WorkerError({
            code: "UNSUPPORTED_MEDIA_TYPE",
            stage: "request",
            status: 415,
            message: "Content-Type must be application/json",
            retryable: false,
          });
        }
        const candidate = await parseCapture(request);
        if (
          typeof candidate === "object" &&
          candidate !== null &&
          "captureId" in candidate &&
          typeof candidate.captureId === "string" &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            candidate.captureId,
          )
        ) {
          captureId = candidate.captureId;
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
        if (!parsed.success) {
          const imageTooLarge = parsed.error.issues.some(
            (issue) =>
              issue.path[0] === "image" &&
              issue.path[1] === "dataUrl" &&
              issue.message === "Decoded image exceeds 5 MiB",
          );
          const invalidImage = parsed.error.issues.some(
            (issue) => issue.path[0] === "image" && issue.path[1] === "dataUrl",
          );
          throw new WorkerError({
            code: imageTooLarge
              ? "IMAGE_TOO_LARGE"
              : invalidImage
                ? "INVALID_IMAGE"
                : "INVALID_CAPTURE",
            stage: "validation",
            status: imageTooLarge ? 413 : 400,
            message: imageTooLarge
              ? "Capture image exceeds the 5 MiB decoded-image limit"
              : invalidImage
                ? "Capture image is not a valid PNG or JPEG data URL"
              : "Capture payload failed validation",
            retryable: false,
          });
        }

        // Validate decoded size and base64 integrity before any Slack side effects.
        const decodedImage = decodeCaptureImage(parsed.data.image.dataUrl);

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
          ...(env.SLACK_REVIEWER_IDS !== undefined
            ? { reviewerIds: env.SLACK_REVIEWER_IDS }
            : {}),
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
          ...(captureId !== undefined ? { captureId } : { captureId: "unknown" }),
          stage: normalized.stage,
          durationMs: Date.now() - requestStartedAt,
          outcome: "error",
        });
        return errorResponse(normalized, captureId);
      }
    },
  };
}

export default createWorker();

export type { Env } from "./types";
