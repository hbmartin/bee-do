# Annotation → PR Agent

**Product specification v1.0** Internal tool · SVRN · July 2026

------

## 1. Summary

A designer or PM looking at a page in SVRN marks up what they want changed, describes it in a sentence, and hits send. Somewhere between five and thirty minutes later a pull request exists, with a screenshot of the change rendered on a real preview deployment. Nobody opened a terminal, filed a ticket, or wrote a reproduction.

The system is four things stitched together: a browser extension that captures intent, a Slack surface that resolves ambiguity before any compute is spent, an ephemeral Daytona sandbox that runs a CLI coding agent against the repo, and a verification step that turns the result back into a picture.

### 1.1 Goals

- A non-engineer can request a UI change from the page they're looking at, without context-switching.
- Ambiguity is resolved in Slack with tappable choices, not free-text ping-pong.
- Output is a reviewable PR with visual proof, not a merged change.
- One billing identity and one set of credentials for the whole team.

### 1.2 Non-goals

- Auto-merge. A human developer owns GitHub, always.
- Backend, schema, or infrastructure changes. This is a UI tool.
- Multi-repo requests. Single monorepo, single branch per request.
- Production-grade multi-tenancy. This is internal, all pages public, no compliance surface.

### 1.3 Success criteria

There is one honest measure: **the share of requests that a developer merges without touching the branch.** If that number sits above roughly a third, the tool is faster than describing the change in Slack to a human. Below that, it's an expensive way to generate review work. Everything else — latency, cost, uptime — is secondary and none of it is worth optimizing until that ratio is known.

Secondary signals worth tracking from M2 onward: how many clarifying rounds a request needs, how often a request is abandoned mid-clarification, and cost per merged PR.

------

## 2. Users

| Role                         | Does                                                         | Needs                                                        |
| ---------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| **Requester** (designer, PM) | Annotates a page, answers clarifying questions in Slack      | To never see a terminal, a diff, or a git concept            |
| **Developer** (Harold)       | Reviews and merges PRs, tunes `AGENTS.md`, handles anything the agent refuses | Enough context in the PR to review without replaying the conversation |
| **The agent**                | Reads the brief, edits code, verifies visually, opens a PR   | An unambiguous brief and hard boundaries                     |

The requester is the design center. Every interface decision resolves in their favor, and every piece of engineering vocabulary that leaks into Slack is a defect.

------

## 3. Architecture

### 3.1 The two-phase rule

The single most important structural decision: **the sandbox never waits for a human.**

Clarification and execution are separate phases with different cost profiles. Clarification is a couple of cheap API calls and can sit unanswered for a week for free. Execution is metered compute and runs to completion without blocking. Conflating them — keeping a container alive while someone is at lunch — is the expensive mistake this design exists to avoid.

```
┌─────────────┐
│  Extension  │  capture → annotate → bundle
└──────┬──────┘
       │ POST /api/ingest
       ▼
┌─────────────┐
│   Ingest    │  auth, validate, persist, open channel
└──────┬──────┘
       │
       ▼
╔═══════════════════════════════════════════╗
║  PHASE A — CLARIFY          no compute    ║
║                                           ║
║  Clarifier (Messages API)                 ║
║       ↓ questions as JSON                 ║
║  Slack Block Kit  ⇄  requester taps       ║
║       ↓                                   ║
║  Brief frozen                             ║
║  (timeout → defaults, proceed anyway)     ║
╚═══════════════════════════════════════════╝
       │
       ▼
╔═══════════════════════════════════════════╗
║  PHASE B — EXECUTE          Daytona       ║
║                                           ║
║  boot snapshot → clone → branch           ║
║       ↓                                   ║
║  codex -p  (brief + annotated PNG)       ║
║       ↓                                   ║
║  dev server up → Playwright screenshot    ║
║       ↓                                   ║
║  self-correct loop (max 2)                ║
║       ↓                                   ║
║  commit, push, open PR → destroy sandbox  ║
╚═══════════════════════════════════════════╝
       │
       ▼
┌─────────────┐
│  Verifier   │  on Vercel deploy → screenshot preview
└──────┬──────┘  → PR comment + Slack thread
       ▼
   Developer reviews
```

