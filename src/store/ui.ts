import { create } from 'zustand'
import type { ToolCategoryId } from '@/components/tools/catalog'

interface UIState {
  /** 标签页侧栏是否收起 */
  tabSidebarCollapsed: boolean
  /** 收藏夹悬浮窗是否打开 */
  favoritesOpen: boolean
  /** 设置悬浮窗是否打开 */
  settingsOpen: boolean
  /** 当前选中的工具分类(图标栏高亮) */
  activeCategory: ToolCategoryId | null
  /** 收藏夹悬浮窗位置/尺寸(持久在 localStorage) */
  favoritesRect: { x: number; y: number; w: number; h: number }
  /** 是否检测到有新版本(设置图标红点提示) */
  hasUpdate: boolean
  /** 检测到的新版信息(供设置面板跨挂载展示 release notes)。null = 无更新或未检查 */
  updateInfo: { version: string; notes: string; publishedAt: string } | null

  toggleTabSidebar: () => void
  toggleFavorites: () => void
  setFavoritesOpen: (open: boolean) => void
  toggleSettings: () => void
  setSettingsOpen: (open: boolean) => void
  setActiveCategory: (id: ToolCategoryId | null) => void
  setFavoritesRect: (rect: Partial<{ x: number; y: number; w: number; h: number }>) => void
  setHasUpdate: (v: boolean) => void
  setUpdateInfo: (info: { version: string; notes: string; publishedAt: string } | null) => void
}

const savedRect = (() => {
  try {
    const s = localStorage.getItem('raintool:favoritesRect')
    if (s) return JSON.parse(s)
  } catch {
    /* ignore */
  }
  return { x: 0, y: 0, w: 260, h: 360 }
})()

export const useUIStore = create<UIState>((set, get) => ({
  tabSidebarCollapsed: false,
  favoritesOpen: false,
  settingsOpen: false,
  activeCategory: null,
  favoritesRect: savedRect,
  hasUpdate: false,
  updateInfo: null,

  toggleTabSidebar: () => set((s) => ({ tabSidebarCollapsed: !s.tabSidebarCollapsed })),
  toggleFavorites: () => set((s) => ({ favoritesOpen: !s.favoritesOpen })),
  setFavoritesOpen: (open) => set({ favoritesOpen: open }),
  toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setActiveCategory: (id) => set({ activeCategory: id }),
  setFavoritesRect: (rect) => {
    const next = { ...get().favoritesRect, ...rect }
    try {
      localStorage.setItem('raintool:favoritesRect', JSON.stringify(next))
    } catch {
      /* ignore */
    }
    set({ favoritesRect: next })
  },
  setHasUpdate: (v) => set({ hasUpdate: v }),
  setUpdateInfo: (info) => set({ updateInfo: info }),
}))
