import type { CaptureResponse, CaptureSuccess, CaptureV1 } from "../../src/shared/capture";
import { MAX_LABEL_TEXT, MAX_REQUEST_TEXT } from "../../src/shared/limits";
import { buildCapture } from "./capture";
import {
  clampNormalizedPoint,
  clampOffset,
  containRect,
  normalizePoint,
  type Point,
} from "./geometry";
import { fitImageToBudget, type ImageEncodingRequest } from "./image-budget";
import { normalizeHttpsUrl } from "./url";

declare global {
  interface Window {
    __beeDoOverlayLoaded?: boolean;
  }
}

type OpenPayload = {
  captureId: string;
  capturedAt: string;
  project: "trellium";
  requesterSlackUserId: string;
  screenshot: string;
  context: {
    page: CaptureV1["page"];
    diagnostics: CaptureV1["diagnostics"];
  };
};

type Stroke = { kind: "stroke"; points: Point[] };
type Label = { kind: "label"; point: Point; text: string };
type Markup = Stroke | Label;
type Tool = "pen" | "text";

const SIGNAL = "#ff2e88";
const SIGNAL_INK = "#12040a";
const STROKE_WIDTH = 3;

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("This browser could not encode the screenshot."));
      },
      type,
      quality,
    );
  });
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("This browser could not prepare the screenshot."));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("Image read failed.")));
    reader.readAsDataURL(blob);
  });
}

function wrapLabel(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const words = text.trim().split(/\s+/);
  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && context.measureText(next).width > maxWidth) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  if (lines.length > 4) {
    const visible = lines.slice(0, 4);
    visible[3] = `${visible[3]?.slice(0, -1) ?? ""}…`;
    return visible;
  }
  return lines;
}

class CaptureOverlay {
  private readonly abortController = new AbortController();
  private readonly host = element("div");
  private readonly shadow = this.host.attachShadow({ mode: "open" });
  private readonly stage = element("div", "stage");
  private readonly frame = element("div", "image-frame");
  private readonly shot = element("img", "shot");
  private readonly ink = element("canvas", "ink");
  private readonly requestInput = element("textarea", "request-field");
  private readonly status = element("div", "status");
  private readonly sendButton = element("button", "send", "Send to Slack");
  private readonly penButton = element("button", "tool", "Pen");
  private readonly textButton = element("button", "tool", "Text");
  private readonly undoButton = element("button", "tool", "Undo");
  private readonly clearButton = element("button", "tool", "Clear");
  private readonly markupCount = element("span", "markup-count");
  private readonly successActions = element("div", "success-actions");
  private readonly previousOverflow = document.documentElement.style.overflow;

  private actions: Markup[] = [];
  private drawing: Stroke | null = null;
  private labelEditor: HTMLInputElement | null = null;
  private labelEditorPoint: Point | null = null;
  private tool: Tool = "pen";
  private ready = false;
  private sending = false;
  private delivered: CaptureSuccess | null = null;

  constructor(private readonly payload: OpenPayload) {
    this.host.style.cssText = "all:initial";
    this.build();
    this.bind();

    document.documentElement.append(this.host);
    document.documentElement.style.overflow = "hidden";
    this.shot.src = payload.screenshot;
  }

  close = (): void => {
    this.abortController.abort();
    document.documentElement.style.overflow = this.previousOverflow;
    this.host.remove();
    if (activeOverlay === this) activeOverlay = null;
  };

