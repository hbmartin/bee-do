import type { CaptureSuccess, CaptureV1 } from "../shared/capture";
import { decodeCaptureImage, type DecodedImage } from "./image";
import { requiredDeliveryError } from "./errors";
import { SlackClient } from "./slack";
import type { DeliveryWarning } from "./types";

const SLACK_MEMBER_ID_PATTERN = /^[UW][A-Z0-9]{8,}$/;
const MAX_CHANNEL_NAME_LENGTH = 80;
const MAX_DIAGNOSTICS_TEXT = 3_500;

type ChannelResponse = {
  ok: true;
  channel?: { id?: string; name?: string };
};

type MessageResponse = { ok: true; ts?: string };
type UploadUrlResponse = { ok: true; upload_url?: string; file_id?: string };
type PermalinkResponse = { ok: true; permalink?: string };

export type DeliveryLog = {
  captureId: string;
  stage: string;
  durationMs: number;
  outcome: "success" | "warning" | "error";
  channelId?: string;
  channelName?: string;
  rootTs?: string;
  warningCodes?: DeliveryWarning[];
};

export type DeliveryDependencies = {
  slack: SlackClient;
  reviewerIds?: string;
  makeAttempt?: () => string;
  log?: (entry: DeliveryLog) => void;
  decodedImage?: DecodedImage;
};

function cleanSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "home"
  );
}

export function routeSlug(path: string): string {
  return cleanSlug(path).slice(0, 53);
}

export function randomAttempt(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(2));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function buildChannelName(capture: CaptureV1, attempt = randomAttempt()): string {
  const attemptSlug = cleanSlug(attempt).slice(0, 4).padEnd(4, "0");
  const id = capture.captureId.replaceAll("-", "").slice(0, 8);
  const suffix = `-${id}-${attemptSlug}`;
  const prefix = `bee-${capture.project.slug}-`;
  const availableRouteLength = MAX_CHANNEL_NAME_LENGTH - prefix.length - suffix.length;
  return `${prefix}${routeSlug(capture.page.path).slice(0, availableRouteLength)}${suffix}`;
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackLinkUrl(value: string): string {
  return value.replaceAll("|", "%7C").replaceAll("<", "%3C").replaceAll(">", "%3E");
}

export function buildRootMessage(capture: CaptureV1): {
  text: string;
  blocks: Array<Record<string, unknown>>;
} {
  const viewport = `${capture.page.viewport.width}×${capture.page.viewport.height} @${capture.page.devicePixelRatio}x`;
  const linkLabel = escapeMrkdwn(
    `${capture.page.path}${capture.page.search || ""}`,
  );
  const escapedRequest = escapeMrkdwn(capture.request.text);
  const blockRequest = escapedRequest.slice(0, 2_988);

  return {
    text: [
      `Bee-do capture ${capture.captureId}`,
      `Requester: <@${capture.requester.slackUserId}>`,
      `Project: ${capture.project.slug}`,
      `Page: ${escapeMrkdwn(capture.page.url)}`,
      `Viewport: ${viewport}`,
      `Request: ${escapedRequest}`,
    ].join("\n"),
    blocks: [
      {
        type: "header",
        text: {
          type: "plain_text",
          text: `Bee-do capture · ${capture.project.slug}`,
        },
      },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Request*\n${blockRequest}`,
        },
      },
      {
        type: "section",
        fields: [
          {
            type: "mrkdwn",
            text: `*Requester*\n<@${capture.requester.slackUserId}>`,
          },
          {
            type: "mrkdwn",
            text: `*Project*\n${capture.project.slug}`,
          },
          {
            type: "mrkdwn",
            text: `*Page*\n<${slackLinkUrl(capture.page.url)}|${linkLabel}>`,
          },
          { type: "mrkdwn", text: `*Viewport*\n${viewport}` },
        ],
      },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `Capture ID: \`${capture.captureId}\`` },
        ],
      },
    ],
  };
}

