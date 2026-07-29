// Runs in the page's own JS context at document_start so it can wrap console
// and catch errors that fire before anything else loads. Keeps a small ring
// buffer; hands it over only when the overlay asks for it.
(() => {
  const MAX_ERRORS = 25;
  const MAX_CLICKS = 12;
  const errors = [];
  const clicks = [];

  const push = (arr, item, cap) => {
    arr.push(item);
    if (arr.length > cap) arr.shift();
  };

  const stringify = (v) => {
    if (v instanceof Error) return `${v.name}: ${v.message}\n${v.stack || ""}`.trim();
    if (typeof v === "string") return v;
    try {
      return JSON.stringify(v);
    } catch {
      return String(v);
    }
  };

  const record = (level, args) => {
    push(
      errors,
      {
        level,
        message: args.map(stringify).join(" ").slice(0, 1200),
        at: new Date().toISOString(),
      },
      MAX_ERRORS
    );
  };

  for (const level of ["error", "warn"]) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      record(level, args);
      original(...args);
    };
  }

  window.addEventListener("error", (e) => {
    record("uncaught", [e.message, `${e.filename}:${e.lineno}:${e.colno}`]);
  });

  window.addEventListener("unhandledrejection", (e) => {
    record("unhandledrejection", [e.reason]);
  });

  // Cheap, readable selector — enough for a human or a model to locate the node.
  const describe = (el) => {
    if (!el || el === document.body) return "body";
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < 4; depth++) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }
      const testId =
        node.getAttribute("data-testid") || node.getAttribute("data-test-id");
      if (testId) {
        parts.unshift(`${part}[data-testid="${testId}"]`);
        break;
      }
      const cls = (node.getAttribute("class") || "")
        .split(/\s+/)
        .filter((c) => c && !/^(css|sc|jsx)-/.test(c) && c.length < 24)
        .slice(0, 2);
      if (cls.length) part += `.${cls.join(".")}`;
      parts.unshift(part);
      node = node.parentElement;
    }
    return parts.join(" > ");
  };

  document.addEventListener(
    "click",
    (e) => {
      const el = e.target;
      if (!el || el.nodeType !== 1) return;
      push(
        clicks,
        {
          selector: describe(el),
          text: (el.innerText || el.value || "").trim().slice(0, 60),
          at: new Date().toISOString(),
        },
        MAX_CLICKS
      );
    },
    true
  );

  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.__annotate !== "collect") return;
    window.postMessage(
      {
        __annotate: "collected",
        nonce: e.data.nonce,
        payload: { consoleErrors: errors.slice(), clickTrace: clicks.slice() },
      },
      "*"
    );
  });
})();