  private build(): void {
    const stylesheet = element("link");
    stylesheet.rel = "stylesheet";
    stylesheet.href = chrome.runtime.getURL("overlay.css");
    this.shadow.append(stylesheet);

    this.shot.alt = "Captured page";
    this.shot.draggable = false;
    this.frame.append(this.shot, this.ink);

    for (const button of [this.penButton, this.textButton, this.undoButton, this.clearButton]) {
      button.type = "button";
    }
    const cancelButton = element("button", "tool", "Cancel");
    cancelButton.type = "button";
    cancelButton.addEventListener("click", this.close, {
      signal: this.abortController.signal,
    });

    const hint = element("div", "hint", "draw or place text · esc to close");
    const toolbar = element("div", "toolbar");
    toolbar.append(
      hint,
      this.penButton,
      this.textButton,
      this.undoButton,
      this.clearButton,
      cancelButton,
    );
    this.stage.append(this.frame, toolbar);

    const head = element("div", "head");
    head.append(
      element("p", "eyebrow", "Bee-do Capture"),
      element("p", "route", `${this.payload.context.page.path}${this.payload.context.page.search}`),
      element(
        "p",
        "meta",
        `${this.payload.context.page.viewport.width}×${this.payload.context.page.viewport.height} @${this.payload.context.page.devicePixelRatio}x · ${this.payload.context.diagnostics.console.length} console entries`,
      ),
    );

    const form = element("div", "capture-form");
    const requestLabel = element("label", "request-label");
    requestLabel.append(element("span", undefined, "What should change?"));
    this.requestInput.placeholder = "Describe the change you want…";
    this.requestInput.maxLength = MAX_REQUEST_TEXT;
    this.requestInput.rows = 7;
    requestLabel.append(this.requestInput);

    const markupSummary = element("div", "markup-summary");
    markupSummary.append(
      element("span", undefined, "Screenshot markup"),
      this.markupCount,
      element("small", undefined, "Optional. Pen strokes and text are burned into the image."),
    );
    form.append(requestLabel, markupSummary);

    this.sendButton.type = "button";
    this.sendButton.disabled = true;

    const openSlack = element("button", "send", "Open Slack");
    openSlack.type = "button";
    openSlack.addEventListener(
      "click",
      () => {
        if (!this.delivered) return;
        const permalink = normalizeHttpsUrl(this.delivered.slack.permalink);
        if (!permalink) return;
        window.open(permalink, "_blank", "noopener,noreferrer");
      },
      { signal: this.abortController.signal },
    );
    const closeButton = element("button", "secondary", "Close");
    closeButton.type = "button";
    closeButton.addEventListener("click", this.close, {
      signal: this.abortController.signal,
    });
    this.successActions.hidden = true;
    this.successActions.append(openSlack, closeButton);

    const foot = element("div", "foot");
    foot.append(this.sendButton, this.successActions);

    const rail = element("aside", "rail");
    rail.append(head, form, this.status, foot);

    const root = element("div", "root");
    root.append(this.stage, rail);
    this.shadow.append(root);
  }

  private bind(): void {
    const signal = this.abortController.signal;
    this.shot.addEventListener(
      "error",
      () => {
        this.ready = false;
        this.status.dataset.tone = "bad";
        this.status.textContent = "The screenshot could not be loaded. Close and retry.";
        this.update();
      },
      { once: true, signal },
    );
    this.shot.addEventListener(
      "load",
      () => {
        this.ready = true;
        this.layout();
        this.update();
      },
      { once: true, signal },
    );
    window.addEventListener("resize", this.layout, { signal });
    window.addEventListener("keydown", this.onKeydown, {
      capture: true,
      signal,
    });

    this.frame.addEventListener("pointerdown", this.onPointerDown, { signal });
    this.frame.addEventListener("pointermove", this.onPointerMove, { signal });
    this.frame.addEventListener("pointerup", this.finishStroke, { signal });
    this.frame.addEventListener("pointercancel", this.finishStroke, { signal });

    this.penButton.addEventListener("click", () => this.setTool("pen"), { signal });
    this.textButton.addEventListener("click", () => this.setTool("text"), { signal });
    this.undoButton.addEventListener("click", this.undo, { signal });
    this.clearButton.addEventListener("click", this.clear, { signal });
    this.requestInput.addEventListener("input", () => this.update(), { signal });
    this.sendButton.addEventListener("click", () => void this.submit(), { signal });

    this.setTool("pen");
    this.update();
  }

  private layout = (): void => {
    if (!this.ready) return;
    const frame = containRect(
      this.stage.clientWidth,
      this.stage.clientHeight,
      this.shot.naturalWidth,
      this.shot.naturalHeight,
    );
    Object.assign(this.frame.style, {
      left: `${frame.left}px`,
      top: `${frame.top}px`,
      width: `${frame.width}px`,
      height: `${frame.height}px`,
    });
    this.positionLabelEditor();
    if (this.ink.width !== this.shot.naturalWidth || this.ink.height !== this.shot.naturalHeight) {
      this.ink.width = this.shot.naturalWidth;
      this.ink.height = this.shot.naturalHeight;
    }
    this.paint();
  };

  private pointFromEvent(event: PointerEvent): Point | null {
    const rect = this.frame.getBoundingClientRect();
    return normalizePoint(event.clientX, event.clientY, rect);
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (this.sending || this.delivered || event.button !== 0) return;
    const point = this.pointFromEvent(event);
    if (!point) return;

    if (this.tool === "text") {
      this.openLabelEditor(point);
      return;
    }

    this.cancelLabelEditor();
    this.frame.setPointerCapture(event.pointerId);
    this.drawing = { kind: "stroke", points: [point] };
    event.preventDefault();
  };

  private onPointerMove = (event: PointerEvent): void => {
    if (!this.drawing) return;
    const rect = this.frame.getBoundingClientRect();
    const point = clampNormalizedPoint(event.clientX, event.clientY, rect);
    if (!point) return;
    this.drawing.points.push(point);
    this.paint();
  };

