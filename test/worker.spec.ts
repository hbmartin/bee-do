import { describe, expect, it } from "vitest";

import type { CaptureV1 } from "../src/shared/capture";
import { MAX_CAPTURE_REQUEST_BYTES, MAX_IMAGE_BYTES } from "../src/shared/capture";
import {
  SLACK_CONTEXT_TEXT_MAX,
  SLACK_FIELD_TEXT_MAX,
  SLACK_HEADER_TEXT_MAX,
  SLACK_MESSAGE_TEXT_MAX,
  SLACK_SECTION_TEXT_MAX,
} from "../src/shared/limits";
import {
  buildChannelName,
  buildDiagnosticsMessage,
  type DeliveryLog,
} from "../src/worker/delivery";
import { createWorker, type WorkerDependencies } from "../src/worker";
import type { Env, Fetcher } from "../src/worker/types";

const CAPTURE_ID = "c773afc4-f923-47ad-b1c1-ceffa1f4e5af";
const SECRET = "test-ingest-secret";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";
const PNG_BYTES = Uint8Array.from(atob(PNG_BASE64), (character) => character.charCodeAt(0));
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x01, 0x02, 0xff, 0xd9, 0x00]);

const env: Env = {
  CAPTURE_INGEST_SECRET: SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_REVIEWER_IDS: "U12345678,U99999999,U99999999",
};

function capture(
  image: Uint8Array = PNG_BYTES,
  mimeType: CaptureV1["image"]["mimeType"] = "image/png",
): CaptureV1 {
  return {
    schemaVersion: 1,
    captureId: CAPTURE_ID,
    capturedAt: "2026-07-29T12:00:00.000Z",
    request: { text: "Update the hero heading" },
    requester: { slackUserId: "U12345678" },
    project: { slug: "trellium" },
    page: {
      url: "https://trellium.ai/dashboard?mode=focus",
      path: "/dashboard",
      search: "?mode=focus",
      title: "Dashboard",
      viewport: { width: 1_440, height: 900 },
      devicePixelRatio: 2,
    },
    image: { mimeType, byteLength: image.byteLength, annotated: true },
    diagnostics: {
      console: [
        {
          level: "warn",
          message: "A captured warning",
          occurredAt: "2026-07-29T11:59:00.000Z",
        },
      ],
      clicks: [
        {
          selector: "main > button.primary",
          text: "Continue",
          occurredAt: "2026-07-29T11:59:30.000Z",
        },
      ],
    },
  };
}

type MultipartOptions = {
  image?: Uint8Array;
  mimeType?: CaptureV1["image"]["mimeType"];
  headers?: HeadersInit;
  includeCapture?: boolean;
  includeImage?: boolean;
};

function request(metadata: unknown | string = capture(), options: MultipartOptions = {}): Request {
  const image = options.image ?? PNG_BYTES;
  const mimeType =
    options.mimeType ??
    (typeof metadata === "object" &&
    metadata !== null &&
    "image" in metadata &&
    typeof metadata.image === "object" &&
    metadata.image !== null &&
    "mimeType" in metadata.image &&
    typeof metadata.image.mimeType === "string"
      ? (metadata.image.mimeType as CaptureV1["image"]["mimeType"])
      : "image/png");
  const form = new FormData();
  if (options.includeCapture !== false) {
    form.append("capture", typeof metadata === "string" ? metadata : JSON.stringify(metadata));
  }
  if (options.includeImage !== false) {
    const imageBuffer = new Uint8Array(image.byteLength);
    imageBuffer.set(image);
    form.append(
      "image",
      new Blob([imageBuffer.buffer], { type: mimeType }),
      mimeType.endsWith("jpeg") ? "x.jpg" : "x.png",
    );
  }
  const headers = new Headers(options.headers);
  if (!headers.has("authorization")) headers.set("authorization", `Bearer ${SECRET}`);
  return new Request("https://bee-do.example/v1/captures", {
    method: "POST",
    headers,
    body: form,
  });
}

type RecordedCall = { url: string; init?: RequestInit };

