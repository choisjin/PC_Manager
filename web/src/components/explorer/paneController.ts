import type { FileEntry } from '../../api'

export type SortKey = 'name' | 'size' | 'modified' | 'type'
export type ViewMode = 'details' | 'icons'
/** 자세히 보기에서 켜고 끌 수 있는 열 (이름은 항상 표시) */
export type OptionalColumn = 'modified' | 'type' | 'size'
export type ColumnVisibility = Record<OptionalColumn, boolean>

/** 상단 통합 툴바가 현재 활성 창을 조작하기 위한 핸들 */
export interface PaneController {
  paneId: string
  agentId: string
  machineName: string
  online: boolean
  path: string
  canUp: boolean
  canBack: boolean
  canForward: boolean
  itemCount: number
  selectionCount: number
  canPaste: boolean
  /** 압축 파일 안을 보고 있음 (읽기 전용: 만들기·붙여넣기·이름 바꾸기·삭제·올리기 불가) */
  inArchive: boolean
  view: ViewMode
  sortKey: SortKey
  sortAsc: boolean
  columns: ColumnVisibility
  showHidden: boolean
  search: string
  // 동작 (항상 최신 상태에 적용)
  navigate: (path: string) => void
  up: () => void
  back: () => void
  forward: () => void
  refresh: () => void
  newFolder: () => void
  cut: () => void
  copy: () => void
  paste: () => void
  rename: () => void
  remove: () => void
  fetchSelected: () => void
  /** 공유: 선택한 파일 1개의 다운로드 링크를 만들어 복사 */
  shareSelected: () => void
  /** 파일 1개(폴더 아님)를 골랐을 때만 공유 가능 */
  canShare: boolean
  setSort: (key: SortKey) => void
  setView: (view: ViewMode) => void
  toggleColumn: (column: OptionalColumn) => void
  toggleHidden: () => void
  /** 저장할 때 원본 .bak 남기기 (내 PC 프로그램 저장·브라우저 편집 공통) */
  backupOnSave: boolean
  toggleBackupOnSave: () => void
  setSearch: (q: string) => void
  openTerminal: () => void
  openRemote: () => void
  upload: () => void
}

/** 윈도우 탐색기식 유형 표시 */
export function fileTypeLabel(entry: FileEntry): string {
  if (entry.isDirectory) return '파일 폴더'
  const dot = entry.name.lastIndexOf('.')
  if (dot <= 0) return '파일'
  return `${entry.name.slice(dot + 1).toUpperCase()} 파일`
}

/** 폴더 먼저, 그다음 기준별 정렬 */
export function sortEntries(entries: FileEntry[], key: SortKey, asc: boolean): FileEntry[] {
  const dir = asc ? 1 : -1
  const cmp = (a: FileEntry, b: FileEntry) => {
    let r = 0
    if (key === 'size') r = a.size - b.size
    else if (key === 'modified') r = (a.modifiedAt ?? '').localeCompare(b.modifiedAt ?? '')
    else if (key === 'type') r = fileTypeLabel(a).localeCompare(fileTypeLabel(b))
    else r = a.name.localeCompare(b.name, 'ko')
    return r === 0 ? a.name.localeCompare(b.name, 'ko') * dir : r * dir
  }
  return [...entries].sort((a, b) => (a.isDirectory === b.isDirectory ? cmp(a, b) : a.isDirectory ? -1 : 1))
}

export interface Crumb {
  label: string
  target: string
}

/** 경로를 브레드크럼 조각으로 (내 PC › D: › a › b) */
export function buildCrumbs(path: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: '내 PC', target: '' }]
  if (!path) return crumbs
  const normalized = path.replace(/\//g, '\\')
  const parts = normalized.split('\\').filter(Boolean)
  if (parts.length === 0) return crumbs
  // 서버 주소만(\\서버): 한 칸
  if (normalized.startsWith('\\\\') && parts.length === 1) {
    crumbs.push({ label: parts[0], target: `\\\\${parts[0]}` })
    return crumbs
  }
  // 네트워크 공유: \\서버\공유 까지를 한 칸(루트)으로
  if (normalized.startsWith('\\\\') && parts.length >= 2) {
    let unc = `\\\\${parts[0]}\\${parts[1]}`
    crumbs.push({ label: `${parts[0]}\\${parts[1]}`, target: unc })
    for (let i = 2; i < parts.length; i++) {
      unc = `${unc}\\${parts[i]}`
      crumbs.push({ label: parts[i], target: unc })
    }
    return crumbs
  }
  let acc = `${parts[0]}\\`
  crumbs.push({ label: parts[0], target: acc })
  for (let i = 1; i < parts.length; i++) {
    acc = acc.endsWith('\\') ? acc + parts[i] : `${acc}\\${parts[i]}`
    crumbs.push({ label: parts[i], target: acc })
  }
  return crumbs
}