### 3.2 Components

| Component    | Runtime                    | Responsibility                              |
| ------------ | -------------------------- | ------------------------------------------- |
| Extension    | Chrome MV3                 | Capture, annotate, collect page context     |
| Ingest API   | Vercel function            | Auth, validate, persist, open Slack channel |
| Orchestrator | Inngest (or Trigger.dev)   | Durable workflow across both phases         |
| Clarifier    | Messages API               | Bundle → structured questions               |
| Slack app    | Vercel functions           | Block Kit render + interactivity webhook    |
| Executor     | Daytona SDK                | Sandbox lifecycle, agent invocation         |
| Verifier     | GitHub Action + Playwright | Preview screenshot, visual diff             |
| Store        | Neon Postgres              | Request state                               |

**Why a durable workflow runner and not just functions:** Phase B runs 10–30 minutes. Vercel functions time out well before that, and a request that dies halfway leaves an orphaned sandbox burning money. Inngest gives step-level retries, a durable sleep for the clarification timeout, and a place to see what's stuck. This is not optional infrastructure; it's the thing that makes the system operable.

------

## 4. Component specifications

### 4.1 Extension

Shipped in M0. See `README.md` for setup.

**Capture.** `chrome.tabs.captureVisibleTab` fires *before* the overlay renders, so the requester annotates a still that is pixel-identical to what the agent receives. No layout drift, no fighting host-page CSS for hit targets.

**Annotation.** Freehand strokes on a shadow-DOM canvas. Each stroke drops a numbered pin at its endpoint and opens a matching numbered note in the rail. Send stays disabled until every mark has a note.

> **The numbering is load-bearing.** The same integer appears on the pin burned into the PNG and in front of the note in the brief. A freehand squiggle near a button is ambiguous — it could mean the button, its label, or the spacing around it. The number plus the note resolves it. Any refactor that breaks this correspondence breaks the product.

**Context collected.** URL, pathname, search, title, viewport, DPR, a ring buffer of the last 25 console errors and warnings (wrapped at `document_start` in the MAIN world), and the last 12 clicks with generated selectors.

**Deferred to M4:** full-page scroll-and-stitch capture, element-picker mode, presigned Blob upload for large captures.

### 4.2 Ingest API

`POST /api/ingest`, shared-secret auth via `x-annotate-secret`.

1. Validate the bundle shape. Reject anything without at least one annotated mark.
2. Insert a `requests` row, status `received`.
3. Create the Slack channel (`req-<yymmdd>-<route-slug>-<rand>`), invite the requester and the developer.
4. Post the request summary; upload the annotated PNG into the thread.
5. Emit `request.received` to the orchestrator.
6. Return the channel to the extension so the overlay can confirm and close.

Vercel caps request bodies near 4.5 MB. The overlay falls back to JPEG q90 above ~3 MB. When that starts biting, switch to a presigned Blob upload and send a URL — a one-day change, not worth doing before it hurts.

### 4.3 Clarifier

A single Messages API call. Cheap model, no sandbox, no repo clone.

**Input:** the bundle, plus a cached repo file tree (refreshed nightly, ~200 lines of paths), plus `AGENTS.md`, plus the last five resolved briefs as few-shot examples.

**Output:** strict JSON, no prose.

```jsonc
{
  "restated": "Shorten the deal-terms label so it doesn't wrap at 1440px.",
  "confidence": "high",
  "questions": [
    {
      "id": "q1",
      "text": "When the label is too long, what should happen?",
      "options": [
        { "id": "a", "label": "Truncate with an ellipsis" },
        { "id": "b", "label": "Wrap to two lines" },
        { "id": "c", "label": "Shrink the font" }
      ],
      "default": "a",
      "why": "Determines whether this is a CSS change or a copy change."
    }
  ]
}
```

