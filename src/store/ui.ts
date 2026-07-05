import { create } from 'zustand'
import type { ToolCategoryId } from '@/components/tools/catalog'

interface UIState {
  /** 标签页侧栏是否收起 */
  tabSidebarCollapsed: boolean
  /** 收藏夹悬浮窗是否打开 */
  favoritesOpen: boolean
  /** 当前选中的工具分类(图标栏高亮) */
  activeCategory: ToolCategoryId | null
  /** 收藏夹悬浮窗位置/尺寸(持久在 localStorage) */
  favoritesRect: { x: number; y: number; w: number; h: number }

  toggleTabSidebar: () => void
  toggleFavorites: () => void
  setFavoritesOpen: (open: boolean) => void
  setActiveCategory: (id: ToolCategoryId | null) => void
  setFavoritesRect: (rect: Partial<{ x: number; y: number; w: number; h: number }>) => void
}

const savedRect = (() => {
  try {
    const s = localStorage.getItem('devtoolbox:favoritesRect')
    if (s) return JSON.parse(s)
  } catch {
    /* ignore */
  }
  return { x: 0, y: 0, w: 260, h: 360 }
})()

export const useUIStore = create<UIState>((set, get) => ({
  tabSidebarCollapsed: false,
  favoritesOpen: false,
  activeCategory: null,
  favoritesRect: savedRect,

  toggleTabSidebar: () => set((s) => ({ tabSidebarCollapsed: !s.tabSidebarCollapsed })),
  toggleFavorites: () => set((s) => ({ favoritesOpen: !s.favoritesOpen })),
  setFavoritesOpen: (open) => set({ favoritesOpen: open }),
  setActiveCategory: (id) => set({ activeCategory: id }),
  setFavoritesRect: (rect) => {
    const next = { ...get().favoritesRect, ...rect }
    try {
      localStorage.setItem('devtoolbox:favoritesRect', JSON.stringify(next))
    } catch {
      /* ignore */
    }
    set({ favoritesRect: next })
  },
}))
