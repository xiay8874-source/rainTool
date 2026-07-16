export const RAINTOOL_DIAGRAM_PROTOCOL_VERSION = 1

export type DiagramSource = 'raintool' | 'zcode' | 'codex' | 'mcp' | 'legacy'

export interface DiagramMetadata {
  id: string
  title: string
  revision: number
  createdAt: number
  updatedAt: number
  source: DiagramSource
  sourceClient?: string
  favorite: boolean
  tags: string[]
  legacySessionId?: string
}

export interface DiagramDocument extends DiagramMetadata {
  xml: string
}

export interface DiagramListQuery {
  query?: string
  favorite?: boolean
  source?: DiagramSource
  offset?: number
  limit?: number
}

export interface DiagramListResult {
  items: DiagramMetadata[]
  total: number
}

export interface DiagramCreateInput {
  title?: string
  xml?: string
  source?: DiagramSource
  sourceClient?: string
  favorite?: boolean
  tags?: string[]
  legacySessionId?: string
}

export interface DiagramUpdateInput {
  id: string
  title?: string
  xml?: string
  favorite?: boolean
  tags?: string[]
  expectedRevision?: number
}

export type DiagramUpdateResult =
  | { status: 'ok'; document: DiagramDocument }
  | { status: 'conflict'; document: DiagramDocument }

export interface DiagramDuplicateInput {
  id: string
  title?: string
  source?: DiagramSource
  sourceClient?: string
}

export interface DiagramRevisionMetadata {
  revision: number
  savedAt: number
}

export interface DiagramChangedEvent {
  document: DiagramDocument
  reason: 'created' | 'updated' | 'duplicated' | 'restored' | 'migrated'
}

export interface DiagramDeletedEvent {
  id: string
}

export interface DiagramOpenRequest {
  id: string
  focus?: boolean
}

export interface DiagramExportRequest {
  requestId: string
  id: string
  format: 'png' | 'svg'
}

export interface DiagramExportResult {
  requestId: string
  data?: string
  error?: string
}

export interface LegacyDiagramInput {
  legacySessionId: string
  title: string
  xml: string
  createdAt?: number
  updatedAt?: number
}

export interface LegacyDiagramMigrationResult {
  imported: number
  skipped: number
  documents: DiagramDocument[]
}

export interface DiagramBridgeRpcRequest {
  method: string
  params?: unknown
}

export interface DiagramBridgeRpcResponse {
  ok: boolean
  result?: unknown
  error?: {
    code: string
    message: string
    data?: unknown
  }
}
