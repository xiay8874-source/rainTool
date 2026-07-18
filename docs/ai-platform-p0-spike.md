# AI Platform — P0 Architecture Spike & Compatibility Report

> Scope: P0 only. No implementation. This document is the sole deliverable.
> It records runtime versions, dependency/license decisions, the RainCode →
> TypeScript/Electron mapping, an event-contract draft, and a P0 test plan.
> Authoritative input: `docs/ai-platform-plan.md` §8 (P0 gate) and §11.
>
> Hard constraints honored: did not implement chat UI, Provider, MCP client,
> Agent, Git, or AI Draw.io; did not modify tabs or the existing diagram MCP
> bridge; did not copy Java/Tauri runtime; did not add a generic Bash tool;
> did not start P1.

## 1. Changed files

| File | Change | Reason |
|---|---|---|
| `docs/ai-platform-p0-spike.md` | **Added (this file)** | P0 research deliverable |

No source files under `electron/`, `src/`, `scripts/`, `tests/`, `vendor/`,
`LICENSES/`, or `THIRD_PARTY_NOTICES.md` were modified. `package.json` and
`package-lock.json` are untouched (no dependencies installed — P0 is a spike).

## 2. Embedded-Node / runtime conclusion (Gate P0 step 1)

Measured against the **installed** Electron, not the `^33.0.0` range:

| Artifact | Value | How measured |
|---|---|---|
| `node_modules/electron/package.json` version | `33.4.11` | `cat` of installed package |
| `node_modules/electron/dist/version` | `33.4.11` | Electron's own version file |
| `process.versions.node` (embedded) | **`20.18.3`** | `ELECTRON_RUN_AS_NODE=1 …/Electron -e "console.log(process.versions.node)"` |
| `process.versions.chrome` | `130.0.6723.191` | same probe |
| `process.versions.electron` | `33.4.11` | same probe |

Packaged-runtime path is deterministic: `npm run dev` and `npm run start:prod`
both run Next/AI-Draw.io under Electron's bundled arm64 Node via an
`ELECTRON_RUN_AS_NODE=1` shim (`scripts/dev.mjs:25 createElectronNodeShim`,
`scripts/dev.mjs:178`). The main process and any `utilityProcess.fork` child
(see `electron/ai-drawio-service.ts:131`) therefore also execute on Node 20.

**Gate decision:** the AI Platform must target **Node 20.18.3** as its floor
until a dedicated Electron upgrade (plan §4.4 rule 3: Electron upgrades are a
separate change with separate regression). No `>=22` dependency may be added
in P0–P5 without an Electron bump first.

`safeStorage` and `utilityProcess` are confirmed available in this Electron
build: `utilityProcess.fork` is already used in production by
`electron/ai-drawio-service.ts:1,131`; `safeStorage` is a stable Electron API
present since Electron 15 and is the plan-mandated credential store (§4.3).
(They read as `undefined` under `ELECTRON_RUN_AS_NODE=1` because that mode
loads pure Node without the Electron app module — expected, not a defect.)

## 3. Dependency compatibility conclusion (Gate P0 step 2)

All engines verified against the live npm registry (`registry.npmjs.org`),
not guessed from READMEs.

### 3.1 Verdict

**Adopt `ai@5.0.216` + `@ai-sdk/openai@2.0.114` + `zod@3.25.76`.** All
declare `engines.node >=18` (or no engines) and run on Electron 33's Node
20.18.3. The latest `ai@7` and `@ai-sdk/openai@4.x` require Node 22 and are
**blocked** until a separate Electron ≥36 upgrade.

> **P0 compatibility correction (applied during P1).** The original spike
> matrix paired `ai@5.0.216` with `@ai-sdk/openai@3.0.86`. That pairing is a
> **cross-generation mismatch**: `ai@5` depends on `@ai-sdk/provider@2.0.3`
> (LanguageModelV2), while `@ai-sdk/openai@3.x` depends on
> `@ai-sdk/provider@3.x` (LanguageModelV3). The provider returns a V3 model
> that `ai@5`'s `streamText` rejects at compile time. The correct same-
> generation pairing is `ai@5.0.216` + `@ai-sdk/openai@2.0.114` — both depend
> on exactly `@ai-sdk/provider@2.0.3` and `@ai-sdk/provider-utils@3.0.30`
> (verified via `npm ls`), both Node `>=18`, both Apache-2.0. No `as`/`unknown`
> casts are used to bridge the generations. P1 therefore pins
> `@ai-sdk/openai@2.0.114`, not `3.0.86`.

