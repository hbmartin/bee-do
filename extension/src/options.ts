import { lockStorage } from "./storage";

type Settings = {
  endpoint: string;
  secret: string;
  slackUserId: string;
};

const fields = ["endpoint", "secret", "slackUserId"] as const;

/** Resolves a required element. A narrowed `const` does not stay narrowed inside the handlers
 * below, so the null check has to live where the element is produced. */
function required<T extends Element>(selector: string, description: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Settings page is missing ${description}`);
  return element;
}

const form = required<HTMLFormElement>("#settings", "its form");
const status = required<HTMLSpanElement>("#status", "its status element");

function input(id: (typeof fields)[number]): HTMLInputElement {
  return required<HTMLInputElement>(`#${id}`, `the ${id} input`);
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
    // Stored settings are absent until the page has been saved once, so every key is optional.
    const stored = await chrome.storage.local.get<Partial<Settings>>([...fields]);
    for (const field of fields) input(field).value = stored[field] ?? "";
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
