import type { CaptureSuccess, CaptureV1, DeliveredChannel } from "../shared/capture";
import {
  SLACK_CHANNEL_NAME_MAX,
  SLACK_CONTEXT_TEXT_MAX,
  SLACK_FIELD_TEXT_MAX,
  SLACK_HEADER_TEXT_MAX,
  SLACK_MESSAGE_TEXT_MAX,
  SLACK_SECTION_TEXT_MAX,
  truncate,
} from "../shared/limits";
import { requiredDeliveryError } from "./errors";
import type { DecodedImage } from "./image";
import { describeSlackError, SlackClient } from "./slack";
import type { DeliveryWarning } from "./types";

const SLACK_MEMBER_ID_PATTERN = /^[UW][A-Z0-9]{8,}$/;
const MAX_DIAGNOSTIC_ENTRY = 400;
const CONSOLE_BUDGET = 2_200;
const CLICK_BUDGET = 1_200;
const LINK_LABEL_MAX = 160;
const LINK_COMFORT_MARGIN = 100;

type ChannelResponse = {
  ok: true;
  channel?: { id?: string; name?: string };
};

type MessageResponse = { ok: true; ts?: string };
type UploadUrlResponse = { ok: true; upload_url?: string; file_id?: string };
type PermalinkResponse = { ok: true; permalink?: string };
type Block = Record<string, unknown>;

export type DeliveryLog = {
  captureId: string;
  stage: string;
  durationMs: number;
  outcome: "success" | "warning" | "error";
  channelId?: string;
  channelName?: string;
  rootTs?: string;
  warningCodes?: DeliveryWarning[];
  code?: string;
  slackMethod?: string;
  slackCode?: string;
  httpStatus?: number;
};

export type DeliveryDependencies = {
  slack: SlackClient;
  decodedImage: DecodedImage;
  reviewerIds?: string;
  makeAttempt?: () => string;
  log?: (entry: DeliveryLog) => void;
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
  const availableRouteLength = SLACK_CHANNEL_NAME_MAX - prefix.length - suffix.length;
  return `${prefix}${routeSlug(capture.page.path).slice(0, availableRouteLength)}${suffix}`;
}

function escapeMrkdwn(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function slackLinkUrl(value: string): string {
  return value.replaceAll("|", "%7C").replaceAll("<", "%3C").replaceAll(">", "%3E");
}

function clampTextNode(node: unknown, max: number): unknown {
  if (typeof node !== "object" || node === null) return node;
  const record = node as Record<string, unknown>;
  const value = record["text"];
  if (typeof value !== "string") return node;
  return { ...record, text: truncate(value, max) };
}

/** Applies Slack's text limits as the final guard before every block message is posted. */
export function clampBlocks(blocks: Block[]): Block[] {
  return blocks.map((block) => {
    const next: Block = { ...block };
    const textMax = block["type"] === "header" ? SLACK_HEADER_TEXT_MAX : SLACK_SECTION_TEXT_MAX;
    if (next["text"] !== undefined) next["text"] = clampTextNode(next["text"], textMax);
    if (Array.isArray(next["fields"])) {
      next["fields"] = next["fields"].map((field) => clampTextNode(field, SLACK_FIELD_TEXT_MAX));
    }
    if (Array.isArray(next["elements"])) {
      next["elements"] = next["elements"].map((element) =>
        clampTextNode(element, SLACK_CONTEXT_TEXT_MAX),
      );
    }
    return next;
  });
}

function buildPageField(capture: CaptureV1): string {
  const prefix = "*Page*\n";
  const label = truncate(
    escapeMrkdwn(`${capture.page.path}${capture.page.search || ""}`),
    LINK_LABEL_MAX,
  );
  const linked = `${prefix}<${slackLinkUrl(capture.page.url)}|${label}>`;
  if (linked.length <= SLACK_FIELD_TEXT_MAX - LINK_COMFORT_MARGIN) return linked;

  const plainUrl = escapeMrkdwn(capture.page.url);
  return `${prefix}${truncate(plainUrl, SLACK_FIELD_TEXT_MAX - prefix.length)}`;
}

export function buildRootMessage(capture: CaptureV1): { text: string; blocks: Block[] } {
  const viewport = `${capture.page.viewport.width}×${capture.page.viewport.height} @${capture.page.devicePixelRatio}x`;
  const escapedRequest = escapeMrkdwn(capture.request.text);
  const blocks: Block[] = [
    {
      type: "header",
      text: { type: "plain_text", text: `Bee-do capture · ${capture.project.slug}` },
    },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*Request*\n${escapedRequest}` },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Requester*\n<@${capture.requester.slackUserId}>` },
        { type: "mrkdwn", text: `*Project*\n${capture.project.slug}` },
        { type: "mrkdwn", text: buildPageField(capture) },
        { type: "mrkdwn", text: `*Viewport*\n${viewport}` },
      ],
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `Capture ID: \`${capture.captureId}\`` }],
    },
  ];

  return {
    text: truncate(
      [
        `Bee-do capture ${capture.captureId}`,
        `Requester: <@${capture.requester.slackUserId}>`,
        `Project: ${capture.project.slug}`,
        `Page: ${escapeMrkdwn(capture.page.url)}`,
        `Viewport: ${viewport}`,
        `Request: ${escapedRequest}`,
      ].join("\n"),
      SLACK_MESSAGE_TEXT_MAX,
    ),
    blocks: clampBlocks(blocks),
  };
}