Rules the prompt enforces:

- Maximum three questions. If more seem necessary, the request is too big — say so and ask the requester to split it.
- Every question has 2–4 options and a default. No free-text questions.
- Options are written in the requester's vocabulary. "Truncate with an ellipsis," not "apply `text-overflow`."
- `why` is not shown to the requester. It goes in the PR description so the developer can see what the agent was uncertain about.
- If `confidence` is high and no question is genuinely load-bearing, return zero questions and skip straight to Phase B.

### 4.4 Slack surface

**Scopes:** `chat:write`, `files:write`, `channels:manage`, `channels:join`, `commands`.

**Channel per request.** Named for the route and date so the list is scannable. Archived automatically 7 days after the PR opens.

**Thread structure.** The root message is the request. Everything else — clarifying questions, status, the final PR link and preview screenshot — lands in the thread.

**Interactivity.** Slack requires an acknowledgement within 3 seconds. The webhook does exactly one thing: verify the signature, write the answer, ack. All real work is handed to the orchestrator. Answering a question replaces the block with a plain confirmation line so the thread reads as a transcript rather than a form.

**The timeout.** A durable sleep of 4 hours. On expiry, unanswered questions take their defaults, the thread gets a message naming which assumptions were made, and Phase B starts. This is the stated design: proceed on best guess rather than stall.

**No approval gate.** Per product decision, the agent does not present a plan for sign-off. The check is the PR.

### 4.5 Executor (Daytona)

**Why Daytona:** container-based with sub-90ms creation, configurable CPU/memory/disk, declarative image builds with snapshot layering, and hibernate/resume that preserves state at no compute cost. Rates run $0.0504 per vCPU-hour and $0.0162 per GiB-hour — the low end of the market. The hibernate capability is insurance: if the two-phase rule ever needs to bend, sessions can wait without burning compute.

**Snapshot.** A pre-built image containing Node, pnpm, git, Playwright with Chromium, the codex Code CLI at a pinned version, and the monorepo's `node_modules` warmed. Rebuilt nightly and on lockfile change. Cold-cloning and installing a monorepo per request would dominate the runtime; a warm snapshot turns boot into seconds.

**Resources:** 4 vCPU, 8 GB, 20 GiB disk. The default 1 vCPU / 1 GB will not build a Next.js app.

**Lifecycle:**

```
create from snapshot
  → git fetch, checkout main, pull
  → branch: agent/<request-id>-<route-slug>
  → write BRIEF.md and capture.png into /workspace/.request/
  → codex -p  (see §5)
  → pnpm dev &  → wait for port
  → playwright screenshot at page.path
  → self-correct loop (max 2 rounds)
  → git commit, push
  → gh pr create
  → destroy
```

Hard ceiling: 30 minutes wall clock. Exceeded means the sandbox is destroyed, the branch is pushed as-is if there are commits, and the thread says so. A silent hang is worse than a visible failure.

**Concurrency:** unlimited by product decision, but with a per-repo advisory lock on branch creation to avoid two agents racing the same base.

### 4.6 Verification

Two layers, deliberately.

**In-sandbox self-correction.** The dev server comes up, Playwright navigates to the captured `page.path` at the captured viewport, and screenshots. That PNG goes back to the agent via `--resume` with the original annotated capture: *does this match marks 1–3?* Up to two correction rounds. This is the entire reason the sandbox runs the app, and it's where output quality comes from — an agent that can see its own work fixes about half its own mistakes before a human sees them.

**Post-deploy proof.** A GitHub Action on `deployment_status: success` screenshots the real Vercel preview at the same route and viewport, posts it to the PR and the Slack thread. This is what the requester actually looks at. The preview is the real artifact; the sandbox screenshot is a scratch pad.

**Visual diff (M5).** `pixelmatch` between the pre-change capture — which the extension already took, for free, at annotation time — and the preview screenshot. Delta highlighted in the same signal color as the marks.

