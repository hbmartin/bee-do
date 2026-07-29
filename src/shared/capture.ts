import { z } from "zod";

import {
  decodedImageBytes,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_REQUEST_TEXT,
} from "./limits";
import { resolveProject, TRELLIUM_PROJECT } from "./projects";

export {
  decodedImageBytes,
  MAX_CAPTURE_BODY_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DATA_URL_CHARS,
  MAX_LABEL_TEXT,
  MAX_REQUEST_TEXT,
} from "./limits";

export const consoleEntrySchema = z
  .object({
    level: z.string().trim().min(1).max(32),
    message: z.string().max(1_200),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const clickEntrySchema = z
  .object({
    selector: z.string().max(500),
    text: z.string().max(200),
    occurredAt: z.iso.datetime(),
  })
  .strict();

export const captureV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    captureId: z.uuid(),
    capturedAt: z.iso.datetime(),
    request: z
      .object({ text: z.string().trim().min(1).max(MAX_REQUEST_TEXT) })
      .strict(),
    requester: z
      .object({ slackUserId: z.string().regex(/^[UW][A-Z0-9]{8,}$/) })
      .strict(),
    project: z.object({ slug: z.literal(TRELLIUM_PROJECT) }).strict(),
    page: z
      .object({
        url: z.url(),
        path: z.string().startsWith("/").max(2_000),
        search: z.string().max(2_000),
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
    image: z
      .object({
        dataUrl: z
          .string()
          .max(MAX_IMAGE_DATA_URL_CHARS)
          .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/)
          .refine((value) => decodedImageBytes(value) <= MAX_IMAGE_BYTES, {
            message: "Decoded image exceeds 5 MiB",
          }),
        annotated: z.boolean(),
      })
      .strict(),
    diagnostics: z
      .object({
        console: z.array(consoleEntrySchema).max(25),
        clicks: z.array(clickEntrySchema).max(12),
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
export type ConsoleEntry = z.infer<typeof consoleEntrySchema>;
export type ClickEntry = z.infer<typeof clickEntrySchema>;

export type CaptureSuccess = {
  ok: true;
  captureId: string;
  slack: {
    channelId: string;
    channelName: string;
    rootTs: string;
    permalink: string;
  };
  warnings: string[];
};

export type CaptureError = {
  ok: false;
  captureId?: string;
  error: {
    code: string;
    stage: string;
    message: string;
    retryable: boolean;
  };
};

export type CaptureResponse = CaptureSuccess | CaptureError;
