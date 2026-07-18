# AI Platform — P3: Internal Tools + Approval Workflow

> Status: **implemented** (pending final validation). Builds on P1 (chat) + P2
> (context vault + artifacts). P3 adds internal tools, a single-use TTL
> approval workflow for write tools, an append-only audit log, and a
> cross-process apply contract for the JSON Workbench. It does NOT add MCP,
> an Agent loop, subagents, Git, filesystem, shell, or network tools.

## 1. What P3 adds

| Capability | Risk | Approval | Mutates editor? |
|---|---|---|---|
| `json.inspect-selection` | read | no | no |
| `json.propose-repair` | propose | no | no (persists a **read-only** kind=json artifact; preview/copy only — NO apply/writeback) |
| `json.apply-proposal-demo` | write | **yes** (single-use TTL) | yes (editor input only, after hash+revision match) |

### propose→artifact contract

`json.propose-repair` persists its repaired JSON as a **read-only** `kind=json`
artifact via the P2 `AiArtifactRepository` and returns its `artifactRef`. The
`tool-completed` event carries `artifactRef?`; the `ToolCallCard` renders a
"在 Artifacts 查看" link that opens the Artifacts drawer (preview/copy only).

The failure contract is **NOT best-effort** when a repository is wired:
- restricted content (PEM/.env/AWS) → the repository's `create()` throws → the
  executor maps it to `tool-failed` (`restricted-content`) — never a silent
  preview-only result with no `artifactRef`. Restricted content never reaches
  disk (the repository rejects before writing).
- invalid JSON / oversize → `tool-failed` (`executor-error`).
- The preview-only fallback (no `artifactRef`) applies ONLY when the runtime is
  not wired with an `artifactRepository` (`createArtifact` undefined) — e.g. a
  minimal test harness. In production (`index.ts`) the repository is always
  wired, so a successful propose always produces an artifact.

The artifact is a PROPOSAL — there is NO apply/writeback path from it. The
write target remains exclusively `json.apply-proposal-demo` (approval-bound).

### Tool invocation contract

There are TWO distinct tool paths. P3 implements ONLY direct invocation:

1. **Direct invocation (P3, implemented)** — the renderer explicitly requests
   tool calls via `AiStartRunRequest.toolCalls`. The run stays in `chat` mode;
   the model is NEVER involved (no `tools` passed to `streamChat`). The
   runtime resolves + Zod-validates each call, runs the tool state machine,
   and emits tool/approval events. Direct invocation has its own capability
   gate (`directInvocationAllowed`) that allows read|propose|write in all modes
   (never `dangerous`).

2. **Model tool calling (NOT implemented)** — reserved for a future phase that
   widens `P1_SUPPORTED_RUN_MODES` to assistant/agent with a real loop.

### Direct-tool runs require NO provider credential

A direct-tool run does not call the model, so it must not require a profile or
API key. The `runLoop` checks `request.toolCalls` BEFORE the profile/credential
lookups. A read/propose/apply tool run succeeds even when no profile or
credential is configured.

## 2. Architecture

```
Renderer (JSON Workbench / AI Assistant)
  │  aiStartRun({ toolCalls: [...] })
  ▼
IPC (ai-ipc.ts) ── Zod-validates toolCalls shape ──▶ Runtime.start()
  │
  ▼
Runtime.runToolCalls()
  │  for each tool call:
  │    1. registry.resolve(id, rawInput, mode, profile, direct=true)
  │       → allowlist + Zod strict parse + capability gate
  │    2. emit tool-call-proposed (FIXED metadata: tool/risk/scope/length — NO raw input)
  │    3. if write:
  │       a. build approval request (normalizedInput + targetScope + contentHash + revision)
  │       b. approvalManager.propose() → pending token
  │       c. emit approval-required (token + impact + scope + hash)
  │       d. await decision (poll via approvalManager.inspect — typed, no cast)
  │       e. emit approval-resolved
  │       f. if approved: approvalManager.consume() (default-deny: 7-field match)
  │    4. emit tool-started
  │    5. execute tool (read/propose: direct; write: ctx.applyToTarget)
  │    6. emit tool-completed / tool-failed
  │  terminal: completed (all ok) / failed (any failed) / cancelled (cancel)
  │
  │  Cross-process apply (write tools):
  │    executor calls ctx.applyToTarget(proposal, revision, scope, hash)
  │    → runtime emits apply-request event to renderer
  │    → runtime registers pending one-shot (applyId + scope + hash + revision)
  │    → renderer verifies its editor revision matches, applies via onInput, acks
  │    → runtime.handleApplyAck(ack) verifies applyId + scope + hash + revision
  │    → mismatch → ok:false (IPC rejected) + tool fails scope-mismatch
  │    → unknown/duplicate → ok:false (IPC rejected)
  ▼
Audit Log (append-only, safe metadata, no renderer clear)
```

