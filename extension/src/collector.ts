import { isSupportedPage } from "../../src/shared/projects";

import type { ClickEntry, ConsoleEntry } from "../../src/shared/capture";

declare global {
  interface Window {
    __beeDoCollectorInstalled?: boolean;
  }
}

(() => {
  if (!isSupportedPage(location.href) || window.__beeDoCollectorInstalled) return;
  window.__beeDoCollectorInstalled = true;

  const errors: ConsoleEntry[] = [];
  const clicks: ClickEntry[] = [];

  function push<T>(items: T[], item: T, limit: number): void {
    items.push(item);
    if (items.length > limit) items.shift();
  }

  function stringify(value: unknown): string {
    if (value instanceof Error) {
      return `${value.name}: ${value.message}\n${value.stack ?? ""}`.trim();
    }
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  function record(level: ConsoleEntry["level"], values: unknown[]): void {
    push(
      errors,
      {
        level,
        message: values.map(stringify).join(" ").slice(0, 1_200),
        occurredAt: new Date().toISOString(),
      },
      25,
    );
  }

  for (const level of ["error", "warn"] as const) {
    const original = console[level].bind(console);
    console[level] = (...values: unknown[]) => {
      record(level, values);
      original(...values);
    };
  }

  window.addEventListener("error", (event) => {
    record("uncaught", [event.message, `${event.filename}:${event.lineno}:${event.colno}`]);
  });

  window.addEventListener("unhandledrejection", (event) => {
    record("unhandledrejection", [event.reason]);
  });

  function describe(element: Element | null): string {
    if (!element || element === document.body) return "body";
    const parts: string[] = [];
    let node: Element | null = element;

    for (let depth = 0; node && depth < 4; depth += 1) {
      let part = node.tagName.toLowerCase();
      if (node.id) {
        parts.unshift(`${part}#${node.id}`);
        break;
      }

      const testId = node.getAttribute("data-testid") ?? node.getAttribute("data-test-id");
      if (testId) {
        parts.unshift(`${part}[data-testid="${testId.slice(0, 80)}"]`);
        break;
      }

      const classes = (node.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter((name) => name && !/^(css|sc|jsx)-/.test(name) && name.length < 24)
        .slice(0, 2);
      if (classes.length) part += `.${classes.join(".")}`;
      parts.unshift(part);
      node = node.parentElement;
    }

    return parts.join(" > ").slice(0, 500);
  }

  document.addEventListener(
    "click",
    (event) => {
      const element = event.target instanceof Element ? event.target : null;
      if (!element) return;
      const htmlElement = element as HTMLElement;
      const inputElement = element as HTMLInputElement;
      push(
        clicks,
        {
          selector: describe(element),
          text: (htmlElement.innerText || inputElement.value || "").trim().slice(0, 200),
          occurredAt: new Date().toISOString(),
        },
        12,
      );
    },
    true,
  );

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.__beeDo !== "collect") return;
    window.postMessage(
      {
        __beeDo: "collected",
        nonce: event.data.nonce,
        diagnostics: { console: [...errors], clicks: [...clicks] },
      },
      "*",
    );
  });
})();
