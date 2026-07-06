import type { ToolCategoryId } from './tools/catalog'

// 简洁线性图标,1.2px 描边,currentColor,无填充
// 风格:低对比、淡雅,与整体设计一致

interface IconProps {
  size?: number
  className?: string
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
})

export function CategoryIcon({ id, size = 18, className }: IconProps & { id: ToolCategoryId }) {
  switch (id) {
    case 'json':
      return (
        <svg {...base(size)} className={className}>
          <path d="M7 4C5 4 5 6 5 8c0 1.5-.5 2-1.5 2 1 0 1.5.5 1.5 2 0 2 0 4 2 4" />
          <path d="M17 4c2 0 2 2 2 4 0 1.5.5 2 1.5 2-1 0-1.5.5-1.5 2 0 2 0 4-2 4" />
        </svg>
      )
    case 'encode':
      return (
        <svg {...base(size)} className={className}>
          <path d="M4 8h4M4 12h6M4 16h4" />
          <path d="M14 9l4 3-4 3" />
          <path d="M18 12h2" />
        </svg>
      )
    case 'crypto':
      return (
        <svg {...base(size)} className={className}>
          <rect x="5" y="10" width="14" height="10" rx="1.5" />
          <path d="M8 10V7a4 4 0 0 1 8 0v3" />
        </svg>
      )
    case 'time':
      return (
        <svg {...base(size)} className={className}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 8v4l3 2" />
        </svg>
      )
    case 'codegen':
      return (
        <svg {...base(size)} className={className}>
          <path d="M9 8l-4 4 4 4" />
          <path d="M15 8l4 4-4 4" />
          <path d="M13 6l-2 12" />
        </svg>
      )
    case 'text':
      return (
        <svg {...base(size)} className={className}>
          <path d="M5 6h14M5 12h14M5 18h9" />
        </svg>
      )
    case 'network':
      return (
        <svg {...base(size)} className={className}>
          <circle cx="12" cy="12" r="3" />
          <path d="M5 12a7 7 0 0 1 14 0M2 12a10 10 0 0 1 20 0" />
        </svg>
      )
  }
}

export function StarIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 4l2.5 5 5.5.8-4 3.9 1 5.5L12 16.5 7 19.2l1-5.5-4-3.9 5.5-.8z" />
    </svg>
  )
}

export function PlusIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

export function CloseIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  )
}

export function ChevronRightIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  )
}

export function ChevronUpIcon({ size = 12, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M6 15l6-6 6 6" />
    </svg>
  )
}

export function CollapseIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  )
}

export function ExpandIcon({ size = 14, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

export function SettingsIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </svg>
  )
}

export function BackIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M15 6l-6 6 6 6" />
    </svg>
  )
}

export function ForwardIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M9 6l6 6-6 6" />
    </svg>
  )
}

export function DownloadIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size)} className={className}>
      <path d="M12 3v12" />
      <path d="M7 11l5 5 5-5" />
      <path d="M5 20h14" />
    </svg>
  )
}
