// Sits between the page's collector (MAIN world) and the extension.
// Also the only always-on listener, so the overlay can be injected on demand.
(() => {
  const collect = () =>
    new Promise((resolve) => {
      const nonce = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        window.removeEventListener("message", onMessage);
        resolve({ consoleErrors: [], clickTrace: [] });
      }, 500);

      const onMessage = (e) => {
        if (e.source !== window) return;
        if (e.data?.__annotate !== "collected" || e.data.nonce !== nonce) return;
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
        resolve(e.data.payload);
      };

      window.addEventListener("message", onMessage);
      window.postMessage({ __annotate: "collect", nonce }, "*");
    });

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== "annotate:collect") return;
    collect().then(sendResponse);
    return true; // async response
  });
})();
