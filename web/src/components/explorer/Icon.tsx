import type { ReactNode } from 'react'
import { fileKind, type FileKind } from '../../fileTypes'

// 윈도우 11 Fluent 스타일의 자체 제작 라인 아이콘 (SVG).
// 마이크로소프트의 독점 Windows .ico/Segoe Fluent 글꼴을 배포하지 않기 위해 직접 그린 아이콘을 쓴다.
export type IconName =
  | 'back' | 'forward' | 'up' | 'refresh'
  | 'new-folder' | 'cut' | 'copy' | 'paste' | 'rename' | 'download' | 'delete'
  | 'sort' | 'view-grid' | 'view-details' | 'terminal' | 'remote' | 'upload' | 'search'
  | 'folder' | 'file' | 'video' | 'pc' | 'drive' | 'star' | 'chevron' | 'close' | 'plus'
  // 원격조작 특수 키
  | 'keyboard' | 'three-keys' | 'alt-tab' | 'play' | 'lock' | 'chart' | 'close-window' | 'camera' | 'text' | 'fullscreen' | 'fullscreen-exit'

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
  remote: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /><path d="M10.5 7.5l4.5 2-2 .6-.6 2z" /></>,
  upload: <><path d="M12 20V9" /><path d="M8 13l4-4 4 4" /><path d="M5 4h14" /></>,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4-4" /></>,
  file: <><path d="M13 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V9z" /><path d="M13 3v6h6" /></>,
  pc: <><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></>,
  drive: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 12h.01" /><path d="M3 12h12" /></>,
  chevron: <path d="M9 6l6 6-6 6" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  keyboard: <><rect x="3" y="6" width="18" height="12" rx="2" /><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" /></>,
  'three-keys': <><rect x="2" y="9" width="5.5" height="6" rx="1" /><rect x="9.25" y="9" width="5.5" height="6" rx="1" /><rect x="16.5" y="9" width="5.5" height="6" rx="1" /></>,
  'alt-tab': <><rect x="3" y="8" width="12" height="10" rx="1.5" /><path d="M9 8V6.5A1.5 1.5 0 0 1 10.5 5h9A1.5 1.5 0 0 1 21 6.5v8a1.5 1.5 0 0 1-1.5 1.5H15" /></>,
  play: <path d="M8 5v14l11-7z" />,
  lock: <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>,
  chart: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7.5 16v-4M12 16V8M16.5 16v-6" /></>,
  'close-window': <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M10 13l4 4M14 13l-4 4" /></>,
  camera: <><path d="M4 8h3.5l1.5-2h6l1.5 2H20v11H4z" /><circle cx="12" cy="13" r="3" /></>,
  text: <><path d="M5 6h14M12 6v13M9 19h6" /></>,
  fullscreen: <><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" /></>,
  'fullscreen-exit': <><path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5" /></>,
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

// 파일 종류별 모양 (24×24). 모양 자체로 구분되게 그린다: 사진 액자, 필름, 음표, 표, 상자 등
const PAGE = 'M6.5 2.5h7.8l4.7 4.7v13.3a1 1 0 0 1-1 1h-11.5a1 1 0 0 1-1-1v-17a1 1 0 0 1 1-1z'
const PAGE_FOLD = 'M14.3 2.5v3.7a1 1 0 0 0 1 1h3.7'