### 3.2 Compatibility matrix

| Package | Pinned candidate | engines.node | Fits Node 20.18.3? | Role |
|---|---|---|---|---|
| `ai` (core) | `5.0.216` (dist-tag `ai-v5`) | `>=18` | ✅ | streamText / generateObject / toolLoop abstraction |
| `ai` (core, alt) | `4.3.16` | `>=18` | ✅ | fallback if v5 stream contract drifts |
| `ai` (core) | `7.0.31` (latest) | `>=22` | ❌ | blocked — needs Electron bump |
| `@ai-sdk/openai` | `3.0.86` (last v3) | `>=18` | ✅ | OpenAI-compatible + OpenRouter + DeepSeek + local endpoints |
| `@ai-sdk/openai` | `4.0.16` (latest) | `>=22` | ❌ | blocked |
| `@ai-sdk/anthropic` | `1.2.12` (last v1) | `>=18` | ✅ | Anthropic adapter |
| `@ai-sdk/anthropic` | `4.0.16` (latest) | `>=22` | ❌ | blocked |
| `@ai-sdk/google` | `1.2.18` (last v1) | `>=18` | ✅ | Gemini adapter |
| `@ai-sdk/google` | `4.0.18` (latest) | `>=22` | ❌ | blocked |
| `@ai-sdk/provider-utils` | 2.x / 3.x (transitive) | `>=18` | ✅ | fetch runtime used by core |
| `@ai-sdk/provider-utils` | 5.0.11 (latest) | `>=22` | ❌ | pulled only by `ai@7` |
| `@modelcontextprotocol/sdk` | `1.29.0` (stable, dist-tag `latest`) | `>=18` | ✅ | MCP client, stdio + Streamable HTTP |
| `zod` | `3.25.76` | (no engines) | ✅ | tool input schema → JSON Schema (peer `^3` for provider v3/v1) |
| `zod` | `4.4.3` | (no engines) | ⚠️ defer | provider v3/v1 peer is `^3`; adopt zod 4 only with provider v4 + Node 22 |

Note on `@modelcontextprotocol/sdk`: the plan (§10) warns that `main`/v2 is
pre-release. The registry confirms `dist-tags.latest = 1.29.0` — there is no
public `2.x` on `latest`. P4 will pin `^1.29` and not follow `main`.

### 3.3 Recommended runtime approach

1. **Primary:** vendor the AI SDK Provider abstraction. `ai@5.0.216` gives
   `streamText` / `generateObject` and a provider-agnostic tool loop; we wrap
   it in `ai-provider-registry.ts` so RainTool never calls a provider SDK
   directly from the loop. Provider packages are restricted to the v3/v1 line.
2. **Fallback (plan §4.4 option 2):** if any v5 stream/tool-loop behavior
   proves unstable on Node 20 in P1, drop to a standard-`fetch` adapter that
   implements the same internal `Provider` interface (OpenAI-compatible chat
   completions + Anthropic Messages + Gemini generateContent). This keeps the
   registry boundary identical and avoids a forced Electron upgrade.
3. **No Electron upgrade in P0–P5.** Upgrading to Electron 36+ (Node 22) is a
   standalone change with its own regression; only then may `ai@7` + provider
   v4 be adopted. Track this as a follow-up gate, not part of P0.

## 4. License inventory (Gate P0 step 4)

Goal (plan §10): no AGPL / Fair Source / SSPL code may be copied or linked
into RainTool. Behavior borrowing is allowed; code reuse requires per-file
license check + copyright retention + `THIRD_PARTY_NOTICES.md` update.