function sanitizeDiagnostic(value: string): string {
  return escapeMrkdwn(
    Array.from(value, (character) => {
      const code = character.charCodeAt(0);
      return code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31) || code === 127
        ? " "
        : character;
    }).join(""),
  );
}

function buildDiagnosticSection<T>(
  title: string,
  entries: readonly T[],
  render: (entry: T) => string,
  budget: number,
): string | null {
  if (entries.length === 0) return null;

  const lines: string[] = [];
  const noticeReserve = 48;
  let used = title.length + 1 + noticeReserve;
  let index = entries.length - 1;
  for (; index >= 0; index -= 1) {
    const line = truncate(render(entries[index]!), MAX_DIAGNOSTIC_ENTRY);
    const cost = line.length + 1;
    if (used + cost > budget) break;
    used += cost;
    lines.unshift(line);
  }

  const omitted = index + 1;
  return [title, ...(omitted > 0 ? [`_… ${omitted} earlier entries omitted_`] : []), ...lines].join(
    "\n",
  );
}

/** Keeps the entries closest to capture while reserving independent console and click budgets. */
export function buildDiagnosticsMessage(capture: CaptureV1): string | null {
  const consoleSection = buildDiagnosticSection(
    "*Console*",
    capture.diagnostics.console,
    (entry) =>
      `• [${sanitizeDiagnostic(entry.level)}] ${sanitizeDiagnostic(entry.message)} _${entry.occurredAt}_`,
    CONSOLE_BUDGET,
  );
  const clickSection = buildDiagnosticSection(
    "*Recent clicks*",
    capture.diagnostics.clicks,
    (entry) => {
      const text = entry.text ? ` — “${sanitizeDiagnostic(entry.text)}”` : "";
      return `• ${sanitizeDiagnostic(entry.selector)}${text} _${entry.occurredAt}_`;
    },
    CLICK_BUDGET,
  );
  if (consoleSection === null && clickSection === null) return null;

  return ["*Capture diagnostics*", consoleSection, clickSection]
    .filter((section): section is string => section !== null)
    .join("\n");
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
      code: `${stage.toUpperCase()}_FAILED`,
      ...context,
      ...describeSlackError(error),
    });
    throw error;
  }
}

export async function publishCapture(
  capture: CaptureV1,
  dependencies: DeliveryDependencies,
): Promise<CaptureSuccess> {
  const deliveryStartedAt = Date.now();
  const { slack, decodedImage: image } = dependencies;
  const log = dependencies.log ?? (() => undefined);
  const warnings: DeliveryWarning[] = [];
  const channelName = buildChannelName(capture, (dependencies.makeAttempt ?? randomAttempt)());

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

  const channel: DeliveredChannel = { channelId, channelName };
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
      ...channel,
      ...(invitees.invalidReviewer ? { warningCodes: ["INVALID_REVIEWER_ID"] } : {}),
    });
  } catch (error) {
    warnings.push("INVITE_FAILED");
    log({
      captureId: capture.captureId,
      stage: "invite",
      durationMs: Date.now() - inviteStartedAt,
      outcome: "warning",
      code: "INVITE_FAILED",
      ...channel,
      warningCodes: ["INVITE_FAILED"],
      ...describeSlackError(error),
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
      channel,
    );
    rootTs = getRequiredString(posted.ts, "root message timestamp");
  } catch (error) {
    throw requiredDeliveryError("root_message", error, channel);
  }

  try {
    await timedStage(
      capture.captureId,
      "image_upload",
      async () => {
        const ticket = await slack.api<UploadUrlResponse>("files.getUploadURLExternal", {
          filename: `capture-${capture.captureId}.${image.extension}`,
          length: image.bytes.byteLength,
          alt_txt: `Rendered page capture for Bee-do request ${capture.captureId}`,
        });
        const uploadUrl = getRequiredString(ticket.upload_url, "upload URL");
        const fileId = getRequiredString(ticket.file_id, "file ID");
        await slack.upload(uploadUrl, image.bytes, image.mimeType);
        await slack.api("files.completeUploadExternal", {
          files: [{ id: fileId, title: `Annotated capture ${capture.captureId}` }],
          channel_id: channelId,
          thread_ts: rootTs,
        });
      },
      log,
      { ...channel, rootTs },
    );
  } catch (error) {
    throw requiredDeliveryError("image_upload", error, channel);
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
        ...channel,
        rootTs,
      });
    } catch (error) {
      warnings.push("DIAGNOSTICS_POST_FAILED");
      log({
        captureId: capture.captureId,
        stage: "diagnostics",
        durationMs: Date.now() - diagnosticsStartedAt,
        outcome: "warning",
        code: "DIAGNOSTICS_POST_FAILED",
        ...channel,
        rootTs,
        warningCodes: ["DIAGNOSTICS_POST_FAILED"],
        ...describeSlackError(error),
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
          { channel: channelId, message_ts: rootTs },
          "GET",
        ),
      log,
      { ...channel, rootTs },
    );
    permalink = getRequiredString(linked.permalink, "message permalink");
  } catch (error) {
    throw requiredDeliveryError("permalink", error, channel);
  }

  log({
    captureId: capture.captureId,
    stage: "delivery",
    durationMs: Date.now() - deliveryStartedAt,
    outcome: warnings.length > 0 ? "warning" : "success",
    ...channel,
    rootTs,
    ...(warnings.length > 0 ? { warningCodes: warnings } : {}),
  });

  return {
    ok: true,
    captureId: capture.captureId,
    slack: { ...channel, rootTs, permalink },
    warnings,
  };
}
