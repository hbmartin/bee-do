# Annotate → Slack (Phase 1)

Browser extension → serverless function → Slack. No agent, no sandbox, no repo access.
The point of this phase is to prove the capture is good enough to act on, and to
lock the bundle schema that every later phase reads.

```
extension ──POST /api/ingest──▶ cloudflare worker ──▶ Slack
  capture                         auth + shape         new channel
  annotate                                             message + threaded PNG
  collect context
```

## Slack app

Create an app at api.slack.com/apps → **From scratch**. Under *OAuth & Permissions*
add these bot scopes:

| Scope | Why |
| --- | --- |
| `chat:write` | post the request |
| `files:write` | upload the annotated capture |
| `channels:manage` | open a channel per request |
| `channels:join` | bot lands in the channel it creates |

Install to the workspace and copy the bot token (`xoxb-…`).

## Deploy the function

```bash
cloudflare env add SLACK_BOT_TOKEN      # xoxb-…
cloudflare env add ANNOTATE_SECRET      # any long random string
cloudflare env add SLACK_INVITE_USERS   # optional: U0123,U0456
# cloudflare env add SLACK_CHANNEL_ID   # optional: post to one fixed channel instead
cloudflare deploy --prod
```

## Load the extension

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`.
2. Open the extension's options and fill in the endpoint, the secret, your name,
   and the project slug.
3. Go to any page on your app and hit the toolbar button (or `Alt+Shift+A`).

Drag across anything you want changed. Each drag drops a numbered pin and opens a
matching note in the rail. `Cmd/Ctrl+Z` undoes, `Esc` closes. Send is disabled
until every mark has a note — that constraint exists because an unlabelled mark is
the one thing a coding agent cannot act on.

## The bundle

This schema is the contract. Phase 2's clarifier and Phase 3's agent prompt both
read it, so change it here first.

```jsonc
{
  "capturedAt": "2026-07-29T18:04:11.930Z",
  "requester": "Dana",
  "project": "svrn",
  "page": {
    "url": "https://svrn.app/deals/abc?tab=terms",
    "path": "/deals/abc",
    "search": "?tab=terms",
    "title": "Terms · Deal",
    "viewport": { "w": 1440, "h": 812 },
    "dpr": 2
  },
  "annotations": [
    { "n": 1, "note": "This label wraps at 1440 — shorten or truncate.",
      "at": { "x": 0.41, "y": 0.28 } }
  ],
  "consoleErrors": [
    { "level": "error", "message": "…", "at": "2026-07-29T18:03:02.114Z" }
  ],
  "clickTrace": [
    { "selector": "div.panel > button", "text": "Terms", "at": "…" }
  ],
  "screenshot": "data:image/png;base64,…"   // marks + numbers burned in
}
```

Two details that matter more than they look:

- **The numbers are load-bearing.** The same integer appears on the pin in the PNG
  and in front of the note. That correspondence is the whole reason a model can
  read a freehand scribble. Don't let a later refactor drop it.
- **The screenshot is a still, not the live page.** Capture happens before the
  overlay opens, so what gets marked up is pixel-identical to what the agent
  receives. No layout drift between annotating and sending.

## Known edges

- Visible viewport only. Full-page capture needs scroll-and-stitch in the service
  worker — worth adding once you see whether anyone misses it.
- cloudflare caps request bodies around 4.5 MB. The overlay falls back to JPEG q90 if
  the PNG exceeds ~3 MB; if you start hitting that, move to a presigned upload to
  Blob storage and send a URL instead of base64.
- `consoleErrors` only contains what happened *after* the collector loaded. It runs
  at `document_start`, so that's nearly everything, but not errors from a page
  loaded before the extension was installed.
- Shared secret in `chrome.storage.sync` is fine for an internal tool and not fine
  for anything else.

## What Phase 2 adds

The function stops being the last stop: it writes the bundle to Postgres, then a
clarifier call turns it into Block Kit questions posted in the same channel. The
sandbox doesn't appear until Phase 3, which is the first time any of this needs
Daytona, a git identity, or a database for the app under test.
