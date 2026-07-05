import { useEffect, useRef, useState } from 'react'
import { CloseIcon, ChevronDownIcon, ChevronUpIcon } from '../icons'

/**
 * 浏览器风格浮动查找/替换栏(展示型组件)。
 * 状态由宿主持有;本组件只负责 UI 与键盘交互。
 *
 * - 查找框:输入即触发高亮;Enter=下一个,Shift+Enter=上一个,Esc=关闭
 * - 替换框(canReplace 时可展开):"替换"替换当前并跳到下一个,"全部替换"替换所有
 * - 命中计数:N / M(当前第 N 个,共 M 个,1 起始)
 *
 * ⌘F 唤起:监听 window 的 'raintool:find' 自定义事件,
 * 仅当本组件可见(offsetParent !== null)时打开并聚焦 —— 兼容 keep-alive 隐藏标签。
 */
export function FindBar({
  open,
  onClose,
  find,
  setFind,
  replace,
  setReplace,
  matchCount,
  activeIndex,
  onPrev,
  onNext,
  onReplaceNext,
  onReplaceAll,
  canReplace,
}: {
  open: boolean
  onClose: () => void
  find: string
  setFind: (s: string) => void
  replace: string
  setReplace: (s: string) => void
  matchCount: number
  activeIndex: number // 0-based;显示时 +1
  onPrev: () => void
  onNext: () => void
  onReplaceNext: () => void
  onReplaceAll: () => void
  canReplace: boolean
}) {
  const findInputRef = useRef<HTMLInputElement>(null)
  const [showReplace, setShowReplace] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // ⌘F 唤起:仅当本组件在可视区(offsetParent !== null)时响应
  useEffect(() => {
    if (!open) return
    const onFind = () => {
      if (rootRef.current && rootRef.current.offsetParent !== null) {
        findInputRef.current?.focus()
        findInputRef.current?.select()
      }
    }
    window.addEventListener('raintool:find', onFind)
    return () => window.removeEventListener('raintool:find', onFind)
  }, [open])

  // 打开时自动聚焦查找框
  useEffect(() => {
    if (open) {
      findInputRef.current?.focus()
      findInputRef.current?.select()
    }
  }, [open])

  if (!open) return null

  const hasMatch = matchCount > 0
  // 显示 N / M;无匹配时 0 / 0
  const countText = hasMatch ? `${activeIndex + 1} / ${matchCount}` : (find ? '0 / 0' : '')

  const onFindKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) onPrev()
      else onNext()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose()
    }
  }

  const ghostBtn =
    'flex h-5 w-5 items-center justify-center rounded-btn text-ink-tertiary hover:bg-bg-hover hover:text-ink-primary disabled:opacity-30 disabled:hover:bg-transparent'
  const inputCls =
    'w-full rounded-btn border border-line bg-bg-surface px-2 py-0.5 text-caption text-ink-primary outline-none focus:border-accent placeholder:text-ink-tertiary'
  const smallBtn =
    'rounded-btn border border-line px-1.5 py-0.5 text-label text-ink-secondary hover:bg-bg-hover hover:text-ink-primary disabled:opacity-40'

  return (
    <div
      ref={rootRef}
      className="absolute right-3 top-3 z-30 flex w-[340px] flex-col rounded-card border border-line-strong bg-bg-surface shadow-float"
    >
      {/* 查找行 */}
      <div className="flex items-center gap-1 px-2 py-1.5">
        {canReplace && (
          <button
            onClick={() => setShowReplace(!showReplace)}
            className={ghostBtn}
            title={showReplace ? '隐藏替换' : '显示替换'}
          >
            <ChevronDownIcon
              size={12}
              className={showReplace ? '' : '-rotate-90'}
            />
          </button>
        )}
        <input
          ref={findInputRef}
          data-findbar-input
          value={find}
          onChange={(e) => setFind(e.target.value)}
          onKeyDown={onFindKeyDown}
          placeholder="查找"
          spellCheck={false}
          className={inputCls}
        />
        <span className="min-w-[44px] text-right text-label text-ink-tertiary" style={!hasMatch && find ? { color: '#d65a5a' } : undefined}>
          {countText}
        </span>
        <button onClick={onPrev} disabled={!hasMatch} className={ghostBtn} title="上一个 (Shift+Enter)">
          <ChevronUpIcon size={12} />
        </button>
        <button onClick={onNext} disabled={!hasMatch} className={ghostBtn} title="下一个 (Enter)">
          <ChevronDownIcon size={12} />
        </button>
        <button onClick={onClose} className={ghostBtn} title="关闭 (Esc)">
          <CloseIcon size={12} />
        </button>
      </div>

      {/* 替换行(可折叠,仅 canReplace) */}
      {canReplace && showReplace && (
        <div className="flex items-center gap-1 border-t border-line px-2 py-1.5">
          <input
            value={replace}
            onChange={(e) => setReplace(e.target.value)}
            placeholder="替换为"
            spellCheck={false}
            className={inputCls}
          />
          <button onClick={onReplaceNext} disabled={!hasMatch} className={smallBtn} title="替换当前并跳到下一个">
            替换
          </button>
          <button onClick={onReplaceAll} disabled={!hasMatch} className={smallBtn} title="替换全部">
            全部替换
          </button>
        </div>
      )}
    </div>
  )
}
