// Pure bridge-message classifier for the AI Draw.io iframe handoff.
//
// The renderer subscribes to `message` events from the embedded Draw.io iframe
// (protocol `raintool-diagram-v1`). The component's `handleMessage` callback
// delegates the decision of "what kind of message is this + what should the
// component do" to `classifyBridgeMessage`, a pure function. This keeps the
// state-transition logic unit-testable without React/DOM/iframe.
//
// Contract: the classifier NEVER touches the DOM, never posts back, never
// mutates external state. It only returns a descriptor the caller applies.
//
// Message types (mirrors the embedded Next bridge contract):
//   - raintool:diagram-ready   — iframe editor finished initializing; the
//                                 renderer may now send load/export requests.
//   - raintool:diagram-autosave — editor persisted a new XML; queue a save.
//   - raintool:diagram-export-result — export PNG/SVG completed; resolve IPC.
//   - raintool:legacy-response  — legacy diagrams discovered; migrate.
//   - anything else             — ignored (defensive; the bridge may add new
//                                 messages later — the renderer must not
//                                 crash or misinterpret them).

import type { LegacyDiagramInput } from '../../../electron/diagram-types'

/** The bridge protocol every message must carry. */
export const BRIDGE_PROTOCOL = 'raintool-diagram-v1'

/** A bridge message envelope. Loose-typed (the iframe is cross-origin). */
export interface BridgeMessage {
  protocol?: string
  type?: string
  diagramId?: string
  revision?: number
  xml?: string
  requestId?: string
  data?: string
  items?: LegacyDiagramInput[]
}

/**
 * Context the classifier needs to make decisions. The caller passes the
 * current document id (so autosave for a different/stale document is ignored)
 * and the set of pending export request ids (so only awaited exports resolve).
 */
export interface BridgeClassifyContext {
  /** The diagram id currently loaded into the iframe, or null if none. */
  currentDocumentId: string | null
  /** Pending export request ids awaiting a result from the iframe. */
  pendingExportRequestIds: Set<string>
  /** Whether the legacy migration has already run (idempotent guard). */
  legacyMigrationDone: boolean
}

/** Discriminated descriptor of what the component should do for a message. */
export type BridgeAction =
  | { kind: 'ready' }
  | { kind: 'autosave'; diagramId: string; xml: string }
  | { kind: 'export-result'; requestId: string; data: string | undefined; error: string | undefined }
  | { kind: 'legacy-response'; items: LegacyDiagramInput[] }
  | { kind: 'ignore'; reason: string }

/**
 * Classify a bridge message into a `BridgeAction`. Pure: no DOM, no side
 * effects. The caller applies the action (set state, post messages, call
 * IPC). Returns `{ kind: 'ignore' }` for anything that doesn't match the
 * protocol + a known type, or that references a stale/unexpected document.
 *
 * Validation rules:
 *   - `protocol` MUST equal `raintool-diagram-v1` (defense against other
 *     postMessage senders that might reach the window).
 *   - `raintool:diagram-autosave` is honored ONLY when `message.diagramId`
 *     matches `ctx.currentDocumentId` — a stale autosave from a previous
 *     document (e.g. after switching tabs) must NOT overwrite the current one.
 *   - `raintool:diagram-export-result` is honored ONLY when `requestId` is in
 *     `ctx.pendingExportRequestIds` — a stray/unsolicited export result is
 *     ignored (the renderer never sent that request).
 *   - `raintool:legacy-response` is honored ONLY when
 *     `ctx.legacyMigrationDone === false` — idempotent; a second legacy
 *     response (e.g. after a frame reload) does not re-migrate.
 */
export function classifyBridgeMessage(
  message: BridgeMessage | null | undefined,
  ctx: BridgeClassifyContext,
): BridgeAction {
  if (!message || message.protocol !== BRIDGE_PROTOCOL) {
    return { kind: 'ignore', reason: 'protocol-mismatch' }
  }
  switch (message.type) {
    case 'raintool:diagram-ready':
      return { kind: 'ready' }
    case 'raintool:diagram-autosave': {
      if (
        typeof message.diagramId === 'string' &&
        typeof message.xml === 'string' &&
        message.diagramId === ctx.currentDocumentId
      ) {
        return { kind: 'autosave', diagramId: message.diagramId, xml: message.xml }
      }
      return { kind: 'ignore', reason: 'stale-or-malformed-autosave' }
    }
    case 'raintool:diagram-export-result': {
      const requestId = typeof message.requestId === 'string' ? message.requestId : ''
      if (requestId && ctx.pendingExportRequestIds.has(requestId)) {
        const data = typeof message.data === 'string' ? message.data : undefined
        return {
          kind: 'export-result',
          requestId,
          data,
          error: data ? undefined : 'Draw.io 未返回导出数据',
        }
      }
      return { kind: 'ignore', reason: 'unknown-export-request' }
    }
    case 'raintool:legacy-response': {
      if (ctx.legacyMigrationDone) {
        return { kind: 'ignore', reason: 'legacy-already-migrated' }
      }
      if (Array.isArray(message.items)) {
        return { kind: 'legacy-response', items: message.items }
      }
      return { kind: 'ignore', reason: 'malformed-legacy-response' }
    }
    default:
      return { kind: 'ignore', reason: `unknown-type:${message.type ?? ''}` }
  }
}
