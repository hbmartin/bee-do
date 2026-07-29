import { describe, expect, it } from "vitest";

import {
  captureV1Schema,
  type CaptureV1,
  type ClickEntry,
  type ConsoleEntry,
  MAX_IMAGE_BYTES,
  MAX_REQUEST_TEXT,
} from "../src/shared/capture";
import { isSupportedPage, resolveProject, TRELLIUM_PROJECT } from "../src/shared/projects";
import { buildCapture } from "../extension/src/capture";
import {
  clampNormalizedPoint,
  clampOffset,
  containRect,
  normalizePoint,
} from "../extension/src/geometry";
import { normalizeHttpsUrl } from "../extension/src/url";

const CAPTURE_ID = "c773afc4-f923-47ad-b1c1-ceffa1f4e5af";
const CAPTURED_AT = "2026-07-29T12:00:00.000Z";

function makeCapture(): CaptureV1 {
  return {
    schemaVersion: 1 as const,
    captureId: CAPTURE_ID,
    capturedAt: CAPTURED_AT,
    request: { text: "Update the hero heading" },
    requester: { slackUserId: "U12345678" },
    project: { slug: TRELLIUM_PROJECT },
    page: {
      url: "https://trellium.ai/dashboard?mode=focus",
      path: "/dashboard",
      search: "?mode=focus",
      title: "Trellium dashboard",
      viewport: { width: 1_440, height: 900 },
      devicePixelRatio: 2,
    },
    image: {
      mimeType: "image/png" as const,
      byteLength: 68,
      annotated: true,
    },
    diagnostics: {
      console: [] as ConsoleEntry[],
      clicks: [] as ClickEntry[],
    },
  };
}

function makeConsoleEntry(index: number) {
  return {
    level: "warn" as const,
    message: `warning ${index}`,
    occurredAt: CAPTURED_AT,
  };
}

function makeClickEntry(index: number) {
  return {
    selector: `button:nth-of-type(${index + 1})`,
    text: `Button ${index}`,
    occurredAt: CAPTURED_AT,
  };
}

describe("project resolution", () => {
  it("accepts the exact trellium.ai HTTPS host", () => {
    expect(resolveProject("https://trellium.ai/path?query=1")).toBe(TRELLIUM_PROJECT);
    expect(isSupportedPage("https://trellium.ai/path?query=1")).toBe(true);
  });

  it("accepts a deployment owned by hbmartins-projects", () => {
    const url = "https://feature-redesign-hbmartins-projects.vercel.app/dashboard";

    expect(resolveProject(url)).toBe(TRELLIUM_PROJECT);
    expect(isSupportedPage(url)).toBe(true);
  });

  it.each([
    "https://feature-redesign.vercel.app/dashboard",
    "https://feature-redesign-other-projects.vercel.app/dashboard",
    "https://hbmartins-projects.vercel.app/dashboard",
    "http://trellium.ai/dashboard",
  ])("rejects an unapproved page: %s", (url) => {
    expect(resolveProject(url)).toBeNull();
    expect(isSupportedPage(url)).toBe(false);
  });
});

describe("CaptureV1 request and requester validation", () => {
  it("accepts a valid capture and trims the required request", () => {
    const capture = makeCapture();
    capture.request.text = "  Update the hero heading\n";

    const parsed = captureV1Schema.safeParse(capture);

    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.request.text).toBe("Update the hero heading");
    }
  });

  it.each(["", "   ", "\n\t"])('rejects an empty request: "%s"', (text) => {
    const capture = makeCapture();
    capture.request.text = text;

    expect(captureV1Schema.safeParse(capture).success).toBe(false);
  });

  it("rejects a request longer than the contract maximum", () => {
    const capture = makeCapture();
    capture.request.text = "x".repeat(MAX_REQUEST_TEXT + 1);

    expect(captureV1Schema.safeParse(capture).success).toBe(false);
  });

  it.each(["U12345678", "WABCDEFGH", "U1A2B3C4D5"])(
    "accepts a Slack member ID: %s",
    (slackUserId) => {
      const capture = makeCapture();
      capture.requester.slackUserId = slackUserId;

      expect(captureV1Schema.safeParse(capture).success).toBe(true);
    },
  );

  it.each(["U1234567", "u12345678", "C12345678", "U1234-678", ""])(
    "rejects an invalid Slack member ID: %s",
    (slackUserId) => {
      const capture = makeCapture();
      capture.requester.slackUserId = slackUserId;

      expect(captureV1Schema.safeParse(capture).success).toBe(false);
    },
  );
});

describe("Capture construction", () => {
  it("trims the request and reuses the seed's UUID and timestamp on retry", () => {
    const source = makeCapture();
    const seed = {
      captureId: source.captureId,
      capturedAt: source.capturedAt,
      project: source.project.slug,
      requesterSlackUserId: source.requester.slackUserId,
      page: source.page,
      diagnostics: source.diagnostics,
    };

    const first = buildCapture(seed, "  Update the hero heading  ", source.image);
    const retry = buildCapture(seed, first.request.text, source.image);

    expect(first.request.text).toBe("Update the hero heading");
    expect(retry.captureId).toBe(CAPTURE_ID);
    expect(retry.capturedAt).toBe(CAPTURED_AT);
    expect(retry.captureId).toBe(first.captureId);
  });
});

