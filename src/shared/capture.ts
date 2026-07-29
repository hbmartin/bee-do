import { z } from "zod";

import {
  MAX_CLICK_ENTRIES,
  MAX_CLICK_SELECTOR,
  MAX_CLICK_TEXT,
  MAX_CONSOLE_ENTRIES,
  MAX_CONSOLE_MESSAGE,
  MAX_IMAGE_BYTES,
  MAX_PAGE_PATH,
  MAX_PAGE_SEARCH,
  MAX_PAGE_URL,
  MAX_REQUEST_TEXT,
} from "./limits";
import { resolveProject, TRELLIUM_PROJECT } from "./projects";

export {
  CAPTURE_IMAGE_PART,
  CAPTURE_METADATA_PART,
  MAX_CAPTURE_REQUEST_BYTES,
  MAX_IMAGE_BYTES,
  MAX_LABEL_TEXT,
  MAX_METADATA_BYTES,
  MAX_REQUEST_TEXT,
  truncate,
} from "./limits";

const CAPTURE_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * The single source of truth for Capture ID shape. The Worker needs this before validation
 * runs so that a rejected Capture can still be correlated in its error response and logs.
 */
export function isCaptureId(value: unknown): value is string {
  return typeof value === "string" && CAPTURE_ID_PATTERN.test(value);
}

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg"] as const;
export type ImageMimeType = (typeof IMAGE_MIME_TYPES)[number];

export const consoleEntrySchema = z
  .object({
    level: z.string().trim().min(1).max(32),
    message: z.string().max(MAX_CONSOLE_MESSAGE),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const clickEntrySchema = z
  .object({
    selector: z.string().max(MAX_CLICK_SELECTOR),
    text: z.string().max(MAX_CLICK_TEXT),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const captureV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    captureId: z.string().refine(isCaptureId, { message: "Capture ID must be a UUID" }),
    capturedAt: z.iso.datetime(),
    request: z.object({ text: z.string().trim().min(1).max(MAX_REQUEST_TEXT) }).strict(),
    requester: z.object({ slackUserId: z.string().regex(/^[UW][A-Z0-9]{8,}$/) }).strict(),
    project: z.object({ slug: z.literal(TRELLIUM_PROJECT) }).strict(),
    page: z
      .object({
        url: z.url().max(MAX_PAGE_URL),
        path: z.string().startsWith("/").max(MAX_PAGE_PATH),
        search: z.string().max(MAX_PAGE_SEARCH),
        title: z.string().max(500),
        viewport: z
          .object({
            width: z.number().int().positive().max(32_768),
            height: z.number().int().positive().max(32_768),
          })
          .strict(),
        devicePixelRatio: z.number().positive().max(8),
      })
      .strict(),
    // The bytes travel in a separate multipart part; this describes them so the Worker can
    // reject a mismatch before spending a Slack call on it.
    image: z
      .object({
        mimeType: z.enum(IMAGE_MIME_TYPES),
        byteLength: z.number().int().positive().max(MAX_IMAGE_BYTES),
        annotated: z.boolean(),
        // Recorded when the extension had to degrade the capture to fit the size budget.
        scale: z.number().positive().max(1).optional(),
        quality: z.number().positive().max(1).optional(),
      })
      .strict(),
    diagnostics: z
      .object({
        console: z.array(consoleEntrySchema).max(MAX_CONSOLE_ENTRIES),
        clicks: z.array(clickEntrySchema).max(MAX_CLICK_ENTRIES),
      })
      .strict(),
  })
  .strict()
  .superRefine((capture, context) => {
    let url: URL;
    try {
      url = new URL(capture.page.url);
    } catch {
      return;
    }

    if (resolveProject(url.href) !== capture.project.slug) {
      context.addIssue({
        code: "custom",
        path: ["page", "url"],
        message: "Page URL is not supported by this project",
      });
    }
    if (url.pathname !== capture.page.path || url.search !== capture.page.search) {
      context.addIssue({
        code: "custom",
        path: ["page"],
        message: "Page path and search must match page.url",
      });
    }
  });

export type CaptureV1 = z.infer<typeof captureV1Schema>;
export type CaptureImage = CaptureV1["image"];
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;
export type ClickEntry = z.infer<typeof clickEntrySchema>;

export type DeliveredChannel = {
  channelId: string;
  channelName: string;
};

export type CaptureSuccess = {
  ok: true;
  captureId: string;
  slack: DeliveredChannel & {
    rootTs: string;
    permalink: string;
  };
  warnings: string[];
};

export type CaptureError = {
  ok: false;
  captureId?: string;
  /**
   * Present when the failure happened after the Request Channel was created. Without it the
   * orphaned channel is untraceable from the response, and only manual log archaeology can
   * connect it back to the Capture.
   */
  slack?: DeliveredChannel;
  error: {
    code: string;
    stage: string;
    message: string;
    retryable: boolean;
  };
};

export type CaptureResponse = CaptureSuccess | CaptureError;
