import type { CaptureV1 } from "../../src/shared/capture";

export type CaptureSeed = {
  captureId: string;
  capturedAt: string;
  project: CaptureV1["project"]["slug"];
  requesterSlackUserId: string;
  page: CaptureV1["page"];
  diagnostics: CaptureV1["diagnostics"];
};

export function buildCapture(
  seed: CaptureSeed,
  requestText: string,
  image: CaptureV1["image"],
): CaptureV1 {
  return {
    schemaVersion: 1,
    captureId: seed.captureId,
    capturedAt: seed.capturedAt,
    request: { text: requestText.trim() },
    requester: { slackUserId: seed.requesterSlackUserId },
    project: { slug: seed.project },
    page: seed.page,
    image,
    diagnostics: seed.diagnostics,
  };
}