function sanitizeDiagnostic(value: string): string {
  return escapeMrkdwn(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " "));
}

export function buildDiagnosticsMessage(capture: CaptureV1): string | null {
  if (capture.diagnostics.console.length === 0 && capture.diagnostics.clicks.length === 0) {
    return null;
  }

  const sections: string[] = ["*Capture diagnostics*"];
  if (capture.diagnostics.console.length > 0) {
    sections.push(
      "*Console*",
      ...capture.diagnostics.console.map(
        (entry) =>
          `• [${entry.level}] ${sanitizeDiagnostic(entry.message)} _${entry.occurredAt}_`,
      ),
    );
  }
  if (capture.diagnostics.clicks.length > 0) {
    sections.push(
      "*Recent clicks*",
      ...capture.diagnostics.clicks.map((entry) => {
        const text = entry.text ? ` — “${sanitizeDiagnostic(entry.text)}”` : "";
        return `• ${sanitizeDiagnostic(entry.selector)}${text} _${entry.occurredAt}_`;
      }),
    );
  }

  const message = sections.join("\n");
  return message.length <= MAX_DIAGNOSTICS_TEXT
    ? message
    : `${message.slice(0, MAX_DIAGNOSTICS_TEXT - 14)}\n… truncated`;
}

function parseInvitees(
  capture: CaptureV1,
  reviewerIds: string | undefined,
): { users: string[]; invalidReviewer: boolean } {
  const reviewers = (reviewerIds ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const invalidReviewer = reviewers.some((value) => !SLACK_MEMBER_ID_PATTERN.test(value));
  const valid = reviewers.filter((value) => SLACK_MEMBER_ID_PATTERN.test(value));
  return {
    users: [...new Set([capture.requester.slackUserId, ...valid])],
    invalidReviewer,
  };
}

function getRequiredString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Slack response omitted ${description}`);
  }
  return value;
}

async function timedStage<T>(
  captureId: string,
  stage: string,
  operation: () => Promise<T>,
  log: (entry: DeliveryLog) => void,
  context: Pick<DeliveryLog, "channelId" | "channelName" | "rootTs"> = {},
): Promise<T> {
  const startedAt = Date.now();
  try {
    const result = await operation();
    log({
      captureId,
      stage,
      durationMs: Date.now() - startedAt,
      outcome: "success",
      ...context,
    });
    return result;
  } catch (error) {
    log({
      captureId,
      stage,
      durationMs: Date.now() - startedAt,
      outcome: "error",
      ...context,
    });
    throw error;
  }
}

export async function publishCapture(
  capture: CaptureV1,
  dependencies: DeliveryDependencies,
): Promise<CaptureSuccess> {
  const deliveryStartedAt = Date.now();
  const { slack } = dependencies;
  const log = dependencies.log ?? (() => undefined);
  const warnings: DeliveryWarning[] = [];
  const channelName = buildChannelName(
    capture,
    (dependencies.makeAttempt ?? randomAttempt)(),
  );
  const image = dependencies.decodedImage ?? decodeCaptureImage(capture.image.dataUrl);

  let channelId: string;
  try {
    const created = await timedStage(
      capture.captureId,
      "channel_create",
      () =>
        slack.api<ChannelResponse>("conversations.create", {
          name: channelName,
          is_private: false,
        }),
      log,
      { channelName },
    );
    channelId = getRequiredString(created.channel?.id, "channel ID");
  } catch (error) {
    throw requiredDeliveryError("channel_create", error);
  }

  const invitees = parseInvitees(capture, dependencies.reviewerIds);
  if (invitees.invalidReviewer) warnings.push("INVALID_REVIEWER_ID");
  const inviteStartedAt = Date.now();
  try {
    await slack.api("conversations.invite", {
      channel: channelId,
      users: invitees.users.join(","),
      force: true,
    });
    log({
      captureId: capture.captureId,
      stage: "invite",
      durationMs: Date.now() - inviteStartedAt,
      outcome: invitees.invalidReviewer ? "warning" : "success",
      channelId,
      channelName,
      ...(invitees.invalidReviewer
        ? { warningCodes: ["INVALID_REVIEWER_ID"] }
        : {}),
    });
  } catch {
    warnings.push("INVITE_FAILED");
    log({
      captureId: capture.captureId,
      stage: "invite",
      durationMs: Date.now() - inviteStartedAt,
      outcome: "warning",
      channelId,
      channelName,
      warningCodes: ["INVITE_FAILED"],
    });
  }

  let rootTs: string;
  try {
    const message = buildRootMessage(capture);
    const posted = await timedStage(
      capture.captureId,
      "root_message",
      () =>
        slack.api<MessageResponse>("chat.postMessage", {
          channel: channelId,
          text: message.text,
          blocks: message.blocks,
          unfurl_links: false,
          unfurl_media: false,
        }),
      log,
      { channelId, channelName },
    );
    rootTs = getRequiredString(posted.ts, "root message timestamp");
  } catch (error) {
    throw requiredDeliveryError("root_message", error);
  }

  try {
    await timedStage(
      capture.captureId,
      "image_upload",
      async () => {
        const ticket = await slack.api<UploadUrlResponse>(
          "files.getUploadURLExternal",
          {
            filename: `capture-${capture.captureId}.${image.extension}`,
            length: image.bytes.byteLength,
            alt_txt: `Rendered page capture for Bee-do request ${capture.captureId}`,
          },
        );
        const uploadUrl = getRequiredString(ticket.upload_url, "upload URL");
        const fileId = getRequiredString(ticket.file_id, "file ID");
        await slack.upload(uploadUrl, image.bytes, image.mimeType);
        await slack.api("files.completeUploadExternal", {
          files: [
            {
              id: fileId,
              title: `Annotated capture ${capture.captureId}`,
            },
          ],
          channel_id: channelId,
          thread_ts: rootTs,
        });
      },
      log,
      { channelId, channelName, rootTs },
    );
  } catch (error) {
    throw requiredDeliveryError("image_upload", error);
  }

  const diagnostics = buildDiagnosticsMessage(capture);
  if (diagnostics !== null) {
    const diagnosticsStartedAt = Date.now();
    try {
      await slack.api("chat.postMessage", {
        channel: channelId,
        thread_ts: rootTs,
        text: diagnostics,
        unfurl_links: false,
        unfurl_media: false,
      });
      log({
        captureId: capture.captureId,
        stage: "diagnostics",
        durationMs: Date.now() - diagnosticsStartedAt,
        outcome: "success",
        channelId,
        channelName,
        rootTs,
      });
    } catch {
      warnings.push("DIAGNOSTICS_POST_FAILED");
      log({
        captureId: capture.captureId,
        stage: "diagnostics",
        durationMs: Date.now() - diagnosticsStartedAt,
        outcome: "warning",
        channelId,
        channelName,
        rootTs,
        warningCodes: ["DIAGNOSTICS_POST_FAILED"],
      });
    }
  }

  let permalink: string;
  try {
    const linked = await timedStage(
      capture.captureId,
      "permalink",
      () =>
        slack.api<PermalinkResponse>(
          "chat.getPermalink",
          {
            channel: channelId,
            message_ts: rootTs,
          },
          "GET",
        ),
      log,
      { channelId, channelName, rootTs },
    );
    permalink = getRequiredString(linked.permalink, "message permalink");
  } catch (error) {
    throw requiredDeliveryError("permalink", error);
  }

  log({
    captureId: capture.captureId,
    stage: "delivery",
    durationMs: Date.now() - deliveryStartedAt,
    outcome: warnings.length > 0 ? "warning" : "success",
    channelId,
    channelName,
    rootTs,
    ...(warnings.length > 0 ? { warningCodes: warnings } : {}),
  });

  return {
    ok: true,
    captureId: capture.captureId,
    slack: { channelId, channelName, rootTs, permalink },
    warnings,
  };
}
