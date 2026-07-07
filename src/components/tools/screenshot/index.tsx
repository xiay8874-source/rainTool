import type { ToolProps } from '../shared'
import { Gallery } from './Gallery'
import { Editor } from './Editor'
import { useState } from 'react'

export default function ScreenshotTool(_props: ToolProps) {
  const [editingTabId, setEditingTabId] = useState<string | null>(null)

  if (editingTabId) {
    return <Editor tabId={editingTabId} onBack={() => setEditingTabId(null)} />
  }

  return <Gallery onEdit={(id) => setEditingTabId(id)} />
}