**Route resolution** is the known weak point. The requester's URL is `/deals/abc?tab=terms`; the agent needs `/deals/[id]` to find the file, and Playwright needs an id that exists in the preview environment, which is not the production one. Resolution in §9.

### 4.7 GitHub

A GitHub App, not a PAT: scoped to the one repo, auditable, and PRs are authored by a bot identity that's obviously not a human. The sandbox receives a short-lived installation token, never a long-lived credential.

**PR body template:**

```markdown
### Request
<restated brief>

Requested by <name> · <slack channel link> · <original url>

### Marks
1. <note>
2. <note>

### Assumptions made
- <question> → <answer> (chosen by requester / defaulted on timeout)

### Verification
- Sandbox screenshot: <link>
- Preview screenshot: posted on deploy

### Agent
codex-<model> · <n> turns · $<cost> · session <id>
```

The assumptions section is the highest-value part of the PR for the reviewer. It is where every ambiguity the agent resolved is visible in one place.

------

## 5. Agent invocation

### 5.1 Authentication

**API key on codex Platform, billed at standard API rates.** Not a personal subscription.

This is the supported mechanism for exactly what's wanted here: one billing identity serving the whole team. As of June 15, 2026, programmatic usage — the Agent SDK, `codex -p`, and third-party apps — still draws from a subscription's usage limits, and recommends codex Platform with an API key for predictable pay-as-you-go automation. A subscription credential shared across a team also means shared rate limits, no per-request cost attribution, and a credential-refresh problem inside an ephemeral container.

`.codex/` configuration is unaffected — commands, subagents, and `AGENTS.md` live in the repo and apply identically.

### 5.2 Invocation

```bash
codex -p "$(cat /workspace/.request/BRIEF.md)" \
  --output-format stream-json \
  --permission-mode dontAsk \
  --max-turns 40 \
  --max-budget-usd 3.00 \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash(pnpm *),Bash(git *)" \
  --verbose
```

The annotated PNG is attached as an image, per the CLI's image input path — the visual is the request, and describing it in text discards most of the signal.

`--max-turns` and `--max-budget-usd` are the runaway guards; both exit non-zero at the limit. `stream-json` gives a live event stream to relay into the Slack thread as progress, and the terminating result message carries `session_id` and `total_cost_usd` — the session id feeds the self-correction `--resume`, and the cost goes into the PR body.

### 5.3 AGENTS.md additions

The guardrails live in the repo, versioned, reviewable:

```markdown
## Automated UI change requests

Requests arriving via .request/BRIEF.md are UI changes from non-engineers.

- Touch only: apps/web/**. Never packages/db/**, never migrations.
- No schema changes, no new dependencies, no config changes.
- No new files unless the brief clearly needs a new component.
- Match the existing component and token vocabulary. Do not introduce
  new colors, spacing values, or one-off utility classes.
- Keep the diff minimal. This is reviewed by a human who did not
  write the brief.
- If the request requires backend work, stop and write
  .request/REFUSED.md explaining why. Do not attempt a workaround.
```

The refusal path matters: it is the only way a scoped agent can decline gracefully rather than producing a plausible-looking change to the wrong layer.

------

## 6. Data model

```sql
create table requests (
  id              uuid primary key,
  created_at      timestamptz not null default now(),
  requester       text not null,
  project         text not null,

  bundle          jsonb not null,       -- extension payload minus the image
  screenshot_url  text not null,        -- blob storage

  slack_channel   text,
  slack_thread_ts text,

  status          text not null,        -- see below
  clarifier       jsonb,                -- questions as generated
  answers         jsonb,                -- {q1: "a", ...} + timeout markers
  brief           text,                 -- frozen input to the agent

  sandbox_id      text,
  session_id      text,
  cost_usd        numeric,

  branch          text,
  pr_url          text,
  preview_url     text,

  failure         text
);
```

**Status machine:**

```
received → clarifying → briefed → executing → verifying → delivered
                ↓            ↓         ↓           ↓
             abandoned    refused   failed     failed
```

