# Bee-do M0: Capture → Slack

Bee-do M0 is a deployable tracer from a Chrome browser extension to a Cloudflare Worker and then to a dedicated Slack app. A requester describes a change, marks up the visible viewport, and sends one versioned Capture. The Worker validates it and creates a public Request Channel containing a summary, the rendered screenshot, and bounded page diagnostics.

This milestone deliberately stops at Slack. It does not persist Captures, run a coding agent, create a branch or pull request, watch a preview deployment, or interact with Slack after Delivery.

```text
Chrome extension ──POST /v1/captures──▶ Cloudflare Worker ──▶ Slack Request Channel
  capture + annotate                 validate + deliver       root summary
  console + click context                                     threaded image
                                                               diagnostics
```

Domain terminology shared by this repository is defined in [CONTEXT.md](./CONTEXT.md). The longer-term direction and intentionally unresolved architecture are in [Annotation based PR Agent proposal.md](./Annotation%20based%20PR%20Agent%20proposal.md).

## Capture API

The extension sends `POST /v1/captures` as `multipart/form-data` with `Authorization: Bearer <pilot-secret>`. The browser supplies the multipart boundary. The request contains a `capture` JSON metadata part and an `image` file part whose content type is `image/png` or `image/jpeg`. The shared TypeScript/Zod metadata contract is versioned as:

```ts
type CaptureV1 = {
  schemaVersion: 1;
  captureId: string; // UUID generated once and reused on retry
  capturedAt: string;
  request: { text: string };
  requester: { slackUserId: string };
  project: { slug: "trellium" };
  page: {
    url: string;
    path: string;
    search: string;
    title: string;
    viewport: { width: number; height: number };
    devicePixelRatio: number;
  };
  image: {
    mimeType: "image/png" | "image/jpeg";
    byteLength: number;
    annotated: boolean;
    scale?: number;
    quality?: number;
  };
  diagnostics: {
    console: Array<{ level: string; message: string; occurredAt: string }>;
    clicks: Array<{ selector: string; text: string; occurredAt: string }>;
  };
};
```

A successful Delivery returns HTTP `201`:

```json
{
  "ok": true,
  "captureId": "…",
  "slack": {
    "channelId": "C…",
    "channelName": "bee-trellium-dashboard-1234abcd-a1b2",
    "rootTs": "…",
    "permalink": "https://…slack.com/archives/…"
  },
  "warnings": []
}
```

Failures return a non-2xx status with a stable machine code, failed stage, safe message, and retry guidance. If a required stage fails after channel creation, `slack` identifies the orphaned channel for manual cleanup:

```json
{
  "ok": false,
  "captureId": "…",
  "slack": {
    "channelId": "C…",
    "channelName": "bee-trellium-dashboard-1234abcd-a1b2"
  },
  "error": {
    "code": "IMAGE_UPLOAD_FAILED",
    "stage": "image_upload",
    "message": "Capture image could not be uploaded to Slack",
    "retryable": true
  }
}
```

`GET /healthz` is unauthenticated. Every other route or method is rejected. The Worker caps the complete multipart request at 10,000,000 bytes, the raw image part at 9,000,000 bytes, and Capture metadata at 256,000 bytes before creating anything in Slack.

## Prerequisites

- Chrome 120 or newer.
- Node.js supported by the checked-in Wrangler version.
- pnpm 11.15.1 (the version declared in `package.json`).
- A Cloudflare account that can deploy a `workers.dev` Worker.
- Permission to create and install an app in the target Slack workspace.

Install dependencies and generate the Cloudflare environment types:

```bash
corepack enable
pnpm install
pnpm generate:types
```

## 1. Install the dedicated Slack app

The portable app definition lives at [`slack/app-manifest.yaml`](./slack/app-manifest.yaml). It grants the Bee-do bot only these scopes:

| Scope                    | Used for                                      |
| ------------------------ | --------------------------------------------- |
| `channels:manage`        | Create one public Request Channel per Capture |
| `channels:write.invites` | Invite the requester and configured reviewers |
| `chat:write`             | Publish the root summary and diagnostics      |
| `files:write`            | Upload the rendered screenshot                |