function slackMock(
  options: {
    failMethod?: string;
    failDiagnostics?: boolean;
    failInvite?: boolean;
  } = {},
): { fetcher: Fetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let messageNumber = 0;

  const fetcher: Fetcher = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url === "https://files.slack.test/upload") {
      if (options.failMethod === "external_upload") return new Response("no", { status: 500 });
      return new Response("ok");
    }

    const method = new URL(url).pathname.split("/").at(-1) ?? "";
    if (method === "chat.postMessage") messageNumber += 1;
    const shouldFail =
      options.failMethod === method ||
      (options.failInvite && method === "conversations.invite") ||
      (options.failDiagnostics && method === "chat.postMessage" && messageNumber === 2);
    if (shouldFail) return Response.json({ ok: false, error: "test_failure" });

    switch (method) {
      case "conversations.create":
        return Response.json({
          ok: true,
          channel: { id: "C12345678", name: "bee-test" },
        });
      case "conversations.invite":
        return Response.json({ ok: true });
      case "chat.postMessage":
        return Response.json({ ok: true, ts: messageNumber === 1 ? "100.200" : "100.201" });
      case "files.getUploadURLExternal":
        return Response.json({
          ok: true,
          upload_url: "https://files.slack.test/upload",
          file_id: "F12345678",
        });
      case "files.completeUploadExternal":
        return Response.json({ ok: true, files: [{ id: "F12345678" }] });
      case "chat.getPermalink":
        return Response.json({
          ok: true,
          permalink: "https://test.slack.com/archives/C12345678/p100200",
        });
      default:
        throw new Error(`Unexpected Slack call: ${url}`);
    }
  };

  return { fetcher, calls };
}

function jsonBody(call: RecordedCall): Record<string, unknown> {
  if (typeof call.init?.body !== "string") throw new Error("Expected a JSON request body");
  return JSON.parse(call.init.body) as Record<string, unknown>;
}

