import type {
  CaptureResponse,
  CaptureV1,
  ClickEntry,
  ConsoleEntry,
} from "../../src/shared/capture";
import { CAPTURE_IMAGE_PART, CAPTURE_METADATA_PART } from "../../src/shared/capture";
import { resolveProject } from "../../src/shared/projects";
import { lockStorage } from "./storage";

type Settings = {
  endpoint: string;
  secret: string;
  slackUserId: string;
};

type CollectedContext = {
  page: CaptureV1["page"];
  diagnostics: { console: ConsoleEntry[]; clicks: ClickEntry[] };
};

type SubmitMessage = {
  type: "bee-do:submit";
  capture: CaptureV1;
  imageDataUrl: string;
};

const SETTINGS_DEFAULTS: Settings = {
  endpoint: "",
  secret: "",
  slackUserId: "",
};

chrome.runtime.onInstalled.addListener(() => void lockStorage());
chrome.runtime.onStartup.addListener(() => void lockStorage());
void lockStorage();

async function getSettings(): Promise<Settings> {
  return {
    ...SETTINGS_DEFAULTS,
    ...(await chrome.storage.local.get(SETTINGS_DEFAULTS)),
  };
}

function sendToTab<T>(tabId: number, message: unknown): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response: T | undefined) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });
}

function decodeImageDataUrl(dataUrl: string, expectedMimeType: string): Uint8Array {
  const match = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/]+={0,2})$/.exec(dataUrl);
  if (!match || match[1] !== expectedMimeType) {
    throw new Error("The rendered image does not match its Capture metadata.");
  }

  const binary = atob(match[2] ?? "");
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function showPageAlert(tabId: number, message: string): Promise<void> {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (text: string) => window.alert(text),
    args: [message],
  });
}

async function fallbackContext(tabId: number): Promise<CollectedContext | undefined> {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => ({
      page: {
        url: location.href,
        path: location.pathname,
        search: location.search,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
      },
      diagnostics: { console: [], clicks: [] },
    }),
  });
  return results[0]?.result as CollectedContext | undefined;
}

chrome.action.onClicked.addListener((tab) => {
  void (async () => {
    if (!tab.id || !tab.url) return;

    const project = resolveProject(tab.url);
    if (!project) {
      await showPageAlert(
        tab.id,
        "Bee-do Capture is only enabled on trellium.ai and approved Harold Martin Vercel previews.",
      );
      return;
    }

    const settings = await getSettings();
    if (!settings.endpoint || !settings.secret || !settings.slackUserId) {
      await chrome.runtime.openOptionsPage();
      return;
    }

    try {
      const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: "png",
      });
      const context =
        (await sendToTab<CollectedContext>(tab.id, { type: "bee-do:collect" })) ??
        (await fallbackContext(tab.id));
      if (!context) throw new Error("Could not read the captured page.");

      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["overlay.js"],
      });
      await sendToTab(tab.id, {
        type: "bee-do:open",
        payload: {
          captureId: crypto.randomUUID(),
          capturedAt: new Date().toISOString(),
          project,
          requesterSlackUserId: settings.slackUserId,
          screenshot,
          context,
        },
      });
    } catch (error) {
      await showPageAlert(
        tab.id,
        error instanceof Error ? error.message : "Bee-do could not capture this page.",
      );
    }
  })();
});

chrome.runtime.onMessage.addListener(
  (message: SubmitMessage, _sender, sendResponse: (response: CaptureResponse) => void) => {
    if (message?.type !== "bee-do:submit") return undefined;

    void (async () => {
      const settings = await getSettings();
      try {
        const capture = {
          ...message.capture,
          requester: { slackUserId: settings.slackUserId },
        };
        const imageBytes = decodeImageDataUrl(message.imageDataUrl, capture.image.mimeType);
        if (imageBytes.byteLength !== capture.image.byteLength) {
          throw new Error("The rendered image size does not match its Capture metadata.");
        }
        const form = new FormData();
        form.append(CAPTURE_METADATA_PART, JSON.stringify(capture));
        form.append(
          CAPTURE_IMAGE_PART,
          new Blob([imageBytes], { type: capture.image.mimeType }),
          `capture.${capture.image.mimeType === "image/jpeg" ? "jpg" : "png"}`,
        );

        const response = await fetch(settings.endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${settings.secret}`,
          },
          body: form,
        });

        const body = (await response.json().catch(() => null)) as CaptureResponse | null;
        if (!body) {
          sendResponse({
            ok: false,
            captureId: message.capture.captureId,
            error: {
              code: "invalid_response",
              stage: "ingest",
              message: `Worker returned ${response.status} without a valid response.`,
              retryable: response.status >= 500,
            },
          });
          return;
        }
        sendResponse(body);
      } catch (error) {
        sendResponse({
          ok: false,
          captureId: message.capture.captureId,
          error: {
            code: "network_error",
            stage: "ingest",
            message: error instanceof Error ? error.message : "Could not reach the Worker.",
            retryable: true,
          },
        });
      }
    })();

    return true;
  },
);