const KIND_SHAPE: Record<FileKind, ReactNode> = {
  // 사진: 액자 + 해 + 산
  image: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" fill="#e6fcf5" stroke="#1f9e8f" strokeWidth="1.2" />
      <circle cx="8" cy="9.3" r="1.8" fill="#f59f00" />
      <path d="M3.2 17.8l5.4-5.4 3.7 3.7 2.6-2.6 5.9 4.4v.4a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z" fill="#1f9e8f" />
    </>
  ),
  // 영상: 필름 (구멍 + 재생)
  video: (
    <>
      <rect x="2.5" y="4.5" width="19" height="15" rx="2" fill="#7048e8" />
      <path d="M4.5 6.2h1.6M8.5 6.2h1.6M12.5 6.2h1.6M16.5 6.2h1.6M4.5 17.8h1.6M8.5 17.8h1.6M12.5 17.8h1.6M16.5 17.8h1.6" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" />
      <path d="M10 9v6l5-3z" fill="#fff" />
    </>
  ),
  // 오디오: 음표
  audio: (
    <>
      <path d="M9.5 17V6.2l10-2.2v10.6" stroke="#d6336c" strokeWidth="2" strokeLinejoin="round" />
      <ellipse cx="7" cy="17.3" rx="3" ry="2.4" fill="#d6336c" />
      <ellipse cx="17" cy="14.9" rx="3" ry="2.4" fill="#d6336c" />
    </>
  ),
  // 텍스트: 줄이 있는 종이
  text: (
    <>
      <path d={PAGE} fill="var(--file-page, #fff)" stroke="#6b7480" strokeWidth="1.1" strokeLinejoin="round" />
      <path d={PAGE_FOLD} stroke="#6b7480" strokeWidth="1.1" strokeLinejoin="round" />
      <path d="M8 10.5h8M8 13.5h8M8 16.5h5" stroke="#6b7480" strokeWidth="1.2" strokeLinecap="round" />
    </>
  ),
  // 코드: </>
  code: (
    <>
      <rect x="2.5" y="3.5" width="19" height="17" rx="3" fill="#3b5bdb" />
      <path d="M9 8.5L5.8 12 9 15.5M15 8.5l3.2 3.5-3.2 3.5M13.2 7.5l-2.4 9" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // 엑셀: 표
  excel: (
    <>
      <rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="#1d7044" />
      <rect x="6" y="6" width="12" height="12" rx="1" fill="#fff" />
      <path d="M6 10h12M6 14h12M10 6v12M14 6v12" stroke="#1d7044" strokeWidth="1.1" />
    </>
  ),
  // 워드·한글: W
  word: (
    <>
      <rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="#2b579a" />
      <path d="M6.5 7.5l2 9 3.5-7 3.5 7 2-9" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // 파워포인트: 원그래프
  powerpoint: (
    <>
      <rect x="2.5" y="2.5" width="19" height="19" rx="3" fill="#c4472b" />
      <path d="M11.3 7.2a5.2 5.2 0 1 0 5.4 5.4h-5.4z" fill="#fff" />
      <path d="M12.9 5.8v5.3h5.3a5.3 5.3 0 0 0-5.3-5.3z" fill="#fff" opacity="0.75" />
    </>
  ),
  // PDF: 빨간 문서
  pdf: (
    <>
      <path d={PAGE} fill="#d0312d" />
      <path d={PAGE_FOLD} fill="#f08c8a" stroke="#f08c8a" strokeWidth="0.6" strokeLinejoin="round" />
      <path d="M7.5 17.5c2-1.5 3.6-4.6 4-7.7.2-1.6-1.4-1.6-1.3-.1.3 3.2 3.7 6.6 6.3 6.6 1.3 0 1.2-1.3-.3-1.4-3.3-.2-7.1 1.6-8.7 2.9-.7.6.1 1.3 0-.3z" stroke="#fff" strokeWidth="1" strokeLinejoin="round" />
    </>
  ),
  // 압축: 지퍼 달린 상자
  archive: (
    <>
      <rect x="3.5" y="7.5" width="17" height="13" rx="1.5" fill="#d9952f" />
      <rect x="2.5" y="4" width="19" height="4.5" rx="1.2" fill="#b07219" />
      <rect x="10.5" y="4" width="3" height="16.5" fill="#f1d39b" />
      <path d="M10.5 6h1.5M12 8h1.5M10.5 10h1.5M12 12h1.5M10.5 14h1.5" stroke="#8a5a14" strokeWidth="1" />
      <rect x="10" y="15" width="4" height="3.5" rx="0.8" fill="#8a5a14" />
    </>
  ),
  // 프로그램: 창 + 톱니
  program: (
    <>
      <rect x="2.5" y="3.5" width="19" height="17" rx="2.5" fill="#495057" />
      <path d="M2.5 6a2.5 2.5 0 0 1 2.5-2.5h14A2.5 2.5 0 0 1 21.5 6v1.5h-19z" fill="#343a40" />
      <circle cx="5" cy="5.5" r=".7" fill="#ff6b6b" />
      <circle cx="7.2" cy="5.5" r=".7" fill="#ffd43b" />
      <circle cx="12" cy="14" r="2.3" stroke="#fff" strokeWidth="1.5" />
      <path d="M12 9.6v1.3M12 17.1v1.3M7.6 14h1.3M15.1 14h1.3M8.9 10.9l.9.9M14.2 16.2l.9.9M8.9 17.1l.9-.9M14.2 11.8l.9-.9" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" />
    </>
  ),
  // 그 밖: 빈 종이
  other: (
    <>
      <path d={PAGE} fill="var(--file-page, #fff)" stroke="#9aa3ad" strokeWidth="1.1" strokeLinejoin="round" />
      <path d={PAGE_FOLD} stroke="#9aa3ad" strokeWidth="1.1" strokeLinejoin="round" />
    </>
  ),
}

/** 탐색기 파일 아이콘: 종류마다 모양이 다르다 (사진·필름·음표·표·W·원그래프·PDF·상자·창·종이) */
export function FileIcon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false" fill="none">
      {KIND_SHAPE[fileKind(name)]}
    </svg>
  )
}