describe("Worker routing and validation", () => {
  it("serves an unauthenticated health check", async () => {
    const response = await createWorker().fetch(new Request("https://bee-do.example/healthz"), env);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects unknown routes and unsupported methods", async () => {
    const worker = createWorker();
    const missing = await worker.fetch(new Request("https://bee-do.example/nope"), env);
    const wrongMethod = await worker.fetch(new Request("https://bee-do.example/v1/captures"), env);

    expect(missing.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
  });

  it("requires the configured bearer token", async () => {
    const response = await createWorker().fetch(
      request(capture(), { headers: { authorization: "" } }),
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED", stage: "authentication", retryable: false },
    });
  });

  it("rejects the legacy JSON content type and malformed metadata JSON", async () => {
    const legacy = new Request("https://bee-do.example/v1/captures", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify(capture()),
    });
    const wrongType = await createWorker().fetch(legacy, env);
    const malformed = await createWorker().fetch(request("{"), env);

    expect(wrongType.status).toBe(415);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "MALFORMED_JSON", stage: "validation" },
    });
  });

  it("does not accept a content type that only starts like multipart", async () => {
    const response = await createWorker().fetch(
      new Request("https://bee-do.example/v1/captures", {
        method: "POST",
        headers: {
          authorization: `Bearer ${SECRET}`,
          "content-type": "multipart/form-data-pretend",
        },
        body: "not multipart",
      }),
      env,
    );

    expect(response.status).toBe(415);
  });

  it("rejects a declared payload larger than 10 MB before reading it", async () => {
    const response = await createWorker().fetch(
      request(capture(), {
        headers: { "content-length": String(MAX_CAPTURE_REQUEST_BYTES + 1) },
      }),
      env,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "REQUEST_TOO_LARGE", stage: "request" },
    });
  });

  it("enforces the streaming body cap when content-length is absent", async () => {
    const oversized = new Uint8Array(MAX_CAPTURE_REQUEST_BYTES + 1);
    const oversizedRequest = new Request("https://bee-do.example/v1/captures", {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "multipart/form-data; boundary=stream-test",
      },
      body: oversized,
    });
    expect(oversizedRequest.headers.get("content-length")).toBeNull();

    const response = await createWorker().fetch(oversizedRequest, env);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "REQUEST_TOO_LARGE", stage: "request" },
    });
  });

  it("returns SERVICE_MISCONFIGURED when CAPTURE_INGEST_SECRET is missing", async () => {
    const { CAPTURE_INGEST_SECRET: _secret, ...brokenEnv } = env;
    const response = await createWorker().fetch(request(), brokenEnv);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "SERVICE_MISCONFIGURED", stage: "configuration", retryable: false },
    });
  });

  it("returns SERVICE_MISCONFIGURED when SLACK_BOT_TOKEN is missing", async () => {
    const { SLACK_BOT_TOKEN: _token, ...brokenEnv } = env;
    const response = await createWorker().fetch(request(), brokenEnv);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: { code: "SERVICE_MISCONFIGURED", stage: "configuration", retryable: false },
    });
  });

  it("rejects a capture whose page and project contract is invalid", async () => {
    const invalid = capture();
    invalid.page.url = "https://unrelated.vercel.app/dashboard?mode=focus";
    const response = await createWorker().fetch(request(invalid), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      ok: false,
      captureId: CAPTURE_ID,
      error: {
        code: "INVALID_CAPTURE",
        stage: "validation",
        message: "Capture payload failed validation at page.url",
        retryable: false,
      },
    });
  });

  it("returns a stable error for unsupported Capture schema versions", async () => {
    const unsupported = { ...capture(), schemaVersion: 2 };
    const response = await createWorker().fetch(request(unsupported), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: {
        code: "UNSUPPORTED_SCHEMA_VERSION",
        stage: "validation",
        retryable: false,
      },
    });
  });

  it("rejects a malformed image signature", async () => {
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const metadata = capture(bytes);
    const response = await createWorker().fetch(request(metadata, { image: bytes }), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_IMAGE", stage: "validation", retryable: false },
    });
  });

  it("accepts a real JPEG part end-to-end", async () => {
    const slack = slackMock();
    const metadata = capture(JPEG_BYTES, "image/jpeg");
    const response = await createWorker({ fetcher: slack.fetcher }).fetch(
      request(metadata, { image: JPEG_BYTES, mimeType: "image/jpeg" }),
      env,
    );

    expect(response.status).toBe(201);
    expect(jsonBody(slack.calls[3]!)).toMatchObject({
      filename: `capture-${CAPTURE_ID}.jpg`,
      length: JPEG_BYTES.byteLength,
    });
    expect(slack.calls[4]!.init?.headers).toEqual({ "content-type": "image/jpeg" });
  });

  it("rejects a mismatched declared and actual image size", async () => {
    const metadata = capture();
    metadata.image.byteLength += 1;
    const response = await createWorker().fetch(request(metadata), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_IMAGE", stage: "validation" },
    });
  });

  it("rejects a multipart image type that disagrees with metadata", async () => {
    const metadata = capture();
    const response = await createWorker().fetch(request(metadata, { mimeType: "image/jpeg" }), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_IMAGE", stage: "validation" },
    });
  });

  it("returns the image-specific 413 for an oversized image part", async () => {
    const oversized = new Uint8Array(MAX_IMAGE_BYTES + 1);
    oversized.set(PNG_BYTES.subarray(0, 8));
    const metadata = capture();
    metadata.image.byteLength = MAX_IMAGE_BYTES;
    const response = await createWorker().fetch(request(metadata, { image: oversized }), env);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "IMAGE_TOO_LARGE", stage: "validation", retryable: false },
    });
  });
});

describe("request channel names", () => {
  it("keeps the stable capture fragment across retry attempts", () => {
    expect(buildChannelName(capture(), "a1b2")).toBe("bee-trellium-dashboard-c773afc4-a1b2");
    expect(buildChannelName(capture(), "c3d4")).toBe("bee-trellium-dashboard-c773afc4-c3d4");
  });

  it("sanitizes and truncates route slugs to Slack's 80-character limit", () => {
    const longRoute = capture();
    longRoute.page.path = `/${"A strange route/".repeat(20)}`;

    const name = buildChannelName(longRoute, "face");

    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toMatch(/^bee-trellium-[a-z0-9-]+-c773afc4-face$/);
  });
});