| Component / reference | License | P0 decision |
|---|---|---|
| `ai` (Vercel AI SDK core) | Apache-2.0 | **OK to depend** at `5.0.216` |
| `@ai-sdk/openai` 3.0.86 | Apache-2.0 | OK to depend |
| `@ai-sdk/anthropic` 1.2.12 | Apache-2.0 | OK to depend |
| `@ai-sdk/google` 1.2.18 | Apache-2.0 | OK to depend |
| `@modelcontextprotocol/sdk` 1.29.0 | MIT | OK to depend (P4) |
| `zod` 3.25.76 | MIT | OK to depend |
| RainCode (local, `/Users/xiayu/.../raincode`) | Internal, same maintainer | **Blueprint only.** Reimplement in TS. Do **not** ship Java/Spring Boot/Tauri. Do **not** reuse its plaintext `~/.raincode/config.json` key storage (plan §10.1). |
| OpenCode | MIT | Selective per-file study only. Do **not** import its TUI/Bun runtime; do **not** adopt its Bash permission model (plan §10.1). |
| DeepChat | Apache-2.0 | Architecture study only; per-file check before any reuse |
| LibreChat / `agents` | MIT | Event/permission layering reference only |
| NextChat | MIT | UX reference only |
| LobeHub | — | Product design reference only; verify per-package license before any code |
| **Cherry Studio** | **AGPL-3.0** | **Must not copy or link.** Research/reading only, never a dependency. |

Existing notices already declared in `THIRD_PARTY_NOTICES.md` (next-ai-draw-io
Apache-2.0, draw.io Apache-2.0) are unaffected. P0 adds **zero** dependencies,
so no notices change in this phase. When P1 installs the SDK packages above,
append their Apache-2.0 / MIT entries and copy license texts into `LICENSES/`.

## 5. RainCode → TypeScript/Electron mapping

Maps the five RainCode sources named in plan §11 to the `electron/ai-platform/`
module layout in plan §3.2. **Mapping of responsibilities only — no Java code
is ported verbatim.** Each row states what is kept, what is dropped, and why.

### 5.1 `architecture.md` → Electron layering

| RainCode layer | RainTool TS counterpart | Keep / Drop |
|---|---|---|
| `api` (HTTP/SSE controllers, DTOs) | **Drop.** Replace with typed IPC channels + `AiRunEvent` stream (§6). RainTool has no HTTP server in the AI path. | Drop HTTP/SSE |
| `application` (use-case orchestration) | `ai-agent-runner.ts`, `ai-runtime.ts` | Keep semantics |
| `domain` (Task, Plan, ToolCall, CodeEdit, ChangeSet) | `ai-types.ts` DTOs: `AiRun`, `AiMessage`, `AiToolCall`, `AiArtifact` | Keep (as plain TS types) |
| `tool` (read_file, search_code, git_diff, …) | `ai-tool-registry.ts` — **only RainTool-component tools** (plan §6.1) | Narrow drastically |
| `permission` (path, sensitive-file, approval) | `ai-approval-manager.ts` + `assertTrustedRenderer` boundary + `AiToolRisk` | Keep rules, IPC-bound |
| `project` (Project Space root validation) | Component-root boundary (JSON/Git/diagram IDs), no filesystem root | Keep concept, drop Project Space |
| `model` (provider abstractions) | `ai-provider-registry.ts` + `ai-provider-*.ts` (OpenAI/Anthropic/Google) | Keep via AI SDK |
| `edit` (Diff, ChangeSet, rollback) | Artifacts only in P0–P3; component `applyArtifact` is `write` risk | Defer most |
| `event` (AgentEvent, SSE, persistence) | `AiRunEvent` IPC stream + `ai-audit-log.ts` | Keep, change transport |
| `checkpoint` (network/task resume) | `ai-runtime.ts` run state + checkpoint draft | Keep, simplified |
| `infrastructure` (fs, rg, git, JSON, Keychain) | Electron main + `safeStorage`; no rg/shell in P0–P3 | Keep subset |

### 5.2 `security-model.md` → acceptance cases

