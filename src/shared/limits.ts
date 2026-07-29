// Transport limits. The Capture request is multipart/form-data: a JSON metadata part and a
// raw image part. Nothing is base64-encoded on the wire, so every limit below is an exact
// byte count rather than an estimate derived from an encoded string length.
export const MAX_CAPTURE_REQUEST_BYTES = 10_000_000;
export const MAX_IMAGE_BYTES = 9_000_000;
export const MAX_METADATA_BYTES = 256_000;

export const CAPTURE_METADATA_PART = "capture";
export const CAPTURE_IMAGE_PART = "image";

// Capture content limits.
export const MAX_REQUEST_TEXT = 3_000;
export const MAX_LABEL_TEXT = 160;
export const MAX_PAGE_URL = 8_192;
export const MAX_PAGE_PATH = 2_000;
export const MAX_PAGE_SEARCH = 2_000;
export const MAX_CONSOLE_MESSAGE = 1_200;
export const MAX_CLICK_SELECTOR = 500;
export const MAX_CLICK_TEXT = 200;
export const MAX_CONSOLE_ENTRIES = 25;
export const MAX_CLICK_ENTRIES = 12;

// Slack Block Kit limits. Exceeding any of these makes chat.postMessage fail wholesale with
// invalid_blocks, which would strand an already-created Request Channel.
export const SLACK_HEADER_TEXT_MAX = 150;
export const SLACK_SECTION_TEXT_MAX = 3_000;
export const SLACK_FIELD_TEXT_MAX = 2_000;
export const SLACK_CONTEXT_TEXT_MAX = 3_000;
export const SLACK_MESSAGE_TEXT_MAX = 40_000;
export const SLACK_CHANNEL_NAME_MAX = 80;

/** Shortens `value` to `max` characters, marking the cut with an ellipsis. */
export function truncate(value: string, max: number): string {
  if (max <= 0) return "";
  if (value.length <= max) return value;
  if (max === 1) return "…";
  return `${value.slice(0, max - 1)}…`;
}
