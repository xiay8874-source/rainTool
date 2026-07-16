export type AiDrawioStartErrorCode =
  | 'PORT_IN_USE'
  | 'MISSING_RESOURCE'
  | 'START_TIMEOUT'
  | 'START_FAILED'

export type AiDrawioStartResult =
  | { status: 'ready'; code: 'READY'; url: string }
  | { status: 'error'; code: AiDrawioStartErrorCode; message: string; details?: string }
