import { create } from 'zustand'

// ============ 类型 ============

export interface TabState {
  /** 标签页持有的工具输入内容(字符串,由各工具自行解释) */
  input: string
  /** 工具自定义配置(JSON 字符串) */
  config?: string
  /** 是否固定 */
  pinned?: boolean
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

  // 标签操作
  openTab: (toolId: string, title?: string, groupId?: string | null) => string
  closeTab: (id: string) => void
  renameTab: (id: string, title: string) => void
  duplicateTab: (id: string) => string
  setActiveTab: (id: string) => void
  setTabInput: (id: string, input: string) => void
  setTabConfig: (id: string, config: string) => void
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
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

export const useAppStore = create<AppState>((set, get) => ({
  tabs: [],
  groups: [],
  activeTabId: null,

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
    return id
  },

  closeTab: (id) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.id !== id)
      const activeTabId =
        s.activeTabId === id ? (tabs.length ? tabs[tabs.length - 1].id : null) : s.activeTabId
      return { tabs, activeTabId }
    }),

  renameTab: (id, title) =>
    set((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, title } : t)) })),

  duplicateTab: (id) => {
    const src = get().tabs.find((t) => t.id === id)
    if (!src) return id
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
    return newId
  },

  setActiveTab: (id) => set({ activeTabId: id }),

  setTabInput: (id, input) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, state: { ...t.state, input } } : t)),
    })),

  setTabConfig: (id, config) =>
    set((s) => ({
      tabs: s.tabs.map((t) => (t.id === id ? { ...t, state: { ...t.state, config } } : t)),
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

  closeGroupTabs: (id) =>
    set((s) => {
      const tabIds = s.tabs.filter((t) => t.groupId === id).map((t) => t.id)
      const tabs = s.tabs.filter((t) => t.groupId !== id)
      const activeTabId = tabIds.includes(s.activeTabId ?? '')
        ? tabs.length
          ? tabs[tabs.length - 1].id
          : null
        : s.activeTabId
      return { tabs, activeTabId }
    }),
}))