## 3. Security guarantees (carried from P1/P2 + P3 additions)

- **No model-generated code/command may execute.** Only registered executors
  receive Zod-validated DTOs. The registry is the single validation chokepoint.
- **Write requires a main-process, single-use, TTL approval** bound to
  runId + toolCallId + toolId + normalizedInput + targetScope + contentHash +
  revision. No valid approval, stale scope, reject/cancel/expiry → impossible
  to execute. `consume()` is default-deny; `decide()` is the ONLY approve path.
- **No direct renderer approval bypass.** The renderer can call
  `ai:approval:decide` (guarded by `assertTrustedRenderer`); it CANNOT call
  `consume()`. Executing a write without a valid matching approval is
  impossible.
- **Reject requires a non-empty reason.** Approve reason is optional. A
  restricted reason (PEM/.env/AWS) is rejected — no secret in the audit log.
- **Cross-process apply is token/correlation-bound.** Main owns the validated
  proposal + approved token + target scope/hash/revision. The renderer may
  apply ONLY if its current editor revision matches, then acks via the guarded
  `ai:apply:ack` IPC. Main rejects duplicate/unknown/mismatched acks. There is
  NO renderer-initiated arbitrary "success/execution" call.
- **Mismatched ack returns a rejected IPC result.** A mismatch (wrong
  scope/hash/revision) consumes the one-shot (resolving the tool failure) BUT
  the IPC call throws — the renderer never sees success for a bad ack.
- **Audit log is append-only / read-only to the renderer.** No `ai:audit:clear`
  IPC. No public `clear()` method. The filter is Zod-validated (strict). Audit
  summaries are FIXED metadata (tool/risk/scope/count/length) — NEVER the raw
  tool input/payload.
- **Raw keys never sent to renderer, logs, conversation JSON, errors, or
  exports.** All tool text is sanitized via `sanitizeToolText`
  (`classifySensitivity` + `redactSecrets`) before crossing to the
  renderer/audit.
- **Cancel during approval wait is immediate.** `cancel()` cancels pending
  approvals (flipping tokens to `cancelled`), resolves pending apply one-shots,
  and aborts. The poller observes the abort + cancelled token, emits exactly
  one `cancelled` terminal, and removes the run. No later approve/ack can
  execute.

## 4. Cancellation semantics (direct-tool runs)

`cancel(runId, reason)` for a direct-tool run waiting on approval:

1. Sets `cancelReason` + aborts the AbortController.
2. Calls `approvalManager.cancel(runId)` — flips pending tokens to `cancelled`
   so the poller returns immediately (no 10-min wait).
3. Resolves any pending apply one-shots as stale-target.
4. The poller observes `run.abort.signal.aborted` OR the token's `cancelled`
   status → returns `{ status: 'cancelled' }`.
5. `runToolCalls` emits exactly one `cancelled` terminal via `commitTerminal`
   and returns. `finishRun` cleans up (audit, pending applies, approvals).
6. No later `decide`/`consume`/`handleApplyAck` can execute — the token is
   cancelled, the run is removed from `runsById`.

## 5. IPC surface (P3 additions)

| Channel | Direction | Purpose |
|---|---|---|
| `ai:tool:list` | renderer→main | Tool metadata (no executor/schema) |
| `ai:approval:decide` | renderer→main | Approve/reject (reject requires reason) |
| `ai:approval:list-pending` | renderer→main | Pending approval tokens |
| `ai:audit:list` | renderer→main | Read-only audit list (Zod-validated filter) |
| `ai:apply:ack` | renderer→main | Ack an apply-request (scope/hash/revision verified) |
| `ai:run:event` | main→renderer | Tool/approval/apply events (extends P1/P2) |

There is **NO** `ai:audit:clear`, `ai:audit:append`, `ai:approval:consume`, or
`ai:tool:execute` IPC. The renderer cannot wipe the audit log, fabricate audit
entries, consume an approval, or execute a tool directly.

## 6. Renderer integration

