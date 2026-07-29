# Bee-do M0 setup and deployment guide

This guide is the end-to-end runbook for setting up, deploying, verifying, operating, and rolling back the current Bee-do M0 milestone. It is written for the manually distributed internal pilot represented by this repository.

M0 implements one complete path:

```text
Chrome extension -- POST /v1/captures --> Cloudflare Worker --> public Slack channel
  capture viewport     authenticate and validate             root summary
  collect context      create and populate channel           threaded image
  render markup        return Slack permalink                diagnostics
```

The authoritative product vocabulary is in [CONTEXT.md](../CONTEXT.md), and the Capture API contract is documented in the [README](../README.md#capture-api).

## M0 scope

M0 includes:

- A manually loaded Chrome Manifest V3 extension.
- Visible-viewport capture on `https://trellium.ai/*` and approved Vercel previews.
- Pen and text annotations rendered into the delivered image.
- A required request description and requester Slack member ID.
- Bounded console warnings/errors and recent-click diagnostics.
- An authenticated Cloudflare Worker endpoint at `POST /v1/captures`.
- A dedicated Slack app that creates one public Request Channel for each Capture.
- A root summary, threaded annotated image, optional diagnostics, and a Slack permalink.
- Structured Cloudflare Worker logs and stable error/warning codes.

M0 intentionally does not include persistent Capture or workflow state, D1, R2, a coding agent, branch or pull-request creation, preview monitoring, Slack interactivity, automatic channel archival, Chrome Web Store distribution, CI deployment, an automated browser test suite, or tests against a real Slack workspace.

Retries are not idempotent. Retrying the same Capture preserves its Capture ID for correlation but can create another channel. A failed Delivery can also leave a partial channel that must be inspected and archived manually.

## Files that control the deployment

| File                                                      | Purpose                                                                        |
| --------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [`wrangler.jsonc`](../wrangler.jsonc)                     | Worker name, entry point, compatibility date, `workers.dev`, and observability |
| [`slack/app-manifest.yaml`](../slack/app-manifest.yaml)   | Slack app identity and bot scopes                                              |
| [`extension/manifest.json`](../extension/manifest.json)   | Chrome permissions, supported hosts, scripts, and keyboard shortcut            |
| [`package.json`](../package.json)                         | Pinned pnpm version and build, check, development, and deployment commands     |
| [`src/shared/capture.ts`](../src/shared/capture.ts)       | Versioned Capture schema and response types                                    |
| [`src/shared/limits.ts`](../src/shared/limits.ts)         | Transport, content, and Slack limits                                           |
| [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | Push and pull-request checks; it does not deploy                               |

## Prerequisites

### Local software

- Git.
- Chrome 120 or newer.
- Node.js 22 or newer. Node.js 24 is recommended because it matches CI.
- Corepack, included with supported Node.js installations.
- pnpm 11.15.1, selected through the `packageManager` field in `package.json`.

Confirm the toolchain from the repository root:

```bash
node --version
corepack enable
pnpm --version
```

After `corepack enable`, `pnpm --version` should print `11.15.1` when run in this repository.

### Required accounts and access

The operator needs:

- A Cloudflare account with permission to deploy a Worker to a `workers.dev` subdomain.
- Permission to create and install an app in the pilot Slack workspace.
- Permission to create public Slack channels through the installed app.
- Access to `trellium.ai` or an approved Vercel preview for the acceptance test.
- The Slack member ID of each requester and optional reviewer.

Slack member IDs begin with `U` or `W`. A member can copy their ID from their Slack profile's **More** menu.

### Values to collect

Keep this worksheet in a password manager or another approved secret store, not in the repository:

| Value               | Example shape                                   | Used by                                     |
| ------------------- | ----------------------------------------------- | ------------------------------------------- |
| Slack bot token     | `xoxb-...`                                      | Worker secret `SLACK_BOT_TOKEN`             |
| Pilot ingest secret | At least 32 random bytes                        | Worker and each extension installation      |
| Reviewer member IDs | `U012...,W034...`                               | Optional Worker secret `SLACK_REVIEWER_IDS` |
| Requester member ID | `U012...`                                       | Extension settings                          |
| Worker origin       | `https://bee-do-ingest.<subdomain>.workers.dev` | Health check and extension endpoint         |
| Capture endpoint    | Worker origin plus `/v1/captures`               | Extension settings                          |

## 1. Bootstrap the repository

From the repository root, install exactly the dependencies in the lockfile and generate the Cloudflare environment types:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm generate:types
```

`pnpm generate:types` creates `worker-configuration.d.ts`. The file is generated and ignored by Git.

Run the baseline checks before configuring external services:

```bash
pnpm check
pnpm test:coverage
pnpm build
```

These commands verify formatting, lint rules, TypeScript, Worker tests, test coverage, the extension bundle, and a dry-run Worker bundle. Generated artifacts are placed under `dist/` and `coverage/`; both directories are ignored by Git.

## 2. Create and install the Slack app

Bee-do uses a dedicated Slack bot. It does not use Socket Mode, event subscriptions, interactive components, or token rotation in M0.

1. Open [Slack API apps](https://api.slack.com/apps).
2. Select **Create New App**, then **From an app manifest**.
3. Select the pilot workspace.
4. Paste or upload [`slack/app-manifest.yaml`](../slack/app-manifest.yaml).
5. Review and create the app.
6. Install the app to the workspace.
7. Open **OAuth & Permissions** and copy the **Bot User OAuth Token** beginning with `xoxb-`.
8. Store the token in the approved secret store.

The manifest requests only these bot scopes:

| Scope                    | Why M0 needs it                               |
| ------------------------ | --------------------------------------------- |
| `channels:manage`        | Create a public Request Channel               |
| `channels:write.invites` | Invite the requester and configured reviewers |
| `chat:write`             | Post the root summary and diagnostics         |
| `files:write`            | Upload and attach the annotated image         |

Do not add the bot to a standing channel. The bot creates a new public channel for each Capture and becomes a member as part of channel creation.

If the manifest changes after installation, update the app configuration in Slack and reinstall or reauthorize it before deploying code that depends on the new scopes.

## 3. Authenticate Wrangler with Cloudflare

The checked-in configuration deploys a Worker named `bee-do-ingest` from `src/worker/index.ts` and enables its `workers.dev` URL and Worker observability.

Authenticate and confirm that Wrangler selected the intended account:

```bash
pnpm exec wrangler login
pnpm exec wrangler whoami
```

If the Cloudflare user can access multiple accounts, verify the account shown by `whoami` before creating secrets or deploying. The repository currently has one deployment configuration and no named Wrangler environments, so `--env` should not be added to these commands.

## 4. Configure Worker secrets

The Worker reads the following runtime bindings:

| Secret                  | Required | Format and behavior                                                                |
| ----------------------- | -------- | ---------------------------------------------------------------------------------- |
| `SLACK_BOT_TOKEN`       | Yes      | Installed Slack bot token beginning with `xoxb-`                                   |
| `CAPTURE_INGEST_SECRET` | Yes      | High-entropy bearer secret shared with extension installations                     |
| `SLACK_REVIEWER_IDS`    | No       | Comma-separated Slack member IDs; whitespace is trimmed and duplicates are removed |

Generate the ingest secret with a cryptographically secure generator. For example, this prints a 256-bit hexadecimal value to the terminal:

```bash
openssl rand -hex 32
```

Save it immediately in the approved secret store. Do not put any secret in `wrangler.jsonc`, an extension source file, a shell script, an issue, or a committed environment file.

Create the remote secrets interactively:

```bash
pnpm exec wrangler secret put SLACK_BOT_TOKEN
pnpm exec wrangler secret put CAPTURE_INGEST_SECRET

# Run this only when reviewers should be invited automatically.
pnpm exec wrangler secret put SLACK_REVIEWER_IDS
```

At each prompt, paste only the corresponding value. Use a comma-separated value such as `U0123456789,U9876543210` for reviewers. If there are no reviewers, omit `SLACK_REVIEWER_IDS`; the requester will still be invited.

On a first deployment, Wrangler may ask permission to create the `bee-do-ingest` Worker while adding its first secret. Accept only after verifying the account and Worker name.

Confirm that the secret names exist without revealing their values:

```bash
pnpm exec wrangler secret list
```

Cloudflare does not return secret values after storage. If a value is uncertain, replace it with `wrangler secret put` rather than trying to read it back.

## 5. Deploy the Worker

### Pre-deployment verification

For a release, reproduce the CI checks from a clean dependency state:

```bash
pnpm install --frozen-lockfile
pnpm generate:types
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test:coverage
pnpm build
git status --short
```

Review `git status` before deploying so the deployed source is intentional. CI runs the same quality and build checks on pushes and pull requests with Node.js 24, but CI does not deploy the Worker, install the extension, or contact Slack.

### Deploy

Deploy from the repository root:

```bash
pnpm deploy
```

The `deploy` script reruns `pnpm check`, rebuilds `dist/extension`, and executes `wrangler deploy`. Wrangler builds and publishes the Worker configured in `wrangler.jsonc`; it does not distribute the Chrome extension.

Record the version or deployment identifier and the service URL printed by Wrangler. The expected URL shape is:

```text
https://bee-do-ingest.<account-subdomain>.workers.dev
```

The extension deliberately accepts deployed endpoints only on HTTPS `workers.dev` origins. A custom Worker domain will be rejected by the current extension options validation even if the Worker is reachable there.

### Verify the deployed service

The health endpoint is public and has no Slack side effects:

```bash
curl --fail-with-body \
  https://bee-do-ingest.<account-subdomain>.workers.dev/healthz
```

Expected response:

```json
{ "ok": true }
```

Also verify the route guards without exposing the ingest secret:

```bash
curl --include \
  https://bee-do-ingest.<account-subdomain>.workers.dev/not-a-route

curl --request POST \
  --include \
  https://bee-do-ingest.<account-subdomain>.workers.dev/v1/captures
```

The unknown route should return `404 NOT_FOUND`. The unauthenticated Capture request should return `401 UNAUTHORIZED`. Do not put the bearer secret directly into copied terminal commands, logs, screenshots, or shared shell history.

## 6. Build and install the Chrome extension

Build the unpacked Manifest V3 extension:

```bash
pnpm build:extension
```

The loadable directory is `dist/extension`. It contains the manifest, options page, styles, compiled JavaScript, and source maps.

1. Open `chrome://extensions` in Chrome.
2. Turn on **Developer mode**.
3. Select **Load unpacked**.
4. Select this repository's `dist/extension` directory, not the source `extension` directory.
5. Pin **Bee-do Capture** to the toolbar if desired.
6. Open the extension details and choose **Extension options**.

This is an internal, manually distributed extension. M0 does not produce a ZIP, CRX, signed package, or Chrome Web Store release.

### Configure extension settings

Enter:

- **Capture endpoint:** the full HTTPS Worker URL ending exactly in `/v1/captures`, for example `https://bee-do-ingest.<account-subdomain>.workers.dev/v1/captures`.
- **Pilot secret:** the exact current `CAPTURE_INGEST_SECRET` value.
- **Your Slack member ID:** the requester's member ID beginning with `U` or `W`.

Select **Save settings**. Chrome will ask for permission to access that Worker origin. Approve the exact origin. A saved status should appear.

The endpoint validator allows only:

- `https://*.workers.dev/v1/captures`
- `http://localhost[:port]/v1/captures`
- `http://127.0.0.1[:port]/v1/captures`

Settings are stored in `chrome.storage.local` for that Chrome profile. The extension asks Chrome to restrict the settings to trusted extension contexts, but the shared secret remains a pilot credential and is not suitable for public distribution.

### Refresh after an extension update

After rebuilding the extension:

1. Open `chrome://extensions`.
2. Select **Reload** on Bee-do Capture.
3. Refresh any already-open supported page so the updated collector and bridge scripts load at `document_start`.
4. Confirm extension settings are still present.

Loading the same `dist/extension` path normally preserves the extension identity and settings. Removing and loading it again can clear profile-local settings and require a fresh endpoint permission grant.

## 7. Run the owner-operated M0 acceptance test

The automated suite mocks Slack. A real deployment is complete only after this manual end-to-end smoke test succeeds.

### Prepare

1. Open one supported page:
   - `https://trellium.ai/*`, or
   - a Vercel hostname ending in `-hbmartins-projects.vercel.app` with a non-empty prefix.
2. Refresh the page after loading or reloading the extension. Diagnostics are collected only after the collector loads.
3. Optionally start a Worker log tail in another terminal:

   ```bash
   pnpm exec wrangler tail bee-do-ingest --format pretty
   ```

4. If diagnostics are part of the test, make a page click and cause or observe a console warning/error after the refresh. Bee-do does not collect ordinary `console.log` messages.

### Submit a Capture

1. Select the Bee-do toolbar action or press `Alt+Shift+A`.
2. Confirm that the extension captures the visible viewport and opens its full-screen overlay.
3. Enter a non-empty request description.
4. Draw at least one pen stroke.
5. Add at least one text label by selecting **Text**, clicking the image, typing the label, and pressing Enter.
6. Select **Send to Slack** and wait for Delivery to finish.
7. Select **Open Slack** after success.

Useful overlay controls are:

- **Undo:** remove the most recent stroke or label.
- **Clear:** remove all annotations.
- **Escape:** cancel active text input first; when no text input is active, close the overlay.
- **Close:** dismiss the overlay after success.

The screenshot is taken before the overlay opens, so the Bee-do UI should not appear in the delivered image. Only the visible viewport is captured; this is not a full-page screenshot.

### Verify Slack

Confirm all of the following:

- A new public channel exists with a name shaped like `bee-trellium-<route>-<capture8>-<attempt4>`.
- The requester and all valid configured reviewers are channel members, unless an invite warning was returned.
- The root message identifies the request, requester, `trellium` project, page, viewport, and full Capture ID.
- The annotated PNG or JPEG is attached in the root message thread.
- The pen stroke and text label appear in the correct positions.
- Console and click diagnostics appear in the thread when collected.
- **Open Slack** opens the root message permalink.
- The Worker tail shows stage-level structured logs and a final `delivery` outcome.

A successful Delivery returns HTTP `201`. Invite, invalid-reviewer, and diagnostics-post problems are non-fatal warnings, so the extension can report success with warnings. Investigate warnings before declaring the release verified.

## Local Worker development

Create an ignored `.dev.vars` file in the repository root:

```dotenv
SLACK_BOT_TOKEN="xoxb-replace-me"
CAPTURE_INGEST_SECRET="replace-with-a-local-pilot-secret"
SLACK_REVIEWER_IDS="U0123456789,U9876543210"
```

Use real values locally, but never commit the file. `.dev.vars` and `.dev.vars*` are ignored by Git.

Start the local Worker:

```bash
pnpm dev
```

Wrangler normally prints a URL on `localhost` or `127.0.0.1`. Configure the extension with that origin and `/v1/captures`, then save and approve the new exact-origin permission.

Important: local Worker execution still calls the real Slack API when given a real bot token. Every successful local Capture creates a real public channel. Use a test workspace when possible, and manually archive channels created during testing.

When local testing is finished, restore the deployed HTTPS endpoint and production pilot secret in the extension options.

## Routine deployment runbook

Use this sequence for each M0 code release:

1. Confirm the intended revision and review local changes with `git status --short` and `git diff`.
2. Run `pnpm install --frozen-lockfile`.
3. Run the full pre-deployment verification set.
4. Confirm remote secret names with `pnpm exec wrangler secret list` when configuration changed.
5. Run `pnpm deploy`.
6. Record the deployed version/deployment ID and Worker URL.
7. Verify `/healthz`.
8. Reload the unpacked extension from the newly rebuilt `dist/extension` directory on every pilot browser that should receive the update.
9. Refresh the supported target page.
10. Complete the owner-operated acceptance test.
11. Inspect warnings and Worker logs, and archive any test or orphaned Slack channels.

A Worker deployment does not update already loaded extension code. An extension rebuild does not deploy the Worker. Treat those as two artifacts that must remain compatible with Capture schema version `1`.

## Operations and observability

### Tail Worker logs

```bash
pnpm exec wrangler tail bee-do-ingest --format pretty
```

For machine-readable output, use `--format json`. Delivery logs contain safe operational fields such as:

- `captureId`
- `stage`
- `durationMs`
- `outcome`
- `channelId` and `channelName`, when available
- `rootTs`, when available
- `warningCodes` or error `code`
- Slack method, Slack error code, and HTTP status for Slack API failures

The Worker is designed not to log the bearer secret, request description, screenshot, or diagnostic contents. Preserve that property when adding temporary debugging. Avoid logging full request bodies, headers, extension settings, or `.dev.vars`.

### Correlate and clean up a partial Delivery

Use the full Capture ID as the primary correlation key. The channel name contains the first eight compact UUID characters and a four-character attempt suffix.

If a required Slack stage fails after channel creation, the error response and log include `channelId` and `channelName`. Inspect that channel before retrying. Because retry is not idempotent, either:

- Archive the partial channel and retry the same Capture, accepting that the retry creates a new channel with the same Capture ID; or
- Resolve the Slack problem and submit a fresh Capture if preserving the overlay state is not necessary.

Do not assume a retry repairs an existing channel.

### Rotate secrets

To rotate the Slack token or ingest secret, run the same `secret put` command with the existing key:

```bash
pnpm exec wrangler secret put SLACK_BOT_TOKEN
pnpm exec wrangler secret put CAPTURE_INGEST_SECRET
```

After rotating `CAPTURE_INGEST_SECRET`, update every active extension installation. During the rollout, browsers with the old value receive `401 UNAUTHORIZED`.

After changing Slack scopes or reinstalling the Slack app, update `SLACK_BOT_TOKEN` if Slack issued a new token and rerun the acceptance test.

## Rollback

### Worker rollback

List recent deployments and identify the last known-good version:

```bash
pnpm exec wrangler deployments list
```

Roll back by version ID and record the reason:

```bash
pnpm exec wrangler rollback <version-id> \
  --message "Rollback Bee-do M0 after failed acceptance test"
```

Then verify `/healthz` and repeat the owner-operated acceptance test. If the incident involved configuration, check the secret names with `wrangler secret list` and replace any uncertain value with `wrangler secret put`; stored values cannot be read back for comparison.

### Extension rollback

Cloudflare rollback does not roll back Chrome extension files. To restore an earlier extension:

1. Check out or obtain the known-good source revision without discarding uncommitted work.
2. Run `pnpm install --frozen-lockfile` and `pnpm build:extension` for that revision.
3. Reload the known-good `dist/extension` directory in `chrome://extensions`.
4. Refresh the target page.
5. Confirm its Capture schema is compatible with the deployed Worker and rerun the smoke test.

## Troubleshooting

| Symptom or code                                    | Likely cause                                                                                                 | Action                                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Extension opens its options instead of the overlay | One or more settings are empty                                                                               | Save the endpoint, ingest secret, and requester Slack member ID                                               |
| `Endpoint access was not granted`                  | Chrome exact-origin permission was denied                                                                    | Save again and approve the requested Worker origin                                                            |
| Options reject the endpoint                        | It is not HTTPS on `*.workers.dev`, local HTTP on `localhost`/`127.0.0.1`, or the path is not `/v1/captures` | Correct the full endpoint; custom domains are unsupported in M0                                               |
| Bee-do says the page is unsupported                | The page is not `trellium.ai` or an approved owner-specific Vercel preview                                   | Use a supported URL; arbitrary `*.vercel.app` hosts are deliberately blocked                                  |
| Toolbar changes have no effect after rebuilding    | Chrome or the page still has old extension scripts                                                           | Reload the extension, then refresh the target page                                                            |
| `network_error`                                    | Worker is unavailable, endpoint permission is missing, local Wrangler stopped, or the browser is offline     | Check `/healthz`, the configured endpoint, Chrome permissions, and `pnpm dev` if local                        |
| `UNAUTHORIZED`                                     | Extension and Worker ingest secrets differ                                                                   | Replace the extension setting or rotate the Worker secret intentionally                                       |
| `SERVICE_MISCONFIGURED`                            | `CAPTURE_INGEST_SECRET` or `SLACK_BOT_TOKEN` is absent                                                       | Check `wrangler secret list`, then replace the missing secret                                                 |
| `INVALID_CAPTURE` or `UNSUPPORTED_SCHEMA_VERSION`  | Extension and Worker are incompatible or metadata is invalid                                                 | Deploy matching revisions and confirm schema version `1`                                                      |
| `INVALID_IMAGE`                                    | Bytes, MIME type, file signature, or declared byte length disagree                                           | Rebuild matching extension/Worker revisions; retry with a fresh screenshot                                    |
| `IMAGE_TOO_LARGE` or `REQUEST_TOO_LARGE`           | The image could not fit the transport budget, even after client degradation                                  | Retry at a smaller viewport; inspect extension image-budget behavior before changing limits                   |
| `CHANNEL_CREATE_FAILED`                            | Slack token, scope, workspace policy, or channel limits prevent creation                                     | Check Worker Slack error fields, app installation, `channels:manage`, and workspace limits                    |
| `ROOT_MESSAGE_FAILED`                              | Slack rejected or could not post the summary                                                                 | Check `chat:write`, the bot installation, and the orphan channel in the error response                        |
| `IMAGE_UPLOAD_FAILED`                              | Slack external upload or attachment failed                                                                   | Check `files:write`, Slack status, token validity, and the reported orphan channel                            |
| `PERMALINK_FAILED`                                 | Slack could not resolve the root link                                                                        | Inspect the created channel/root message and Slack error details before retrying                              |
| `INVALID_REVIEWER_ID` warning                      | At least one configured reviewer is malformed                                                                | Replace `SLACK_REVIEWER_IDS` with valid comma-separated `U`/`W` member IDs                                    |
| `INVITE_FAILED` warning                            | Slack could not invite one or more users                                                                     | Check workspace membership, IDs, channel policy, and `channels:write.invites`; invite manually if appropriate |
| `DIAGNOSTICS_POST_FAILED` warning                  | Root and image succeeded but the optional diagnostic message failed                                          | Inspect logs and the thread; retry only if a duplicate channel is acceptable                                  |
| No diagnostics in Slack                            | Nothing eligible was collected, or the collector loaded after the relevant events                            | Refresh the page and generate a click or console warning/error before capture                                 |
| Duplicate or partial channels                      | A Capture was retried or a required stage failed after creation                                              | Correlate by Capture ID, inspect logs, and archive unwanted channels manually                                 |

For any Slack Delivery error, the structured log's `slackMethod`, `slackCode`, and `httpStatus` are more actionable than the extension's deliberately safe user-facing message.

## Current M0 limits and security properties

- Complete multipart request: at most 10,000,000 bytes.
- Raw image part: at most 9,000,000 bytes.
- Capture metadata part: at most 256,000 bytes.
- Request description: at most 3,000 characters.
- Text annotation label: at most 160 characters.
- Console history: 25 entries, with warnings/errors and uncaught errors collected after extension load.
- Click history: 12 entries collected after extension load.
- Image types: PNG or JPEG only; declared MIME type, byte length, and file signature are validated before Slack side effects.
- Oversized captures: the extension tries lower JPEG quality and then downscales; it does not intentionally reduce a wider source below 800 pixels, and it never upscales a narrower source.
- Authentication: one high-entropy bearer secret shared by manually installed pilot extensions.
- Settings: stored locally in the Chrome profile, with trusted-context access requested where supported.
- Supported project: only `trellium`, derived from an allowlisted HTTPS page origin rather than requester input.
- Slack channels: public and manually managed.
- Persistence: none; the Worker retains no Capture workflow state.

The unauthenticated `/healthz` endpoint reports process availability only. It does not validate Slack credentials, reviewer configuration, extension permissions, or an end-to-end Delivery. The manual acceptance test is therefore required after deployment and configuration changes.

## Deployment completion checklist

- [ ] Repository dependencies installed from the lockfile.
- [ ] Full local verification set passes.
- [ ] Slack app installed from the checked-in manifest.
- [ ] Slack bot token stored as a Worker secret.
- [ ] Random ingest secret stored as a Worker secret and in the approved secret store.
- [ ] Optional reviewer IDs configured and validated.
- [ ] Intended Cloudflare account confirmed.
- [ ] Worker deployment succeeds and its version ID is recorded.
- [ ] `/healthz` returns `{"ok":true}`.
- [ ] Extension rebuilt, loaded from `dist/extension`, and refreshed on the target page.
- [ ] Extension endpoint, secret, requester ID, and exact-origin permission are correct.
- [ ] Real approved-page Capture succeeds with a request, pen stroke, and text label.
- [ ] Public Slack channel, invitees, root message, threaded image, diagnostics, and permalink are verified.
- [ ] Worker logs show the expected stage outcomes with no sensitive content.
- [ ] Warnings are resolved or explicitly accepted.
- [ ] Test, duplicate, and partial Slack channels are archived as appropriate.
