import { create } from 'zustand'

// ============ 类型 ============

export interface TabState {
  /** 标签页持有的工具输入内容(字符串,由各工具自行解释) */
  input: string
  /** 对比模式左侧(独立于树形 input,仅 json-workbench 用,持久化) */
  diffLeft?: string
  /** 对比模式右侧 */
  diffRight?: string
  /** 工具自定义配置(JSON 字符串) */
  config?: string
  /** 是否固定 */
  pinned?: boolean
  /** AI Draw.io 绑定的持久化图纸 ID */
  diagramId?: string
}

export interface Tab {
  id: string
  /** 工具 id(对应 catalog) */
  toolId: string
  /** 显示名(可重命名) */
  title: string
  /** 所属分组 id;无分组为 null */
  groupId: string | null
  /** 标签状态 */
  state: TabState
  /** 创建时间 */
  createdAt: number
}

/** 分组颜色(莫兰迪,对应 tailwind group-1..6) */
export type GroupColor = 1 | 2 | 3 | 4 | 5 | 6

export interface TabGroup {
  id: string
  name: string
  color: GroupColor
  /** 自定义分组为 true;自动按工具类型分组为 false */
  custom: boolean
  /** 排序序号 */
  order: number
}

// ============ Store ============

interface AppState {
  tabs: Tab[]
  groups: TabGroup[]
  activeTabId: string | null

  // 标签导航历史(浏览器式前进/后退)
  // history 存 tab id(或 null 表示 EmptyState),historyIndex 指向当前位置
  history: (string | null)[]
  historyIndex: number
  canGoBack: () => boolean
  canGoForward: () => boolean
  goBack: () => void
  goForward: () => void

  // 标签操作
  openTab: (toolId: string, title?: string, groupId?: string | null) => string
  openDiagramTab: (diagramId: string, title?: string, groupId?: string | null) => string
  closeTab: (id: string) => void
  renameTab: (id: string, title: string) => void
  duplicateTab: (id: string) => Promise<string>
  setActiveTab: (id: string | null) => void
  setTabInput: (id: string, input: string) => void
  setTabDiffLeft: (id: string, v: string) => void
  setTabDiffRight: (id: string, v: string) => void
  setTabConfig: (id: string, config: string) => void
  setTabDiagramId: (id: string, diagramId: string, title?: string) => void
  togglePin: (id: string) => void
  moveTabToGroup: (id: string, groupId: string | null) => void
  reorderTab: (id: string, toIndex: number) => void

  // 分组操作
  createGroup: (name: string, color?: GroupColor, custom?: boolean) => string
  renameGroup: (id: string, name: string) => void
  setGroupColor: (id: string, color: GroupColor) => void
  deleteGroup: (id: string) => void // 标签落入未分组
  reorderGroup: (id: string, toIndex: number) => void
  /** 解散组(保留标签,落入未分组) */
  ungroup: (id: string) => void
  /** 关闭组内所有标签 */
  closeGroupTabs: (id: string) => void

