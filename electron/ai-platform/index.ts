// AI Platform bootstrap. Wires the repositories, provider registry, runtime,
// and IPC handlers together using app.getPath('userData') as the data root
// (NOT a hard-coded home path). Called once from main.ts when the app is ready.
//
// The AI data lives under userData/ai/ (credentials.json, profiles.json,
// conversations/). This is distinct from the legacy ~/raintool/ store used by
// favorites/workspace — those keep their existing location.

import { app, type BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { AiConversationRepository } from './ai-conversation-repository.js'
import { AiCredentialVault } from './ai-credential-vault.js'
import { AiModelProfileRepository } from './ai-model-profile-repository.js'
import { AiSupplierRepository } from './ai-supplier-repository.js'
import { AiProviderRegistry } from './ai-provider-registry.js'
import { AiRuntime } from './ai-runtime.js'
import { registerAiIpc, type AiIpcDeps } from './ai-ipc.js'
import { AiContextVault } from './ai-context-vault.js'
import { AiArtifactRepository } from './ai-artifact-repository.js'
import { AiToolRegistry } from './ai-tool-registry.js'
import { AiApprovalManager } from './ai-approval-manager.js'
import { AiAuditLog } from './ai-audit-log.js'
import { registerJsonTools } from './ai-json-tools.js'
import { registerDiagramTools } from './ai-diagram-tools.js'
import type { DiagramRepository } from '../diagram-repository.js'
import type { DiagramChangedEvent } from '../diagram-types.js'
import { AiMcpConfigRepository } from './ai-mcp-config-repository.js'
import { AiMcpManager } from './ai-mcp-manager.js'
import type { AiCancelReason, AiRunEvent } from './ai-types.js'
import { TOKENHUB_DEFAULT_MODELS, TOKENHUB_DEFAULT_SUPPLIER_ID } from './ai-types.js'

export interface AiPlatform {
  runtime: AiRuntime
  /** Emit a run event to the main window (used by runtime → renderer). */
  emit: (event: AiRunEvent) => void
  /**
   * Cancel every active run. `reason` is preserved into each `cancelled` event
   * so window-close shutdown is distinguishable from user/timeout cancels.
   */
  cancelAll: (reason: AiCancelReason) => void
  /** P2: clear all in-memory attachment payloads (call on app quit). */
  clearContextVault: () => void
  /** P3: cancel every pending approval (call on app quit). */
  cancelAllApprovals: () => void
  /** P4: disconnect every MCP client (call on app quit). */
  disconnectAllMcp: () => Promise<void>
}

let platform: AiPlatform | null = null

/**
 * Initialize the AI Platform. Idempotent: returns the existing instance.
 * `mainWindowGetter` lets the IPC layer reach the live window without holding
 * a stale reference across recreations.
 */
export function initAiPlatform(options: {
  mainWindow: () => BrowserWindow | null
  assertTrustedRenderer: AiIpcDeps['assertTrustedRenderer']
  /** P4: the RainTool diagram repository, for diagram tool adapters. Optional for tests. */
  diagramRepository?: DiagramRepository
  /**
   * P4: called after a diagram write tool mutates a diagram, mirroring the
   * diagram-bridge-server's onChanged so the renderer refreshes. Optional for
   * tests. The real implementation sends a `diagram:changed` event to the main
   * window (same path as the bridge).
   */
  onDiagramChanged?: (document: ReturnType<DiagramRepository['require']>, reason: DiagramChangedEvent['reason']) => void
}): AiPlatform {
  if (platform) return platform

  const dataDir = app.getPath('userData')
  const credentialVault = new AiCredentialVault(dataDir)
  const supplierRepository = new AiSupplierRepository(dataDir)
  const profileRepository = new AiModelProfileRepository(dataDir)
  // P0-1: link the profile repo to the supplier repo so profile reads merge
  // the supplier's connection config (protocol/baseUrl/credentialKey) and
  // respect the supplier's enable flag.
  profileRepository.setSupplierRepository({
    get: (id) => {
      const s = supplierRepository.get(id)
      return s ? { enabled: s.enabled, protocol: s.protocol, baseUrl: s.baseUrl, credentialKey: s.credentialKey } : null
    },
  })
  // P0-1 migration: assign a supplierId to every legacy profile that lacks
  // one, deduping into the TokenHub default supplier where the URL matches.
  // Seed the TokenHub default models if the TokenHub supplier has no models
  // yet AND no profiles exist at all (first run).
  migrateLegacyProfilesIntoSuppliers(profileRepository, supplierRepository)
  seedTokenHubDefaultModels(profileRepository, supplierRepository)
  const conversationRepository = new AiConversationRepository(dataDir)
  const providerRegistry = new AiProviderRegistry()
  const contextVault = new AiContextVault(dataDir)
  const artifactRepository = new AiArtifactRepository(dataDir)

  // P3: tool registry (allowlisted + Zod-validated), approval manager
  // (single-use TTL write tokens), audit log (append-only, safe metadata).
  const toolRegistry = new AiToolRegistry()
  registerJsonTools(toolRegistry)
  // P4: register the RainTool diagram tool adapters (read + approval-gated
  // write) into the same registry. Only when a diagram repository is provided
  // (production); tests that don't need diagram tools omit it.
  if (options.diagramRepository) {
    registerDiagramTools(toolRegistry, options.diagramRepository, options.onDiagramChanged)
  }
  const approvalManager = new AiApprovalManager()
  const auditLog = new AiAuditLog(dataDir)

  // P4: MCP client manager. Metadata-only config persistence + main-owned
  // connections. The bundled RainTool MCP launcher path is resolved by main
  // (packaged vs dev) — never a renderer path. The renderer only sends
  // validated config candidates + confirmation nonces.
  const mcpConfigRepository = new AiMcpConfigRepository(dataDir)
  const mcpManager = new AiMcpManager({
    configRepository: mcpConfigRepository,
    resolveBundledLauncher: () => resolveBundledMcpLauncher(),
    emit: (event) => {
      const win = options.mainWindow()
      if (win && !win.isDestroyed()) {
        win.webContents.send('ai:mcp:event', event)
      }
    },
  })

  const emit = (event: AiRunEvent) => {
    const win = options.mainWindow()
    if (win && !win.isDestroyed()) {
      win.webContents.send('ai:run:event', event)
    }
  }

  const runtime = new AiRuntime({
    providerRegistry,
    conversationRepository,
    credentialVault,
    profileRepository,
    contextVault,
    artifactRepository,
    toolRegistry,
    approvalManager,
    auditLog,
    emit,
  })

  registerAiIpc({
    mainWindow: options.mainWindow,
    assertTrustedRenderer: options.assertTrustedRenderer,
    conversationRepository,
    profileRepository,
    supplierRepository,
    credentialVault,
    runtime,
    contextVault,
    artifactRepository,
    toolRegistry,
    approvalManager,
    auditLog,
    mcpManager,
  })

  platform = {
    runtime,
    emit,
    cancelAll: (reason) => runtime.cancelAll(reason),
    clearContextVault: () => contextVault.clearAll(),
    cancelAllApprovals: () => approvalManager.cancelAll(),
    disconnectAllMcp: () => mcpManager.disconnectAll(),
  }
  return platform
}

/**
 * Resolve the bundled RainTool MCP launcher. Packaged: under the app Resources
 * directory (`raintool-mcp/raintool-mcp`). Dev: under the repo build output.
 * The renderer NEVER supplies this path — main owns it. Returns null if no
 * launcher is present (the UI shows the built-in as unavailable).
 */
function resolveBundledMcpLauncher(): { command: string; args: string[] } | null {
  // Packaged: <Resources>/raintool-mcp/raintool-mcp (a shell launcher that
  // execs the bundled index.cjs with node).
  const packaged = path.join(process.resourcesPath ?? '', 'raintool-mcp', 'raintool-mcp')
  if (packaged && existsSync(packaged)) {
    return { command: packaged, args: ['--client', 'raintool'] }
  }
  // Dev: build/raintool-mcp/raintool-mcp (created by `npm run build:mcp`).
  const dev = path.join(app.getAppPath(), 'build', 'raintool-mcp', 'raintool-mcp')
  if (existsSync(dev)) {
    return { command: dev, args: ['--client', 'raintool'] }
  }
  return null
}

export function getAiPlatform(): AiPlatform | null {
  return platform
}

/**
 * P0-1 migration: assign a supplierId to every legacy profile that lacks one.
 * Idempotent + safe-dedup: profiles pointing at the same (providerId,
 * baseUrl, credentialKey) collapse into ONE supplier; TokenHub-shaped
 * profiles fold into the seeded TokenHub supplier. Run once at bootstrap.
 */
function migrateLegacyProfilesIntoSuppliers(
  profileRepository: AiModelProfileRepository,
  supplierRepository: AiSupplierRepository,
): void {
  for (const profile of profileRepository.list()) {
    if (profile.supplierId) continue
    const supplierId = supplierRepository.resolveSupplierForLegacyProfile({
      providerId: profile.providerId,
      baseUrl: profile.baseUrl,
      credentialKey: profile.credentialKey,
    })
    profileRepository.assignSupplier(profile.id, supplierId)
  }
}

/**
 * P0-1: on first run (no profiles at all), seed the TokenHub default models
 * (GLM-5.2 / AUTO / Logos / Multimodal-Chat) under the TokenHub supplier so
 * the user has working models out of the box. Idempotent: if any profiles
 * exist, do nothing (the user may have deleted the defaults — don't recreate).
 */
function seedTokenHubDefaultModels(
  profileRepository: AiModelProfileRepository,
  supplierRepository: AiSupplierRepository,
): void {
  if (profileRepository.list().length > 0) return
  const tokenhub = supplierRepository.get(TOKENHUB_DEFAULT_SUPPLIER_ID)
  if (!tokenhub) return
  for (const m of TOKENHUB_DEFAULT_MODELS) {
    profileRepository.upsert({
      providerId: tokenhub.providerId,
      displayName: m.displayName,
      model: m.model,
      baseUrl: tokenhub.baseUrl,
      credentialKey: tokenhub.credentialKey,
      supplierId: tokenhub.id,
      enabled: true,
      capabilities: { vision: false, toolCalling: false, jsonSchema: false, reasoning: false },
    })
  }
}