`abandoned` is a requester who never answered and whose defaults were never taken because they cancelled. `refused` is the agent declining in-scope. Distinguishing them matters — one is a UX problem, the other is working as designed.

------

## 7. Failure modes

| Failure                          | Handling                                                     |
| -------------------------------- | ------------------------------------------------------------ |
| Clarifier returns malformed JSON | One retry with a repair prompt, then skip clarification and proceed with the raw bundle |
| Requester never answers          | 4h durable sleep → defaults → proceed, thread states the assumptions |
| Sandbox fails to boot            | Retry once on a fresh snapshot; then fail loudly in-thread   |
| Dev server won't start           | Skip in-sandbox verification, proceed to PR, flag prominently in the PR body |
| Agent hits turn or budget cap    | Push whatever exists as a draft PR, label `agent-incomplete` |
| Agent writes `REFUSED.md`        | No PR. Thread explains why in plain language, tags the developer |
| Agent touches a forbidden path   | Pre-push check rejects; abort, no PR, alert the developer    |
| Vercel preview never deploys     | PR still lands, thread notes verification was skipped        |
| Two requests on the same route   | Both proceed independently; conflicting PRs are the reviewer's problem, not the system's |

Guiding principle: **fail visibly in the thread the requester is already watching.** Silence is the worst outcome, because it teaches people the tool doesn't work.

------

## 8. Cost model

Per request, rough:

| Line                                 | Estimate           |
| ------------------------------------ | ------------------ |
| Clarifier call                       | ~$0.01             |
| Agent tokens (typical UI change)     | $0.40 – $2.50      |
| Daytona (4 vCPU / 8 GB, ~15 min)     | ~$0.08             |
| Verification Action + Vercel preview | negligible         |
| **Total**                            | **~$0.50 – $2.60** |

Model tokens dominate by an order of magnitude; sandbox cost is a rounding error. Which means: optimize the brief quality, not the infrastructure. A clarification round that prevents one wasted agent run pays for a thousand clarifier calls.

`--max-budget-usd 3.00` caps the tail. Track `cost_usd` per request from M3 and per merged PR from M4 — the second number is the real one.

------

## 9. Open decisions

Three, and they all block M3 rather than M1 or M2.

**9.1 Database for the sandbox.** Running the app to verify means the app needs data. Options: a Neon branch per request (clean, adds seconds to boot, costs little), one shared seeded dev branch (fastest, but concurrent agents share mutable state), or MSW-mocked data at the network layer (fastest and safest, but the screenshot is then of mocked UI, which undercuts the point of visual verification). *Recommendation: shared seeded read-only branch.* The agent is forbidden from writing schema anyway, and read-only removes the concurrency concern entirely.

**9.2 Route resolution.** The extension captures `/deals/abc`. Three approaches: carry both the concrete URL and a resolved route pattern (needs a Next.js route manifest lookup in the extension — fragile); have the agent infer the file from the path (usually works, occasionally wrong); or have Playwright navigate from the homepage following the recorded click trace (robust, slower, and the click trace already exists in the bundle). *Recommendation: agent infers the file for editing, Playwright replays the click trace for screenshotting.* The two problems have different best answers and don't need the same solution.

**9.3 Git identity.** GitHub App vs PAT. *Recommendation: GitHub App*, decided above in §4.7 — the only reason to consider a PAT is a half-day of setup time.

------

## 10. Milestones

### M0 — Capture → Slack ✅

**Delivered.** Extension, ingest function, Slack posting. No agent, no sandbox, no repo access.

**Why it exists:** it locks the bundle schema, which every later phase reads, and it's independently useful — a designer can already file a well-formed visual bug report in fifteen seconds.

**Acceptance:** a designer annotates a page and the marked-up capture plus context appears in a new Slack channel.

------

### M1 — Persistence and orchestration

*~2 days*

