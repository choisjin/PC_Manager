import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { ARCHIVE_PASSWORD_PREFIX, api, type DirectoryListing, type FileEntry, type PcStatus, type Transfer } from '../../api'
import { archiveBaseName, BACKUP_SETTING_EVENT, isArchiveFile, isImageFile, isPdfFile, isTextFile, isVideoFile, loadBackupSetting, saveBackupSetting } from '../../fileTypes'
import { formatBytes } from '../../format'
import type { SubscribeTransfers, WatchRun } from '../../useDashboard'
import { FileViewer, type ViewerKind } from '../FileViewer'
import { VideoViewer } from '../VideoViewer'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { DriveTree } from './DriveTree'
import { Icon } from './Icon'
import { copyText, type FileClipboard, FILES_MIME, type FilesDragPayload, newId, PANE_MIME } from './pcGroups'

const COL_WIDTH_KEY = 'explorer.colWidths'
const COLUMNS_KEY = 'explorer.columns'
const COLUMNS_EVENT = 'explorer-columns'
const DEFAULT_COLUMNS: ColumnVisibility = { modified: true, type: true, size: true }
const HIDDEN_KEY = 'explorer.showHidden'

function loadShowHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

function loadColumns(): ColumnVisibility {
  try {
    const saved = localStorage.getItem(COLUMNS_KEY)
    return saved ? { ...DEFAULT_COLUMNS, ...JSON.parse(saved) } : DEFAULT_COLUMNS
  } catch {
    return DEFAULT_COLUMNS
  }
}
import { fileTypeLabel, type PaneController, sortEntries, type SortKey, type ViewMode, type ColumnVisibility, type OptionalColumn } from './paneController'
import { SplitCompressModal } from './SplitCompressModal'
import { RemoteModal } from './RemoteModal'
import { TerminalModal } from './TerminalModal'

export interface Pane {
  paneId: string
  agentId: string
  w?: number
  h?: number
}

interface Props {
  paneId: string
  agentId: string
  machineName: string
  online: boolean
  /** 대시보드를 연 PC의 에이전트(온라인일 때만). 있으면 파일 더블클릭 = 그 PC 프로그램으로 열기 */
  selfAgentId: string | null
  active: boolean
  onActivate: () => void
  onControllerChange: (controller: PaneController) => void
  width?: number
  height?: number
  clipboard: FileClipboard | null
  setClipboard: (clipboard: FileClipboard | null) => void
  favorites: string[]
  selfUserId: string | null
  /** 수동 상태 (테스트 중이면 원격 전 확인, 사용 금지면 차단) */
  pcStatus: PcStatus | null
  /** 지금 원격조작 중인 사용자 id */
  remoteUser: string | null
  userName: (userId: string) => string
  onAddFavorite: (path: string) => void
  onRemoveFavorite: (path: string) => void
  onReorderFavorites: (paths: string[]) => void
  subscribeTransfers: SubscribeTransfers
  watchRun: WatchRun
  onClose: () => void
  onReorderDrop: (fromPaneId: string) => void
  onResize: (w: number, h: number) => void
}

/** 창 안의 폴더 탭 (뒤로/앞으로용 방문 기록 포함) */
interface FolderTab {
  id: string
  stack: string[]
  idx: number
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

const favName = (p: string) => {
  const trimmed = p.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || p
}

const tabLabel = (p: string) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p : '내 PC')

// 윈도우 탐색기식 한 줄 날짜 (YYYY-MM-DD HH:mm)
const pad2 = (n: number) => String(n).padStart(2, '0')
const formatFileDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

const joinPath = (directory: string, name: string) =>
  /[\\/]$/.test(directory) ? directory + name : `${directory}\\${name}`

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

const SIDE_WIDTH_KEY = 'pcm.paneSideWidth'

const EXECUTABLE_EXT = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'ps1', 'msix', 'appx', 'scr'])
const isExecutable = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && EXECUTABLE_EXT.has(name.slice(dot + 1).toLowerCase())
}

