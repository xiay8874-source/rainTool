// AI run runtime: allocated-run + background-task lifecycle.
//
// Owns the run state machine for P1 (chat only). Design:
//   - start() is synchronous: it allocates a run (runId + AbortController),
//     registers it, emits `started`, kicks off runLoop() as a background
//     task, and returns { runId } IMMEDIATELY so the renderer can cancel the
//     correct run. The stream runs detached; errors are funneled into events.
//   - runLoop() awaits streamChat, which returns an EXPLICIT terminal outcome
//     (completed | failed | aborted). This guarantees exactly one terminal
//     event: the provider emits completed/failed; the runtime emits cancelled
//     ONLY when the provider returned aborted (no provider terminal). A failed
//     stream is never followed by a runtime completed.
//   - A failed stream persists NO assistant message (no empty reply).
//   - cancel(runId, reason) preserves the reason; a total-run timeout calls
//     cancel(runId, 'timeout'), distinct from a user 'user' cancel. The
//     cancelled event's reason reflects which one fired.
//   - Audit refs carry the actual profile.id (never '').
//
// P1 has NO tool loop, NO subagents, NO attachments. P3+ extends this without
// changing the AiRunEvent contract.

import { randomUUID } from 'node:crypto'
import {
  AI_MAX_RUN_MS,
  type AiCancelReason,
  type AiMessage,
  type AiModelProfile,
  type AiRunAuditRef,
  type AiRunEvent,
  type AiStartRunRequest,
  type AiToolRisk,
  P1_SUPPORTED_RUN_MODES,
} from './ai-types.js'
import type { AiProviderRegistry, AiStreamOutcome } from './ai-provider-registry.js'
import type { AiConversationRepository } from './ai-conversation-repository.js'
import type { AiCredentialVault } from './ai-credential-vault.js'
import type { AiContextVault } from './ai-context-vault.js'
import type { AiArtifactRepository } from './ai-artifact-repository.js'
import { gateContext, type AiContextAttachment } from './ai-context-budget.js'
import type { AiToolRegistry } from './ai-tool-registry.js'
import { sanitizeToolResult, sanitizeToolText } from './ai-tool-registry.js'
import type { AiApprovalManager } from './ai-approval-manager.js'
import type { AiAuditLog } from './ai-audit-log.js'
import {
  AI_APPLY_ACK_TIMEOUT_MS,
  type AiApplyAck,
  type AiApplyToTargetResult,
  type AiApprovalRequest,
  type AiDirectToolCall,
  type AiToolExecCtx,
  type AiToolResult,
  type AiToolRunEvent,
} from './ai-tool-types.js'
import { buildJsonApplyApproval } from './ai-json-tools.js'
import { buildDiagramApproval } from './ai-diagram-tools.js'
import { parseCommitProposal, type CommitProposal } from './ai-commit-proposer.js'
import { isOutboundLocal } from './ai-eligibility.js'

export interface AiRuntimeDeps {
  providerRegistry: AiProviderRegistry
  conversationRepository: AiConversationRepository
  credentialVault: AiCredentialVault
  profileRepository: { get: (id: string) => AiModelProfile | null; getEnabled?: (id: string) => AiModelProfile | null }
  /** P2: context vault for attachment payloads. Optional for P1 back-compat. */
  contextVault?: AiContextVault
  /** P3: tool registry (allowlisted + Zod-validated). */
  toolRegistry?: AiToolRegistry
  /** P3: approval manager (single-use TTL write tokens). */
  approvalManager?: AiApprovalManager
  /** P3: audit log (append-only, safe metadata). */
  auditLog?: AiAuditLog
  /**
   * P3: artifact repository for read-only proposal artifacts (propose tools).
   * When present, the runtime wires `ctx.createArtifact` so a propose tool can
   * persist its output; the returned artifactRef flows through tool-completed.
   * Optional so direct-tool tests can omit it (best-effort contract).
   */
  artifactRepository?: AiArtifactRepository
  /** Send an event to the originating renderer window. */
  emit: (event: AiRunEvent) => void
}

interface ActiveRun {
  runId: string
  conversationId: string
  profileId: string
  abort: AbortController
  startedAt: number
  /** Why the abort fired, set before abort() so the loop can report it. */
  cancelReason: AiCancelReason | null
  /** Accumulated partial text for the cancelled event. */
  partialText: string
  /** Total-run timeout timer (cleared on terminal). */
  totalTimer: ReturnType<typeof setTimeout> | null
  /** P2: explicit attachment ids selected for this run (for cleanup). */
  attachmentIds: string[]
  /**
   * Terminal commitment. Set true as soon as ANY terminal event
   * (completed/failed/cancelled) is emitted. Prevents a second terminal from
   * a persistence/audit failure or the safety-net catch.
   */
  terminalEmitted: boolean
  /**
   * P3: pending apply-request one-shots keyed by applyId (cross-process ack).
   * Stores the pending request's targetScope/contentHash/revision so
   * handleApplyAck can verify the ack matches exactly (no swap). The ack's
   * applyId resolves the one-shot; the scope/hash/revision are compared to
   * reject a mismatched ack even if the applyId was somehow guessed.
   */
  pendingApplies: Map<string, {
    resolve: (r: AiApplyToTargetResult) => void
    timer: ReturnType<typeof setTimeout>
    targetScope: string
    contentHash: string
    revision: string
  }>
}

/**
 * Error thrown by `proposeCommitMessage` (Task 4 one-shot). Carries a structured
 * `code` so the main IPC layer can wrap it into a `[git:CODE]` IPC error for the
 * renderer's `parseGitIpcError`. The `code` mirrors `GitErrorCode` values
 * (AI_UNAVAILABLE / AI_PROVIDER_FAILED / AI_SCHEMA_INVALID / COMMAND_TIMEOUT).
 */
export class ProposeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'ProposeError'
  }
}

/**
 * Manages concurrent runs. P1 allows one active run per conversation; a second
 * start for the same conversation cancels the first (prevents racing streams).
 */
export class AiRuntime {
  private readonly deps: AiRuntimeDeps
  private readonly active = new Map<string, ActiveRun>() // conversationId -> run
  private readonly runsById = new Map<string, ActiveRun>() // runId -> run

  constructor(deps: AiRuntimeDeps) {
    this.deps = deps
  }

