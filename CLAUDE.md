# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Bee-do M0 is a single tracer path: a Chrome MV3 extension captures and annotates a page, `POST`s it to a Cloudflare Worker, and the Worker publishes it to a new public Slack channel. It stops there — no persistence, no agent, no PR, no Slack interactivity.

- `README.md` — Capture API contract, setup, M0 constraints, acceptance smoke test.
- `CONTEXT.md` — the product vocabulary. Use these terms in code, comments, and prose: **Capture**, **Requester**, **Project**, **Delivery**, **Request Channel**.
- `docs/m0-setup-and-deployment.md` — deployment/rollback runbook.
- `Annotation based PR Agent proposal.md` — the milestones after M0 and the contracts M0 is meant to preserve.

## Commands

```bash
corepack enable && pnpm install
pnpm generate:types           # writes the gitignored worker-configuration.d.ts; typecheck runs this first
pnpm check                    # lint + format:check + typecheck + test — run this before calling work done
pnpm test                     # vitest run
pnpm exec vitest run test/worker.spec.ts -t "rejects an unauthorized"   # one file / one test
pnpm test:watch
pnpm test:coverage            # istanbul provider (no thresholds configured)
pnpm lint:fix                 # oxlint --fix
pnpm format                   # oxfmt --write
pnpm dev                      # wrangler dev; needs a .dev.vars with the three secrets
pnpm build:extension          # esbuild → dist/extension (load unpacked); BEE_DO_SOURCE_MAPS=1 to include maps
pnpm deploy                   # pnpm check + build:extension + wrangler deploy
```

Worker secrets (`wrangler secret put`, or `.dev.vars` locally): `SLACK_BOT_TOKEN`, `CAPTURE_INGEST_SECRET`, `SLACK_REVIEWER_IDS`. CI (`.github/workflows/ci.yml`) runs the same check sequence on Node 24 and never deploys.

### TypeScript projects

There are three, one per runtime, because their global types are mutually incompatible — `worker-configuration.d.ts` redeclares `Blob`, `fetch`, and friends more loosely than the DOM, so checking extension code against workerd globals hides real browser type errors:

| Project                   | Covers                                  | Globals                                       |
| ------------------------- | --------------------------------------- | --------------------------------------------- |
| `tsconfig.json`           | `src/**`, `test/**`, `vitest.config.ts` | workerd (`worker-configuration.d.ts`), no DOM |
| `extension/tsconfig.json` | `extension/src/**` + `src/shared/**`    | `DOM`, `DOM.Iterable`, `chrome`               |
| `scripts/tsconfig.json`   | `scripts/**/*.mjs` (`checkJs`)          | `node`                                        |

`tsconfig.base.json` holds the shared strictness flags; each project sets `lib` and an explicit `types` array, and those arrays must stay explicit so one runtime's globals never leak into another. `pnpm typecheck` runs all three. `src/shared/**` is deliberately checked twice — it must compile in both runtimes. Editors pick the right project automatically from directory nesting.

## Architecture

Two runtimes, one shared contract.

**`src/shared/` — the contract both sides import.** `capture.ts` holds the Zod `captureV1Schema` (`CaptureV1`) plus the success/error response types; `limits.ts` holds every byte, character, and Slack Block Kit limit; `projects.ts` maps an approved origin to a Project slug. The extension imports these directly via relative paths (`../../src/shared/...`) and esbuild bundles them, so a schema change reaches both sides at once. Never hardcode a limit at a call site — add it to `limits.ts`.

**`src/worker/` — the Cloudflare Worker.** `index.ts` is the whole request pipeline in order: route → bearer auth (constant-time compare) → `content-length`/streaming size cap → multipart parse → metadata size + JSON parse → Zod validation → image part signature check → Delivery. `delivery.ts` runs the fixed Slack sequence (create channel → invite → root message → external file upload into the thread → diagnostics → permalink) and emits one structured log line per stage. `slack.ts` is a thin API client that turns every failure into a `SlackApiError` carrying method/slack code/HTTP status. `errors.ts` defines `WorkerError` (`code`, `stage`, `status`, `retryable`, optional `slack`).

**`extension/src/` — Manifest V3.** `background.ts` is the service worker and the only place holding the pilot secret: it resolves the Project from the tab URL, calls `captureVisibleTab`, asks the content script for page context, injects `overlay.js`, and later performs the authenticated `fetch` — it also overwrites `requester.slackUserId` from stored settings, so the overlay can never assert someone else's ID. `collector.ts` runs in the **MAIN** world (it must patch the page's own `console`) and `bridge.ts` in the **ISOLATED** world (it needs `chrome.runtime`); they talk over `window.postMessage` with a nonce and a 500 ms timeout, and the background falls back to `chrome.scripting.executeScript` if no content script answers. `overlay.ts` is a shadow-DOM annotation UI that paints markup into a canvas over the screenshot and encodes it through `image-budget.ts`. `options.ts` validates and stores the endpoint/secret/Slack ID and requests the host permission for that exact origin.

### Invariants worth preserving

- **Nothing is created in Slack until everything cheap has been validated.** Size caps, schema, and the image signature check all run before the first Slack call. After channel creation, a required-stage failure returns 502 with `slack` naming the orphaned channel; invite and diagnostics failures are non-fatal and become `warnings` (`DeliveryWarning` in `worker/types.ts`) instead.
- **Project is derived from the page origin, never chosen by the requester** (`resolveProject`). The Zod schema re-derives it from `page.url` and rejects a mismatch. Adding a Project touches `projects.ts`, the `project.slug` literal in `capture.ts`, and the manifest's `host_permissions`, `content_scripts.matches`, and `web_accessible_resources`.
- Chrome forces the manifest to declare `https://*.vercel.app/*`, but `resolveProject` allows only the `-hbmartins-projects.vercel.app` suffix — `collector.ts` and `bridge.ts` both re-check `isSupportedPage` at runtime. Keep both checks.
- Worker logs are single-line JSON via `console.log`. They may carry Capture ID, stage, duration, Slack identifiers, and codes — never the secret, request text, image bytes, or diagnostic contents.
- Slack text is escaped and clamped centrally (`escapeMrkdwn`, `clampBlocks`, `truncate`) because one over-limit block fails `chat.postMessage` wholesale and strands a created channel.

## Testing

All tests run inside workerd via `@cloudflare/vitest-pool-workers`, including the ones covering extension modules. Only DOM-free extension modules can be tested there — `capture.ts`, `geometry.ts`, `url.ts`, `image-budget.ts` are; `overlay.ts`, `background.ts`, `collector.ts`, `bridge.ts`, `options.ts`, `storage.ts` have no tests. Slack is never contacted: `createWorker({ fetcher, makeAttempt, log })` injects a fake `Fetcher`, a deterministic channel-name suffix, and a log sink.

## Gotchas

- New extension entry points must be added to `entries` in `scripts/build-extension.mjs` _and_ wired into `manifest.json`; new static assets to the copy list in the same script. They are typechecked automatically — `extension/tsconfig.json` globs the directory rather than listing files.
- Adding a source directory outside `src/`, `extension/src/`, `test/`, and `scripts/` leaves it unchecked. Give it a project (or extend an existing `include`) at the same time.
- `.oxlintrc.json` sets `maxWarnings: 0` and assigns environments per directory via `overrides` — a new top-level source directory needs its own override or its globals will lint as undefined.
- `exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. The pervasive `...(value !== undefined ? { key: value } : {})` spread idiom is a consequence of that, not an accident — match it rather than declaring `key?: T | undefined`.
- `worker-configuration.d.ts` is generated and gitignored; regenerate after any `wrangler.jsonc` change.