export function ExplorerPane({
  paneId,
  agentId,
  machineName, selfAgentId,
  online,
  active,
  onActivate,
  onControllerChange,
  width,
  height,
  clipboard,
  setClipboard,
  favorites,
  selfUserId,
  pcStatus,
  remoteUser,
  userName,
  onAddFavorite,
  onRemoveFavorite,
  onReorderFavorites,
  subscribeTransfers,
  watchRun,
  onClose,
  onReorderDrop,
  onResize,
}: Props) {
  const [tabs, setTabs] = useState<FolderTab[]>(() => [{ id: newId(), stack: [''], idx: 0 }])
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].id)
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(online)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [view, setView] = useState<ViewMode>('details')
  const [sortKey, setSortKey] = useState<SortKey>('name')
  const [sortAsc, setSortAsc] = useState(true)
  const [search, setSearch] = useState('')
  const [playing, setPlaying] = useState<{ path: string; name: string } | null>(null)
  // 텍스트·이미지·PDF 바로 보기 (텍스트는 편집·저장)
  const [viewing, setViewing] = useState<{ path: string; name: string; kind: ViewerKind; readOnly: boolean } | null>(null)
  const [terminal, setTerminal] = useState(false)
  const [remote, setRemote] = useState(false)
  const accessRef = useRef({ pcStatus, remoteUser })
  accessRef.current = { pcStatus, remoteUser }
  const [splitTargets, setSplitTargets] = useState<FileEntry[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; targets: FileEntry[]; folder: string | null; items?: MenuItem[] } | null>(null)
  // 자세히 보기에 표시할 열 (모든 창 공통, 상단 '보기' 메뉴에서 변경)
  const [columns, setColumns] = useState<ColumnVisibility>(loadColumns)
  useEffect(() => {
    const sync = () => setColumns(loadColumns())
    window.addEventListener(COLUMNS_EVENT, sync)
    return () => window.removeEventListener(COLUMNS_EVENT, sync)
  }, [])
  // 숨김 항목 보기 (모든 창 공통, 기본 숨김 — 윈도우 탐색기와 같다)
  const [showHidden, setShowHidden] = useState(loadShowHidden)
  useEffect(() => {
    const sync = () => setShowHidden(loadShowHidden())
    window.addEventListener(COLUMNS_EVENT, sync)
    return () => window.removeEventListener(COLUMNS_EVENT, sync)
  }, [])
  const toggleHidden = () => {
    const next = !showHidden
    try {
      localStorage.setItem(HIDDEN_KEY, next ? '1' : '0')
    } catch {
      // 무시
    }
    setShowHidden(next)
    window.dispatchEvent(new Event(COLUMNS_EVENT))
  }
  // 저장할 때 .bak 남기기 (모든 창 공통, 기본 끔)
  const [backupOnSave, setBackupOnSave] = useState(loadBackupSetting)
  useEffect(() => {
    const sync = () => setBackupOnSave(loadBackupSetting())
    window.addEventListener(BACKUP_SETTING_EVENT, sync)
    return () => window.removeEventListener(BACKUP_SETTING_EVENT, sync)
  }, [])
  const toggleBackupOnSave = () => saveBackupSetting(!backupOnSave)
  const toggleColumn = (column: OptionalColumn) => {
    const next = { ...loadColumns(), [column]: !columns[column] }
    try {
      localStorage.setItem(COLUMNS_KEY, JSON.stringify(next))
    } catch {
      // 무시
    }
    setColumns(next)
    window.dispatchEvent(new Event(COLUMNS_EVENT))
  }
  // 자세히 보기 열 너비 (px). 이름은 지정 전까지 남는 폭을 차지한다
  const [colWidths, setColWidths] = useState<{ name?: number; modified: number; type: number; size: number }>(() => {
    try {
      const saved = localStorage.getItem(COL_WIDTH_KEY)
      if (saved) return { modified: 132, type: 80, size: 62, ...JSON.parse(saved) }
    } catch {
      // 무시
    }
    return { modified: 132, type: 80, size: 62 }
  })
  const [dragOver, setDragOver] = useState(false)
  const [dropDir, setDropDir] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const requestRef = useRef(0)
  const anchorRef = useRef(-1)
  // 즐겨찾기 순서 변경(드래그)
  const favDragIndex = useRef<number | null>(null)
  const [favOverIndex, setFavOverIndex] = useState<number | null>(null)
  // 왼쪽 경로 패널 폭 (드래그로 조절, 브라우저에 저장)
  const [sideWidth, setSideWidth] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(SIDE_WIDTH_KEY))
      return saved >= 90 && saved <= 360 ? saved : 138
    } catch {
      return 138
    }
  })

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0]
  const path = activeTab.stack[activeTab.idx] ?? ''
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId

  const setTab = (id: string, updater: (t: FolderTab) => FolderTab) =>
    setTabs((ts) => ts.map((t) => (t.id === id ? updater(t) : t)))

  const showListing = (requestId: number, result: DirectoryListing) => {
    if (requestId !== requestRef.current) return
    setLoading(false)
    if (result.error) {
      if (result.archivePath && result.error.startsWith(ARCHIVE_PASSWORD_PREFIX)) {
        const archive = result.archivePath
        void askArchivePassword(archive).then((ok) => {
          if (ok) load(result.path)
          else setError(result.error)
        })
        return
      }
      setError(result.error)
      return
    }
    setError(null)
    setListing(result)
    setSelected(new Set())
    anchorRef.current = -1
    // 방문 기록의 현재 항목을 정규화된 경로로 갱신
    setTab(activeTabIdRef.current, (t) => {
      if (t.stack[t.idx] === result.path) return t
      const stack = t.stack.slice()
      stack[t.idx] = result.path
      return { ...t, stack }
    })
  }

  const load = (target: string) => {
    const requestId = ++requestRef.current
    setLoading(true)
    setSearch('')
    api.listFiles(agentId, target).then(
      (result) => showListing(requestId, result),
      (err) => {
        if (requestId === requestRef.current) {
          setLoading(false)
          setError(toMessage(err))
        }
      },
    )
  }
  const refresh = () => load(path)

  // 새 경로로 이동 (방문 기록에 쌓는다)
  const navigate = (target: string) => {
    setTab(activeTabId, (t) => {
      const stack = t.stack.slice(0, t.idx + 1)
      if (stack[stack.length - 1] !== target) stack.push(target)
      return { ...t, stack, idx: stack.length - 1 }
    })
    load(target)
  }
  const back = () => {
    if (activeTab.idx <= 0) return
    const target = activeTab.stack[activeTab.idx - 1]
    setTab(activeTabId, (t) => ({ ...t, idx: t.idx - 1 }))
    load(target)
  }
  const forward = () => {
    if (activeTab.idx >= activeTab.stack.length - 1) return
    const target = activeTab.stack[activeTab.idx + 1]
    setTab(activeTabId, (t) => ({ ...t, idx: t.idx + 1 }))
    load(target)
  }

  const addTab = () => {
    const id = newId()
    setTabs((ts) => [...ts, { id, stack: [path], idx: 0 }])
    setActiveTabId(id)
  }
  const closeTab = (id: string) => {
    setTabs((ts) => {
      if (ts.length <= 1) return ts
      const idx = ts.findIndex((t) => t.id === id)
      const next = ts.filter((t) => t.id !== id)
      if (id === activeTabId) setActiveTabId(next[Math.max(0, idx - 1)].id)
      return next
    })
  }

  // 활성 탭이 바뀌면 그 탭의 현재 폴더를 불러온다 (마운트 시 빈 경로 = 드라이브 목록)
  const loadActiveTab = useEffectEvent(() => load(activeTab.stack[activeTab.idx] ?? ''))
  useEffect(() => {
    loadActiveTab()
  }, [activeTabId])

  const onTransferUpdated = useEffectEvent((transfer: Transfer) => {
    if (transfer.agentId === agentId && (transfer.kind === 'Push' || transfer.kind === 'Compress' || transfer.kind === 'Extract') && transfer.state === 'Succeeded' && path) load(path)
  })
  useEffect(() => {
    const unsubscribe = subscribeTransfers((transfer) => onTransferUpdated(transfer))
    return () => unsubscribe()
  }, [subscribeTransfers])

  const saveSizeIfChanged = () => {
    const el = sectionRef.current
    if (!el) return
    const w = Math.round(el.offsetWidth)
    const h = Math.round(el.offsetHeight)
    if (w !== (width ?? 0) || h !== (height ?? 0)) onResize(w, h)
  }

  // 왼쪽 경로 패널 폭 드래그 조절
  const startSideResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sideWidth
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(90, Math.min(360, startW + ev.clientX - startX))
      setSideWidth(next)
    }
    const onUp = (ev: MouseEvent) => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      const next = Math.max(90, Math.min(360, startW + ev.clientX - startX))
      try {
        localStorage.setItem(SIDE_WIDTH_KEY, String(next))
      } catch {
        // 무시
      }
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 열 너비 드래그 조절 (헤더 오른쪽 가장자리)
  const startColResize = (key: 'name' | 'modified' | 'type' | 'size', e: React.MouseEvent<HTMLElement>) => {
    e.preventDefault()
    e.stopPropagation()
    const th = (e.currentTarget as HTMLElement).parentElement as HTMLElement
    const startX = e.clientX
    const startWidth = th.getBoundingClientRect().width
    const onMove = (ev: MouseEvent) => {
      const next = Math.max(40, Math.round(startWidth + ev.clientX - startX))
      setColWidths((prev) => ({ ...prev, [key]: next }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      setColWidths((prev) => {
        try {
          localStorage.setItem(COL_WIDTH_KEY, JSON.stringify(prev))
        } catch {
          // 무시
        }
        return prev
      })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 즐겨찾기 순서 바꾸기 (드래그한 항목을 대상 위치로 이동)
  const reorderFavorites = (from: number, to: number) => {
    if (from === to || from < 0 || to < 0) return
    const next = favorites.slice()
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    onReorderFavorites(next)
  }

  // 가져오기 = 브라우저 다운로드(기본 다운로드 폴더로). 실행 파일은 내려받은 뒤 브라우저에서 실행할 수 있다.
  const fetchFiles = (entries: FileEntry[]) => {
    for (const e of entries.filter((x) => !x.isDirectory)) {
      const a = document.createElement('a')
      a.href = api.downloadUrl(agentId, e.fullPath)
      a.download = e.name
      a.rel = 'noopener'
      document.body.appendChild(a)
      a.click()
      a.remove()
    }
  }

  // 공개 다운로드 링크 생성 → 클립보드에 복사
  const createDownloadLink = async (entry: FileEntry) => {
    setError(null)
    setNotice(null)
    try {
      const { url } = await api.createDownloadLink(agentId, entry.fullPath)
      const full = window.location.origin + url
      const ok = await copyText(full)
      setNotice(ok ? `다운로드 링크가 복사되었습니다: ${full}` : `다운로드 링크: ${full}`)
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const compress = (targets: FileEntry[]) => {
    if (!path || targets.length === 0) return
    setError(null)
    void api.compressFiles(agentId, targets.map((t) => t.fullPath), path).catch((err) => setError(toMessage(err)))
  }
  const compressEach = (targets: FileEntry[]) => {
    if (!path || targets.length === 0) return
    setError(null)
    for (const t of targets) void api.compressFiles(agentId, [t.fullPath], path).catch((err) => setError(toMessage(err)))
  }
  const compressSplit = (targets: FileEntry[], splitBytes: number) => {
    if (!path || targets.length === 0) return
    setError(null)
    void api.compressFiles(agentId, targets.map((t) => t.fullPath), path, undefined, splitBytes).catch((err) => setError(toMessage(err)))
  }

  const pushFiles = async (files: FileList) => {
    if (!path) return
    try {
      for (const file of Array.from(files)) await api.pushFile(agentId, joinPath(path, file.name), file)
    } catch (err) {
      setError(toMessage(err))
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  // 검색·정렬을 적용한 화면 표시용 목록
  const displayed = useMemo(() => {
    const all = listing?.entries ?? []
    const entries = showHidden ? all : all.filter((e) => !e.hidden)
    const q = search.trim().toLowerCase()
    const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
    return sortEntries(filtered, sortKey, sortAsc)
  }, [listing, search, sortKey, sortAsc, showHidden])

  const selectClick = (e: React.MouseEvent, entry: FileEntry, index: number) => {
    if (e.shiftKey && anchorRef.current >= 0) {
      const [a, b] = [anchorRef.current, index].sort((x, y) => x - y)
      setSelected(new Set(displayed.slice(a, b + 1).map((en) => en.fullPath)))
    } else if (e.ctrlKey || e.metaKey) {
      setSelected((prev) => {
        const next = new Set(prev)
        if (next.has(entry.fullPath)) next.delete(entry.fullPath)
        else next.add(entry.fullPath)
        return next
      })
      anchorRef.current = index
    } else {
      setSelected(new Set([entry.fullPath]))
      anchorRef.current = index
    }
  }

  // 압축 파일 안을 보고 있으면 그 압축 파일 경로
  const archivePath = listing?.archivePath ?? null
  const inArchive = !!archivePath

  /** 압축 암호를 물어 그 PC에 알려 준다. 넣었으면 true */
  const askArchivePassword = async (archive: string) => {
    const name = archive.split('\\').pop() ?? archive
    const password = window.prompt(`'${name}'은(는) 암호가 걸린 압축 파일입니다.\n암호를 입력하세요.`)
    if (!password) return false
    try {
      await api.setArchivePassword(agentId, archive, password)
      return true
    } catch (err) {
      setError(toMessage(err))
      return false
    }
  }

  /** 텍스트·이미지·PDF는 바로 보기. 해당 없으면 null */
  const viewerKind = (name: string): ViewerKind | null =>
    isTextFile(name) ? 'text' : isImageFile(name) ? 'image' : isPdfFile(name) ? 'pdf' : null
  const openViewer = (entry: FileEntry, kind: ViewerKind) =>
    setViewing({ path: entry.fullPath, name: entry.name, kind, readOnly: inArchive })

  /** 압축 풀기 (같은 PC). entries가 비면 압축 파일 전체 */
  const extract = (archive: string, entries: FileEntry[], destination: string) => {
    setError(null)
    setNotice(null)
    api.extractFiles(agentId, archive, entries.map((e) => e.fullPath), destination).then(
      () => setNotice(`압축 풀기를 시작했습니다 → ${destination}`),
      (err) => setError(toMessage(err)),
    )
  }
  /** 다른 폴더로 압축 풀기: 경로를 입력받는다 */
  const extractTo = (archive: string, entries: FileEntry[]) => {
    const parent = archive.slice(0, archive.lastIndexOf('\\')) || archive
    const dest = window.prompt('압축을 풀 폴더 (이 PC 안의 경로, 없으면 만듭니다)', parent)
    if (dest?.trim()) extract(archive, entries, dest.trim())
  }

  /** 내 PC 프로그램(엑셀 등)으로 열기. 저장하면 이 PC의 원래 경로로 되돌아간다 (압축 안 파일은 열기만) */
  const openLocal = (entry: FileEntry) => {
    if (!selfAgentId) return
    if (entry.size > 500 * 1024 * 1024 && !window.confirm(`'${entry.name}'은(는) ${formatBytes(entry.size)}입니다. 내 PC로 받아서 열까요?`)) return
    setError(null)
    setNotice(selfAgentId === agentId ? `'${entry.name}'을(를) 여는 중…` : `'${entry.name}'을(를) 내 PC로 받아 여는 중…${inArchive ? ' (압축 안 파일: 저장해도 되돌아가지 않음)' : ' 저장하면 이 PC의 원래 위치에 저장됩니다.'}`)
    api.openLocal(agentId, entry.fullPath, selfAgentId, machineName, inArchive, backupOnSave).then(
      () =>
        setNotice(
          selfAgentId === agentId || inArchive
            ? `'${entry.name}'을(를) 열었습니다.`
            : `'${entry.name}'을(를) 내 PC 프로그램으로 열었습니다. 저장하면 ${machineName}의 원래 위치에 저장됩니다${backupOnSave ? ' (원본은 .bak)' : ''}.`,
        ),
      (err) => {
        setNotice(null)
        setError(toMessage(err))
      },
    )
  }

  const openEntry = (entry: FileEntry) => {
    const kind = entry.isDirectory ? null : viewerKind(entry.name)
    if (entry.isDirectory) navigate(entry.fullPath)
    // 압축 파일은 폴더처럼 들어간다 (압축 안의 압축은 풀어서 열어야 함)
    else if (!inArchive && isArchiveFile(entry.name)) navigate(entry.fullPath)
    // 기본: 내 PC 프로그램으로 열기 (내 PC에 에이전트가 있을 때)
    else if (selfAgentId) openLocal(entry)
    else if (isVideoFile(entry.name)) setPlaying({ path: entry.fullPath, name: entry.name })
    else if (kind) openViewer(entry, kind)
    else {
      // 파일 더블클릭 = 가져오기(다운로드 폴더로). 실행 파일이면 실행 안내.
      fetchFiles([entry])
      if (isExecutable(entry.name)) {
        setNotice(`'${entry.name}'을(를) 다운로드했습니다. 브라우저 다운로드 표시줄에서 열어 실행하세요. (브라우저 보안상 자동 실행은 불가)`)
      }
    }
  }

  const paste = async (targetFolder: string) => {
    if (!clipboard || !targetFolder) return
    if (inArchive) {
      setError('압축 파일 안에는 붙여넣을 수 없습니다.')
      return
    }
    setError(null)
    const errors: string[] = []
    for (const item of clipboard.items) {
      try {
        if (clipboard.agentId === agentId) {
          const result = await api.fileOp(agentId, clipboard.mode === 'cut' ? 'Move' : 'Copy', item.path, targetFolder)
          if (!result.success) errors.push(`${item.name}: ${result.error}`)
        } else if (item.isDir) {
          errors.push(`${item.name}: PC 간에는 폴더 복사를 지원하지 않습니다`)
        } else {
          const result = await api.crossCopy({
            sourceAgentId: clipboard.agentId,
            sourcePath: item.path,
            destAgentId: agentId,
            destFolder: targetFolder,
            move: clipboard.mode === 'cut',
          })
          if (!result.success) errors.push(`${item.name}: ${result.error}`)
        }
      } catch (err) {
        errors.push(`${item.name}: ${toMessage(err)}`)
      }
    }
    if (clipboard.mode === 'cut' && errors.length === 0) setClipboard(null)
    refresh()
    if (errors.length) setError(errors.join(' · '))
  }

  // 창 간(또는 폴더로) 파일 드래그: 선택된 것들을 함께 끈다
  const startFileDrag = (e: React.DragEvent, entry: FileEntry) => {
    const chosen = selected.has(entry.fullPath) ? selectedEntries() : [entry]
    const payload: FilesDragPayload = {
      agentId,
      items: chosen.map((t) => ({ path: t.fullPath, name: t.name, isDir: t.isDirectory })),
    }
    e.dataTransfer.setData(FILES_MIME, JSON.stringify(payload))
    e.dataTransfer.effectAllowed = 'move'
  }

  // 드롭한 항목들을 대상 폴더로 이동 (같은 PC=이동, 다른 PC=크로스카피 이동)
  const dropFiles = async (targetFolder: string, raw: string) => {
    let payload: FilesDragPayload
    try {
      payload = JSON.parse(raw) as FilesDragPayload
    } catch {
      return
    }
    if (!targetFolder || !payload.items?.length) return
    setError(null)
    const errors: string[] = []
    for (const item of payload.items) {
      const parent = item.path.replace(/[\\/]+$/, '').replace(/[\\/][^\\/]*$/, '')
      if (samePath(parent, targetFolder)) continue // 같은 위치
      const norm = item.path.replace(/[\\/]+$/, '').toLowerCase()
      if (item.isDir && (samePath(item.path, targetFolder) || `${targetFolder.replace(/[\\/]+$/, '').toLowerCase()}`.startsWith(`${norm}\\`))) {
        errors.push(`${item.name}: 자기 자신 안으로 이동할 수 없습니다`)
        continue
      }
      try {
        if (payload.agentId === agentId) {
          const result = await api.fileOp(agentId, 'Move', item.path, targetFolder)
          if (!result.success) errors.push(`${item.name}: ${result.error}`)
        } else if (item.isDir) {
          errors.push(`${item.name}: PC 간에는 폴더 이동을 지원하지 않습니다`)
        } else {
          const result = await api.crossCopy({ sourceAgentId: payload.agentId, sourcePath: item.path, destAgentId: agentId, destFolder: targetFolder, move: true })
          if (!result.success) errors.push(`${item.name}: ${result.error}`)
        }
      } catch (err) {
        errors.push(`${item.name}: ${toMessage(err)}`)
      }
    }
    refresh()
    if (errors.length) setError(errors.join(' · '))
  }

  const remove = async (entries: FileEntry[]) => {
    if (entries.length === 0) return
    const label = entries.length === 1 ? `'${entries[0].name}'을(를)` : `${entries.length}개 항목을`
    if (!window.confirm(`${label} 삭제합니다. 되돌릴 수 없습니다. 계속할까요?`)) return
    setError(null)
    const errors: string[] = []
    for (const entry of entries) {
      try {
        const result = await api.fileOp(agentId, 'Delete', entry.fullPath)
        if (!result.success) errors.push(`${entry.name}: ${result.error}`)
      } catch (err) {
        errors.push(`${entry.name}: ${toMessage(err)}`)
      }
    }
    refresh()
    if (errors.length) setError(errors.join(' · '))
  }

  const rename = async (entry: FileEntry) => {
    const name = window.prompt('새 이름', entry.name)
    if (!name || name === entry.name) return
    setError(null)
    try {
      const result = await api.fileOp(agentId, 'Rename', entry.fullPath, name)
      if (!result.success) throw new Error(result.error ?? '이름 바꾸기 실패')
      refresh()
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const createFolder = async () => {
    if (!path) {
      setError('폴더를 먼저 여세요.')
      return
    }
    const name = window.prompt('새 폴더 이름', '새 폴더')
    if (!name) return
    setError(null)
    try {
      const result = await api.fileOp(agentId, 'CreateDirectory', path, name)
      if (!result.success) throw new Error(result.error ?? '폴더 생성 실패')
      refresh()
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const setClip = (targets: FileEntry[], mode: 'copy' | 'cut') =>
    setClipboard({ agentId, items: targets.map((t) => ({ path: t.fullPath, name: t.name, isDir: t.isDirectory })), mode })

  const selectedEntries = () => (listing?.entries ?? []).filter((e) => selected.has(e.fullPath))

  const applySort = (key: SortKey) => {
    if (key === sortKey) setSortAsc((v) => !v)
    else {
      setSortKey(key)
      setSortAsc(true)
    }
  }

  // --- 상단 통합 툴바에 넘길 컨트롤러 ---
  const controller: PaneController = {
    paneId,
    agentId,
    machineName,
    online,
    path,
    canUp: listing?.parentPath != null,
    canBack: activeTab.idx > 0,
    canForward: activeTab.idx < activeTab.stack.length - 1,
    itemCount: listing?.entries.length ?? 0,
    selectionCount: selected.size,
    canPaste: !!clipboard && !!path && !inArchive,
    inArchive,
    view,
    sortKey,
    sortAsc,
    search,
    navigate,
    up: () => listing?.parentPath != null && navigate(listing.parentPath),
    back,
    forward,
    refresh,
    newFolder: () => void createFolder(),
    cut: () => setClip(selectedEntries(), 'cut'),
    copy: () => setClip(selectedEntries(), 'copy'),
    paste: () => void paste(path),
    rename: () => {
      const s = selectedEntries()
      if (s.length === 1) void rename(s[0])
    },
    remove: () => void remove(selectedEntries()),
    fetchSelected: () => fetchFiles(selectedEntries()),
    setSort: applySort,
    setView,
    columns,
    toggleColumn,
    showHidden,
    toggleHidden,
    backupOnSave,
    toggleBackupOnSave,
    setSearch,
    openTerminal: () => setTerminal(true),
    openRemote: () => {
      // 툴바가 이전 렌더의 컨트롤러를 들고 있을 수 있으므로 상태는 ref에서 읽는다
      const { pcStatus: st, remoteUser: by } = accessRef.current
      if (st?.status === 'forbidden') {
        setError(`사용 금지 상태라 원격조작할 수 없습니다.${st.note ? ` (${st.note})` : ''}`)
        return
      }
      if (by && by !== (selfUserId ?? 'anonymous')) {
        setError(`${userName(by)}님이 원격조작 중입니다.`)
        return
      }
      if (st?.status === 'testing' && !window.confirm(`이 PC는 '테스트 중' 상태입니다.${st.note ? ` (${st.note})` : ''}\n그래도 원격조작할까요?`)) return
      setError(null)
      setRemote(true)
    },
    upload: () => fileInputRef.current?.click(),
  }
  const controllerRef = useRef(controller)
  controllerRef.current = controller

  const notifyController = useEffectEvent(() => onControllerChange(controllerRef.current))
  useEffect(() => {
    if (active) notifyController()
  }, [active, path, view, sortKey, sortAsc, search, selected, listing, clipboard, activeTab.idx, activeTab.stack.length, online])

  // 윈도우 스타일 단축키 (활성 창에만, 크롬에서 가로챌 수 있는 것만)
  const handleKey = useEffectEvent((e: KeyboardEvent) => {
    const t = e.target as HTMLElement | null
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key
    const sel = selectedEntries()
    if (ctrl && (key === 'a' || key === 'A')) {
      e.preventDefault()
      setSelected(new Set(displayed.map((d) => d.fullPath)))
    } else if (ctrl && (key === 'c' || key === 'C')) {
      if (sel.length) {
        e.preventDefault()
        setClip(sel, 'copy')
      }
    } else if (ctrl && (key === 'x' || key === 'X')) {
      if (sel.length) {
        e.preventDefault()
        setClip(sel, 'cut')
      }
    } else if (ctrl && (key === 'v' || key === 'V')) {
      if (clipboard && path) {
        e.preventDefault()
        void paste(path)
      }
    } else if (ctrl && (key === 'f' || key === 'F')) {
      e.preventDefault()
      ;(document.querySelector('.win-search input') as HTMLInputElement | null)?.focus()
    } else if (key === 'Delete') {
      if (sel.length) {
        e.preventDefault()
        void remove(sel)
      }
    } else if (key === 'F2') {
      if (sel.length === 1) {
        e.preventDefault()
        void rename(sel[0])
      }
    } else if (key === 'Enter') {
      if (sel.length) {
        e.preventDefault()
        if (sel.length === 1) openEntry(sel[0])
        else fetchFiles(sel)
      }
    } else if (key === 'Backspace') {
      if (listing?.parentPath != null) {
        e.preventDefault()
        navigate(listing.parentPath)
      }
    } else if (key === 'Escape') {
      setSelected(new Set())
    } else if (key === 'ArrowDown' || key === 'ArrowUp') {
      if (displayed.length === 0) return
      e.preventDefault()
      const next = Math.max(0, Math.min(displayed.length - 1, anchorRef.current + (key === 'ArrowDown' ? 1 : -1)))
      anchorRef.current = next
      setSelected(new Set([displayed[next].fullPath]))
      queueMicrotask(() => sectionRef.current?.querySelector('tr.selected, .icon-tile.selected')?.scrollIntoView({ block: 'nearest' }))
    }
  })
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => handleKey(e)
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [active])

  // 압축 파일 안: 읽기 전용 메뉴 (보기, 압축 풀기, 가져오기, 복사)
  const buildArchiveMenu = (targets: FileEntry[]): MenuItem[] => {
    const archive = archivePath!
    const files = targets.filter((t) => !t.isDirectory)
    const archiveFolder = archive.slice(0, archive.lastIndexOf('\\')) || archive
    const items: MenuItem[] = []
    if (targets.length === 1 && !targets[0].isDirectory) {
      const kind = viewerKind(targets[0].name)
      if (selfAgentId) items.push({ label: '내 PC 프로그램으로 열기 (읽기 전용 복사본)', onClick: () => openLocal(targets[0]) })
      if (kind) items.push({ label: '내려받지 않고 보기', onClick: () => openViewer(targets[0], kind) })
      if (isVideoFile(targets[0].name)) items.push({ label: '내려받지 않고 재생', onClick: () => setPlaying({ path: targets[0].fullPath, name: targets[0].name }) })
    }
    const what = targets.length ? `선택 ${targets.length}개` : '전체'
    items.push({ label: `압축 풀기: ${what} → 압축 파일이 있는 폴더`, onClick: () => extract(archive, targets, archiveFolder) })
    items.push({ label: `압축 풀기: ${what} → 다른 폴더…`, onClick: () => extractTo(archive, targets) })
    if (files.length > 0) items.push({ label: `내 PC로 가져오기${files.length > 1 ? ` (${files.length})` : ''}`, onClick: () => fetchFiles(files) })
    if (targets.length > 0) {
      items.push({ separator: true })
      items.push({
        label: `복사${targets.length > 1 ? ` (${targets.length})` : ''} — 다른 폴더·PC에 붙여넣기`,
        onClick: () => setClip(targets, 'copy'),
      })
      items.push({ label: '경로 복사', onClick: () => void copyText(targets.map((t) => t.fullPath).join('\n')) })
    }
    return items
  }

  const buildMenu = (targets: FileEntry[], folder: string | null): MenuItem[] => {
    if (inArchive) return buildArchiveMenu(targets)
    const pasteTarget = folder ?? path
    const files = targets.filter((t) => !t.isDirectory)
    const items: MenuItem[] = []
    // 보기·편집 / 압축 파일 열기·풀기
    if (targets.length === 1 && !targets[0].isDirectory) {
      const t = targets[0]
      const kind = viewerKind(t.name)
      if (selfAgentId && !isArchiveFile(t.name))
        items.push({ label: '내 PC 프로그램으로 열기 (저장하면 이 PC에 저장)', onClick: () => openLocal(t) })
      if (kind) items.push({ label: kind === 'text' ? '내려받지 않고 편집' : '내려받지 않고 보기', onClick: () => openViewer(t, kind) })
      else if (t.size <= 5 * 1024 * 1024 && !isArchiveFile(t.name) && !isVideoFile(t.name))
        items.push({ label: '내려받지 않고 텍스트로 편집', onClick: () => openViewer(t, 'text') })
      if (isArchiveFile(t.name)) {
        const folderOf = t.fullPath.slice(0, t.fullPath.lastIndexOf('\\'))
        const sub = `${folderOf}\\${archiveBaseName(t.name)}`
        items.push({ label: '압축 파일 열기 (폴더처럼 보기)', onClick: () => navigate(t.fullPath) })
        items.push({ label: `압축 풀기 → '${archiveBaseName(t.name)}' 폴더에`, onClick: () => extract(t.fullPath, [], sub) })
        items.push({ label: '압축 풀기 → 여기에', onClick: () => extract(t.fullPath, [], folderOf) })
        items.push({ label: '압축 풀기 → 다른 폴더…', onClick: () => extractTo(t.fullPath, []) })
      }
      if (items.length) items.push({ separator: true })
    }
    if (targets.length > 0) {
      items.push({ label: `복사${targets.length > 1 ? ` (${targets.length})` : ''}`, onClick: () => setClip(targets, 'copy') })
      items.push({ label: `잘라내기${targets.length > 1 ? ` (${targets.length})` : ''}`, onClick: () => setClip(targets, 'cut') })
    }
    items.push({
      label: clipboard ? `붙여넣기${folder ? ' (폴더 안)' : ''}${clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}` : '붙여넣기',
      disabled: !clipboard || !pasteTarget,
      onClick: () => void paste(pasteTarget),
    })
    if (files.length > 0) {
      items.push({ label: `가져오기${files.length > 1 ? ` (${files.length})` : ''}`, onClick: () => fetchFiles(files) })
    }
    if (targets.length === 1 && !targets[0].isDirectory) {
      items.push({ label: '다운로드 링크', onClick: () => void createDownloadLink(targets[0]) })
    }
    if (targets.length > 0) {
      items.push({ label: `압축 (ZIP)${targets.length > 1 ? ` (${targets.length}개 합쳐서)` : ''}`, disabled: !path, onClick: () => compress(targets) })
      if (targets.length > 1) {
        items.push({ label: `각각 압축 (${targets.length}개)`, disabled: !path, onClick: () => compressEach(targets) })
      }
      items.push({ label: '분할 압축…', disabled: !path, onClick: () => setSplitTargets(targets) })
    }
    if (targets.length === 1 && isVideoFile(targets[0].name)) {
      items.push({ label: '내려받지 않고 재생', onClick: () => setPlaying({ path: targets[0].fullPath, name: targets[0].name }) })
    }
    if (targets.length > 0) {
      items.push({ label: '경로 복사', onClick: () => void copyText(targets.map((t) => t.fullPath).join('\n')) })
    }
    const favPaths = targets.length ? targets.filter((t) => t.isDirectory).map((t) => t.fullPath) : path ? [path] : []
    if (favPaths.length > 0) {
      items.push({
        label: `즐겨찾기에 추가${favPaths.length > 1 ? ` (${favPaths.length})` : ''}`,
        onClick: () => favPaths.forEach(onAddFavorite),
      })
    }
    if (targets.length > 0) {
      items.push({ separator: true })
      if (targets.length === 1) items.push({ label: '이름 바꾸기', onClick: () => void rename(targets[0]) })
      items.push({ label: `삭제${targets.length > 1 ? ` (${targets.length})` : ''}`, danger: true, onClick: () => void remove(targets) })
    }
    items.push({ separator: true })
    items.push({ label: '새 폴더', disabled: !path, onClick: () => void createFolder() })
    items.push({ label: '터미널 열기', onClick: () => setTerminal(true) })
    return items
  }

  const openRowMenu = (e: React.MouseEvent, entry: FileEntry, index: number) => {
    e.preventDefault()
    e.stopPropagation()
    let targetSet = selected
    if (!selected.has(entry.fullPath)) {
      targetSet = new Set([entry.fullPath])
      setSelected(targetSet)
      anchorRef.current = index
    }
    const targets = displayed.filter((en) => targetSet.has(en.fullPath))
    setMenu({ x: e.clientX, y: e.clientY, targets: targets.length ? targets : [entry], folder: entry.isDirectory ? entry.fullPath : null })
  }

  const openEmptyMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, targets: [], folder: null })
  }

  // 드라이브 트리 노드 우클릭: 드라이브 루트는 안전한 항목만, 폴더는 파일 목록의 폴더 메뉴와 같게
  const openTreeMenu = (e: React.MouseEvent, entry: FileEntry, isDrive: boolean) => {
    e.preventDefault()
    e.stopPropagation()
    const open: MenuItem = { label: '열기', onClick: () => navigate(entry.fullPath) }
    const items: MenuItem[] = isDrive
      ? [
          open,
          { separator: true },
          {
            label: clipboard ? `붙여넣기${clipboard.items.length > 1 ? ` (${clipboard.items.length})` : ''}` : '붙여넣기',
            disabled: !clipboard,
            onClick: () => void paste(entry.fullPath),
          },
          { label: '즐겨찾기에 추가', onClick: () => onAddFavorite(entry.fullPath) },
          { label: '경로 복사', onClick: () => void copyText(entry.fullPath) },
          { separator: true },
          { label: '터미널 열기', onClick: () => setTerminal(true) },
        ]
      : [open, { separator: true }, ...buildMenu([entry], entry.fullPath)]
    setMenu({ x: e.clientX, y: e.clientY, targets: [], folder: null, items })
  }

  const openFavMenu = (e: React.MouseEvent, fp: string) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({
      x: e.clientX,
      y: e.clientY,
      targets: [],
      folder: null,
      items: [
        { label: '열기', onClick: () => navigate(fp) },
        { label: '경로 복사', onClick: () => void copyText(fp) },
        { separator: true },
        { label: '즐겨찾기 제거', danger: true, onClick: () => onRemoveFavorite(fp) },
      ],
    })
  }

  const style = width && height ? { width, height } : undefined

  const rowClass = (entry: FileEntry, isSel: boolean, cut: boolean) =>
    `${entry.isDirectory ? 'dir' : isVideoFile(entry.name) ? 'file video' : 'file'}${isSel ? ' selected' : ''}${cut ? ' cut' : ''}${entry.hidden ? ' hidden-entry' : ''}`
  const iconFor = (entry: FileEntry) => (entry.isDirectory ? 'folder' : isVideoFile(entry.name) ? 'video' : 'file')
  const isCut = (entry: FileEntry) =>
    clipboard?.mode === 'cut' && clipboard.agentId === agentId && clipboard.items.some((i) => i.path === entry.fullPath)

  return (
    <section
      ref={sectionRef}
      className={`panel pane${active ? ' pane-active' : ''}`}
      style={style}
      onMouseDownCapture={onActivate}
      onMouseUp={saveSizeIfChanged}
    >
      {/* 폴더 탭 + PC 이름 */}
      <div className="pane-tabs">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`pane-tab${t.id === activeTabId ? ' active' : ''}`}
            title={tabLabel(t.stack[t.idx])}
            onMouseDown={() => setActiveTabId(t.id)}
          >
            <Icon name="folder" size={14} className="pane-tab-ico" />
            <span className="ellipsis">{tabLabel(t.stack[t.idx])}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                className="pane-tab-x"
                title="탭 닫기"
                onMouseDown={(e) => {
                  e.stopPropagation()
                  closeTab(t.id)
                }}
              >
                <Icon name="close" size={11} />
              </button>
            )}
          </div>
        ))}
        <button type="button" className="pane-tab-add" title="새 탭" onClick={addTab}><Icon name="plus" size={15} /></button>
        <span className="pane-tabs-spacer" />
        <span
          className="pane-id"
          draggable
          title="드래그해서 위치 이동"
          onDragStart={(e) => {
            e.dataTransfer.setData(PANE_MIME, paneId)
            e.dataTransfer.effectAllowed = 'move'
          }}
        >
          <span className={`dot ${online ? 'on' : 'off'}`} />
          <span className="ellipsis">{machineName}</span>
        </span>
        <button type="button" className="icon pane-close" title="창 닫기" onClick={onClose}>✕</button>
      </div>

      {error && <div className="output-error">{error}</div>}
      {notice && (
        <div className="pane-notice">
          <span className="ellipsis">{notice}</span>
          <button type="button" className="icon-mini" title="닫기" onClick={() => setNotice(null)}>✕</button>
        </div>
      )}

      <div className="pane-body">
        <div className="pane-side" style={{ width: sideWidth }}>
          <div className="pane-side-section">
            <div className="pane-side-title">즐겨찾기</div>
            {favorites.length === 0 && <div className="drive-hint small muted">폴더 우클릭 → 즐겨찾기에 추가</div>}
            <ul className="fav-list">
              {favorites.map((fp, i) => (
                <li
                  key={fp}
                  className={`fav-item${samePath(fp, path) ? ' current' : ''}${favOverIndex === i ? ' fav-over' : ''}`}
                  draggable
                  onDragStart={(e) => {
                    favDragIndex.current = i
                    e.dataTransfer.effectAllowed = 'move'
                    e.dataTransfer.setData('text/plain', fp)
                  }}
                  onDragOver={(e) => {
                    if (favDragIndex.current !== null) {
                      e.preventDefault()
                      setFavOverIndex(i)
                    }
                  }}
                  onDragLeave={() => setFavOverIndex((v) => (v === i ? null : v))}
                  onDrop={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    if (favDragIndex.current !== null) reorderFavorites(favDragIndex.current, i)
                    favDragIndex.current = null
                    setFavOverIndex(null)
                  }}
                  onDragEnd={() => {
                    favDragIndex.current = null
                    setFavOverIndex(null)
                  }}
                  onContextMenu={(e) => openFavMenu(e, fp)}
                >
                  <span className="fav-grip" aria-hidden="true">⠿</span>
                  <button type="button" className="drive-name ellipsis fav-btn" title={fp} onClick={() => navigate(fp)}>
                    <Icon name="star" size={13} /> {favName(fp)}
                  </button>
                  <button type="button" className="icon-mini" title="즐겨찾기 제거" onClick={() => onRemoveFavorite(fp)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <DriveTree agentId={agentId} currentPath={path} onNavigate={navigate} onContextMenu={openTreeMenu} />
        </div>

        <div className="pane-side-resizer" title="드래그해서 폭 조절" onMouseDown={startSideResize} />

        <div
          className={`table-wrap${dragOver ? ' drop-active' : ''}`}
          onContextMenu={openEmptyMenu}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes(PANE_MIME) || e.dataTransfer.types.includes(FILES_MIME)) {
              e.preventDefault()
              setDragOver(true)
            }
          }}
          onDragLeave={(e) => {
            if (e.currentTarget === e.target) setDragOver(false)
          }}
          onDrop={(e) => {
            setDragOver(false)
            setDropDir(null)
            const files = e.dataTransfer.getData(FILES_MIME)
            if (files) {
              e.preventDefault()
              void dropFiles(path, files) // 현재 폴더로 이동
              return
            }
            const from = e.dataTransfer.getData(PANE_MIME)
            if (from && from !== paneId) {
              e.preventDefault()
              onReorderDrop(from)
            }
          }}
        >
          {!online ? (
            <div className="pane-empty placeholder">오프라인 PC</div>
          ) : displayed.length === 0 ? (
            <div className="pane-empty placeholder">
              {search ? '검색 결과가 없습니다' : loading ? '불러오는 중…' : '빈 폴더입니다 (우클릭으로 새 폴더·붙여넣기)'}
            </div>
          ) : view === 'details' ? (
            <table
              className="noselect details-table"
              style={
                colWidths.name
                  ? {
                      width:
                        colWidths.name +
                        (columns.modified ? colWidths.modified : 0) +
                        (columns.type ? colWidths.type : 0) +
                        (columns.size ? colWidths.size : 0),
                      minWidth: '100%',
                    }
                  : {
                      // 이름 열이 아주 좁아지지 않게 최소 폭 보장 (그보다 좁으면 가로 스크롤)
                      minWidth:
                        140 +
                        (columns.modified ? colWidths.modified : 0) +
                        (columns.type ? colWidths.type : 0) +
                        (columns.size ? colWidths.size : 0),
                    }
              }
            >
              <colgroup>
                <col style={colWidths.name ? { width: colWidths.name } : undefined} />
                {columns.modified && <col style={{ width: colWidths.modified }} />}
                {columns.type && <col style={{ width: colWidths.type }} />}
                {columns.size && <col style={{ width: colWidths.size }} />}
              </colgroup>
              <thead>
                <tr>
                  {(
                    [
                      ['name', '이름'],
                      ['modified', '수정한 날짜'],
                      ['type', '유형'],
                      ['size', '크기'],
                    ] as const
                  ).filter(([key]) => key === 'name' || columns[key]).map(([key, label]) => (
                    <th key={key} className="sortable" onClick={() => applySort(key)}>
                      {label}
                      {sortKey === key ? (sortAsc ? ' ▲' : ' ▼') : ''}
                      <span className="col-resizer" title="드래그해서 너비 조절" onMouseDown={(e) => startColResize(key, e)} onClick={(e) => e.stopPropagation()} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayed.map((entry, index) => {
                  const isSel = selected.has(entry.fullPath)
                  return (
                    <tr
                      key={entry.fullPath}
                      className={`${rowClass(entry, isSel, isCut(entry))}${dropDir === entry.fullPath ? ' drop-into' : ''}`}
                      draggable
                      onDragStart={(e) => startFileDrag(e, entry)}
                      onClick={(e) => selectClick(e, entry, index)}
                      onDoubleClick={() => openEntry(entry)}
                      onContextMenu={(e) => openRowMenu(e, entry, index)}
                      onDragOver={entry.isDirectory ? (e) => {
                        if (e.dataTransfer.types.includes(FILES_MIME)) {
                          e.preventDefault()
                          e.stopPropagation()
                          setDropDir(entry.fullPath)
                        }
                      } : undefined}
                      onDragLeave={entry.isDirectory ? () => setDropDir((d) => (d === entry.fullPath ? null : d)) : undefined}
                      onDrop={entry.isDirectory ? (e) => {
                        const files = e.dataTransfer.getData(FILES_MIME)
                        if (files) {
                          e.preventDefault()
                          e.stopPropagation()
                          setDropDir(null)
                          setDragOver(false)
                          void dropFiles(entry.fullPath, files)
                        }
                      } : undefined}
                    >
                      <td className="ellipsis">
                        <Icon name={iconFor(entry)} className="file-icon" />
                        {entry.name}
                      </td>
                      {columns.modified && <td className="col-date">{entry.modifiedAt ? formatFileDate(entry.modifiedAt) : ''}</td>}
                      {columns.type && <td className="ellipsis">{fileTypeLabel(entry)}</td>}
                      {columns.size && <td className="col-size">{entry.isDirectory ? '' : formatBytes(entry.size)}</td>}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          ) : (
            <div className="icons-grid noselect">
              {displayed.map((entry, index) => {
                const isSel = selected.has(entry.fullPath)
                return (
                  <div
                    key={entry.fullPath}
                    className={`icon-tile ${rowClass(entry, isSel, isCut(entry))}${dropDir === entry.fullPath ? ' drop-into' : ''}`}
                    title={entry.name}
                    draggable
                    onDragStart={(e) => startFileDrag(e, entry)}
                    onClick={(e) => selectClick(e, entry, index)}
                    onDoubleClick={() => openEntry(entry)}
                    onContextMenu={(e) => openRowMenu(e, entry, index)}
                    onDragOver={entry.isDirectory ? (e) => {
                      if (e.dataTransfer.types.includes(FILES_MIME)) {
                        e.preventDefault()
                        e.stopPropagation()
                        setDropDir(entry.fullPath)
                      }
                    } : undefined}
                    onDragLeave={entry.isDirectory ? () => setDropDir((d) => (d === entry.fullPath ? null : d)) : undefined}
                    onDrop={entry.isDirectory ? (e) => {
                      const files = e.dataTransfer.getData(FILES_MIME)
                      if (files) {
                        e.preventDefault()
                        e.stopPropagation()
                        setDropDir(null)
                        setDragOver(false)
                        void dropFiles(entry.fullPath, files)
                      }
                    } : undefined}
                  >
                    <Icon name={iconFor(entry)} size={44} className="icon-tile-ico" />
                    <span className="icon-tile-name ellipsis-2">{entry.name}</span>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => e.target.files && void pushFiles(e.target.files)} />

      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items ?? buildMenu(menu.targets, menu.folder)} onClose={() => setMenu(null)} />}

      {viewing && (
        <FileViewer
          agentId={agentId}
          path={viewing.path}
          name={viewing.name}
          kind={viewing.kind}
          readOnly={viewing.readOnly}
          onFetch={() => fetchFiles([{ fullPath: viewing.path, name: viewing.name, isDirectory: false, size: 0, modifiedAt: null }])}
          onSaved={() => {
            if (path) load(path)
          }}
          onPasswordNeeded={() => {
            const archive = listing?.archivePath
            return archive ? askArchivePassword(archive) : Promise.resolve(false)
          }}
          onClose={() => setViewing(null)}
        />
      )}
      {playing && (
        <VideoViewer agentId={agentId} path={playing.path} name={playing.name} onFetch={() => fetchFiles([{ fullPath: playing.path, name: playing.name, isDirectory: false, size: 0, modifiedAt: null }])} onClose={() => setPlaying(null)} />
      )}

      {terminal && (
        <TerminalModal agentId={agentId} machineName={machineName} path={path} watchRun={watchRun} onClose={() => setTerminal(false)} />
      )}

      {remote && <RemoteModal agentId={agentId} machineName={machineName} userId={selfUserId} onClose={() => setRemote(false)} />}

      {splitTargets && (
        <SplitCompressModal
          count={splitTargets.length}
          onConfirm={(bytes) => {
            compressSplit(splitTargets, bytes)
            setSplitTargets(null)
          }}
          onClose={() => setSplitTargets(null)}
        />
      )}
    </section>
  )
}
