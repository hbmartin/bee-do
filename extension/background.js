const DEFAULTS = {
  endpoint: "",
  secret: "",
  requester: "",
  project: "svrn",
};

const getSettings = async () => {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  return { ...DEFAULTS, ...stored };
};

const send = (tabId, message) =>
  new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      void chrome.runtime.lastError;
      resolve(response);
    });
  });

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id || !/^https?:/.test(tab.url || "")) return;

  const settings = await getSettings();
  if (!settings.endpoint) {
    await chrome.runtime.openOptionsPage();
    return;
  }

  // Snapshot first: the overlay draws on the still image, so what the designer
  // marks up is pixel-for-pixel what the agent will be handed.
  const screenshot = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  const context = (await send(tab.id, { type: "annotate:collect" })) || {
    consoleErrors: [],
    clickTrace: [],
  };

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["overlay.js"],
  });

  await send(tab.id, {
    type: "annotate:open",
    screenshot,
    context,
    settings: { requester: settings.requester, project: settings.project },
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "annotate:submit") return;

  (async () => {
    const settings = await getSettings();
    try {
      const response = await fetch(settings.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-annotate-secret": settings.secret,
        },
        body: JSON.stringify({
          ...msg.bundle,
          requester: msg.bundle.requester || settings.requester || "unknown",
          project: settings.project,
        }),
      });

      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        sendResponse({
          ok: false,
          error: body.error || `Server returned ${response.status}`,
        });
        return;
      }
      sendResponse({ ok: true, channel: body.channel, permalink: body.permalink });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  })();

  return true; // async response
});
