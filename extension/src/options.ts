import { lockStorage } from "./storage";

type Settings = {
  endpoint: string;
  secret: string;
  slackUserId: string;
};

const fields = ["endpoint", "secret", "slackUserId"] as const;
const form = document.querySelector<HTMLFormElement>("#settings");
const status = document.querySelector<HTMLSpanElement>("#status");

if (!form || !status) throw new Error("Settings form is missing required elements");

function input(id: (typeof fields)[number]): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(`#${id}`);
  if (!element) throw new Error(`Missing settings input: ${id}`);
  return element;
}

function validateEndpoint(value: string): URL {
  const url = new URL(value);
  const isWorkersDev = url.protocol === "https:" && url.hostname.endsWith(".workers.dev");
  const isLocal =
    url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");

  if (!isWorkersDev && !isLocal) {
    throw new Error("Use an HTTPS workers.dev endpoint or a local Wrangler endpoint.");
  }
  if (url.pathname.replace(/\/$/, "") !== "/v1/captures") {
    throw new Error("The endpoint path must be /v1/captures.");
  }
  url.hash = "";
  return url;
}

function setStatus(message: string, tone: "good" | "bad"): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

async function loadSettings(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(fields);
    for (const field of fields) input(field).value = String(stored[field] ?? "");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Could not load settings.", "bad");
  }
}

void loadSettings();
form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    try {
      const endpoint = validateEndpoint(input("endpoint").value.trim());
      const secret = input("secret").value.trim();
      const slackUserId = input("slackUserId").value.trim().toUpperCase();

      if (!secret) throw new Error("Enter the pilot secret.");
      if (!/^[UW][A-Z0-9]{8,}$/.test(slackUserId)) {
        throw new Error("Enter a valid Slack member ID beginning with U or W.");
      }

      const granted = await chrome.permissions.request({
        origins: [`${endpoint.origin}/*`],
      });
      if (!granted) throw new Error("Endpoint access was not granted.");

      const values: Settings = {
        endpoint: endpoint.href,
        secret,
        slackUserId,
      };
      await chrome.storage.local.set(values);
      input("slackUserId").value = slackUserId;
      setStatus("Saved", "good");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not save settings.", "bad");
    }
  })();
});

void lockStorage();
