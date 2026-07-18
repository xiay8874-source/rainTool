// Monaco-backed diff pane for Git Workbench (lazy-loaded).
//
// This module is the ONLY place in the renderer that imports `monaco-editor`
// and `@monaco-editor/react`. The top-level `git-workbench.tsx` shell DOES NOT
// import Monaco — it lazy-loads this module only when a text diff needs to
// render. That keeps the Git Workbench's main chunk small (the file lists,
// commit strip, and top bar render instantly) and isolates Monaco's ~3 MB
// bundle into a separate dynamic chunk that loads on demand.
//
// If Monaco or its workers fail to load inside the packaged app, the
// ErrorBoundary in `git-workbench.tsx` catches the dynamic-import rejection
// and renders a retryable error UI instead of leaving the workspace stuck on
// the Suspense fallback.

import { DiffEditor, loader } from '@monaco-editor/react'
import * as monacoEditor from 'monaco-editor'
import type { editor } from 'monaco-editor'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import type { GitDiffResult } from '../../../../electron/git-types'

// Configure the Monaco environment once per process. The DiffEditor only
// needs the editor worker for plain text; the JSON worker is wired for .json
// files. This must be set before any editor is constructed.
self.MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === 'json') return new jsonWorker()
    return new editorWorker()
  },
} as monacoEditor.Environment

// Hand the bundled monaco instance to @monaco-editor/react so it skips its
// CDN script-injection init path entirely (works offline inside app.asar).
loader.config({ monaco: monacoEditor })

/**
 * Renders a text diff with Monaco's DiffEditor. The IPC returns COMPLETE
 * original/modified texts (not a unified patch), so Monaco consumes them
 * directly — no renderer-side patch reconstruction. The caller is responsible
 * for non-text kinds (binary/too_large/submodule/empty); this component is
 * only reached for `diff.kind === 'text'`.
 */
export function MonacoDiffPane({
  diff,
  selectionPath,
  view,
  onToggleView,
}: {
  /** A text-kind diff. The caller is responsible for narrowing; non-text kinds
   *  never reach this component. */
  diff: GitDiffResult
  selectionPath: string
  view: 'unified' | 'split'
  onToggleView: () => void
}) {
  const effectiveView = diff.view ?? view
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between border-b border-line bg-bg-surface px-2 py-1">
        <span className="truncate text-caption text-ink-tertiary" title={selectionPath}>{selectionPath}</span>
        <button
          onClick={onToggleView}
          className="rounded-btn border border-line px-2 py-0.5 text-caption text-ink-secondary hover:bg-bg-hover"
          title="切换统一/分栏视图"
        >
          {effectiveView === 'split' ? '分栏' : '统一'}
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <DiffEditor
          original={diff.original ?? ''}
          modified={diff.modified ?? ''}
          language={diff.language}
          theme="vs"
          options={
            {
              readOnly: true,
              renderSideBySide: effectiveView === 'split',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              lineNumbers: 'on',
              wordWrap: 'off',
            } as editor.IDiffEditorConstructionOptions
          }
        />
      </div>
    </div>
  )
}

export default MonacoDiffPane
