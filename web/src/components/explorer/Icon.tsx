import type { ReactNode } from 'react'

// 윈도우 11 Fluent 스타일의 자체 제작 라인 아이콘 (SVG).
// 마이크로소프트의 독점 Windows .ico/Segoe Fluent 글꼴을 배포하지 않기 위해 직접 그린 아이콘을 쓴다.
export type IconName =
  | 'back' | 'forward' | 'up' | 'refresh'
  | 'new-folder' | 'cut' | 'copy' | 'paste' | 'rename' | 'download' | 'delete'
  | 'sort' | 'view-grid' | 'view-details' | 'terminal' | 'upload' | 'search'
  | 'folder' | 'file' | 'video' | 'pc' | 'drive' | 'star' | 'chevron' | 'close' | 'plus'

interface Props {
  name: IconName
  size?: number
  className?: string
}

// 선(line) 아이콘: currentColor 스트로크
const LINE: Partial<Record<IconName, ReactNode>> = {
  back: <path d="M14 6l-6 6 6 6" />,
  forward: <path d="M10 6l6 6-6 6" />,
  up: <><path d="M12 19V6" /><path d="M6 11l6-6 6 6" /></>,
  refresh: <><path d="M19 12a7 7 0 1 1-2-4.9" /><path d="M19 4v4h-4" /></>,
  'new-folder': <><path d="M3 8a2 2 0 0 1 2-2h3l2 2h9a1 1 0 0 1 1 1v2" /><path d="M3 8v9a2 2 0 0 0 2 2h7" /><path d="M17 15v6M14 18h6" /></>,
  cut: <><circle cx="6" cy="7" r="2.5" /><circle cx="6" cy="17" r="2.5" /><path d="M8 8.5L20 18M8 15.5L20 6" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h8" /></>,
  paste: <><rect x="6" y="5" width="12" height="16" rx="2" /><path d="M9 5V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1" /></>,
  rename: <><path d="M4 20h16" /><path d="M14.5 5.5l4 4L9 19l-4 1 1-4z" /></>,
  download: <><path d="M12 4v11" /><path d="M8 11l4 4 4-4" /><path d="M5 20h14" /></>,
  delete: <><path d="M4 7h16" /><path d="M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /><path d="M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13" /><path d="M10 11v6M14 11v6" /></>,
  sort: <><path d="M7 5v14" /><path d="M4 8l3-3 3 3" /><path d="M13 8h7M13 12h5M13 16h3" /></>,
  'view-grid': <><rect x="4" y="4" width="7" height="7" rx="1" /><rect x="13" y="4" width="7" height="7" rx="1" /><rect x="4" y="13" width="7" height="7" rx="1" /><rect x="13" y="13" width="7" height="7" rx="1" /></>,
  'view-details': <><path d="M8 6h12M8 12h12M8 18h12" /><path d="M4 6h.01M4 12h.01M4 18h.01" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9l3 3-3 3M13 15h4" /></>,
  upload: <><path d="M12 20V9" /><path d="M8 13l4-4 4 4" /><path d="M5 4h14" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></>,
  file: <><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" /><path d="M13 3v6h6" /></>,
  pc: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  drive: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 12h.01" /><path d="M3 12h12" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
}

export function Icon({ name, size = 16, className }: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    className,
    'aria-hidden': true,
    focusable: false as const,
  }

  // 채움(fill) 아이콘: 폴더(노란색), 별(노란색), 비디오
  if (name === 'folder') {
    return (
      <svg {...common} fill="none">
        <path d="M3 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.4.6L11 7h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="#e8b23a" stroke="#c8922a" strokeWidth="1" strokeLinejoin="round" />
      </svg>
    )
  }
  if (name === 'star') {
    return (
      <svg {...common} fill="none">
        <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8L3.5 9.7l5.9-.9z" fill="#f2b93b" stroke="#d99e28" strokeWidth="1" strokeLinejoin="round" />
      </svg>
    )
  }
  if (name === 'video') {
    return (
      <svg {...common} fill="none">
        <rect x="3" y="6" width="18" height="12" rx="2" fill="#5b8def" stroke="#3f6fd0" strokeWidth="1" />
        <path d="M10 9.5v5l4-2.5z" fill="#fff" />
      </svg>
    )
  }

  return (
    <svg {...common} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {LINE[name]}
    </svg>
  )
}
