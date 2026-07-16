// 工具类型目录:定义所有工具类型、分组、图标
// 图标用简洁的 SVG 或字符,避免花哨 emoji

import type { ComponentType } from 'react'
import type { ToolProps } from './shared'

export type ToolCategoryId =
  | 'json'
  | 'encode'
  | 'crypto'
  | 'time'
  | 'codegen'
  | 'text'
  | 'network'
  | 'ai'

export interface ToolCategory {
  id: ToolCategoryId
  name: string
  icon: string
}

export interface ToolDef {
  id: string
  categoryId: ToolCategoryId
  name: string
  loader: () => Promise<{ default: ComponentType<ToolProps> }>
}

export const CATEGORIES: ToolCategory[] = [
  { id: 'json', name: 'JSON', icon: 'json' },
  { id: 'encode', name: '编码转换', icon: 'encode' },
  { id: 'crypto', name: '加密哈希', icon: 'crypto' },
  { id: 'time', name: '时间日期', icon: 'time' },
  { id: 'codegen', name: '代码生成', icon: 'codegen' },
  { id: 'text', name: '文本处理', icon: 'text' },
  { id: 'network', name: '网络工具', icon: 'network' },
  { id: 'ai', name: 'AI 工具', icon: 'ai' },
]

export const TOOLS: ToolDef[] = [
  {
    id: 'diagram-manager',
    categoryId: 'ai',
    name: '图纸管理',
    loader: () => import('@/components/tools/diagram-manager'),
  },
  {
    id: 'ai-drawio',
    categoryId: 'ai',
    name: 'AI 画图',
    loader: () => import('@/components/tools/ai-drawio'),
  },
  // JSON
  {
    id: 'json-workbench',
    categoryId: 'json',
    name: 'JSON 工作台',
    loader: () => import('@/components/tools/json-workbench'),
  },
  {
    id: 'json-format',
    categoryId: 'json',
    name: 'JSON 格式化',
    loader: () => import('@/components/tools/json-format'),
  },
  // 编码转换
  {
    id: 'base64',
    categoryId: 'encode',
    name: 'Base64',
    loader: () => import('@/components/tools/base64'),
  },
  {
    id: 'url-codec',
    categoryId: 'encode',
    name: 'URL 编解码',
    loader: () => import('@/components/tools/url-codec'),
  },
  {
    id: 'unicode-codec',
    categoryId: 'encode',
    name: 'Unicode 编解码',
    loader: () => import('@/components/tools/unicode-codec'),
  },
  {
    id: 'html-entity',
    categoryId: 'encode',
    name: 'HTML 实体',
    loader: () => import('@/components/tools/html-entity'),
  },
  // 加密哈希
  {
    id: 'hash',
    categoryId: 'crypto',
    name: 'MD5 / SHA / HMAC',
    loader: () => import('@/components/tools/hash'),
  },
  {
    id: 'aes',
    categoryId: 'crypto',
    name: 'AES 加解密',
    loader: () => import('@/components/tools/aes'),
  },
  // 时间
  {
    id: 'timestamp',
    categoryId: 'time',
    name: '时间戳 ⇄ 日期',
    loader: () => import('@/components/tools/timestamp'),
  },
  // 代码生成
  {
    id: 'json-to-pojo',
    categoryId: 'codegen',
    name: 'JSON → Java POJO',
    loader: () => import('@/components/tools/json-to-pojo'),
  },
]

export function getTool(id: string): ToolDef | undefined {
  return TOOLS.find((t) => t.id === id)
}

export function getCategory(id: ToolCategoryId): ToolCategory | undefined {
  return CATEGORIES.find((c) => c.id === id)
}
