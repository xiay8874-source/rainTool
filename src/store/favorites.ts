import { create } from 'zustand'
import type { Tab, TabGroup } from './tabs'

// ============ 类型 ============

/** 单个标签的收藏快照 */
export interface FavoriteTab {
  toolId: string
  title: string
  input: string
  config?: string
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

  /** 持久化到 electron-store */
  persist: () => void
  /** 从 electron-store 加载 */
  hydrate: () => Promise<void>
}

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4)

const STORE_KEY = 'favorites'

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  items: [],
  folders: [],

  addTab: (name, tab, folderId = null) => {
    set((s) => ({
      items: [
        { id: uid(), kind: 'tab', name, tab, createdAt: Date.now(), folderId },
        ...s.items,
      ],
    }))
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
    set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
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

  persist: () => {
    const { items, folders } = get()
    try {
      const w = window as unknown as { raintool?: { storeSet: (k: string, v: unknown) => void } }
      if (w.raintool?.storeSet) {
        w.raintool.storeSet(STORE_KEY, { items, folders })
      } else {
        // 浏览器降级
        localStorage.setItem('raintool:favorites', JSON.stringify({ items, folders }))
      }
    } catch {
      /* ignore */
    }
  },

  hydrate: async () => {
    try {
      const w = window as unknown as {
        raintool?: { storeGet: (k: string) => Promise<unknown> }
      }
      let data: { items?: FavoriteItem[]; folders?: FavoriteFolder[] } | null = null
      if (w.raintool?.storeGet) {
        data = (await w.raintool.storeGet(STORE_KEY)) as typeof data
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
  } as FavoriteTab
}

export function snapshotGroup(group: TabGroup, tabs: Tab[]): FavoriteGroup {
  return {
    name: group.name,
    tabs: tabs.filter((t) => t.groupId === group.id).map(snapshotTab),
  }
}