| RainCode rule | RainTool TS realization | Verification |
|---|---|---|
| Project Space is the file boundary; frontend never reads files | Renderer only consumes `AiRunEvent`; no fs IPC. Every tool executor lives in main. | Test: no `fs` import in `src/ai/**` |
| Sensitive files write-protected (`.env`, `*.pem`, `*.key`, `*.p12`, `*-prod.yml`, `secrets.yml`) | `ai-context-vault.ts` redaction list (same set) + tool-input validation rejects these paths | Test §8.4 |
| Plan mode forbids mutating tools | `AiRunMode = 'chat' \| 'assistant' \| 'agent'` (plan §3.3); `chat`/`assistant` expose only `read`/`propose` tools | Test §8.5 |
| Edit sequence: validate → preview diff → user accept → apply → persist ChangeSet | Artifact → component `applyArtifact` (`write`) → ApprovalCard → audit. No silent write. | Test §8.6 |
| Model output is untrusted; permission owned by backend, not prompts | Tool args validated by Zod schema server-side; unknown fields/diagram IDs/repo paths rejected (plan §7.2) | Test §8.7 |
| API keys in Keychain, masked in UI/logs | `safeStorage` only; never returned over IPC; logs redacted | Test §8.8 |

### 5.3 `ModelToolLoopService.java` → `ai-agent-runner.ts`

| Java responsibility (lines) | TS target | Keep / Drop / Adapt |
|---|---|---|
| `run()` mode normalization: PLAN/AGENT only (278–291) | `ai-runtime.ts` accepts `AiRunMode`; `agent` requires `toolCalling` capability or auto-degrades to `assistant` (plan §4.2) | Adapt: 3 modes, not 2 |
| `continueLoop` step loop with cancellation checks (478–731) | `ai-agent-runner.ts` async generator; `throwIfCanceled` → check `AbortSignal` between steps | Keep shape |
| `MAX_INVALID_TOOL_ARGUMENT_RETRIES = 3` (48) | constant in runner; same 3-retry cap | Keep |
| `MAX_REPAIR_CYCLES = 3` (49) | verification repair cap; P3+ only (no write tools in P0) | Keep, defer |
| `DEFAULT_SUBAGENT_MAX_STEPS = 16`, `_CONCURRENCY = 8` (50–51) | **Drop for v1.** Plan §7.2 disables subagent self-delegation. No `task` tool registered. | Drop (v1) |
| `executeToolCalls` virtual-thread executor (750–878) | Sequential `await` in v1; concurrency only if/when subagents return | Drop concurrency |
| `SubagentProgressEventSink` / `SynchronizedModelRunEventSink` (1421–1511) | Not needed without subagents | Drop |
| Checkpoint save/resume (`saveLatestCheckpoint`, `resumeFromCheckpoint`, 333–445) | `ai-runtime.ts` run-state snapshot; resume restores message list + step | Keep, simplified |
| Output-limit continuation (`isOutputLimitFinishReason`, `continuationInstruction`, 527–538, 2137–2148) | Keep — map to `text-delta` prefix merge + continuation prompt | Keep |
| `ask_user` must be alone (604–619) | P3: ApprovalCard; tool rejected if not sole call | Keep rule |
| `finish_plan` / `finish_agent` required (691–729) | **Adapt.** RainTool has no mandatory finish tool; `assistant`/`agent` runs complete on `stop` finish reason. Finish-tool forcing is a RainCode-specific contract, not imported. | Adapt |
| `callProvider` 120s timeout (2329) | per-call `AbortSignal.timeout(120_000)` + run total 10min budget (plan §4.2) | Keep |
| Context-overflow detection (`isProviderContextOverflow`, 2369–2401) | `ai-context-vault.ts` budget check + provider error mapping | Keep |
| Stale-year web_search guard (906–977) | **Drop.** No `web_search` tool in RainTool v1 (not in plan §6.1 table). | Drop |
| Auto skill routing (`autoSelectSkill`, 2574–2652) | **Drop for v1.** No skills/plugins in RainTool AI v1. | Drop |

### 5.4 `AgentToolRegistry.java` → `ai-tool-registry.ts`

