import { create } from 'zustand'
import type { Tab, TabGroup } from './tabs'

// ============ 类型 ============

/** 单个标签的收藏快照 */
export interface FavoriteTab {
  toolId: string
  title: string
  input: string
  config?: string
  diagramId?: string
}

/** 分组收藏快照(含分组结构) */
export interface FavoriteGroup {
  name: string
  tabs: FavoriteTab[]
}

export interface FavoriteItem {
  id: string
  /** 'tab' 单标签 | 'group' 整组 */
  kind: 'tab' | 'group'
  /** 收藏名 */
  name: string
  /** 收藏时间 */
  createdAt: number
  /** 单标签时填充 */
  tab?: FavoriteTab
  /** 整组时填充 */
  group?: FavoriteGroup
  /** 收藏夹内所属分组(独立于标签页分组) */
  folderId: string | null
}

/** 收藏夹内的分组(整理用,与标签页分组无关) */
export interface FavoriteFolder {
  id: string
  name: string
  order: number
}

interface FavoritesState {
  items: FavoriteItem[]
  folders: FavoriteFolder[]

  addTab: (name: string, tab: FavoriteTab, folderId?: string | null) => void
  addGroup: (name: string, group: FavoriteGroup, folderId?: string | null) => void
  remove: (id: string) => void
  rename: (id: string, name: string) => void
  moveToFolder: (id: string, folderId: string | null) => void

  createFolder: (name: string) => void
  renameFolder: (id: string, name: string) => void
  deleteFolder: (id: string) => void

  /** 恢复:返回要打开的标签与分组信息,由调用方操作 tabs store */
  restoreTab: (id: string) => FavoriteTab | null
  restoreGroup: (id: string) => FavoriteGroup | null

  /** 持久化到 ~/raintool/favorites.json */
  persist: () => Promise<void>
  /** 退出前立即保存(供 onFlush 调用) */
  flush: () => Promise<void>
  /** 从 ~/raintool/favorites.json 加载 */
  hydrate: () => Promise<void>
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const STORE_KEY = 'favorites'

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  items: [],
  folders: [],

  addTab: (name, tab, folderId = null) => {
    set((s) => {
      const existing = tab.diagramId
        ? s.items.find((item) => item.kind === 'tab' && item.tab?.diagramId === tab.diagramId)
        : undefined
      const item: FavoriteItem = {
        id: existing?.id ?? uid(),
        kind: 'tab',
        name,
        tab,
        createdAt: existing?.createdAt ?? Date.now(),
        folderId,
      }
      return { items: [item, ...s.items.filter((candidate) => candidate.id !== item.id)] }
    })
    if (tab.diagramId) void window.raintool?.updateDiagram({ id: tab.diagramId, favorite: true })
    get().persist()
  },

  addGroup: (name, group, folderId = null) => {
    set((s) => ({
      items: [
        { id: uid(), kind: 'group', name, group, createdAt: Date.now(), folderId },
        ...s.items,
      ],
    }))
    get().persist()
  },

  remove: (id) => {
    const item = get().items.find((candidate) => candidate.id === id)
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
    if (item?.tab?.diagramId) {
      void window.raintool?.updateDiagram({ id: item.tab.diagramId, favorite: false })
    }
    get().persist()
  },

  rename: (id, name) => {
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, name } : i)) }))
    get().persist()
  },

  moveToFolder: (id, folderId) => {
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, folderId } : i)) }))
    get().persist()
  },

  createFolder: (name) => {
    set((s) => ({ folders: [...s.folders, { id: uid(), name, order: s.folders.length }] }))
    get().persist()
  },

  renameFolder: (id, name) => {
    set((s) => ({ folders: s.folders.map((f) => (f.id === id ? { ...f, name } : f)) }))
    get().persist()
  },

  deleteFolder: (id) => {
    set((s) => ({
      folders: s.folders.filter((f) => f.id !== id),
      items: s.items.map((i) => (i.folderId === id ? { ...i, folderId: null } : i)),
    }))
    get().persist()
  },

  restoreTab: (id) => get().items.find((i) => i.id === id)?.tab ?? null,

  restoreGroup: (id) => get().items.find((i) => i.id === id)?.group ?? null,

  persist: async () => {
    const { items, folders } = get()
    try {
      if (window.raintool?.storeSet) {
        await window.raintool.storeSet(STORE_KEY, { items, folders })
      } else {
        // 浏览器降级
        localStorage.setItem('raintool:favorites', JSON.stringify({ items, folders }))
      }
    } catch {
      /* ignore */
    }
  },

  flush: async () => {
    await get().persist()
  },

  hydrate: async () => {
    try {
      let data: { items?: FavoriteItem[]; folders?: FavoriteFolder[] } | null = null
      if (window.raintool?.storeGet) {
        data = (await window.raintool.storeGet(STORE_KEY)) as typeof data
      } else {
        const s = localStorage.getItem('raintool:favorites')
        data = s ? JSON.parse(s) : null
      }
      if (data) {
        set({ items: data.items ?? [], folders: data.folders ?? [] })
      }
    } catch {
      /* ignore */
    }
  },
}))

// helper:从当前 tabs store 构建收藏快照
export function snapshotTab(tab: Tab) {
  return {
    toolId: tab.toolId,
    title: tab.title,
    input: tab.state.input,
    config: tab.state.config,
    diagramId: tab.state.diagramId,
  } as FavoriteTab
}

export function snapshotGroup(group: TabGroup, tabs: Tab[]): FavoriteGroup {
  return {
    name: group.name,
    tabs: tabs.filter((t) => t.groupId === group.id).map(snapshotTab),
  }
}