describe("CaptureV1 page consistency", () => {
  it("accepts a supported Vercel deployment when its route fields match", () => {
    const capture = makeCapture();
    capture.page = {
      ...capture.page,
      url: "https://fix-nav-hbmartins-projects.vercel.app/account?q=one",
      path: "/account",
      search: "?q=one",
    };

    expect(captureV1Schema.safeParse(capture).success).toBe(true);
  });

  it("rejects an unsupported Vercel deployment for the trellium project", () => {
    const capture = makeCapture();
    capture.page = {
      ...capture.page,
      url: "https://fix-nav-unrelated.vercel.app/account",
      path: "/account",
      search: "",
    };

    expect(captureV1Schema.safeParse(capture).success).toBe(false);
  });

  it.each([
    { field: "path", path: "/different", search: "?mode=focus" },
    { field: "search", path: "/dashboard", search: "?mode=other" },
  ])("rejects a $field that does not match page.url", ({ path, search }) => {
    const capture = makeCapture();
    capture.page = { ...capture.page, path, search };

    const parsed = captureV1Schema.safeParse(capture);

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: ["page"] })]),
      );
    }
  });
});

describe("CaptureV1 diagnostic limits", () => {
  it("accepts 25 console entries and 12 click entries", () => {
    const capture = makeCapture();
    capture.diagnostics = {
      console: Array.from({ length: 25 }, (_, index) => makeConsoleEntry(index)),
      clicks: Array.from({ length: 12 }, (_, index) => makeClickEntry(index)),
    };

    expect(captureV1Schema.safeParse(capture).success).toBe(true);
  });

  it("rejects a 26th console entry", () => {
    const capture = makeCapture();
    capture.diagnostics.console = Array.from({ length: 26 }, (_, index) => makeConsoleEntry(index));

    expect(captureV1Schema.safeParse(capture).success).toBe(false);
  });

  it("rejects a 13th click entry", () => {
    const capture = makeCapture();
    capture.diagnostics.clicks = Array.from({ length: 13 }, (_, index) => makeClickEntry(index));

    expect(captureV1Schema.safeParse(capture).success).toBe(false);
  });
});

describe("CaptureV1 image validation", () => {
  it.each(["image/png", "image/jpeg"] as const)("accepts valid %s metadata", (mimeType) => {
    const capture = makeCapture();
    capture.image.mimeType = mimeType;

    expect(captureV1Schema.safeParse(capture).success).toBe(true);
  });

  it("rejects the old data URL contract", () => {
    const capture = makeCapture();
    const legacy = {
      ...capture,
      image: { dataUrl: "data:image/png;base64,AA==", annotated: true },
    };

    expect(captureV1Schema.safeParse(legacy).success).toBe(false);
  });

  it("accepts an image exactly at the raw byte limit", () => {
    const capture = makeCapture();
    capture.image.byteLength = MAX_IMAGE_BYTES;

    expect(captureV1Schema.safeParse(capture).success).toBe(true);
  });

  it("rejects an image one byte over the raw byte limit", () => {
    const capture = makeCapture();
    capture.image.byteLength = MAX_IMAGE_BYTES + 1;

    expect(captureV1Schema.safeParse(capture).success).toBe(false);
  });
});

describe("screenshot coordinate mapping", () => {
  it("centers a wide screenshot inside a rail-reduced stage", () => {
    expect(containRect(1_060, 900, 1_440, 900)).toEqual({
      left: 0,
      top: 118.75,
      width: 1_060,
      height: 662.5,
    });
  });

  it("normalizes points inside the rendered image and rejects letterbox space", () => {
    const rect = { left: 100, top: 50, width: 800, height: 450 };

    expect(normalizePoint(500, 275, rect)).toEqual({ x: 0.5, y: 0.5 });
    expect(normalizePoint(99, 275, rect)).toBeNull();
    expect(normalizePoint(500, 501, rect)).toBeNull();
  });

  it("clamps captured pointer movement to the rendered image boundary", () => {
    const rect = { left: 100, top: 50, width: 800, height: 450 };

    expect(clampNormalizedPoint(99, 275, rect)).toEqual({ x: 0, y: 0.5 });
    expect(clampNormalizedPoint(901, 501, rect)).toEqual({ x: 1, y: 1 });
    expect(clampNormalizedPoint(500, 275, rect)).toEqual({ x: 0.5, y: 0.5 });
  });

  it("keeps an editor inside its container", () => {
    expect(clampOffset(190, 50, 200)).toBe(150);
    expect(clampOffset(-2, 50, 200)).toBe(0);
    expect(clampOffset(40, 50, 200)).toBe(40);
    expect(clampOffset(40, 250, 200)).toBe(0);
  });
});

describe("external URL validation", () => {
  it("normalizes HTTPS URLs", () => {
    expect(normalizeHttpsUrl("https://workspace.slack.com/archives/C123/p456")).toBe(
      "https://workspace.slack.com/archives/C123/p456",
    );
  });

  it.each([
    "javascript:alert(document.domain)",
    "data:text/html,unsafe",
    "http://workspace.slack.com/archives/C123/p456",
    "not a URL",
  ])("rejects a non-HTTPS external URL: %s", (url) => {
    expect(normalizeHttpsUrl(url)).toBeNull();
  });
});
