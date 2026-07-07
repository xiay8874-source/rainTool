import { create } from 'zustand'

// ============ 截图记录 ============

export interface ScreenshotRecord {
  id: string
  name: string
  createdAt: number
  source: 'fullscreen' | 'region' | 'window'
  primary: string   // ~/raintool/tabs/screenshots/<id>.png
  thumb: string     // ~/raintool/tabs/screenshots/<id>.thumb.png
  layers: string | null  // ~/raintool/tabs/screenshots/<id>.json,null = 未编辑
  width: number
  height: number
}

interface ScreenshotState {
  records: ScreenshotRecord[]
  persist: () => Promise<void>
  flush: () => Promise<void>
  hydrate: () => Promise<void>

  addRecord: (rec: ScreenshotRecord) => void
  removeRecord: (id: string) => void
  renameRecord: (id: string, name: string) => void
  updateRecord: (id: string, patch: Partial<ScreenshotRecord>) => void
}

const STORE_KEY = 'screenshots'

export const useScreenshotStore = create<ScreenshotState>((set, get) => ({
  records: [],

  addRecord: (rec) => {
    set((s) => ({ records: [rec, ...s.records] }))
    get().persist()
  },

  removeRecord: (id) => {
    set((s) => ({ records: s.records.filter((r) => r.id !== id) }))
    get().persist()
  },

  renameRecord: (id, name) => {
    set((s) => ({
      records: s.records.map((r) => (r.id === id ? { ...r, name } : r)),
    }))
    get().persist()
  },

  updateRecord: (id, patch) => {
    set((s) => ({
      records: s.records.map((r) => (r.id === id ? { ...r, ...patch } : r)),
    }))
    get().persist()
  },

  persist: async () => {
    const { records } = get()
    try {
      if (window.raintool?.storeSet) {
        // 只存路径和元数据,不存图片二进制
        await window.raintool.storeSet(STORE_KEY, { records })
      } else {
        localStorage.setItem('raintool:screenshots', JSON.stringify({ records }))
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
      let data: { records?: ScreenshotRecord[] } | null = null
      if (window.raintool?.storeGet) {
        data = (await window.raintool.storeGet(STORE_KEY)) as typeof data
      } else {
        const s = localStorage.getItem('raintool:screenshots')
        data = s ? JSON.parse(s) : null
      }
      if (data?.records) {
        set({ records: data.records })
      }
    } catch {
      /* ignore */
    }
  },
}))