  private finishStroke = (): void => {
    if (!this.drawing) return;
    if (this.drawing.points.length > 1) this.actions.push(this.drawing);
    this.drawing = null;
    this.paint();
    this.update();
  };

  private setTool(tool: Tool): void {
    this.tool = tool;
    this.penButton.ariaPressed = String(tool === "pen");
    this.textButton.ariaPressed = String(tool === "text");
    this.frame.dataset.tool = tool;
    if (tool === "pen") this.cancelLabelEditor();
  }

  private openLabelEditor(point: Point): void {
    this.cancelLabelEditor();
    const editor = element("input", "label-editor");
    editor.type = "text";
    editor.maxLength = MAX_LABEL_TEXT;
    editor.placeholder = "Type label, then Enter";
    this.frame.append(editor);
    this.labelEditor = editor;
    this.labelEditorPoint = point;
    this.positionLabelEditor();

    editor.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.stopPropagation();
          const text = editor.value.trim();
          if (text) this.actions.push({ kind: "label", point, text });
          this.cancelLabelEditor();
          this.paint();
          this.update();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          this.cancelLabelEditor();
        }
      },
      { signal: this.abortController.signal },
    );
    editor.addEventListener("blur", () => this.cancelLabelEditor(), {
      once: true,
      signal: this.abortController.signal,
    });
    editor.focus();
  }

  private cancelLabelEditor(): void {
    this.labelEditor?.remove();
    this.labelEditor = null;
    this.labelEditorPoint = null;
  }

  private positionLabelEditor(): void {
    if (!this.labelEditor || !this.labelEditorPoint) return;
    const frameRect = this.frame.getBoundingClientRect();
    const editorRect = this.labelEditor.getBoundingClientRect();
    const { width, height } = frameRect;
    this.labelEditor.style.left = `${clampOffset(
      this.labelEditorPoint.x * width,
      editorRect.width,
      width,
    )}px`;
    this.labelEditor.style.top = `${clampOffset(
      this.labelEditorPoint.y * height - 2,
      editorRect.height,
      height,
    )}px`;
  }

  private undo = (): void => {
    this.cancelLabelEditor();
    this.actions.pop();
    this.paint();
    this.update();
  };

  private clear = (): void => {
    this.cancelLabelEditor();
    this.actions = [];
    this.paint();
    this.update();
  };

  private onKeydown = (event: KeyboardEvent): void => {
    const target = event.composedPath()[0];
    const typing =
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLInputElement ||
      (target instanceof HTMLElement && target.isContentEditable);

    if (event.key === "Escape") {
      if (target === this.labelEditor) {
        event.preventDefault();
        event.stopPropagation();
        this.cancelLabelEditor();
        return;
      }
      if (typing) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      if (typing) return;
      event.preventDefault();
      event.stopPropagation();
      this.undo();
    }
  };

  private paint(): void {
    const context = this.ink.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, this.ink.width, this.ink.height);
    this.paintMarkup(
      context,
      this.ink.width,
      this.ink.height,
      this.drawing ? [...this.actions, this.drawing] : this.actions,
    );
  }

  private paintMarkup(
    context: CanvasRenderingContext2D,
    width: number,
    height: number,
    actions: Markup[],
  ): void {
    const scale = width / this.payload.context.page.viewport.width;
    context.lineCap = "round";
    context.lineJoin = "round";

    for (const action of actions) {
      if (action.kind === "stroke") {
        if (action.points.length < 2) continue;
        context.beginPath();
        action.points.forEach((point, index) => {
          const x = point.x * width;
          const y = point.y * height;
          if (index === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        });
        context.strokeStyle = SIGNAL;
        context.lineWidth = STROKE_WIDTH * scale;
        context.stroke();
        continue;
      }

      const fontSize = 16 * scale;
      const paddingX = 7 * scale;
      const paddingY = 5 * scale;
      const lineHeight = 21 * scale;
      context.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      const lines = wrapLabel(context, action.text, Math.max(100 * scale, width * 0.55));
      const textWidth = Math.max(...lines.map((line) => context.measureText(line).width));
      const boxWidth = Math.min(width - 8 * scale, textWidth + paddingX * 2);
      const boxHeight = lines.length * lineHeight + paddingY * 2;
      const x = Math.min(action.point.x * width, width - boxWidth - 4 * scale);
      const y = Math.min(action.point.y * height, height - boxHeight - 4 * scale);

      context.fillStyle = SIGNAL;
      context.beginPath();
      context.roundRect(x, y, boxWidth, boxHeight, 5 * scale);
      context.fill();
      context.fillStyle = SIGNAL_INK;
      context.textAlign = "left";
      context.textBaseline = "top";
      lines.forEach((line, index) => {
        context.fillText(
          line,
          x + paddingX,
          y + paddingY + index * lineHeight,
          boxWidth - paddingX * 2,
        );
      });
    }
  }

  private update(): void {
    const hasRequest = this.requestInput.value.trim().length > 0;
    const locked = this.sending || Boolean(this.delivered);
    this.sendButton.disabled = !this.ready || !hasRequest || locked;
    this.sendButton.textContent = this.sending ? "Sending…" : "Send to Slack";
    this.requestInput.disabled = locked;
    for (const button of [this.penButton, this.textButton, this.undoButton, this.clearButton]) {
      button.disabled = locked;
    }
    this.undoButton.disabled = locked || this.actions.length === 0;
    this.clearButton.disabled = locked || this.actions.length === 0;
    this.markupCount.textContent = this.actions.length
      ? `${this.actions.length} item${this.actions.length === 1 ? "" : "s"}`
      : "None";
  }

  private async renderImage(): Promise<{
    dataUrl: string;
    metadata: CaptureV1["image"];
  }> {
    const canvas = document.createElement("canvas");
    canvas.width = this.shot.naturalWidth;
    canvas.height = this.shot.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser could not render the screenshot.");

    context.drawImage(this.shot, 0, 0);
    this.paintMarkup(context, canvas.width, canvas.height, this.actions);

    const encode = async (request: ImageEncodingRequest): Promise<Blob> => {
      let target = canvas;
      if (request.scale < 1) {
        target = document.createElement("canvas");
        target.width = Math.max(1, Math.round(canvas.width * request.scale));
        target.height = Math.max(1, Math.round(canvas.height * request.scale));
        const targetContext = target.getContext("2d");
        if (!targetContext) throw new Error("This browser could not resize the screenshot.");
        targetContext.drawImage(canvas, 0, 0, target.width, target.height);
      }
      return canvasBlob(target, request.mimeType, request.quality);
    };

    const result = await fitImageToBudget(canvas.width, encode);
    const mimeType = result.blob.type;
    if (mimeType !== "image/png" && mimeType !== "image/jpeg") {
      throw new Error("This browser encoded the screenshot in an unsupported format.");
    }
    return {
      dataUrl: await blobDataUrl(result.blob),
      metadata: {
        mimeType,
        byteLength: result.blob.size,
        annotated: this.actions.length > 0,
        ...(result.scale < 1 ? { scale: result.scale } : {}),
        ...(result.quality !== undefined ? { quality: result.quality } : {}),
      },
    };
  }

  private async submit(): Promise<void> {
    if (this.sending || this.delivered || !this.requestInput.value.trim()) return;
    this.sending = true;
    this.status.dataset.tone = "";
    this.status.textContent = "Rendering and uploading…";
    this.update();

    try {
      const image = await this.renderImage();
      const capture = buildCapture(
        {
          captureId: this.payload.captureId,
          capturedAt: this.payload.capturedAt,
          project: this.payload.project,
          requesterSlackUserId: this.payload.requesterSlackUserId,
          page: this.payload.context.page,
          diagnostics: this.payload.context.diagnostics,
        },
        this.requestInput.value,
        image.metadata,
      );

      const response = (await chrome.runtime.sendMessage({
        type: "bee-do:submit",
        capture,
        imageDataUrl: image.dataUrl,
      })) as CaptureResponse | undefined;

      if (!response) throw new Error("Ingest: the extension received no response.");
      if (!response.ok) {
        const stage = response.error.stage.replaceAll("_", " ");
        const orphan = response.slack ? ` (#${response.slack.channelName} was created)` : "";
        throw new Error(`${stage}: ${response.error.message}${orphan}`);
      }
      this.delivered = response;
      this.status.dataset.tone = "good";
      this.status.textContent = response.warnings.length
        ? `Delivered with warnings: ${response.warnings.join("; ")}`
        : `Delivered to #${response.slack.channelName}`;
      this.sendButton.hidden = true;
      this.successActions.hidden = false;
    } catch (error) {
      this.status.dataset.tone = "bad";
      this.status.textContent = error instanceof Error ? error.message : "Delivery failed.";
    } finally {
      this.sending = false;
      this.update();
    }
  }
}

let activeOverlay: CaptureOverlay | null = null;

if (!window.__beeDoOverlayLoaded) {
  window.__beeDoOverlayLoaded = true;
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== "bee-do:open") return undefined;
    activeOverlay?.close();
    activeOverlay = new CaptureOverlay(message.payload as OpenPayload);
    return undefined;
  });
}
