import { create } from 'zustand'
import type {
  DiagramChangedEvent,
  DiagramDocument,
  DiagramMetadata,
  DiagramSource,
} from '../../electron/diagram-types'

interface DiagramState {
  items: DiagramMetadata[]
  loaded: boolean
  error: string | null
  refresh: () => Promise<void>
  bindEvents: () => () => void
  createDiagram: (title?: string, source?: DiagramSource, sourceClient?: string) => Promise<DiagramDocument>
  duplicateDiagram: (id: string, title?: string) => Promise<DiagramDocument>
  renameDiagram: (id: string, title: string) => Promise<DiagramDocument>
  setFavorite: (id: string, favorite: boolean) => Promise<DiagramDocument>
  deleteDiagram: (id: string) => Promise<boolean>
}

function metadata(document: DiagramDocument): DiagramMetadata {
  const { xml: _xml, ...item } = document
  void _xml
  return item
}

function upsert(items: DiagramMetadata[], document: DiagramDocument): DiagramMetadata[] {
  const next = metadata(document)
  return [next, ...items.filter((item) => item.id !== document.id)]
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export const useDiagramStore = create<DiagramState>((set, get) => ({
  items: [],
  loaded: false,
  error: null,

  refresh: async () => {
    try {
      const result = await window.raintool.listDiagrams({ limit: 200 })
      set({ items: result.items, loaded: true, error: null })
    } catch (error) {
      set({ loaded: true, error: error instanceof Error ? error.message : String(error) })
    }
  },

  bindEvents: () => {
    const offChanged = window.raintool.onDiagramChanged((event: DiagramChangedEvent) => {
      set((state) => ({ items: upsert(state.items, event.document), error: null }))
    })
    const offDeleted = window.raintool.onDiagramDeleted(({ id }) => {
      set((state) => ({ items: state.items.filter((item) => item.id !== id) }))
    })
    void get().refresh()
    return () => {
      offChanged()
      offDeleted()
    }
  },

  createDiagram: async (title, source = 'raintool', sourceClient) => {
    const document = await window.raintool.createDiagram({ title, source, sourceClient })
    set((state) => ({ items: upsert(state.items, document) }))
    return document
  },

  duplicateDiagram: async (id, title) => {
    const document = await window.raintool.duplicateDiagram({ id, title })
    set((state) => ({ items: upsert(state.items, document) }))
    return document
  },

  renameDiagram: async (id, title) => {
    const current = await window.raintool.getDiagram(id)
    if (!current) throw new Error('图纸不存在')
    const result = await window.raintool.updateDiagram({
      id,
      title,
      expectedRevision: current.revision,
    })
    const document = result.document
    set((state) => ({ items: upsert(state.items, document) }))
    return document
  },

  setFavorite: async (id, favorite) => {
    const current = await window.raintool.getDiagram(id)
    if (!current) throw new Error('图纸不存在')
    const result = await window.raintool.updateDiagram({
      id,
      favorite,
      expectedRevision: current.revision,
    })
    const document = result.document
    set((state) => ({ items: upsert(state.items, document) }))
    return document
  },

  deleteDiagram: async (id) => {
    const deleted = await window.raintool.deleteDiagram(id)
    if (deleted) set((state) => ({ items: state.items.filter((item) => item.id !== id) }))
    return deleted
  },
}))