### Store (`src/store/ai.ts`)
- `tools: AiToolMeta[]` — registered tool metadata.
- `toolCalls: ToolCallEntry[]` — lifecycle cards for the active run.
- `pendingApprovals: AiApprovalToken[]` — pending write-tool approvals.
- `auditEntries: AiAuditEntry[]` — read-only audit list.
- `startToolRun(toolCalls)` — start a direct-tool run (no model stream).
- `decideApproval(token, approved, reason?)` — approve/reject.
- `bindRunEvents()` handles `tool-call-proposed`, `approval-required`,
  `approval-resolved`, `tool-started`, `tool-completed`, `tool-failed`.

### AI Assistant (`src/components/tools/ai-assistant.tsx`)
- `ToolCallCard` — renders a tool call's lifecycle (id/risk/metadata/status).
  On `tool-completed`, if `artifactRef` is present (a propose tool persisted a
  read-only artifact), renders a "在 Artifacts 查看" link that opens the
  Artifacts drawer (preview/copy only — NO apply/writeback).
- `ApprovalCard` — renders impact + scope + preview + Approve/Reject buttons.
  Reject is **disabled** until the reason input is non-empty. No keyboard
  shortcut or hidden path to approve.

### JSON Workbench (`src/components/tools/json-workbench/index.tsx`)
- Three P3 buttons: **P3 检查选区** (inspect), **P3 修复提案** (propose),
  **P3 应用提案** (apply — triggers approval).
- `apply-request` subscription: verifies current editor revision (sha256)
  matches the request's revision; if yes, applies via `onInput` + acks
  `applied:true`; if stale, acks `applied:false` (no mutation).

## 7. Upgrade guidance (from P2)

1. **Wire P3 deps in `index.ts`**: construct `AiToolRegistry`,
   `AiApprovalManager`, `AiAuditLog`; call `registerJsonTools(registry)`;
   pass all three **plus the P2 `AiArtifactRepository`** to `AiRuntime` +
   `registerAiIpc`. The artifact repository powers propose→artifact
   (`ctx.createArtifact`); without it, propose falls back to preview-only.
2. **Preload**: expose `aiToolList`, `aiApprovalDecide`, `aiApprovalListPending`,
   `aiAuditList`, `aiApplyAck`. Do NOT expose audit clear.
3. **Types**: add `AiToolMeta`, `AiApprovalToken`, `AiAuditEntry`, `AiApplyAck`,
   `AiAuditFilter` to `RaintoolAPI`.
4. **Store**: add `tools`/`toolCalls`/`pendingApprovals`/`auditEntries` state +
  `startToolRun`/`decideApproval`/`loadTools`/`loadAudit` actions.
5. **UI**: add `ToolCallCard` + `ApprovalCard` to the AI Assistant; add
   inspect/propose/apply buttons + apply-request handler to JSON Workbench.
6. **Quit path**: call `approvalManager.cancelAll()` on app quit (wired in
   `AiPlatform.cancelAllApprovals`).

## 8. What P3 does NOT add

- No MCP client/server.
- No Agent loop or subagents.
- No Git operations or workbench.
- No filesystem, shell, or network tools.
- No model tool calling (reserved for a future phase).
- No component writeback beyond the narrow JSON Workbench editor-input scope.
- No commit/push.

## 9. Test coverage

Two test files cover P3:
- `tests/ai-tools-approval.test.mjs` — 55 tests
- `tests/ai-p3-tools-approval.test.mjs` — 46 tests

Coverage:
- Registry: allowlist, Zod strict, unknown deny, direct-vs-model gate.
- Approval: default-deny, reject-requires-reason, restricted-reason reject,
  single-use, cancel, hash/scope/revision/input mismatch, `inspect()` typed read.
- Audit: fixed metadata (no raw input), no public `clear()`, secret sanitization,
  5001-entry rotation (cap=5000, no duplicate), list filter.
- Apply contract: success, unknown, duplicate, mismatch (scope + hash), refuse
  (applied:false), no module-global callback.
- Direct-tool runs: succeed with NO profile/credential.
- Event ordering + exactly one terminal.
- No-mutation: read/propose never emit apply-request.
- Recovery: rejected approval, cancel during approval wait.
- Artifact: no apply/writeback.
- propose→artifact: valid JSON creates a read-only kind=json artifact +
  `artifactRef` on `tool-completed` (bound to runId/conversationId); restricted
  content surfaces as `tool-failed` (restricted-content), never swallowed;
  preview-only fallback when no repository is wired.
- IPC contract: tool:list, approval:decide (reject-requires-reason +
  restricted-reason), approval:list-pending, audit:list (no clear channel,
  Zod-strict filter), apply:ack (success + ok:false reject + missing-fields
  reject), run:start accepts toolCalls.
