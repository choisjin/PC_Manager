import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { api, type DirectoryListing, type FileEntry, type Transfer } from '../../api'
import { isVideoFile } from '../../fileTypes'
import { formatBytes } from '../../format'
import type { SubscribeTransfers, WatchRun } from '../../useDashboard'
import { VideoViewer } from '../VideoViewer'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { DriveTree } from './DriveTree'
import { Icon } from './Icon'
import { copyText, type FileClipboard, FILES_MIME, type FilesDragPayload, newId, PANE_MIME } from './pcGroups'
import { fileTypeLabel, type PaneController, sortEntries, type SortKey, type ViewMode } from './paneController'
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
  active: boolean
  onActivate: () => void
  onControllerChange: (controller: PaneController) => void
  width?: number
  height?: number
  clipboard: FileClipboard | null
  setClipboard: (clipboard: FileClipboard | null) => void
  favorites: string[]
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
  machineName,
  online,
  active,
  onActivate,
  onControllerChange,
  width,
  height,
  clipboard,
  setClipboard,
  favorites,
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
  const [terminal, setTerminal] = useState(false)
  const [remote, setRemote] = useState(false)
  const [splitTargets, setSplitTargets] = useState<FileEntry[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; targets: FileEntry[]; folder: string | null } | null>(null)
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
    if (transfer.agentId === agentId && (transfer.kind === 'Push' || transfer.kind === 'Compress') && transfer.state === 'Succeeded' && path) load(path)
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
    const entries = listing?.entries ?? []
    const q = search.trim().toLowerCase()
    const filtered = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries
    return sortEntries(filtered, sortKey, sortAsc)
  }, [listing, search, sortKey, sortAsc])

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

  const openEntry = (entry: FileEntry) => {
    if (entry.isDirectory) navigate(entry.fullPath)
    else if (isVideoFile(entry.name)) setPlaying({ path: entry.fullPath, name: entry.name })
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
    canPaste: !!clipboard && !!path,
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
    setSearch,
    openTerminal: () => setTerminal(true),
    openRemote: () => setRemote(true),
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

  const buildMenu = (targets: FileEntry[], folder: string | null): MenuItem[] => {
    const pasteTarget = folder ?? path
    const files = targets.filter((t) => !t.isDirectory)
    const items: MenuItem[] = []
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
      items.push({ label: '재생', onClick: () => setPlaying({ path: targets[0].fullPath, name: targets[0].name }) })
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

  const style = width && height ? { width, height } : undefined

  const rowClass = (entry: FileEntry, isSel: boolean, cut: boolean) =>
    `${entry.isDirectory ? 'dir' : isVideoFile(entry.name) ? 'file video' : 'file'}${isSel ? ' selected' : ''}${cut ? ' cut' : ''}`
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
          <DriveTree agentId={agentId} currentPath={path} onNavigate={navigate} />
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
            <table className="noselect">
              <colgroup>
                <col />
                <col style={{ width: 132 }} />
                <col style={{ width: 80 }} />
                <col style={{ width: 62 }} />
              </colgroup>
              <thead>
                <tr>
                  <th className="sortable" onClick={() => applySort('name')}>이름{sortKey === 'name' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                  <th className="sortable" onClick={() => applySort('modified')}>수정한 날짜{sortKey === 'modified' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                  <th className="sortable" onClick={() => applySort('type')}>유형{sortKey === 'type' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
                  <th className="sortable" onClick={() => applySort('size')}>크기{sortKey === 'size' ? (sortAsc ? ' ▲' : ' ▼') : ''}</th>
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
                      <td className="col-date">{entry.modifiedAt ? formatFileDate(entry.modifiedAt) : ''}</td>
                      <td className="ellipsis">{fileTypeLabel(entry)}</td>
                      <td className="col-size">{entry.isDirectory ? '' : formatBytes(entry.size)}</td>
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

      {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.targets, menu.folder)} onClose={() => setMenu(null)} />}

      {playing && (
        <VideoViewer agentId={agentId} path={playing.path} name={playing.name} onFetch={() => fetchFiles([{ fullPath: playing.path, name: playing.name, isDirectory: false, size: 0, modifiedAt: null }])} onClose={() => setPlaying(null)} />
      )}

      {terminal && (
        <TerminalModal agentId={agentId} machineName={machineName} path={path} watchRun={watchRun} onClose={() => setTerminal(false)} />
      )}

      {remote && <RemoteModal agentId={agentId} machineName={machineName} onClose={() => setRemote(false)} />}

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