  /**
   * Start a chat run SYNCHRONOUSLY. Allocates the run, registers it, emits
   * `started`, and returns { runId } IMMEDIATELY — before any terminal event.
   * The renderer records the runId as activeRunId from the IPC response, THEN
   * subscribes; therefore every terminal (including missing profile/credential/
   * conversation) MUST be emitted from the background runLoop(), never inline
   * here. Emitting a terminal synchronously in start() would race the IPC
   * response and the renderer could drop it (stuck "streaming").
   *
   * The profile is looked up inside runLoop so a missing profile still gets a
   * `started` event + a deferred `failed` terminal with a real runId. The
   * audit ref carries the actual profile id where the profile exists; for a
   * missing profile it carries the requested id so the audit is never silent.
   */
  start(request: AiStartRunRequest): { runId: string } {
    const runId = `run_${randomUUID()}`

    // Cancel any existing run on this conversation before starting a new one.
    const existing = this.active.get(request.conversationId)
    if (existing) this.cancel(existing.runId, 'user')

    const abort = new AbortController()
    const run: ActiveRun = {
      runId,
      conversationId: request.conversationId,
      profileId: request.modelProfileId, // resolved to the real profile.id in runLoop
      abort,
      startedAt: Date.now(),
      cancelReason: null,
      partialText: '',
      totalTimer: null,
      attachmentIds: request.attachmentIds ?? [],
      terminalEmitted: false,
      pendingApplies: new Map(),
    }
    this.active.set(request.conversationId, run)
    this.runsById.set(runId, run)

    const sequence = { value: 1 }
    this.deps.emit({
      runId, sequence: sequence.value++, type: 'started', at: Date.now(),
      payload: {
        conversationId: request.conversationId,
        // The real profile id is not known until runLoop resolves it; emit the
        // requested id so the renderer can correlate, and runLoop's terminal
        // events carry the authoritative id.
        modelProfileId: request.modelProfileId,
        mode: request.mode,
      },
    })

    // Detach the stream task on a microtask so its synchronous prefix (profile
    // lookup + missing-profile/credential/conversation terminals) runs AFTER
    // start() returns. An async function body executes synchronously up to the
    // first await, so calling runLoop() directly would emit those terminals
    // before the IPC start response reaches the renderer — the renderer would
    // have no activeRunId yet and drop the terminal (stuck "streaming").
    // Promise.resolve().then(...) defers the entire body past the return.
    void Promise.resolve()
      .then(() => this.runLoop(request, run, sequence))
      .catch((error) => {
        this.emitSafetyNetFailed(run, sequence, error)
      })

    return { runId }
  }