1. In [Slack API apps](https://api.slack.com/apps), choose **Create New App** → **From an app manifest**.
2. Select the pilot workspace, paste or upload `slack/app-manifest.yaml`, and create the app.
3. Review the four requested scopes, then install the app to the workspace.
4. Copy the **Bot User OAuth Token** (`xoxb-...`) from **OAuth & Permissions**.
5. Collect the Slack member IDs for the requester and any reviewers. A member can copy their ID from their Slack profile under **More**.

The extension stores one requester member ID per browser profile. Reviewers are configured centrally on the Worker.

## 2. Configure and deploy the Worker

The checked-in `wrangler.jsonc` deploys the `bee-do-ingest` service to `workers.dev`. Add its secrets interactively; do not commit their values:

```bash
pnpm exec wrangler secret put SLACK_BOT_TOKEN
pnpm exec wrangler secret put CAPTURE_INGEST_SECRET
pnpm exec wrangler secret put SLACK_REVIEWER_IDS
```

- `SLACK_BOT_TOKEN` is the `xoxb-...` token from the Slack app installation.
- `CAPTURE_INGEST_SECRET` is a long, randomly generated pilot secret shared with manually installed extension copies.
- `SLACK_REVIEWER_IDS` is a comma-separated list of Slack member IDs. Use an empty value if the requester should be the only invitee.

Deploy after running type checks, tests, and production builds:

```bash
pnpm deploy
```

Wrangler prints the service URL, typically `https://bee-do-ingest.<account-subdomain>.workers.dev`. Confirm the deployment without authentication:

```bash
curl https://bee-do-ingest.<account-subdomain>.workers.dev/healthz
```

For local development, create an ignored `.dev.vars` file with the same three keys, then run:

```bash
pnpm dev
```

Use the local URL printed by Wrangler, with `/v1/captures`, in the extension settings. The extension accepts an HTTP endpoint only on `localhost` or `127.0.0.1`; deployed endpoints must use HTTPS on `workers.dev`.

## 3. Build and load the extension

Build the Manifest V3 extension:

```bash
pnpm build:extension
```

The unpacked artifact is written to `dist/extension`.

1. Open `chrome://extensions`.
2. Enable **Developer mode** and choose **Load unpacked**.
3. Select this repository's `dist/extension` directory.
4. Open the extension's **Options** page.
5. Enter the full endpoint ending in `/v1/captures`, the matching pilot secret, and the requester's Slack member ID.
6. Choose **Save settings** and approve access to that exact Worker origin when Chrome prompts.

Settings are kept in `chrome.storage.local` and restricted to trusted extension contexts. The pilot secret is appropriate only for this manually distributed internal tracer.

## 4. Create a Capture

Bee-do is enabled only on:

- `https://trellium.ai/*`
- Vercel preview hosts ending in `-hbmartins-projects.vercel.app`

Chrome requires the extension to declare `https://*.vercel.app/*`, but Bee-do disables collection and submission on every Vercel host that does not match the approved suffix.

On an approved page, select the toolbar action or press `Alt+Shift+A`. Bee-do captures the visible viewport before opening its full-screen overlay. Enter a required request, then use:

- **Pen** to draw freehand strokes.
- **Text** to click, type a label, and press Enter.
- **Undo** to remove the latest stroke or label.
- **Clear** to remove all markup.
- **Escape** to cancel active text input first, or close the overlay when no text is active.

Send the Capture. On success, use **Open Slack** to visit the root message or **Close** to dismiss the overlay. A failed Delivery keeps the same Capture ID available for retry so duplicate or partial Request Channels can be traced.

## Verification

Run the complete local verification set before a deployment:

```bash
pnpm lint
pnpm format:check
pnpm check
pnpm test:coverage
pnpm build
```

Use `pnpm format` to apply oxfmt and `pnpm lint:fix` for safe oxlint fixes.

M0 is complete only after an owner-operated smoke test from an approved page. Use a non-empty request, one pen stroke, and one text label, then confirm:

- A new public Request Channel is created.
- The requester and configured reviewers are invited, or invitation failures are reported as non-fatal warnings.
- The root summary identifies the request, requester, project, page, viewport, and Capture ID.
- The rendered viewport is uploaded in the root message thread with both annotations in the correct positions.
- Console and click diagnostics appear in the thread when present.
- **Open Slack** reaches the root message.

## M0 constraints

- Captures are stateless. A retry can create a duplicate or leave a partial Request Channel; the shared Capture ID is the correlation key.
- Request Channels are public and cleanup is manual.
- Only the visible viewport is captured. The rendered, annotated image is delivered; an unmarked baseline is not retained.
- The application accepts at most 10,000,000 bytes of multipart data, including at most 9,000,000 raw image bytes and 256,000 metadata bytes. The extension tries JPEG quality reductions before downscaling to an 800px-wide floor.
- Console history is limited to 25 entries and click history to 12 entries, collected only after the extension collector loads.
- The only Project in M0 is `trellium`, derived from the approved page origin rather than selected by the requester.
- There is no D1, R2, CI deployment, automated browser suite, real-Slack CI, Slack interactivity, or channel auto-archival in this milestone.

The Worker emits structured operational logs for Capture ID, Delivery stage, duration, Slack identifiers, warning codes, and outcome. It must not log the authorization secret, request text, image, or diagnostic contents.
