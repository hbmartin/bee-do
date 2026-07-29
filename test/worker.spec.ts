import { describe, expect, it } from "vitest";

import {
  MAX_CAPTURE_BODY_BYTES,
  MAX_IMAGE_BYTES,
} from "../src/shared/capture";
import { buildChannelName } from "../src/worker/delivery";
import { createWorker, type WorkerDependencies } from "../src/worker";
import type { Env, Fetcher } from "../src/worker/types";

const CAPTURE_ID = "c773afc4-f923-47ad-b1c1-ceffa1f4e5af";
const SECRET = "test-ingest-secret";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=";

const env: Env = {
  CAPTURE_INGEST_SECRET: SECRET,
  SLACK_BOT_TOKEN: "xoxb-test",
  SLACK_REVIEWER_IDS: "U12345678,U99999999,U99999999",
};

function capture() {
  return {
    schemaVersion: 1 as const,
    captureId: CAPTURE_ID,
    capturedAt: "2026-07-29T12:00:00.000Z",
    request: { text: "Update the hero heading" },
    requester: { slackUserId: "U12345678" },
    project: { slug: "trellium" as const },
    page: {
      url: "https://trellium.ai/dashboard?mode=focus",
      path: "/dashboard",
      search: "?mode=focus",
      title: "Dashboard",
      viewport: { width: 1_440, height: 900 },
      devicePixelRatio: 2,
    },
    image: { dataUrl: PNG, annotated: true },
    diagnostics: {
      console: [
        {
          level: "warn" as const,
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

function request(body: unknown = capture(), headers: HeadersInit = {}): Request {
  return new Request("https://bee-do.example/v1/captures", {
    method: "POST",
    headers: {
      authorization: `Bearer ${SECRET}`,
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function imageDataUrlForBytes(byteLength: number): string {
  const completeGroups = Math.floor(byteLength / 3);
  const remainder = byteLength % 3;
  const tail = remainder === 1 ? "AA==" : remainder === 2 ? "AAA=" : "";
  return `data:image/png;base64,${"AAAA".repeat(completeGroups)}${tail}`;
}

type RecordedCall = { url: string; init?: RequestInit };

function slackMock(options: {
  failMethod?: string;
  failDiagnostics?: boolean;
  failInvite?: boolean;
} = {}): { fetcher: Fetcher; calls: RecordedCall[] } {
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
    if (shouldFail) {
      return Response.json({ ok: false, error: "test_failure" });
    }

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
    const response = await createWorker().fetch(
      new Request("https://bee-do.example/healthz"),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects unknown routes and unsupported methods", async () => {
    const worker = createWorker();
    const missing = await worker.fetch(new Request("https://bee-do.example/nope"), env);
    const wrongMethod = await worker.fetch(
      new Request("https://bee-do.example/v1/captures"),
      env,
    );

    expect(missing.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
  });

  it("requires the configured bearer token", async () => {
    const response = await createWorker().fetch(
      new Request("https://bee-do.example/v1/captures", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(capture()),
      }),
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED", stage: "authentication", retryable: false },
    });
  });

  it("requires JSON and rejects malformed JSON", async () => {
    const wrongType = await createWorker().fetch(
      request("{}", { "content-type": "text/plain" }),
      env,
    );
    const malformed = await createWorker().fetch(request("{"), env);

    expect(wrongType.status).toBe(415);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: { code: "MALFORMED_JSON", stage: "validation" },
    });
  });

  it("does not accept a content type that only starts like JSON", async () => {
    const response = await createWorker().fetch(
      request("{}", { "content-type": "application/json-pretend" }),
      env,
    );

    expect(response.status).toBe(415);
  });

  it("rejects a declared payload larger than 8 MiB before reading it", async () => {
    const response = await createWorker().fetch(
      request("{}", { "content-length": String(MAX_CAPTURE_BODY_BYTES + 1) }),
      env,
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "REQUEST_TOO_LARGE", stage: "request" },
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
      error: { code: "INVALID_CAPTURE", stage: "validation", retryable: false },
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

  it("rejects a malformed image even when its data URL and base64 are well formed", async () => {
    const invalid = capture();
    invalid.image.dataUrl = "data:image/png;base64,AA==";
    const response = await createWorker().fetch(request(invalid), env);

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "INVALID_IMAGE", stage: "validation", retryable: false },
    });
  });

  it("returns the image-specific 413 error for decoded images over 5 MiB", async () => {
    const oversized = capture();
    oversized.image.dataUrl = imageDataUrlForBytes(MAX_IMAGE_BYTES + 1);
    const response = await createWorker().fetch(request(oversized), env);

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: { code: "IMAGE_TOO_LARGE", stage: "validation", retryable: false },
    });
  });

});

describe("request channel names", () => {
  it("keeps the stable capture fragment across retry attempts", () => {
    const first = buildChannelName(capture(), "a1b2");
    const retry = buildChannelName(capture(), "c3d4");

    expect(first).toBe("bee-trellium-dashboard-c773afc4-a1b2");
    expect(retry).toBe("bee-trellium-dashboard-c773afc4-c3d4");
  });

  it("sanitizes and truncates route slugs to Slack's 80-character limit", () => {
    const longRoute = capture();
    longRoute.page.path = `/${"A strange route/".repeat(20)}`;

    const name = buildChannelName(longRoute, "face");

    expect(name.length).toBeLessThanOrEqual(80);
    expect(name).toMatch(/^bee-trellium-[a-z0-9-]+-c773afc4-face$/);
  });
});

describe("Slack delivery", () => {
  it("creates the request channel, thread artifacts, and permalink", async () => {
    const slack = slackMock();
    const logs: unknown[] = [];
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
    expect(slack.calls.map((call) => new URL(call.url).origin)).toEqual([
      "https://slack.com/api/conversations.create",
      "https://slack.com/api/conversations.invite",
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/files.getUploadURLExternal",
      "https://files.slack.test/upload",
      "https://slack.com/api/files.completeUploadExternal",
      "https://slack.com/api/chat.postMessage",
      "https://slack.com/api/chat.getPermalink",
    ].map((url) => new URL(url).origin));

    expect(jsonBody(slack.calls[0]!)).toMatchObject({
      name: "bee-trellium-dashboard-c773afc4-cafe",
      is_private: false,
    });
    expect(jsonBody(slack.calls[1]!)).toMatchObject({
      channel: "C12345678",
      users: "U12345678,U99999999",
      force: true,
    });
    expect(jsonBody(slack.calls[2]!)).toMatchObject({
      channel: "C12345678",
      unfurl_links: false,
    });
    const rootBody = JSON.stringify(jsonBody(slack.calls[2]!));
    expect(rootBody).toContain("Update the hero heading");
    expect(rootBody).toContain("<@U12345678>");
    expect(rootBody).toContain("https://trellium.ai/dashboard?mode=focus");
    expect(rootBody).toContain("1440×900 @2x");
    expect(rootBody).toContain(CAPTURE_ID);
    expect(jsonBody(slack.calls[3]!)).toMatchObject({
      filename: `capture-${CAPTURE_ID}.png`,
      length: expect.any(Number),
      alt_txt: `Rendered page capture for Bee-do request ${CAPTURE_ID}`,
    });
    expect(slack.calls[4]!.init).toMatchObject({
      method: "POST",
      headers: { "content-type": "image/png" },
      body: expect.any(ArrayBuffer),
    });
    expect(jsonBody(slack.calls[5]!)).toMatchObject({
      files: [
        {
          id: "F12345678",
          title: `Annotated capture ${CAPTURE_ID}`,
        },
      ],
      channel_id: "C12345678",
      thread_ts: "100.200",
    });
    expect(jsonBody(slack.calls[6]!)).toMatchObject({
      channel: "C12345678",
      thread_ts: "100.200",
      unfurl_links: false,
      unfurl_media: false,
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
    expect(serializedLogs).not.toContain("data:image");
    expect(serializedLogs).toContain(CAPTURE_ID);
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

  it("warns about invalid reviewers while still inviting valid, deduplicated members", async () => {
    const slack = slackMock();
    const response = await createWorker({
      fetcher: slack.fetcher,
      makeAttempt: () => "bead",
    }).fetch(request(), {
      ...env,
      SLACK_REVIEWER_IDS: "not-a-member,U99999999,U99999999",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      warnings: ["INVALID_REVIEWER_ID"],
    });
    expect(jsonBody(slack.calls[1]!)).toMatchObject({
      users: "U12345678,U99999999",
    });
  });

  it.each([
    ["conversations.create", "channel_create", "CHANNEL_CREATE_FAILED"],
    ["chat.postMessage", "root_message", "ROOT_MESSAGE_FAILED"],
    ["files.getUploadURLExternal", "image_upload", "IMAGE_UPLOAD_FAILED"],
    ["external_upload", "image_upload", "IMAGE_UPLOAD_FAILED"],
    ["files.completeUploadExternal", "image_upload", "IMAGE_UPLOAD_FAILED"],
    ["chat.getPermalink", "permalink", "PERMALINK_FAILED"],
  ])(
    "fails visibly when required method %s fails",
    async (failMethod, stage, code) => {
      const slack = slackMock({ failMethod });
      const response = await createWorker({
        fetcher: slack.fetcher,
        makeAttempt: () => "dead",
      }).fetch(request(), env);

      expect(response.status).toBe(502);
      expect(await response.json()).toMatchObject({
        ok: false,
        captureId: CAPTURE_ID,
        error: { code, stage, retryable: true },
      });
    },
  );
});