  /**
   * Cancel an active run. Records the reason (user vs timeout) BEFORE aborting
   * so the loop reports the correct reason in the `cancelled` event. Returns
   * false if the run already terminated (not active).
   *
   * P3: for a direct-tool run waiting on an approval, cancel() ALSO cancels
   * the pending approval token (flips it to `cancelled` so the poller returns)
   * AND resolves any pending apply one-shots as stale-target. Without this the
   * run would hang: the poller loops until AI_MAX_RUN_MS because the abort
   * signal alone is not observed by the direct-tool path. After cancel, no
   * later approve/ack can execute — the token is cancelled (consume denies)
   * and pending applies are resolved + removed.
   */
  cancel(runId: string, reason: AiCancelReason): boolean {
    const run = this.runsById.get(runId)
    if (!run) return false
    run.cancelReason = reason
    // P3: cancel pending approvals so awaitApprovalDecision returns immediately.
    // The token flips to `cancelled`; consume() will deny it if a late approve
    // somehow arrives. This unblocks the poller without waiting for TTL.
    this.deps.approvalManager?.cancel(runId)
    // P3: resolve any pending apply one-shots so a write tool's
    // ctx.applyToTarget promise doesn't hang. The run is being cancelled, so
    // no apply can complete. finishRun also does this, but we resolve here
    // too so the runToolCalls loop can reach its terminal path promptly.
    for (const [applyId, pending] of run.pendingApplies) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, reason: '运行已取消', category: 'stale-target' })
      run.pendingApplies.delete(applyId)
    }
    run.abort.abort()
    return true
  }

  /** Cancel all active runs (window-close / app shutdown). */
  cancelAll(reason: AiCancelReason): void {
    // Reuse cancel() for every active run so each one gets the SAME cleanup
    // as a single-run cancel: the pending-approval token flips to `cancelled`
    // (consume() denies late approves) and pending-apply one-shots resolve as
    // stale-target. The previous inline form only set cancelReason + aborted,
    // which left write tools hung on their apply/ack promise until the run
    // timeout. Snapshot the ids first: cancel() does not remove the run from
    // runsById (only finishRun does), but snapshotting is robust against any
    // future map mutation during iteration.
    const runIds = Array.from(this.runsById.keys())
    for (const runId of runIds) {
      this.cancel(runId, reason)
    }
  }

  /** Whether a run is still active (for tests). */
  isActive(runId: string): boolean {
    return this.runsById.has(runId)
  }

  /**
   * One-shot structured commit-message proposal (Task 4). Resolves the profile +
   * key exactly like `runLoop` does, calls `providerRegistry.streamChat` directly
   * with the given system + user prompt, collects `finalText`, and validates it
   * via `parseCommitProposal` (strict zod). Records a sanitized audit entry.
   *
   * This bypasses conversation persistence — no `AiConversation`, no
   * `runAuditRef`, no `ai:run:event` stream. It is a synchronous request/reply
   * from the Git Workbench's "生成提交说明" button. The caller (main IPC) wraps
   * any thrown error into a `[git:CODE]` IPC error.
   *
   * Throws on: profile missing, credential missing (non-ollama), provider
   * failure, abort/timeout, or schema-invalid output (AI_SCHEMA_INVALID).
   */
  async proposeCommitMessage(input: {
    modelProfileId: string
    system: string
    userPrompt: string
    abortSignal?: AbortSignal
  }): Promise<CommitProposal> {
    // P0-1: use getEnabled so a disabled model (or a model whose supplier was
    // disabled) is rejected with AI_UNAVAILABLE — never silently used. Fall
    // back to `get` for test fakes that don't implement getEnabled (the real
    // repository always does).
    const resolveProfile = this.deps.profileRepository.getEnabled ?? this.deps.profileRepository.get
    const profile = resolveProfile.call(this.deps.profileRepository, input.modelProfileId)
    if (!profile) {
      throw new ProposeError('AI_UNAVAILABLE', '未找到模型配置，或该模型/供应商已禁用，请在 AI 设置中启用一个 Provider')
    }
    const apiKey = this.deps.credentialVault.get(profile.credentialKey) ?? ''
    // Ollama + loopback profiles (local TokenHub / LM Studio) need no key.
    if (!apiKey && profile.providerId !== 'ollama' && !isOutboundLocal(profile)) {
      throw new ProposeError('AI_UNAVAILABLE', '未配置凭据或凭据不可用')
    }

    // Single-user-message "conversation" for streamChat. The AiMessage shape
    // requires id/at; use stable values (this call is not persisted).
    const messages: AiMessage[] = [
      { id: `propose-${Date.now()}`, role: 'user', at: Date.now(), text: input.userPrompt },
    ]
    const runId = `propose-${randomUUID()}`
    const sequence = { value: 0 }
    // No-op emitter: this one-shot does not stream to the renderer; we collect
    // finalText from the outcome. The provider still receives text-deltas but
    // we discard them (the outcome carries the full text).
    const noopEmit = () => {}

    let outcome: AiStreamOutcome
    try {
      const completeChat = this.deps.providerRegistry.completeChat
      // Commit-title generation has no renderer streaming surface. Prefer the
      // short non-streaming completion path so local reasoning gateways do not
      // spend tens of seconds producing an SSE stream that we only collect at
      // the end anyway. Test fakes and older registries fall back to streamChat.
      outcome = typeof completeChat === 'function'
        ? await completeChat.call(this.deps.providerRegistry, {
          profile,
          apiKey,
          messages,
          system: input.system,
          abortSignal: input.abortSignal ?? new AbortController().signal,
        })
        : await this.deps.providerRegistry.streamChat({
          profile,
          apiKey,
          messages,
          system: input.system,
          abortSignal: input.abortSignal ?? new AbortController().signal,
          emit: noopEmit,
          runId,
          sequence,
        })
    } catch {
      throw new ProposeError('AI_PROVIDER_FAILED', '模型调用失败')
    }

    if (outcome.kind === 'failed') {
      throw new ProposeError('AI_PROVIDER_FAILED', outcome.redactedError || '模型调用失败')
    }
    if (outcome.kind === 'aborted') {
      throw new ProposeError('COMMAND_TIMEOUT', '生成已取消或超时')
    }

    // outcome.kind === 'completed' — validate the title output strictly.
    const parsed = parseCommitProposal(outcome.finalText)
    if (!parsed.ok) {
      throw new ProposeError('AI_SCHEMA_INVALID', `模型输出不符合规范：${parsed.reason}`)
    }

    // Audit (sanitized metadata only — no prompt text, no raw output).
    this.deps.auditLog?.record(runId, 'run-completed', {
      summary: `commit-message proposal (${profile.providerId}/${profile.model})`,
    })

    return parsed.proposal
  }

  /**
   * Emit a terminal event exactly once per run. After the first terminal,
   * subsequent calls are no-ops. Returns true if this call committed the
   * terminal, false if a terminal was already committed.
   */
  private commitTerminal(
    run: ActiveRun,
    emit: () => void,
  ): boolean {
    if (run.terminalEmitted) return false
    run.terminalEmitted = true
    emit()
    return true
  }
  /**
   * Background stream task. Resolves the profile (deferred from start() so
   * missing-profile terminals are not emitted synchronously), then awaits the
   * provider and owns the SINGLE terminal for every outcome. The provider
   * emits ONLY text-deltas; the runtime emits completed/failed/cancelled.
   *
   * Ordering guarantee: for every outcome, the assistant reply (when
   * applicable) is persisted and the audit ref is written + cleanup runs
   * (finishRun) BEFORE the terminal is committed (commitTerminal). A terminal
   * observer therefore sees both the persisted reply and the single audit ref
   * — never stale state. Exactly one terminal per run is enforced via
   * commitTerminal's terminalEmitted guard:
   *   - missing profile / credential / conversation → finishRun(failed) then
   *     commit `failed`, emitted AFTER start() returned (renderer has
   *     activeRunId). Audit carries the requested profile id when the profile
   *     is missing, the real id otherwise.
   *   - `completed` → persist reply; on success finishRun(completed) then
   *     commit `completed`; on persistence failure finishRun(failed) then
   *     commit a single `failed` ("回复持久化失败").
   *   - `failed` → finishRun(failed) then commit `failed`; persist NOTHING.
   *   - `aborted` → persist partial (if any); on success finishRun(cancelled)
   *     then commit `cancelled` with the resolved reason; on partial-persistence
   *     failure finishRun(failed) then commit a single `failed`. Empty partial
   *     skips persistence. Reason: provider aborted.reason === 'timeout' →
   *     'timeout'; else run.cancelReason (user / timeout / window-closed).
   *   - Audit-write failures (recordRunAudit throws) are swallowed in
   *     finishRun and never create a second terminal.
   */
  private async runLoop(
    request: AiStartRunRequest,
    run: ActiveRun,
    sequence: { value: number },
  ): Promise<void> {
    // Enforce P1-supported run modes at the runtime boundary. P1 implements
    // chat only — no agent loop, tool-calling, or component writeback. A non-
    // chat mode produces a DEFERRED `failed` terminal (after the IPC start
    // response has returned) with an explicit safe error; never silent.
    if (!P1_SUPPORTED_RUN_MODES.has(request.mode)) {
      this.finishRun(run, 'failed', `P1 暂不支持该运行模式：${request.mode}（仅 chat）`)
      this.commitTerminal(run, () => this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
        payload: { redactedError: `P1 暂不支持该运行模式：${request.mode}`, kind: 'internal' },
      }))
      return
    }

    // P3: direct tool invocation path — runs BEFORE any profile/credential
    // lookup. A direct-tool run is deterministic + audited + renderer-initiated;
    // it does NOT call the model, so it must NOT require a provider credential
    // or streamChat. (Blocker 2: gating direct tools on profile/apiKey would
    // make the JSON Workbench unreachable when no key is configured — wrong.)
    // The run stays in `chat` mode; the capability gate (directInvocationAllowed)
    // + Zod validation + approval (for write) all apply inside runToolCalls.
    // If toolCalls is absent/empty, the run falls through to the normal chat
    // stream path below (which DOES require profile + credential).
    if (request.toolCalls && request.toolCalls.length > 0) {
      await this.runToolCalls(request, run, sequence)
      return
    }

    // Resolve the profile inside the background task so a missing profile
    // produces a DEFERRED `failed` terminal (after the IPC start response has
    // returned and the renderer has recorded activeRunId). The run was already
    // announced via `started`; never reject silently.
    //
    // P0-1: use getEnabled so a disabled model (or a model whose supplier was
    // disabled) resolves to null → `failed` terminal with a clear message,
    // rather than silently running against a disabled model. Fall back to `get`
    // for test fakes that don't implement getEnabled (the real repository does).
    const resolveProfile = this.deps.profileRepository.getEnabled ?? this.deps.profileRepository.get
    const profile = resolveProfile.call(this.deps.profileRepository, request.modelProfileId)
    if (!profile) {
      // run.profileId stays as the requested id so the audit is never blank.
      this.finishRun(run, 'failed', '未找到模型配置，或该模型/供应商已禁用')
      this.commitTerminal(run, () => this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
        payload: { redactedError: '未找到模型配置，或该模型/供应商已禁用', kind: 'internal' },
      }))
      return
    }
    // Resolve to the authoritative profile id for all downstream audit refs.
    run.profileId = profile.id

    // Resolve the raw key (main-process only). If absent, fail with a generic
    // message — never reveal whether a key exists for this profile. Ollama
    // never needs a key (legacy behavior); any loopback profile (local
    // TokenHub / local LM Studio / local Ollama) is also exempt — it never
    // leaves this machine.
    const apiKey = this.deps.credentialVault.get(profile.credentialKey) ?? ''
    if (!apiKey && profile.providerId !== 'ollama' && !isOutboundLocal(profile)) {
      this.finishRun(run, 'failed', '凭据未配置')
      this.commitTerminal(run, () => this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
        payload: { redactedError: '未配置凭据或凭据不可用', kind: 'internal' },
      }))
      return
    }

    const conversation = this.deps.conversationRepository.get(request.conversationId)
    if (!conversation) {
      this.finishRun(run, 'failed', '会话不存在')
      this.commitTerminal(run, () => this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
        payload: { redactedError: '会话不存在', kind: 'internal' },
      }))
      return
    }

    // Persist the user message immediately so a crash mid-stream keeps the
    // question. The assistant message is appended only on a non-failed outcome.
    const userMessage = this.deps.conversationRepository.appendMessage(
      request.conversationId,
      { role: 'user', at: Date.now(), text: request.message },
    )
    const history: AiMessage[] = [
      ...conversation.messages.filter((m) => m.id !== userMessage.id),
      userMessage,
    ]

    // Total-run timeout. Fires as a 'timeout' cancel, distinct from 'user'.
    run.totalTimer = setTimeout(() => this.cancel(run.runId, 'timeout'), AI_MAX_RUN_MS)

    // P2: gate explicit attachments against the budget. ONLY the ids the
    // renderer explicitly selected are considered — no silent component context.
    // Restricted attachments block the run fail-closed. The assembled context
    // text is prepended to the system prompt. Unknown/invalid ids were already
    // rejected at the IPC boundary; here we resolve + gate the survivors.
    let contextText = ''
    const attachmentIds = request.attachmentIds ?? []
    if (attachmentIds.length > 0 && this.deps.contextVault) {
      const attachments: AiContextAttachment[] = []
      for (const id of attachmentIds) {
        // Only attachments with an in-memory payload are sendable. A
        // metadata-only placeholder (payload gone after restart) is skipped —
        // it was already rejected at the IPC boundary, but this is
        // defense-in-depth so a stale/placeholder id never silently sends.
        const meta = this.deps.contextVault.getMetaForSend(id)
        const text = this.deps.contextVault.getText(id)
        if (meta && text !== null) {
          attachments.push({ meta, text })
        }
      }
      const gate = gateContext(attachments)
      if (gate.blocked) {
        // Fail-closed: a restricted attachment never reaches the provider.
        this.finishRun(run, 'failed', gate.blockReason ?? '附件含受限内容')
        this.commitTerminal(run, () => this.deps.emit({
          runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
          payload: { redactedError: gate.blockReason ?? '附件含受限内容，已阻止发送', kind: 'internal' },
        }))
        return
      }
      contextText = gate.contextText
    }

    // Intercept text-deltas to accumulate partialText for the cancelled event.
    // The provider emits ONLY text-deltas (never a terminal), so runtimeEmit
    // just forwards + accumulates; the runtime owns every terminal below.
    const runtimeEmit = (event: AiRunEvent) => {
      if (event.type === 'text-delta') {
        run.partialText += event.payload.delta
      }
      this.deps.emit(event)
    }

    let outcome: AiStreamOutcome
    try {
      outcome = await this.deps.providerRegistry.streamChat({
        profile,
        apiKey,
        messages: history,
        system: contextText ? `${SYSTEM_PROMPT}\n\n${contextText}` : SYSTEM_PROMPT,
        abortSignal: run.abort.signal,
        emit: runtimeEmit,
        runId: run.runId,
        sequence,
      })
    } catch (error) {
      // streamChat is expected to return a failed outcome. If it threw
      // instead, the runtime owns the single `failed` terminal. Audit + cleanup
      // run BEFORE the terminal commit (consistent with the outcome branches).
      this.finishRun(run, 'failed', '运行时内部错误')
      this.commitTerminal(run, () => this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
        payload: { redactedError: '运行时内部错误', kind: 'internal' },
      }))
      return
    } finally {
      if (run.totalTimer) { clearTimeout(run.totalTimer); run.totalTimer = null }
    }

    switch (outcome.kind) {
      case 'completed': {
        // Runtime owns the `completed` terminal. Persist the assistant reply,
        // then write the audit ref + cleanup (finishRun), THEN commit the
        // terminal — so a terminal observer sees both the persisted reply and
        // the single audit ref. If persistence fails, emit exactly one `failed`
        // terminal (never `completed` with missing history). An audit-write
        // failure is swallowed in finishRun and never causes a second terminal.
        let persisted = true
        try {
          this.deps.conversationRepository.appendMessage(request.conversationId, {
            role: 'assistant',
            at: Date.now(),
            text: outcome.finalText,
            modelProfileId: profile.id,
            runId: run.runId,
          })
        } catch {
          persisted = false
        }
        if (persisted) {
          this.finishRun(run, 'completed', undefined)
          this.commitTerminal(run, () => this.deps.emit({
            runId: run.runId, sequence: sequence.value++, type: 'completed', at: Date.now(),
            payload: { finalText: outcome.finalText },
          }))
        } else {
          this.finishRun(run, 'failed', '回复持久化失败')
          this.commitTerminal(run, () => this.deps.emit({
            runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
            payload: { redactedError: '回复持久化失败', kind: 'internal' },
          }))
        }
        return
      }
      case 'failed': {
        // Runtime owns the single `failed` terminal. Persist NO assistant
        // message — a failed stream must not leave an empty reply. Write the
        // audit ref + cleanup BEFORE committing the terminal.
        this.finishRun(run, 'failed', outcome.redactedError)
        this.commitTerminal(run, () => this.deps.emit({
          runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
          payload: { redactedError: outcome.redactedError, kind: 'provider' },
        }))
        return
      }
      case 'aborted': {
        // Runtime owns the single `cancelled` terminal. Resolve reason:
        // provider per-call timeout → 'timeout'; else the preserved
        // run.cancelReason (user / total-run timeout / window-closed).
        const reason: AiCancelReason =
          outcome.reason === 'timeout' ? 'timeout' : (run.cancelReason ?? 'user')
        // Persist partial text (only if something streamed). If partial
        // persistence fails, fall back to a single `failed` terminal so the UI
        // never shows a cancelled state with missing history. An empty partial
        // skips persistence. Audit + cleanup run BEFORE the terminal commit.
        let partialPersisted = true
        if (run.partialText) {
          try {
            this.deps.conversationRepository.appendMessage(request.conversationId, {
              role: 'assistant',
              at: Date.now(),
              text: run.partialText,
              modelProfileId: profile.id,
              runId: run.runId,
            })
          } catch {
            partialPersisted = false
          }
        }
        if (run.partialText && !partialPersisted) {
          this.finishRun(run, 'failed', '部分回复持久化失败')
          this.commitTerminal(run, () => this.deps.emit({
            runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
            payload: { redactedError: '部分回复持久化失败', kind: 'internal' },
          }))
          return
        }
        this.finishRun(run, 'cancelled', undefined)
        this.commitTerminal(run, () => this.deps.emit({
          runId: run.runId, sequence: sequence.value++, type: 'cancelled', at: Date.now(),
          payload: { reason, partialText: run.partialText },
        }))
        return
      }
    }
  }

  /** Safety net: emit a failed terminal if runLoop threw unexpectedly. */
  private emitSafetyNetFailed(run: ActiveRun, sequence: { value: number }, _error: unknown): void {
    if (!this.runsById.has(run.runId)) return // already terminated
    // Audit + cleanup BEFORE the terminal commit (consistent with runLoop).
    this.finishRun(run, 'failed', '运行时内部错误')
    this.commitTerminal(run, () => this.deps.emit({
      runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
      payload: { redactedError: '运行时内部错误', kind: 'internal' },
    }))
  }

  // -------------------------------------------------------------------------
  // P3: direct tool invocation state machine + cross-process apply coordination
  // -------------------------------------------------------------------------

  /**
   * Run a list of direct-invocation tool calls. For each: resolve+Zod-validate
   * via the registry (direct=true → directInvocationAllowed gate), emit
   * tool-call-proposed, then:
   *   - read/propose → execute immediately, emit tool-started/tool-completed.
   *   - write → propose an approval, emit approval-required, AWAIT the decision
   *     (driven by ai:approval:decide IPC), emit approval-resolved, then (if
   *     approved) consume the token + execute (which calls ctx.applyToTarget
   *     for the cross-process apply flow), emit tool-started/tool-completed.
   *   - rejected/expired/used/cancelled/mismatched → tool-failed with a safe
   *     reason; the run stays recoverable (continues to the next tool or
   *     completes).
   * Exactly one terminal (completed/failed) at the end, via commitTerminal.
   *
   * No profile/credential is required (Blocker 2): direct-tool runs do not
   * call the model. The profile param was removed; the capability gate uses
   * `directInvocationAllowed(mode, true)` (direct invocation always allows
   * read|propose|write; toolCalling:false only downgrades MODEL tool calling,
   * which P3 does not implement).
   */
  private async runToolCalls(
    request: AiStartRunRequest,
    run: ActiveRun,
    sequence: { value: number },
  ): Promise<void> {
    const registry = this.deps.toolRegistry
    const approvals = this.deps.approvalManager
    const audit = this.deps.auditLog
    const toolCalls = request.toolCalls ?? []

    // Without a registry, no tools can run — fail safely.
    if (!registry) {
      this.finishRun(run, 'failed', '工具注册表未配置')
      this.commitTerminal(run, () => this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
        payload: { redactedError: '工具注册表未配置', kind: 'internal' },
      }))
      return
    }

    let allOk = true
    for (const call of toolCalls) {
      const toolCallId = `tc_${randomUUID()}`
      // Direct invocation: pass a synthetic profile with toolCalling=true so
      // directInvocationAllowed returns read|propose|write. The profile is
      // NOT used for model calls (direct-tool runs never stream). This keeps
      // the registry's resolve() signature stable without requiring a real
      // profile/credential for direct-tool runs.
      const directProfile = {
        id: run.profileId,
        providerId: 'openai-compatible',
        displayName: '',
        model: '',
        credentialKey: '',
        capabilities: { vision: false, toolCalling: true, jsonSchema: false, reasoning: false },
        createdAt: run.startedAt,
        updatedAt: run.startedAt,
      } as AiModelProfile
      const resolved = registry.resolve(call.toolId, call.rawInput, request.mode, directProfile, true)
      if (!resolved.ok) {
        audit?.record(run.runId, 'tool-proposed', {
          toolCallId, toolId: call.toolId, summary: resolved.reason, category: resolved.category,
        })
        this.deps.emit({
          runId: run.runId, sequence: sequence.value++, type: 'tool-failed', at: Date.now(),
          payload: { toolCallId, toolId: call.toolId, redactedError: resolved.reason, category: resolved.category },
        })
        audit?.record(run.runId, 'tool-failed', { toolCallId, toolId: call.toolId, redactedError: resolved.reason, category: resolved.category })
        allOk = false
        continue
      }
      const tool = resolved.tool
      const input = resolved.input
      // Blocker 3: audit/tool-call-proposed MUST NOT carry the raw tool input
      // (canonicalJson(input) would leak the payload). Use a fixed metadata
      // summary: tool/risk/scope/count/length only. The raw input stays
      // main-process; only safe metadata crosses to the renderer/audit.
      const inputMeta = this.buildToolInputMeta(tool, input)

      // tool-call-proposed
      this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'tool-call-proposed', at: Date.now(),
        payload: { toolCallId, toolId: tool.id, risk: tool.risk, inputSummary: inputMeta },
      })
      audit?.record(run.runId, 'tool-proposed', { toolCallId, toolId: tool.id, risk: tool.risk, summary: inputMeta })

      // write risk → approval gate
      if (tool.risk === 'write') {
        if (!approvals) {
          const reason = '审批管理器未配置，无法执行写入工具'
          this.deps.emit({
            runId: run.runId, sequence: sequence.value++, type: 'tool-failed', at: Date.now(),
            payload: { toolCallId, toolId: tool.id, redactedError: reason, category: 'no-approval' },
          })
          audit?.record(run.runId, 'tool-failed', { toolCallId, toolId: tool.id, redactedError: reason, category: 'no-approval' })
          allOk = false
          continue
        }
        // Build the approval request bound to the exact input + target. The
        // approval builder is dispatched by componentId: json-workbench uses
        // buildJsonApplyApproval (full-document + selection/document check);
        // diagram uses buildDiagramApproval (id + expectedRevision stale-target
        // detection, no editor-input apply). Each builder is app-owned — server
        // labels never influence risk/scope/hash. A builder may throw on
        // invalid write input (e.g. JSON partial-selection); emit tool-failed.
        let approvalFields
        try {
          approvalFields = tool.componentId === 'diagram'
            ? buildDiagramApproval(run.runId, toolCallId, tool.id, input as Record<string, unknown>)
            : (() => {
                // Full-document-only safety rule: a partial selection that no
                // longer matches the live editor document is rejected before any
                // approval is created. JSON-workbench write tools only.
                const writeInput = input as { selection: string; proposal: string; document: string }
                if (writeInput.selection !== writeInput.document) {
                  throw new Error('Full-document-only safety rule: partial selection is forbidden; retry using the complete editor document.')
                }
                return buildJsonApplyApproval(run.runId, toolCallId, writeInput)
              })()
        } catch (buildErr) {
          const reason = sanitizeToolText((buildErr as Error).message, 300)
          this.deps.emit({
            runId: run.runId, sequence: sequence.value++, type: 'tool-failed', at: Date.now(),
            payload: { toolCallId, toolId: tool.id, redactedError: reason, category: 'invalid-input' },
          })
          audit?.record(run.runId, 'tool-failed', { toolCallId, toolId: tool.id, redactedError: reason, category: 'invalid-input' })
          allOk = false
          continue
        }
        const approvalReq: AiApprovalRequest = {
          ...approvalFields,
          runId: run.runId,
          toolCallId,
          toolId: tool.id,
          risk: tool.risk,
          // Override the preview with a sanitized copy (the builder returns a
          // raw preview; the stored request + emitted event carry the safe one).
          impactPreview: sanitizeToolText(approvalFields.impactPreview, 4000),
        }
        const token = approvals.propose(approvalReq)
        // approval-required
        this.deps.emit({
          runId: run.runId, sequence: sequence.value++, type: 'approval-required', at: Date.now(),
          payload: {
            toolCallId, token: token.token, toolId: tool.id, risk: tool.risk,
            impactSummary: approvalFields.impactSummary,
            impactPreview: sanitizeToolText(approvalFields.impactPreview, 4000),
            targetScope: approvalFields.targetScope,
            contentHash: approvalFields.contentHash,
            expiresAt: token.expiresAt,
          },
        })

        // Await the decision. The approval manager is driven by the
        // ai:approval:decide IPC handler, which calls approvals.decide(). We
        // poll the token status until it's no longer pending (or the run is
        // cancelled/expired). This keeps the run blocked on the user's
        // decision without holding a model connection.
        const decision = await this.awaitApprovalDecision(run, token.token)
        // A cancelled run emits exactly one `cancelled` terminal and stops —
        // no tool-failed, no further tools. The poller returns `cancelled`
        // when the abort signal fires or the token was cancelled by cancel().
        if (decision.status === 'cancelled') {
          const reason: AiCancelReason = run.cancelReason ?? 'user'
          this.finishRun(run, 'cancelled', undefined)
          this.commitTerminal(run, () => this.deps.emit({
            runId: run.runId, sequence: sequence.value++, type: 'cancelled', at: Date.now(),
            payload: { reason, partialText: '' },
          }))
          return
        }
        // approval-resolved
        this.deps.emit({
          runId: run.runId, sequence: sequence.value++, type: 'approval-resolved', at: Date.now(),
          payload: { toolCallId, token: token.token, decision: decision.status === 'approved' ? 'approved' : 'rejected', reason: decision.reason },
        })
        audit?.record(run.runId, decision.status === 'approved' ? 'tool-approved' : 'tool-rejected', { toolCallId, toolId: tool.id, summary: decision.reason })

        if (decision.status !== 'approved') {
          const reason = decision.reason ?? '审批未通过'
          const category = decision.status === 'expired' ? 'approval-expired' : 'approval-rejected'
          this.deps.emit({
            runId: run.runId, sequence: sequence.value++, type: 'tool-failed', at: Date.now(),
            payload: { toolCallId, toolId: tool.id, redactedError: reason, category },
          })
          audit?.record(run.runId, 'tool-failed', { toolCallId, toolId: tool.id, redactedError: reason, category })
          allOk = false
          continue
        }

        // Approved → consume the token (default-deny: any mismatch → fail).
        const consumeResult = approvals.consume(token.token, approvalReq)
        if (!consumeResult.ok) {
          this.deps.emit({
            runId: run.runId, sequence: sequence.value++, type: 'tool-failed', at: Date.now(),
            payload: { toolCallId, toolId: tool.id, redactedError: consumeResult.reason, category: consumeResult.status === 'expired' ? 'approval-expired' : consumeResult.status === 'used' ? 'approval-used' : 'hash-mismatch' },
          })
          audit?.record(run.runId, 'tool-failed', { toolCallId, toolId: tool.id, redactedError: consumeResult.reason, category: consumeResult.status === 'expired' ? 'approval-expired' : consumeResult.status === 'used' ? 'approval-used' : 'hash-mismatch' })
          allOk = false
          continue
        }
      }

      // Execute the tool. The ctx provides emit + applyToTarget (for write).
      this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'tool-started', at: Date.now(),
        payload: { toolCallId, toolId: tool.id },
      })
      audit?.record(run.runId, 'tool-started', { toolCallId, toolId: tool.id })

      const ctx: AiToolExecCtx = {
        runId: run.runId,
        toolCallId,
        emit: (ev: AiToolRunEvent) => this.deps.emit(ev),
        applyToTarget: (proposal, revision, targetScope, contentHash) =>
          this.applyToTarget(run, sequence, toolCallId, tool.id, proposal, revision, targetScope, contentHash),
        // P3 propose→artifact: when the runtime is wired with an artifact
        // repository, expose createArtifact to the executor. A propose tool
        // persists its output as a read-only kind=json artifact; the returned
        // artifactRef flows through tool-completed to the UI. This is NOT
        // best-effort: the repository rejects restricted/invalid/oversize
        // content by throwing, and the executor maps that to tool-failed
        // (never a silent preview-only result). The preview-only fallback
        // applies ONLY when no repository is wired (createArtifact undefined).
        createArtifact: this.deps.artifactRepository
          ? async (input) => {
              const doc = this.deps.artifactRepository!.create({
                kind: input.kind,
                title: input.title,
                content: input.content,
                language: input.language,
                conversationId: run.conversationId,
                runId: run.runId,
              })
              return doc.id
            }
          : undefined,
      }
      let result: AiToolResult
      try {
        result = sanitizeToolResult(await tool.execute(input, ctx))
      } catch (e) {
        result = { ok: false, redactedError: sanitizeToolText((e as Error).message, 300), category: 'executor-error' }
      }

      if (result.ok) {
        this.deps.emit({
          runId: run.runId, sequence: sequence.value++, type: 'tool-completed', at: Date.now(),
          payload: { toolCallId, toolId: tool.id, summary: result.summary, preview: result.preview, artifactRef: result.artifactRef },
        })
        audit?.record(run.runId, 'tool-completed', { toolCallId, toolId: tool.id, summary: result.summary })
      } else {
        this.deps.emit({
          runId: run.runId, sequence: sequence.value++, type: 'tool-failed', at: Date.now(),
          payload: { toolCallId, toolId: tool.id, redactedError: result.redactedError, category: result.category },
        })
        audit?.record(run.runId, 'tool-failed', { toolCallId, toolId: tool.id, redactedError: result.redactedError, category: result.category })
        allOk = false
      }
    }

    // Terminal: completed if all tools ok, failed if any failed. Exactly once.
    if (allOk) {
      this.finishRun(run, 'completed', undefined)
      this.commitTerminal(run, () => this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'completed', at: Date.now(),
        payload: { finalText: `已执行 ${toolCalls.length} 个工具调用` },
      }))
    } else {
      this.finishRun(run, 'failed', '部分工具调用失败')
      this.commitTerminal(run, () => this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'failed', at: Date.now(),
        payload: { redactedError: '部分工具调用失败', kind: 'internal' },
      }))
    }
  }

  /**
   * Await an approval decision by polling the token status via the typed
   * inspect() method (Blocker 4: no cast access to private tokens). Returns
   * a decision (approved/rejected/expired/cancelled) when the token leaves
   * pending, or `cancelled` if the run's abort signal fired (user/timeout
   * cancel). The approval manager is driven by the ai:approval:decide IPC
   * handler; cancel() flips the token to `cancelled` via approvalManager.cancel.
   */
  private async awaitApprovalDecision(
    run: ActiveRun,
    tokenId: string,
  ): Promise<{ status: 'approved' | 'rejected' | 'expired' | 'cancelled'; reason?: string }> {
    const approvals = this.deps.approvalManager!
    const deadline = Date.now() + AI_MAX_RUN_MS
    while (Date.now() < deadline) {
      // Observe cancel: cancel() aborts + cancels the pending token. Either
      // the token is now `cancelled` (caught below) or the abort fired before
      // the manager processed cancel — check the signal directly.
      if (run.abort.signal.aborted) {
        return { status: 'cancelled', reason: run.cancelReason === 'timeout' ? '运行超时' : '运行已取消' }
      }
      if (!this.runsById.has(run.runId)) {
        return { status: 'cancelled', reason: '运行已终止' }
      }
      approvals.purgeExpired()
      const snap = approvals.inspect(tokenId)
      if (!snap) return { status: 'rejected', reason: '审批令牌丢失' }
      if (snap.status !== 'pending') {
        return {
          status: snap.status as 'approved' | 'rejected' | 'expired' | 'cancelled',
          reason: snap.reason,
        }
      }
      await new Promise((r) => setTimeout(r, 50))
    }
    return { status: 'expired', reason: '审批等待超时' }
  }

  /**
   * Build a FIXED metadata summary for a tool call (Blocker 3). NEVER includes
   * the raw tool input/payload — only tool id, risk, component scope, and
   * coarse shape counts/lengths. This is what crosses to the renderer
   * (tool-call-proposed payload) and the audit log (tool-proposed summary).
   * The raw input stays main-process; the renderer/audit see only safe
   * metadata. For the JSON tools the input shape is known, so we emit a
   * precise-but-safe label (selection length / proposal length) without the
   * content.
   */
  private buildToolInputMeta(
    tool: { id: string; risk: AiToolRisk; componentId: string },
    input: unknown,
  ): string {
    const parts: string[] = [`${tool.id}(${tool.risk})`]
    if (tool.componentId === 'json-workbench' && typeof input === 'object' && input !== null) {
      const obj = input as Record<string, unknown>
      if (typeof obj.selection === 'string') parts.push(`selection=${obj.selection.length}chars`)
      if (typeof obj.proposal === 'string') parts.push(`proposal=${obj.proposal.length}chars`)
    } else {
      // Generic shape: count top-level keys + total string length (no values).
      const keys = typeof input === 'object' && input !== null
        ? Object.keys(input as Record<string, unknown>).length
        : 0
      parts.push(`keys=${keys}`)
    }
    return parts.join(' ')
  }

  /**
   * P3 cross-process apply coordination (correction). Called by a write tool's
   * executor via ctx.applyToTarget. Emits an apply-request event to the active
   * renderer, registers a pending one-shot apply keyed by applyId (storing the
   * targetScope/contentHash/revision for later ack verification), and awaits
   * the guarded ai:apply:ack IPC. The renderer may apply ONLY if its current
   * editor revision matches; a stale editor refuses. Main rejects
   * duplicate/unknown/mismatched acks. Timeout/cancel/terminal invalidates.
   */
  private applyToTarget(
    run: ActiveRun,
    sequence: { value: number },
    toolCallId: string,
    toolId: string,
    proposal: string,
    revision: string,
    targetScope: string,
    contentHash: string,
  ): Promise<AiApplyToTargetResult> {
    return new Promise((resolve) => {
      const applyId = `apl_${randomUUID()}`
      const expiresAt = Date.now() + AI_APPLY_ACK_TIMEOUT_MS
      // Register the pending one-shot + timeout BEFORE emitting the
      // apply-request. If the renderer ACKs synchronously (or on a microtask
      // before this body resumes), handleApplyAck must find the entry in
      // run.pendingApplies — otherwise it returns `unknown`, the one-shot is
      // never resolved, and the tool hangs until the run timeout. Registering
      // first closes that synchronous-ACK race; the applyId, metadata
      // (scope/hash/revision), and expiresAt are unchanged from before.
      const timer = setTimeout(() => {
        const pending = run.pendingApplies.get(applyId)
        if (pending) {
          run.pendingApplies.delete(applyId)
          pending.resolve({ ok: false, reason: '应用确认超时', category: 'stale-target' })
        }
      }, AI_APPLY_ACK_TIMEOUT_MS)
      run.pendingApplies.set(applyId, {
        resolve, timer, targetScope, contentHash, revision,
      })
      // Emit the apply-request to the renderer ONLY after the one-shot is
      // registered, so any ACK — synchronous or not — resolves against the
      // stored scope/hash/revision instead of being dropped as unknown.
      this.deps.emit({
        runId: run.runId, sequence: sequence.value++, type: 'apply-request', at: Date.now(),
        payload: { applyId, toolCallId, toolId, targetScope, contentHash, revision, proposal, expiresAt },
      })
    })
  }

  /**
   * Handle a guarded ai:apply:ack from the renderer. Scans the runtime's own
   * pending-apply maps (NO reflection, NO empty fan-out, NO runId parameter —
   * the applyId alone resolves the one-shot). Verifies:
   *   - applyId matches a pending one-shot (else unknown/duplicate → ok:false)
   *   - ack.targetScope/contentHash/revision match the stored pending request
   *     (else mismatch → ok:false; the renderer cannot swap the target/content)
   *   - applied:false with a reason → resolves the one-shot as a stale-target
   *     refusal (the renderer refused, e.g. stale editor revision)
   *
   * Return value (Blocker 5 correction):
   *   - { ok: true }  — the ack matched a pending one-shot AND the
   *     scope/hash/revision matched. The one-shot is resolved (applied or
   *     refused) and consumed. The IPC handler returns success.
   *   - { ok: false, reason: 'unknown'|'duplicate'|'mismatch' } — the ack did
   *     NOT validly complete. For 'mismatch' the one-shot is STILL consumed +
   *     resolved as a scope-mismatch tool failure (so the run fails cleanly),
   *     BUT the IPC call is REJECTED (throws) — a mismatched ack is never
   *     reported as success to the renderer. For 'unknown'/'duplicate' the
   *     one-shot is untouched (there was none to consume).
   *
   * The renderer cannot fabricate execution: only a matching ack (right
   * applyId + right scope/hash/revision) returns ok:true.
   */
  handleApplyAck(ack: AiApplyAck): { ok: true } | { ok: false; reason: 'unknown' | 'duplicate' | 'mismatch' } {
    for (const run of this.runsById.values()) {
      const pending = run.pendingApplies.get(ack.applyId)
      if (!pending) continue
      // Found the one-shot. Verify the ack's scope/hash/revision match the
      // stored pending request exactly. A mismatch consumes the one-shot
      // (resolves the tool failure) BUT returns ok:false so the IPC layer
      // rejects the call — a mismatched ack is never reported as success.
      const mismatch =
        ack.targetScope !== pending.targetScope ||
        ack.contentHash !== pending.contentHash ||
        ack.revision !== pending.revision
      run.pendingApplies.delete(ack.applyId)
      clearTimeout(pending.timer)
      if (mismatch) {
        pending.resolve({ ok: false, reason: '应用确认范围/哈希/版本不匹配', category: 'scope-mismatch' })
        return { ok: false, reason: 'mismatch' }
      }
      if (ack.applied) {
        pending.resolve({ ok: true, applied: true })
      } else {
        pending.resolve({ ok: false, reason: sanitizeToolText(ack.reason ?? '渲染进程拒绝应用', 300), category: 'stale-target' })
      }
      return { ok: true }
    }
    // No pending apply matched → unknown/duplicate/stale. The renderer cannot
    // fabricate execution: an ack with no matching pending one-shot is a no-op.
    return { ok: false, reason: 'unknown' }
  }

  private finishRun(
    run: ActiveRun,
    status: AiRunAuditRef['status'],
    redactedError?: string,
  ): void {
    if (run.totalTimer) { clearTimeout(run.totalTimer); run.totalTimer = null }
    // P3: invalidate any pending apply one-shots + cancel pending approvals.
    // A terminal means the run is over — no further apply acks are accepted.
    for (const [applyId, pending] of run.pendingApplies) {
      clearTimeout(pending.timer)
      pending.resolve({ ok: false, reason: '运行已终止', category: 'stale-target' })
      run.pendingApplies.delete(applyId)
    }
    this.deps.approvalManager?.cancel(run.runId)
    const ref: AiRunAuditRef = {
      runId: run.runId,
      startedAt: run.startedAt,
      endedAt: Date.now(),
      modelProfileId: run.profileId, // actual profile id, never ''
      status,
      redactedError,
    }
    try {
      this.deps.conversationRepository.recordRunAudit(run.conversationId, ref)
    } catch {
      /* conversation may be gone; audit is best-effort */
    }
    // P3: record the run terminal in the audit log.
    this.deps.auditLog?.record(run.runId, status === 'completed' ? 'run-completed' : status === 'failed' ? 'run-failed' : 'run-cancelled', { redactedError })
    // P2: clear the attachment payloads for this run (ephemeral cleanup on
    // terminal). The metas may persist (metadata-only placeholders) but the
    // raw text is gone once the run is done.
    if (run.attachmentIds.length > 0 && this.deps.contextVault) {
      this.deps.contextVault.clearForRun(run.attachmentIds)
    }
    this.active.delete(run.conversationId)
    this.runsById.delete(run.runId)
  }
}

const SYSTEM_PROMPT =
  'You are RainTool AI Assistant, a general-purpose helper embedded in the RainTool desktop app. ' +
  'Answer concisely and helpfully. You do not have tools in this version; if a task needs file ' +
  'access or external actions, tell the user what is not yet supported.'
