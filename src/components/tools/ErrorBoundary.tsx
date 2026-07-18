// Reusable React error boundary for lazy-loaded tool subcomponents.
//
// Used to wrap dynamic-imported chunks (e.g. Monaco diff pane) so a load or
// render failure shows an explicit, retryable error UI instead of leaving the
// workspace stuck on a Suspense fallback forever. The boundary is intentionally
// narrow: it catches errors from its children only, surfaces a short safe
// message, and offers a Retry button that re-mounts the subtree by flipping a
// remount key. It NEVER reports the raw error stack to the user — only the
// message (which is already redacted by the time it reaches a tool component).
//
// The boundary does NOT silently swallow errors in production builds: when
// `import.meta.env.DEV` is true the full error is also logged to console for
// developer diagnosis; in packaged builds only the safe message is shown.

import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Short, user-facing label shown above the error (e.g. "Diff 编辑器"). */
  label: string
  /** Hint shown under the label, e.g. how to recover. */
  recoverHint?: string
  /**
   * Optional external retry handler. When provided, the Retry button calls
   * this INSTEAD of the internal remount. Used by tab-level boundaries
   * (Workspace.tsx) where retry must clear the tool's lazy-import cache so a
   * rejected chunk-load promise is re-issued — the internal remount alone
   * would re-suspend on the same rejected promise and re-throw. When omitted,
   * the internal remount (bump remountKey) is used (sufficient for the diff
   * pane, where the failure is a render error rather than a cached rejection).
   */
  onRetry?: () => void
}

interface State {
  error: Error | null
  /** Bumped by Retry to force a remount of children. */
  remountKey: number
}

export class ToolErrorBoundary extends Component<Props, State> {
  state: State = { error: null, remountKey: 0 }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.error('[ToolErrorBoundary]', this.props.label, error, info)
    }
  }

  private retry = () => {
    // If an external onRetry is wired (tab-level boundary), defer to it — it
    // clears the tool's lazy-import cache + bumps the parent key so this
    // boundary unmounts/remounts fresh (error cleared) and a NEW lazy promise
    // is issued. The internal remount below is a no-op for that path because
    // the parent remount replaces this instance entirely.
    if (this.props.onRetry) {
      this.props.onRetry()
      return
    }
    this.setState((s) => ({ error: null, remountKey: s.remountKey + 1 }))
  }

  render(): ReactNode {
    if (this.state.error) {
      const message = this.state.error.message || '加载失败'
      return (
        <div className="flex h-full w-full items-center justify-center p-4">
          <div className="w-full max-w-md rounded-card border border-line bg-bg-surface p-4 text-center shadow-float">
            <div className="text-page text-ink-primary">{this.props.label}加载失败</div>
            <div className="mt-2 text-body text-ink-secondary">
              {this.props.recoverHint ?? '可重试加载；若多次失败，请重启 RainTool 后再试。'}
            </div>
            <details className="mt-3 text-left text-caption text-ink-tertiary">
              <summary className="cursor-pointer">技术详情</summary>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-btn bg-bg-subtle p-2">{message}</pre>
            </details>
            <div className="mt-4 flex justify-center">
              <button
                type="button"
                onClick={this.retry}
                className="rounded-btn bg-accent px-4 py-2 text-body text-white hover:opacity-90"
              >
                重试加载
              </button>
            </div>
          </div>
        </div>
      )
    }
    // Keyed remount so Retry forces the lazy child to re-import + re-render.
    return <div key={this.state.remountKey} className="h-full w-full">{this.props.children}</div>
  }
}
