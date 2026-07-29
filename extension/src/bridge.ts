import { isSupportedPage } from "../../src/shared/projects";

import type { ClickEntry, ConsoleEntry } from "../../src/shared/capture";

type CollectedContext = {
  page: {
    url: string;
    path: string;
    search: string;
    title: string;
    viewport: { width: number; height: number };
    devicePixelRatio: number;
  };
  diagnostics: { console: ConsoleEntry[]; clicks: ClickEntry[] };
};

(() => {
  if (!isSupportedPage(location.href)) return;

  function collect(): Promise<CollectedContext> {
    return new Promise((resolve) => {
      const nonce = crypto.randomUUID();
      let settled = false;

      const finish = (
        diagnostics: CollectedContext["diagnostics"] = { console: [], clicks: [] },
      ): void => {
        if (settled) return;
        settled = true;
        window.removeEventListener("message", onMessage);
        resolve({
          page: {
            url: location.href,
            path: location.pathname,
            search: location.search,
            title: document.title,
            viewport: { width: innerWidth, height: innerHeight },
            devicePixelRatio,
          },
          diagnostics,
        });
      };

      const timer = window.setTimeout(() => finish(), 500);
      const onMessage = (event: MessageEvent): void => {
        if (
          event.source !== window ||
          event.data?.__beeDo !== "collected" ||
          event.data.nonce !== nonce
        ) {
          return;
        }
        window.clearTimeout(timer);
        finish(event.data.diagnostics as CollectedContext["diagnostics"]);
      };

      window.addEventListener("message", onMessage);
      window.postMessage({ __beeDo: "collect", nonce }, "*");
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "bee-do:collect") return undefined;
    void collect().then(sendResponse);
    return true;
  });
})();