Neon Postgres, the `requests` table, Inngest wired in. Ingest writes a row and emits an event. A status command shows what's in flight. Nothing user-visible changes.

**Acceptance:** every request has a durable row and a workflow run; killing the function mid-request loses nothing.

**Why before the agent:** debugging an agent pipeline without a state store is guesswork, and retrofitting durability into a working pipeline is worse than building on it.

------

### M2 — The clarification loop

*~4 days*

Clarifier call, Block Kit rendering, interactivity webhook, answer persistence, the 4-hour timeout with defaults. The brief is generated and posted to the thread. **Still no agent** — the frozen brief is simply shown to the developer.

**Acceptance:** a request produces at most three tappable questions in the requester's vocabulary; answering them (or letting them time out) produces a brief the developer agrees is actionable.

**Why this is the riskiest milestone:** all the product risk lives here. If the clarifier asks bad questions, no amount of agent quality saves the output. Two weeks of running M2 without an agent attached will teach more about what the tool needs than building M3 first would. Read every generated brief.

------

### M3 — Sandbox and agent

*~1 week*

Daytona snapshot, the executor workflow, `codex -p` invocation, `AGENTS.md` guardrails, branch and PR creation, cost capture. No visual verification yet — a PR opens and Vercel's own preview comment is the only proof.

**Blocks on:** §9.1, §9.2, §9.3.

**Acceptance:** a frozen brief produces a PR on a branch, within budget and turn caps, touching only allowed paths, with the assumptions section populated.

------

### M4 — Visual verification

*~4 days*

Dev server in the sandbox, Playwright screenshot at the captured route, the self-correction loop, and the post-deploy Action that screenshots the real preview and posts it to the PR and the thread.

**Acceptance:** the requester sees a picture of their change without opening GitHub, and the merge-without-touching rate measurably improves against M3's baseline.

**This is where the product becomes the product.** M3 opens PRs; M4 closes the loop the requester actually cares about.

------

### M5 — Refinement

*~1 week, driven by what M4 reveals*

Candidates, in the order they'll probably matter:

- **Iteration.** Annotate the *preview* and reply into the same thread; the agent amends the existing PR. This is arguably the real product and the reason to build any of it — it turns one shot into a conversation.
- Visual diff with the pre-change capture.
- Full-page scroll-and-stitch capture.
- Element-picker mode alongside freehand.
- Per-requester cost and success dashboards.

------

### Timeline

```
M0  ████                                          done
M1      ██
M2        ████████
M3                ██████████████
M4                              ████████
M5                                      ██████████
    └── week 1 ──┴── week 2 ──┴── week 3 ──┴── week 4 ──┘
```

Roughly four weeks of focused work to M4. M2 is the milestone worth sitting on longer than planned.

------

## 11. Explicitly out of scope

- Backend, API, or database changes
- Multi-repo or cross-service requests
- Anything requiring authentication to reach the page
- Automatic merging or deployment to production
- Mobile app annotation
- Non-Slack chat surfaces
- External or client-facing use

------

## Appendix A — Bundle schema

The contract between the extension and everything downstream. Change it here first.

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
  "screenshot": "data:image/png;base64,…"
}
```

## Appendix B — Brief format

The frozen artifact handed to the agent as `/workspace/.request/BRIEF.md`.

```markdown
# UI change request

**Route:** /deals/[id]  ·  **Captured at:** 1440×812 @2x
**Requested by:** Dana
**Original URL:** https://svrn.app/deals/abc?tab=terms

## What to change

Marks are numbered in the attached capture.

1. This label wraps at 1440 — shorten or truncate.
2. The divider above it is too heavy against the panel background.

## Resolved

- Overflow behaviour: truncate with an ellipsis  *(chosen by requester)*
- Applies at: all viewports  *(defaulted — no answer within 4h)*

## Console at capture time
```

[error] Warning: validateDOMNesting…

```
## Constraints

See AGENTS.md § Automated UI change requests. Frontend only.
Write .request/REFUSED.md rather than working around a constraint.
```