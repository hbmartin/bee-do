# Bee-do: Capture → Clarify → Change → Preview

## Vision

Bee-do should let a requester point at a page, describe a change in plain language, and receive a reviewable pull request with a preview link without opening a terminal. Codex CLI is the coding agent at the center of that future workflow; the surrounding system supplies trusted context, resolves ambiguity, provides an isolated runtime, and publishes evidence of the result.

The intended product flow is:

1. **Capture:** a browser extension submits the request, rendered viewport, page identity, and bounded diagnostics.
2. **Clarify:** a Request Channel in Slack becomes the durable human conversation surface. The system asks only questions that must be answered before implementation.
3. **Execute:** after the intent is clear, an isolated agent runtime checks out the Project and runs Codex CLI through implementation and verification.
4. **Review:** the runtime pushes a branch and opens a pull request; it never auto-merges.
5. **Preview:** the system watches the pull request's deployment, then posts the preview link and verification evidence back to the Request Channel.

## M0 architectural commitment

M0 implements only **Capture → Delivery**:

```text
Chrome extension ──▶ Cloudflare Worker ──▶ public Slack Request Channel
```

The extension owns capture and annotation. The Worker authenticates and validates a versioned Capture before passing it across a clear delivery boundary to Slack. Slack receives a root summary, the rendered screenshot in its thread, and bounded diagnostics. M0 does not persist workflow state or invoke an agent.

This tracer establishes three contracts that later milestones should preserve:

- **Capture is versioned input.** Future persistence and orchestration consume the same validated contract; they do not require the extension to know where or how agents run.
- **Project is derived from an approved origin.** The requester cannot select an arbitrary repository or execution target.
- **The Request Channel is the conversation surface.** Clarification, execution status, pull request results, and preview evidence should extend the existing root thread.

The authoritative M0 setup, operations, limits, and acceptance test are in [README.md](./README.md). Shared product terms are in [CONTEXT.md](./CONTEXT.md).

## Likely next milestones

### M1: Durable Capture and Slack conversation

Persist validated Captures and Delivery state, associate Slack messages with a Capture, verify Slack requests, and support resumable clarification in the root thread. Define explicit states for received, awaiting clarification, ready to execute, running, completed, and failed.

### M2: Agent execution tracer

Launch one isolated runtime for a ready Capture, check out an allow-listed Project, invoke Codex CLI with the frozen brief and image, enforce time and credential boundaries, and report progress and terminal failure to Slack. No runtime should remain allocated while waiting for a human answer.

### M3: Pull request and preview loop

Give the runtime short-lived GitHub credentials, push a scoped branch, open a pull request, watch the associated preview deployment, and return the pull request and preview URLs to the Request Channel. Add automated verification evidence before considering the workflow complete.

## Decisions intentionally deferred

The most consequential infrastructure choice—where agentic work runs—is unresolved. No sandbox or ephemeral-container vendor is selected by this proposal. The evaluation should compare isolation, startup time, maximum execution duration, hibernate/resume behavior, secret injection, network controls, observability, cleanup guarantees, regional availability, and cost under a realistic repository workload.

The workflow/orchestration vendor is also unresolved. A later decision should follow the state machine and failure requirements discovered during M0/M1 rather than committing now to a particular durable-workflow product. The design must support retries, resumable Codex sessions, human waits without live compute, idempotent external side effects, cancellation, and recovery of abandoned executions.

Other deferred decisions include Capture storage, artifact storage, GitHub App design, preview-provider adapters, agent authentication and billing, concurrency policy, and repository-specific verification. M0 should gather evidence without silently deciding any of them.

## Guardrails that carry forward

- A human reviews and merges every pull request.
- Each execution is scoped to an allow-listed Project and uses short-lived, least-privilege credentials.
- Clarification completes before metered agent compute begins; waiting for a person does not hold a live sandbox.
- Every Capture, Slack Delivery, agent session, branch, pull request, and preview remains correlated by stable identifiers.
- Failures are visible and resumable. Partial Slack channels, branches, or runtimes must not disappear into an implicit retry loop.
- Request text, screenshots, diagnostics, source code, and credentials are treated as sensitive and excluded from routine logs.