describe("diagnostics", () => {
  it("preserves newest entries and reserves room for clicks", () => {
    const noisy = capture();
    noisy.diagnostics.console = Array.from({ length: 25 }, (_, index) => ({
      level: "error",
      message: `console-${String(index).padStart(2, "0")}-${"x".repeat(1_150)}`,
      occurredAt: `2026-07-29T11:${String(index).padStart(2, "0")}:00.000Z`,
    }));
    noisy.diagnostics.clicks = Array.from({ length: 12 }, (_, index) => ({
      selector: `button[data-index="${index}"]${"y".repeat(450)}`,
      text: `click-${String(index).padStart(2, "0")}`,
      occurredAt: `2026-07-29T11:${String(index + 30).padStart(2, "0")}:00.000Z`,
    }));

    const message = buildDiagnosticsMessage(noisy);

    expect(message).not.toBeNull();
    expect(message!.length).toBeLessThanOrEqual(3_500);
    expect(message).toContain("console-24");
    expect(message).not.toContain("console-00");
    expect(message).toContain('data-index="11"');
    expect(message).not.toContain('data-index="0"');
    expect(message).toMatch(/earlier entries omitted/);
    expect(message!.indexOf("console-23")).toBeLessThan(message!.indexOf("console-24"));
  });
});