  // 持久化:重启后恢复完整工作区
  persist: () => Promise<void>
  /** 退出前立即保存(取消防抖,await persist)。供 onFlush 调用 */
  flush: () => Promise<void>
  hydrate: () => Promise<void>
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

export const useAppStore = create<AppState>((set, get) => {
  // 导航历史内部辅助:记录一次"前进栈被截断"的跳转
  // isNav=true 表示是 goBack/goForward 触发的切换,只移动指针不新建条目
  const pushHistory = (id: string | null, isNav = false) => {
    set((s) => {
      if (isNav) return {} // goBack/goForward 自行处理指针
      // 截断当前位置之后的前进栈,再追加新条目
      const truncated = s.history.slice(0, s.historyIndex + 1)
      // 跳过连续重复(同一标签连续点击不产生冗余条目)
      if (truncated[truncated.length - 1] === id) return {}
      truncated.push(id)
      return { history: truncated, historyIndex: truncated.length - 1 }
    })
  }

  return {
    tabs: [],
    groups: [],
    activeTabId: null,
    history: [null],
    historyIndex: 0,

    canGoBack: () => get().historyIndex > 0,
    canGoForward: () => get().historyIndex < get().history.length - 1,

    goBack: () => {
      const { history, historyIndex, tabs } = get()
      if (historyIndex <= 0) return
      const newIdx = historyIndex - 1
      let target = history[newIdx]
      // 已关闭的标签从历史中清除,跳过
      if (target !== null && !tabs.some((t) => t.id === target)) {
        set({ history: history.filter((h) => h !== target), historyIndex: newIdx })
        // 递归重试(过滤后索引可能变化)
        get().goBack()
        return
      }
      set({ activeTabId: target, historyIndex: newIdx })
    },

    goForward: () => {
      const { history, historyIndex, tabs } = get()
      if (historyIndex >= history.length - 1) return
      const newIdx = historyIndex + 1
      let target = history[newIdx]
      if (target !== null && !tabs.some((t) => t.id === target)) {
        set({ history: history.filter((h) => h !== target), historyIndex: newIdx - 1 })
        get().goForward()
        return
      }
      set({ activeTabId: target, historyIndex: newIdx })
    },

    openTab: (toolId, title, groupId = null) => {
      const id = uid()
      const tab: Tab = {
        id,
        toolId,
        title: title ?? '',
        groupId,
        state: { input: '' },
        createdAt: Date.now(),
      }
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
      pushHistory(id)
      return id
    },

    openDiagramTab: (diagramId, title, groupId = null) => {
      const existing = get().tabs.find(
        (tab) => tab.toolId === 'ai-drawio' && tab.state.diagramId === diagramId,
      )
      if (existing) {
        set({ activeTabId: existing.id })
        pushHistory(existing.id)
        return existing.id
      }
      const id = uid()
      const tab: Tab = {
        id,
        toolId: 'ai-drawio',
        title: title ?? 'AI 画图',
        groupId,
        state: { input: '', diagramId },
        createdAt: Date.now(),
      }
      set((s) => ({ tabs: [...s.tabs, tab], activeTabId: id }))
      pushHistory(id)
      return id
    },

    closeTab: (id) => {
      set((s) => {
        const tabs = s.tabs.filter((t) => t.id !== id)
        const wasActive = s.activeTabId === id
        const activeTabId = wasActive
          ? tabs.length
            ? tabs[tabs.length - 1].id
            : null
          : s.activeTabId
        // 从历史栈中移除已关闭标签的引用,重算 index
        const history = s.history.filter((h) => h !== id)
        const historyIndex = Math.min(s.historyIndex, history.length - 1)
        return { tabs, activeTabId, history, historyIndex }
      })
      // 若关的是活动标签,补录新的活动标签到历史
      const s = get()
      if (s.activeTabId !== id) pushHistory(s.activeTabId)
    },

    renameTab: (id, title) =>
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),

    duplicateTab: async (id) => {
      const src = get().tabs.find((t) => t.id === id)
      if (!src) return id
      if (src.toolId === 'ai-drawio') {
        const document = src.state.diagramId
          ? await window.raintool.duplicateDiagram({ id: src.state.diagramId })
          : await window.raintool.createDiagram({ title: `${src.title || 'AI 画图'} 副本` })
        const newId = uid()
        const copy: Tab = {
          ...src,
          id: newId,
          title: document.title,
          state: { ...src.state, diagramId: document.id },
          createdAt: Date.now(),
        }
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id)
          const tabs = [...s.tabs]
          tabs.splice(idx + 1, 0, copy)
          return { tabs, activeTabId: newId }
        })
        pushHistory(newId)
        return newId
      }
      const newId = uid()
      const copy: Tab = {
        ...src,
        id: newId,
        title: src.title + ' 副本',
        state: { ...src.state },
        createdAt: Date.now(),
      }
      // 插入到原标签后面
      set((s) => {
        const idx = s.tabs.findIndex((t) => t.id === id)
        const tabs = [...s.tabs]
        tabs.splice(idx + 1, 0, copy)
        return { tabs, activeTabId: newId }
      })
      pushHistory(newId)
      return newId
    },

    setActiveTab: (id) => {
      const cur = get().activeTabId
      if (cur === id) return
      set({ activeTabId: id })
      pushHistory(id)
    },

  setTabInput: (id, input) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, state: { ...t.state, input } } : t)),
    })),

  setTabDiffLeft: (id, v) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, state: { ...t.state, diffLeft: v } } : t)),
    })),

  setTabDiffRight: (id, v) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, state: { ...t.state, diffRight: v } } : t)),
    })),

  setTabConfig: (id, config) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, state: { ...t.state, config } } : t)),
    })),

  setTabDiagramId: (id, diagramId, title) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id
          ? { ...t, title: title ?? t.title, state: { ...t.state, diagramId } }
          : t,
      ),
    })),

  togglePin: (id) =>
    set((s) => ({
      tabs: s.tabs.map((t) =>
        t.id === id ? { ...t, state: { ...t.state, pinned: !t.state.pinned } } : t,
      ),
    })),

  moveTabToGroup: (id, groupId) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, groupId } : t)) })),

  reorderTab: (id, toIndex) =>
    set((s) => {
      const tabs = [...s.tabs]
      const from = tabs.findIndex((t) => t.id === id)
      if (from < 0) return s
      const [moved] = tabs.splice(from, 1)
      tabs.splice(toIndex, 0, moved)
      return { tabs }
    }),

  createGroup: (name, color = 1, custom = true) => {
    const id = uid()
    const order = get().groups.length
    set((s) => ({ groups: [...s.groups, { id, name, color, custom, order }] }))
    return id
  },

  renameGroup: (id, name) =>
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, name } : g)) })),

  setGroupColor: (id, color) =>
    set((s) => ({ groups: s.groups.map((g) => (g.id === id ? { ...g, color } : g)) })),

  deleteGroup: (id) =>
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      tabs: s.tabs.map((t) => (t.groupId === id ? { ...t, groupId: null } : t)),
    })),

  reorderGroup: (id, toIndex) =>
    set((s) => {
      const groups = [...s.groups].sort((a, b) => a.order - b.order)
      const from = groups.findIndex((g) => g.id === id)
      if (from < 0) return s
      const [moved] = groups.splice(from, 1)
      groups.splice(toIndex, 0, moved)
      return { groups: groups.map((g, i) => ({ ...g, order: i })) }
    }),

  ungroup: (id) =>
    set((s) => ({
      groups: s.groups.filter((g) => g.id !== id),
      tabs: s.tabs.map((t) => (t.groupId === id ? { ...t, groupId: null } : t)),
    })),

  closeGroupTabs: (id) => {
    const tabIds = get().tabs.filter((t) => t.groupId === id).map((t) => t.id)
    set((s) => {
      const tabs = s.tabs.filter((t) => t.groupId !== id)
      const activeTabId = tabIds.includes(s.activeTabId ?? '')
        ? tabs.length
          ? tabs[tabs.length - 1].id
          : null
        : s.activeTabId
      // 从历史中移除被关闭的标签
      const history = s.history.filter((h) => h === null || !tabIds.includes(h))
      const historyIndex = Math.min(s.historyIndex, history.length - 1)
      return { tabs, activeTabId, history, historyIndex }
    })
    const s = get()
    if (tabIds.includes(s.activeTabId ?? '')) pushHistory(s.activeTabId)
  },

  persist: async () => {
    const { tabs, groups, activeTabId } = get()
    const snapshot = { tabs, groups, activeTabId, version: 3 }
    try {
      if (window.raintool?.storeSet) {
        await window.raintool.storeSet('workspace', snapshot)
      } else {
        localStorage.setItem('raintool:workspace', JSON.stringify(snapshot))
      }
    } catch {
      /* ignore */
    }
  },

  flush: async () => {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    await get().persist()
  },

  hydrate: async () => {
    try {
      let data: { tabs?: Tab[]; groups?: TabGroup[]; activeTabId?: string | null } | null = null
      if (window.raintool?.storeGet) {
        data = (await window.raintool.storeGet('workspace')) as typeof data
      } else {
        const s = localStorage.getItem('raintool:workspace')
        data = s ? JSON.parse(s) : null
      }
      if (data && (data.tabs?.length || data.groups?.length)) {
        const tabs = data.tabs ?? []
        const activeTabId =
          data.activeTabId && tabs.some((t) => t.id === data!.activeTabId)
            ? data.activeTabId
            : (tabs[0]?.id ?? null)
        set({
          tabs,
          groups: data.groups ?? [],
          activeTabId,
          // 恢复后历史从当前活动标签开始
          history: [activeTabId],
          historyIndex: 0,
        })
      }
    } catch {
      /* ignore */
    }
  },
  }
})

// 自动持久化:任何状态变化都触发防抖保存(300ms)
let persistTimer: ReturnType<typeof setTimeout> | null = null
useAppStore.subscribe(() => {
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    useAppStore.getState().persist()
  }, 300)
})
