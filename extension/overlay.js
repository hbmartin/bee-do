// Injected on demand. Renders a shadow-DOM overlay on top of the captured
// still, collects freehand marks + a note per mark, composites everything into
// one PNG, and hands the bundle to the service worker.
(() => {
  if (window.__annotateOverlayLoaded) return;
  window.__annotateOverlayLoaded = true;

  const SIGNAL = "#ff2e88";
  const STROKE_WIDTH = 3;

  let host = null;
  let state = null;

  const el = (tag, props = {}, children = []) => {
    const node = document.createElement(tag);
    Object.assign(node, props);
    for (const child of [].concat(children)) {
      node.append(child);
    }
    return node;
  };

  function open({ screenshot, context, settings }) {
    if (host) close();

    state = {
      marks: [], // { points: [{x,y}], note: string }  x/y normalised 0..1
      context,
      settings,
      page: {
        url: location.href,
        path: location.pathname,
        search: location.search,
        title: document.title,
        viewport: { w: innerWidth, h: innerHeight },
        dpr: devicePixelRatio,
      },
      sending: false,
    };

    host = el("div");
    host.style.cssText = "all:initial";
    const shadow = host.attachShadow({ mode: "open" });

    const style = el("link", {
      rel: "stylesheet",
      href: chrome.runtime.getURL("overlay.css"),
    });
    shadow.append(style);

    const ui = buildUI(shadow, screenshot);
    shadow.append(ui.root);

    document.documentElement.append(host);
    document.documentElement.style.overflow = "hidden";
    addEventListener("keydown", onKeydown, true);
  }

  function close() {
    removeEventListener("keydown", onKeydown, true);
    document.documentElement.style.overflow = "";
    host?.remove();
    host = null;
    state = null;
  }

  function onKeydown(e) {
    if (!host) return;
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.stopPropagation();
      state.marks.pop();
      state?.render();
    }
  }

  function buildUI(shadow, screenshot) {
    const shot = el("img", { className: "shot", src: screenshot, alt: "" });
    const ink = el("canvas", { className: "ink" });
    const pins = el("div", { className: "pins" });

    const undo = el("button", { className: "tool", textContent: "Undo" });
    const clear = el("button", { className: "tool", textContent: "Clear" });
    const cancel = el("button", { className: "tool", textContent: "Cancel" });
    const hint = el("div", {
      className: "hint",
      textContent: "drag to mark · esc to close",
    });
    const toolbar = el("div", { className: "toolbar" }, [
      hint,
      undo,
      clear,
      cancel,
    ]);

    const stage = el("div", { className: "stage" }, [shot, ink, pins, toolbar]);

    const route = el("p", {
      className: "route",
      textContent: state.page.path + state.page.search,
    });
    const meta = el("p", {
      className: "meta",
      textContent: [
        `${state.page.viewport.w}×${state.page.viewport.h} @${state.page.dpr}x`,
        `${state.context.consoleErrors.length} console errors`,
      ].join("  ·  "),
    });
    const head = el("div", { className: "head" }, [
      el("p", { className: "eyebrow", textContent: "Change request" }),
      route,
      meta,
    ]);

    const notes = el("div", { className: "notes" });
    const status = el("div", { className: "status" });
    const sendBtn = el("button", {
      className: "send",
      textContent: "Send to Slack",
      disabled: true,
    });
    const foot = el("div", { className: "foot" }, [sendBtn]);
    const rail = el("div", { className: "rail" }, [head, notes, status, foot]);

    const leader = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    leader.setAttribute("class", "leader");
    const leaderPath = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "path"
    );
    leader.append(leaderPath);

    const root = el("div", { className: "root" }, [stage, rail, leader]);

    // ---- drawing -------------------------------------------------------

    const sizeCanvas = () => {
      const rect = stage.getBoundingClientRect();
      ink.width = rect.width * devicePixelRatio;
      ink.height = rect.height * devicePixelRatio;
    };

    const toNorm = (e) => {
      const rect = stage.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width,
        y: (e.clientY - rect.top) / rect.height,
      };
    };

    let drawing = null;

    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      stage.setPointerCapture(e.pointerId);
      drawing = { points: [toNorm(e)], note: "" };
    });

    stage.addEventListener("pointermove", (e) => {
      if (!drawing) return;
      drawing.points.push(toNorm(e));
      paint(drawing);
    });

    const finish = () => {
      if (!drawing) return;
      if (drawing.points.length > 2) state.marks.push(drawing);
      drawing = null;
      render();
      // focus the note that was just created
      notes.querySelector(".note:last-child .field")?.focus();
    };

    stage.addEventListener("pointerup", finish);
    stage.addEventListener("pointercancel", finish);

    function paint(inProgress) {
      const ctx = ink.getContext("2d");
      ctx.clearRect(0, 0, ink.width, ink.height);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = SIGNAL;
      ctx.lineWidth = STROKE_WIDTH * devicePixelRatio;
      for (const mark of state.marks.concat(inProgress || [])) {
        strokePath(ctx, mark.points, ink.width, ink.height);
      }
    }

    function strokePath(ctx, points, w, h) {
      if (points.length < 2) return;
      ctx.beginPath();
      ctx.moveTo(points[0].x * w, points[0].y * h);
      for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x * w, points[i].y * h);
      }
      ctx.stroke();
    }

    // ---- rail ----------------------------------------------------------

    const anchorOf = (mark) => mark.points[mark.points.length - 1];

    function render() {
      paint();
      pins.replaceChildren();
      notes.replaceChildren();

      state.marks.forEach((mark, i) => {
        const n = i + 1;
        const a = anchorOf(mark);

        const pin = el("div", { className: "pin", textContent: String(n) });
        pin.style.left = `${a.x * 100}%`;
        pin.style.top = `${a.y * 100}%`;
        pin.dataset.n = String(n);
        pins.append(pin);

        const field = el("textarea", {
          className: "field",
          value: mark.note,
          placeholder: `What should change here?`,
          rows: 2,
        });
        field.addEventListener("input", () => {
          mark.note = field.value;
          updateSend();
        });
        field.addEventListener("focus", () => drawLeader(pin));
        field.addEventListener("blur", () => leaderPath.removeAttribute("d"));

        const drop = el("button", {
          className: "drop",
          textContent: "×",
          title: `Remove mark ${n}`,
        });
        drop.addEventListener("click", () => {
          state.marks.splice(i, 1);
          render();
        });

        const row = el("div", { className: "note" }, [
          el("div", { className: "badge", textContent: String(n) }),
          field,
          drop,
        ]);
        row.addEventListener("pointerenter", () => {
          pin.dataset.lit = "1";
          drawLeader(pin);
        });
        row.addEventListener("pointerleave", () => {
          delete pin.dataset.lit;
          leaderPath.removeAttribute("d");
        });
        notes.append(row);
      });

      if (!state.marks.length) {
        notes.append(
          el("div", { className: "empty" }, [
            el("b", { textContent: "Nothing marked yet" }),
            document.createTextNode(
              "Drag across anything on the page you want changed. Each mark gets a number and a note."
            ),
          ])
        );
      }

      undo.disabled = !state.marks.length;
      clear.disabled = !state.marks.length;
      updateSend();
    }

    function drawLeader(pin) {
      const a = pin.getBoundingClientRect();
      const b = notes
        .querySelector(`.note:nth-child(${pin.dataset.n}) .badge`)
        ?.getBoundingClientRect();
      if (!b) return;
      const x1 = a.right;
      const y1 = a.top + a.height / 2;
      const x2 = b.left;
      const y2 = b.top + b.height / 2;
      const mid = x1 + (x2 - x1) / 2;
      leaderPath.setAttribute(
        "d",
        `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`
      );
    }

    function updateSend() {
      const ready =
        state.marks.length > 0 &&
        state.marks.every((m) => m.note.trim().length > 0) &&
        !state.sending;
      sendBtn.disabled = !ready;
      sendBtn.textContent = state.sending
        ? "Sending…"
        : state.marks.length && !ready
          ? "Add a note to every mark"
          : "Send to Slack";
    }

    undo.addEventListener("click", () => {
      state.marks.pop();
      render();
    });
    clear.addEventListener("click", () => {
      state.marks = [];
      render();
    });
    cancel.addEventListener("click", close);
    sendBtn.addEventListener("click", () => submit(shot, status, updateSend));

    state.render = render;
    shot.addEventListener("load", () => {
      sizeCanvas();
      render();
    });
    addEventListener("resize", () => {
      sizeCanvas();
      render();
    });
    if (shot.complete) {
      sizeCanvas();
      render();
    }

    return { root };
  }

  // ---- export ----------------------------------------------------------

  // Burn the marks and their numbers into the image. The number in the PNG and
  // the number in the notes list are the same number — that correspondence is
  // what makes the bundle readable by a model.
  function composite(shot) {
    const canvas = document.createElement("canvas");
    canvas.width = shot.naturalWidth;
    canvas.height = shot.naturalHeight;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(shot, 0, 0);

    const scale = canvas.width / state.page.viewport.w;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = SIGNAL;
    ctx.lineWidth = STROKE_WIDTH * scale;

    state.marks.forEach((mark) => {
      ctx.beginPath();
      mark.points.forEach((p, i) => {
        const x = p.x * canvas.width;
        const y = p.y * canvas.height;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    });

    state.marks.forEach((mark, i) => {
      const last = mark.points[mark.points.length - 1];
      const x = last.x * canvas.width;
      const y = last.y * canvas.height;
      const r = 13 * scale;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = SIGNAL;
      ctx.fill();
      ctx.lineWidth = 2 * scale;
      ctx.strokeStyle = "#0b0d10";
      ctx.stroke();
      ctx.fillStyle = "#12040a";
      ctx.font = `600 ${16 * scale}px ui-monospace, Menlo, monospace`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(String(i + 1), x, y + scale);
    });

    // Serverless bodies are small; fall back to JPEG if the PNG is heavy.
    let out = canvas.toDataURL("image/png");
    if (out.length > 3_000_000) out = canvas.toDataURL("image/jpeg", 0.9);
    return out;
  }

  async function submit(shot, status, updateSend) {
    state.sending = true;
    updateSend();
    status.dataset.tone = "";
    status.textContent = "Uploading…";

    const bundle = {
      capturedAt: new Date().toISOString(),
      requester: state.settings.requester,
      page: state.page,
      annotations: state.marks.map((m, i) => ({
        n: i + 1,
        note: m.note.trim(),
        at: m.points[m.points.length - 1],
      })),
      consoleErrors: state.context.consoleErrors,
      clickTrace: state.context.clickTrace,
      screenshot: composite(shot),
    };

    chrome.runtime.sendMessage({ type: "annotate:submit", bundle }, (res) => {
      state.sending = false;
      if (res?.ok) {
        status.dataset.tone = "good";
        status.textContent = `Posted to ${res.channel || "Slack"}`;
        setTimeout(close, 1200);
      } else {
        status.dataset.tone = "bad";
        status.textContent = res?.error || "Send failed. Check the endpoint in options.";
        updateSend();
      }
    });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "annotate:open") open(msg);
  });
})();