describe("Slack delivery", () => {
  it("creates the request channel, thread artifacts, and permalink", async () => {
    const slack = slackMock();
    const logs: DeliveryLog[] = [];
    const dependencies: WorkerDependencies = {
      fetcher: slack.fetcher,
      makeAttempt: () => "cafe",
      log: (entry) => logs.push(entry),
    };
    const response = await createWorker(dependencies).fetch(request(), env);
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      ok: true,
      captureId: CAPTURE_ID,
      slack: {
        channelId: "C12345678",
        channelName: "bee-trellium-dashboard-c773afc4-cafe",
        rootTs: "100.200",
        permalink: "https://test.slack.com/archives/C12345678/p100200",
      },
      warnings: [],
    });

    expect(slack.calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/api/conversations.create",
      "/api/conversations.invite",
      "/api/chat.postMessage",
      "/api/files.getUploadURLExternal",
      "/upload",
      "/api/files.completeUploadExternal",
      "/api/chat.postMessage",
      "/api/chat.getPermalink",
    ]);
    expect(jsonBody(slack.calls[0]!)).toMatchObject({
      name: "bee-trellium-dashboard-c773afc4-cafe",
      is_private: false,
    });
    expect(jsonBody(slack.calls[1]!)).toMatchObject({
      channel: "C12345678",
      users: "U12345678,U99999999",
      force: true,
    });
    const rootBody = JSON.stringify(jsonBody(slack.calls[2]!));
    expect(rootBody).toContain("Update the hero heading");
    expect(rootBody).toContain("<@U12345678>");
    expect(rootBody).toContain("https://trellium.ai/dashboard?mode=focus");
    expect(rootBody).toContain("1440×900 @2x");
    expect(rootBody).toContain(CAPTURE_ID);
    expect(jsonBody(slack.calls[3]!)).toMatchObject({
      filename: `capture-${CAPTURE_ID}.png`,
      length: PNG_BYTES.byteLength,
      alt_txt: `Rendered page capture for Bee-do request ${CAPTURE_ID}`,
    });
    expect(slack.calls[4]!.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "image/png" },
      body: expect.any(ArrayBuffer),
    });
    expect(jsonBody(slack.calls[5]!)).toMatchObject({
      files: [{ id: "F12345678", title: `Annotated capture ${CAPTURE_ID}` }],
      channel_id: "C12345678",
      thread_ts: "100.200",
    });
    expect(JSON.stringify(jsonBody(slack.calls[6]!))).toContain("Capture diagnostics");
    const permalinkCall = slack.calls[7]!;
    const permalinkUrl = new URL(permalinkCall.url);
    expect(permalinkCall.init?.method).toBe("GET");
    expect(permalinkCall.init?.body).toBeUndefined();
    expect(Object.fromEntries(permalinkUrl.searchParams)).toEqual({
      channel: "C12345678",
      message_ts: "100.200",
    });

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain("Update the hero heading");
    expect(serializedLogs).not.toContain(PNG_BASE64);
    expect(serializedLogs).not.toContain(SECRET);
    expect(serializedLogs).toContain(CAPTURE_ID);
  });

  it("clamps every block text value for a long page URL", async () => {
    const slack = slackMock();
    const long = capture();
    long.page.search = `?q=${"x".repeat(1_987)}`;
    long.page.url = `https://trellium.ai${long.page.path}${long.page.search}`;
    const response = await createWorker({ fetcher: slack.fetcher }).fetch(request(long), env);

    expect(response.status).toBe(201);
    const root = jsonBody(slack.calls[2]!);
    expect(root.text).toContain(long.page.url);
    expect((root.text as string).length).toBeLessThanOrEqual(SLACK_MESSAGE_TEXT_MAX);
    const blocks = root.blocks as Array<Record<string, unknown>>;
    for (const block of blocks) {
      const text = (block.text as { text?: string } | undefined)?.text;
      if (text !== undefined) {
        expect(text.length).toBeLessThanOrEqual(
          block.type === "header" ? SLACK_HEADER_TEXT_MAX : SLACK_SECTION_TEXT_MAX,
        );
      }
      for (const field of (block.fields as Array<{ text: string }> | undefined) ?? []) {
        expect(field.text.length).toBeLessThanOrEqual(SLACK_FIELD_TEXT_MAX);
      }
      for (const element of (block.elements as Array<{ text: string }> | undefined) ?? []) {
        expect(element.text.length).toBeLessThanOrEqual(SLACK_CONTEXT_TEXT_MAX);
      }
    }
  });

  it("returns non-fatal warnings for invite and diagnostics failures", async () => {
    const slack = slackMock({ failInvite: true, failDiagnostics: true });
    const response = await createWorker({
      fetcher: slack.fetcher,
      makeAttempt: () => "beef",
    }).fetch(request(), env);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      ok: true,
      captureId: CAPTURE_ID,
      warnings: ["INVITE_FAILED", "DIAGNOSTICS_POST_FAILED"],
    });
  });

  it("warns about invalid reviewers while inviting valid, deduplicated members", async () => {
    const slack = slackMock();
    const response = await createWorker({
      fetcher: slack.fetcher,
      makeAttempt: () => "bead",
    }).fetch(request(), {
      ...env,
      SLACK_REVIEWER_IDS: "not-a-member,U99999999,U99999999",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ warnings: ["INVALID_REVIEWER_ID"] });
    expect(jsonBody(slack.calls[1]!)).toMatchObject({ users: "U12345678,U99999999" });
  });

  it.each([
    ["conversations.create", "channel_create", "CHANNEL_CREATE_FAILED"],
    ["chat.postMessage", "root_message", "ROOT_MESSAGE_FAILED"],
    ["files.getUploadURLExternal", "image_upload", "IMAGE_UPLOAD_FAILED"],
    ["external_upload", "image_upload", "IMAGE_UPLOAD_FAILED"],
    ["files.completeUploadExternal", "image_upload", "IMAGE_UPLOAD_FAILED"],
    ["chat.getPermalink", "permalink", "PERMALINK_FAILED"],
  ])("fails visibly when required method %s fails", async (failMethod, stage, code) => {
    const slack = slackMock({ failMethod });
    const response = await createWorker({
      fetcher: slack.fetcher,
      makeAttempt: () => "dead",
    }).fetch(request(), env);
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(body).toMatchObject({
      ok: false,
      captureId: CAPTURE_ID,
      error: { code, stage, retryable: true },
    });
    if (stage !== "channel_create") {
      expect(body).toMatchObject({
        slack: {
          channelId: "C12345678",
          channelName: "bee-trellium-dashboard-c773afc4-dead",
        },
      });
    }
  });

  it("logs stable and Slack error codes without sensitive Capture content", async () => {
    const slack = slackMock({ failMethod: "chat.postMessage" });
    const logs: DeliveryLog[] = [];
    const response = await createWorker({
      fetcher: slack.fetcher,
      log: (entry) => logs.push(entry),
    }).fetch(request(), env);

    expect(response.status).toBe(502);
    expect(logs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          stage: "root_message",
          outcome: "error",
          code: "ROOT_MESSAGE_FAILED",
          slackMethod: "chat.postMessage",
          slackCode: "test_failure",
          httpStatus: 200,
        }),
      ]),
    );
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toContain("Update the hero heading");
    expect(serialized).not.toContain(PNG_BASE64);
    expect(serialized).not.toContain(SECRET);
  });
});