| Java concern | TS realization |
|---|---|
| `toolsFor(mode, permissionLevel)` filter (25–32) | `toolsFor(mode: AiRunMode, enabledToolIds: string[])`: intersect registered tools with user-enabled set + mode capability (plan §6.1). No `PermissionLevel` enum; `AiToolRisk` replaces it. |
| `PermissionLevel` L0/L2/L3 | `AiToolRisk = 'read' \| 'propose' \| 'write' \| 'dangerous'` (plan §3.3). `dangerous` not exposed to model in v1. |
| Read tools: `get_current_project`, `list_projects`, `read_project_file`, `search_project`, `git_diff`, `git_log`, `web_fetch`, `web_search`, … | **Almost all dropped.** v1 tools (plan §6.1): `git.status`, `git.branch`, `git.diff-selected`, `git.staged-summary`, `diagram.list`, `diagram.read-current`, `diagram.check`, `json.read-selection`, `json.validate`, `app.now`, `app.version`. No project-space, no local fs, no web. |
| Write tools: `replace_project_text`, `write_file`, `run_command`, `delete_file`, … | **Dropped.** v1 write tools are component-scoped only: `git.stage-selected`, `git.create-commit`, `diagram.create`, `diagram.save-revision`, `json.apply-fix`. No `run_command`, no generic fs, no `delete`. |
| `task` subagent tool | **Dropped** (plan §7.2). |
| `ask_user`, `finish_plan`, `finish_agent` | `ask_user` → ApprovalCard (P3). No finish tools (see §5.3). |
| JSON-Schema builder `schema(...)` (291–303) | Zod schemas compiled to JSON Schema via `zod-to-json-schema` (or AI SDK's built-in). |

### 5.5 `ToolExecutionPolicy.java` → `AiToolRisk` + policy

| Java factory | Fields | TS realization |
|---|---|---|
| `read(category)` | idempotent=true, sideEffect=NONE, retry=true, replay=true, 30s | `risk:'read'`, `retry: true`, `timeoutMs: 30_000` |
| `write(idempotent)` | sideEffect=MEDIUM, retry=false, replay=idempotent, 30s | `risk:'write'`, `retry: false`, `replay: idempotent`, `timeoutMs: 30_000` |
| `command()` | sideEffect=MEDIUM, retry=false, replay=false, 60s | **No v1 equivalent** (no shell tool). Reserved. |
| `network()` | idempotent=true, sideEffect=LOW, retry=false, 30s | Reserved for a future read-only fetch; not in v1 tool table. |
| `dangerous()` | sideEffect=HIGH, retry=false, 30s | `risk:'dangerous'` — **not registered to model in v1** (plan §2.4). |
| `finish()` | idempotent=true, replay=true, 5s | N/A — no finish tools (see §5.3). |

The `SideEffectLevel`/`ToolCategory` enums collapse into `AiToolRisk` plus a
small `AiToolPolicy { retry; replay; timeoutMs }` record on each
`AiToolDefinition` (plan §3.3 already sketches `risk`; we add the policy fields
to preserve RainCode's retry/replay/timeout semantics).

## 6. Event-contract draft (Gate P0 step 3)

Transport: typed IPC, one `ai:run:event` channel per `runId`, monotonically
increasing `sequence` so the renderer can recover after a missed frame (plan
§7.1). All payloads are JSON-serializable; no `Buffer`, no `Error` object, no
API key, no unredacted attachment content.

```ts
// electron/ai-platform/ai-types.ts (DRAFT — not implemented in P0)

export type AiRunMode = 'chat' | 'assistant' | 'agent'
export type AiToolRisk = 'read' | 'propose' | 'write' | 'dangerous'

export type AiRunEventType =
  | 'started'
  | 'context-estimated'
  | 'context-over-limit'
  | 'provider-selected'
  | 'text-delta'
  | 'tool-requested'
  | 'approval-required'
  | 'tool-started'
  | 'tool-finished'
  | 'tool-failed'
  | 'recoverable-error'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'budget-exhausted'

export interface AiRunEvent {
  runId: string
  sequence: number
  type: AiRunEventType
  /** epoch ms; present on every event for audit ordering */
  at: number
  /** step within the run; starts at 1, increments per model call (RainCode §5.3) */
  step?: number
  payload: AiRunEventPayload
}

export type AiRunEventPayload =
  | { mode: AiRunMode; modelProfileId: string; enabledToolIds: string[] }       // started
  | { estimatedTokens: number; limitTokens: number; overLimit: boolean }        // context-*
  | { providerId: string; model: string }                                        // provider-selected
  | { delta: string; snapshot: string }                                          // text-delta
  | { toolCallId: string; toolId: string; inputSummary: string; risk: AiToolRisk } // tool-requested
  | { toolCallId: string; reason: string; options: AiApprovalOption[] }         // approval-required
  | { toolCallId: string; toolId: string; inputSummary: string }                // tool-started
  | { toolCallId: string; outputSummary: string; bytes: number; durationMs: number } // tool-finished
  | { toolCallId: string; toolId: string; redactedError: string }               // tool-failed
  | { kind: 'invalid-args' | 'finish-reminder' | 'empty-response'; detail: string } // recoverable-error
  | { reason: 'stop' | 'length' | 'budget'; finalText?: string }                // completed
  | { redactedError: string; kind: 'provider' | 'tool' | 'internal' }           // failed
  | { reason: 'user' | 'window-closed'; partialDraftSaved: boolean }            // cancelled
  | { budget: 'steps' | 'time' | 'tokens'; usedSteps: number; usedMs: number }  // budget-exhausted

export interface AiApprovalOption {
  id: string
  label: string
  description: string
  /** when true, selecting this option executes the proposed action */
  executes?: boolean
}
```

### 6.1 IPC channels (draft, not implemented)

| Channel | Direction | Shape |
|---|---|---|
| `ai:run:start` | renderer → main | `{ conversationId, mode, modelProfileId, enabledToolIds, message, attachmentIds[] }` → `{ runId }` |
| `ai:run:event` | main → renderer | `AiRunEvent` (stream, keyed by `runId`) |
| `ai:run:cancel` | renderer → main | `{ runId }` → `{ cancelled: boolean }` |
| `ai:approval:decide` | renderer → main | `{ runId, toolCallId, optionId, freeTextReason? }` |
| `ai:conversation:list` / `:get` / `:delete` | renderer → main | session index/metadata (no keys, no ephemeral content) |

Every renderer→main handler is guarded by the existing `assertTrustedRenderer`
(see `electron/main.ts:75`); the AI channels reuse that boundary, they do not
weaken it. `ai:run:event` is emitted only to `mainWindow.webContents` and only
when `assertTrustedRenderer`'s sender check would pass for the originating
request — same pattern as `diagram:changed` (`electron/main.ts:97`).

### 6.2 Session migration format (draft)

Conversations persist to `~/raintool/ai/conversations/<conversationId>.json`.
Versioned so future schema changes are migratable (plan §5.1). **No keys, no
ephemeral attachment content** — only metadata (plan §4.3).

```jsonc
{
  "schemaVersion": 1,
  "id": "conv_...",
  "createdAt": "2026-07-18T09:00:00+08:00",
  "updatedAt": "2026-07-18T09:05:00+08:00",
  "title": "解释支付流程图",
  "modelProfileId": "openai-gpt-4o",
  "mode": "chat",
  "messages": [
    {
      "id": "msg_...",
      "role": "user",
      "at": "2026-07-18T09:00:00+08:00",
      "text": "解释这张图",
      "attachmentRefs": [
        { "id": "att_...", "source": "diagram-manager", "title": "支付流程图",
          "mimeType": "application/xml", "byteSize": 1820,
          "sensitivity": "normal", "persistMode": "metadata-only" }
      ]
    },
    { "id": "msg_...", "role": "assistant", "at": "...", "text": "…",
      "modelProfileId": "openai-gpt-4o" }
  ],
  "enabledToolIds": [],
  "runAuditRefs": ["run_..."]
}
```

`persistMode` is `metadata-only` by default for persistent conversations;
`ephemeral` attachments are dropped on save (plan §4.3). `schemaVersion: 1`
is the P0 baseline; a future migration bumps it and runs a transform on load.
P0 only **drafts** this — `ai-conversation-repository.ts` is implemented in P1.

## 7. Recommended runtime approach (summary)

1. **Floor:** Node 20.18.3 (Electron 33.4.11 embedded). All deps `>=18`.
2. **Adopt:** `ai@5.0.216` + `@ai-sdk/openai@3.0.86` +
   `@ai-sdk/anthropic@1.2.12` + `@ai-sdk/google@1.2.18` + `zod@3.25.76`.
   Defer `@modelcontextprotocol/sdk@1.29.0` to P4.
3. **Boundary:** providers are wrapped behind `ai-provider-registry.ts`; the
   agent loop never imports a provider SDK directly. If v5 misbehaves on Node
   20, swap to the fetch-adapter fallback (plan §4.4) without touching the
   registry contract.
4. **No Electron upgrade in P0–P5.** Track `ai@7`/provider-v4/Node-22 as a
   separate gate after an Electron 36+ regression pass.

## 8. P0 test plan

P0 produces **no production code**, so tests are written as **contract tests
that P1 must satisfy** plus a **runtime smoke check** runnable now. All tests
use the existing `node --test` runner (`tests/*.test.mjs` convention; see
`tests/diagram-repository.test.mjs`). New tests live in `tests/ai-platform/`.

### 8.1 Runtime smoke (runnable now, no deps)

`tests/ai-platform/runtime-versions.test.mjs`:

- Assert `node_modules/electron/package.json` version starts with `33.`.
- Spawn `ELECTRON_RUN_AS_NODE=1 <electron> -e "process.versions.node"` and
  assert the major is `20`. This guards the floor: a future `package.json`
  bump that silently raises the embedded Node trips this test before P1.
- Record the value into the test output for audit.

### 8.2 Dependency-engine gate (runnable after P1 install)

`tests/ai-platform/dependency-engines.test.mjs`:

- For each installed `ai`, `@ai-sdk/openai`, `@ai-sdk/anthropic`,
  `@ai-sdk/google`, `@ai-sdk/provider-utils`, `@modelcontextprotocol/sdk`,
  `zod`: read its `package.json` `engines.node`; assert it either is absent or
  satisfies `>=18` (i.e. does **not** require `>=22`). Fails if someone runs
  `npm i ai@latest` and pulls Node-22-only code into the Electron main bundle.

### 8.3 Event-contract shape (pure TS, no network)

`tests/ai-platform/event-contract.test.mjs`:

- Import the `AiRunEvent` type and a fake emitter; assert every `AiRunEventType`
  has a matching payload discriminator; assert `sequence` is monotonic across a
  scripted run; assert no payload field named `apiKey`/`token`/`secret` exists
  (static key scan over the type's string form).

### 8.4 Sensitive-content redaction (P2 contract)

- Feed a fake attachment whose content contains `.env`, `-----BEGIN PRIVATE
  KEY-----`, `AKIA…` to the (P2) context vault; assert the serialized
  attachment metadata carries `sensitivity: 'restricted'` and the redacted
  blob matches the documented denylist (security-model.md sensitive set).
- **Implemented (P2 final):** restricted attachments are blocked fail-closed
  at the runtime (provider never called); the artifact repository *rejects*
  restricted content on create/update via `classifySensitivity` (no file
  written, safe error), with `redactSecrets` retained as defense-in-depth for
  residual tokens that slip past classification (e.g. a `sk-…` embedded in
  prose that is not a `^KEY=VALUE` assignment).

### 8.5 Mode capability gate (P3 contract)

- `toolsFor('chat', …)` returns zero tools; `toolsFor('assistant', …)` returns
  only `risk:'read'|'propose'`; `toolsFor('agent', …)` may include `write` but
  never `dangerous`. A model profile with `toolCalling:false` downgrades
  `agent`→`assistant` (plan §4.2).

### 8.6 Approval enforcement (P3 contract)

- A `write` tool invocation with no prior `approval-required` event fails with
  `tool-failed` and never calls its executor. A rejected approval emits a
  `tool-failed` whose `redactedError` is the user's reason (plan §2.4).

### 8.7 Untrusted model output (P3 contract)

- Tool input with an unknown `diagramId` / `repoId` / extra field is rejected
  by Zod validation **before** the executor runs; the model receives a
  short factual error, not a stack trace.

### 8.8 Key non-leak (P1 contract)

- After storing a key via (P1) credential vault, `ai:conversation:list` and
  `ai:run:event` payloads contain no substring of the key; a deliberate
  grep over a recorded run's JSON dump finds zero matches.

### 8.9 Regression guard (unchanged behavior)

- `npm run verify:mcp` and `npm run test:diagrams` remain green and
  unmodified — they prove the AI spike did not touch the diagram MCP bridge,
  AI Draw.io, or the existing repository. (P0 adds no code, so these run
  against the current tree and must pass as-is.)

## 9. Risks & open items for review

1. **Provider v3/v1 is a generation behind.** `@ai-sdk/openai@3` / anthropic@1
   / google@1 will eventually stop receiving upstream fixes. Mitigation: the
   registry boundary means we can move to provider v4 + `ai@7` in one step
   once Electron ≥36 (Node 22) lands. **Review item:** decide whether to
   budget that Electron upgrade before P4 (MCP) or after.
2. **`ai@5` stream contract on Node 20.18.3 is unverified at runtime.** P0
   only checked `engines`. P1 must run a real (mocked-endpoint) streamText
   loop under the packaged Electron before declaring the provider layer done.
   Fallback is the fetch adapter (§3.3 / plan §4.4).
3. **No finish tools.** RainCode forces `finish_plan`/`finish_agent`; RainTool
   does not (§5.3). This changes loop termination semantics — a model that
   emits only content ends the run. **Review item:** confirm this is desired
   for `agent` mode, or whether we want a soft "plan complete" signal.
4. **No subagents in v1.** The `task` tool and its concurrency/cancel plumbing
   (ModelToolLoopService 750–878, 1457–1573) are intentionally dropped (plan
   §7.2). Re-introducing them later is a non-trivial re-add, not a config
   flip — flagged for the roadmap.
5. **`web_fetch`/`web_search` dropped.** RainTool v1 tool table (plan §6.1)
   has no web tools, so the stale-year guard and Tavily integration are not
   ported. If a read-only `web_fetch` is later wanted, port
   `ToolExecutionPolicy.network()` and add a URL allowlist + SSRF guard
   (loopback/private-range rejection, as RainCode already does).
6. **safeStorage availability on Linux/Windows.** macOS (current target,
   `package.json` mac arm64 only) is fine. If cross-platform ships later,
   safeStorage may be unavailable on some Linux keyring setups — plan §4.3
   already mandates "disable save, never plaintext fallback." P1 must test
   the `safeStorage.isEncryptionAvailable()` branch.
7. **Checkpoint scope.** RainCode checkpoints every step; the plan (§7.1) only
   requires renderer recovery via `sequence`. P0 keeps checkpointing minimal
   (run state + last message list). **Review item:** is per-step durability
   needed for "断线恢复", or is sequence-replay enough?
8. **Session migration version.** `schemaVersion: 1` is drafted but no
   migration runner exists. P1 must ship the loader + a v1→v2 path before
   any schema change, or pin v1 until a dedicated migration phase.

## 10. Gate P0 checklist (plan §8)

| Requirement | Status |
|---|---|
| Read plan + RainCode sources + existing Electron boundary | ✅ Done (§5) |
| Verify Electron embedded Node; record `process.versions.node` | ✅ `20.18.3` (§2) |
| Decide AI SDK version or fetch adapter | ✅ `ai@5` + provider v3/v1, fetch fallback (§3) |
| Minimal provider mock + stream event contract + session migration format | ✅ Drafted, not implemented (§6) |
| Dependency license inventory, no AGPL/Fair Source | ✅ (§4) |
| Not modify AI Draw.io, MCP bridge, tabs | ✅ No source changes (§1) |
| Stop before P1; report for review | ✅ This document |

**P0 is complete. Awaiting Gate P0 review before P1.**
