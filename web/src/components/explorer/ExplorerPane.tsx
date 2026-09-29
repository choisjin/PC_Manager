import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { api, type DirectoryListing, type FileEntry, type Transfer } from '../../api'
import { isVideoFile } from '../../fileTypes'
import { formatBytes, formatTime } from '../../format'
import type { SubscribeTransfers, WatchRun } from '../../useDashboard'
import { VideoViewer } from '../VideoViewer'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { DriveTree } from './DriveTree'
import { copyText, type FileClipboard, PANE_MIME } from './pcGroups'
import { SplitCompressModal } from './SplitCompressModal'
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
  width?: number
  height?: number
  clipboard: FileClipboard | null
  setClipboard: (clipboard: FileClipboard | null) => void
  favorites: string[]
  onAddFavorite: (path: string) => void
  onRemoveFavorite: (path: string) => void
  subscribeTransfers: SubscribeTransfers
  watchRun: WatchRun
  onClose: () => void
  onReorderDrop: (fromPaneId: string) => void
  onResize: (w: number, h: number) => void
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

const favName = (p: string) => {
  const trimmed = p.replace(/[\\/]+$/, '')
  return trimmed.split(/[\\/]/).pop() || p
}

const joinPath = (directory: string, name: string) =>
  /[\\/]$/.test(directory) ? directory + name : `${directory}\\${name}`

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ExplorerPane({
  paneId,
  agentId,
  machineName,
  online,
  width,
  height,
  clipboard,
  setClipboard,
  favorites,
  onAddFavorite,
  onRemoveFavorite,
  subscribeTransfers,
  watchRun,
  onClose,
  onReorderDrop,
  onResize,
}: Props) {
  const [path, setPath] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(online)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<{ path: string; name: string } | null>(null)
  const [terminal, setTerminal] = useState(false)
  const [splitTargets, setSplitTargets] = useState<FileEntry[] | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; targets: FileEntry[]; folder: string | null } | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const requestRef = useRef(0)
  const anchorRef = useRef(-1)

  const showListing = (requestId: number, result: DirectoryListing) => {
    if (requestId !== requestRef.current) return
    setLoading(false)
    if (result.error) {
      setError(result.error)
      return
    }
    setError(null)
    setListing(result)
    setPath(result.path)
    setPathInput(result.path)
    setSelected(new Set())
    anchorRef.current = -1
  }

  const load = (target: string) => {
    const requestId = ++requestRef.current
    setLoading(true)
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

  const loadDrives = useEffectEvent(() => load(''))

  const onTransferUpdated = useEffectEvent((transfer: Transfer) => {
    // 이 PC로의 올리기·압축이 끝나면 목록을 새로 고쳐 새 파일(zip 등)을 보여준다
    if (transfer.agentId === agentId && (transfer.kind === 'Push' || transfer.kind === 'Compress') && transfer.state === 'Succeeded' && path) load(path)
  })

  useEffect(() => {
    loadDrives()
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeTransfers((transfer) => onTransferUpdated(transfer))
    return () => unsubscribe()
  }, [subscribeTransfers])

  // 모서리 드래그 리사이즈 후(마우스 뗄 때) 크기가 바뀌었으면 저장한다.
  // (마운트 시점 관측이 저장된 크기를 덮어쓰지 않도록 ResizeObserver 대신 이 방식을 쓴다)
  const saveSizeIfChanged = () => {
    const el = sectionRef.current
    if (!el) return
    const w = Math.round(el.offsetWidth)
    const h = Math.round(el.offsetHeight)
    if (w !== (width ?? 0) || h !== (height ?? 0)) onResize(w, h)
  }

  const fetchFiles = (entries: FileEntry[]) => {
    entries
      .filter((e) => !e.isDirectory)
      .forEach((e) => void api.fetchFile(agentId, e.fullPath).catch((err) => setError(toMessage(err))))
  }

  // 선택 항목을 하나의 zip으로 (이름은 서버가 정한다). 진행 상황은 하단 전송 기록에 표시된다.
  const compress = (targets: FileEntry[]) => {
    if (!path || targets.length === 0) return
    setError(null)
    void api.compressFiles(agentId, targets.map((t) => t.fullPath), path).catch((err) => setError(toMessage(err)))
  }

  // 선택 항목을 각각 개별 zip으로
  const compressEach = (targets: FileEntry[]) => {
    if (!path || targets.length === 0) return
    setError(null)
    for (const t of targets) void api.compressFiles(agentId, [t.fullPath], path).catch((err) => setError(toMessage(err)))
  }

  // 분할 압축: 하나의 zip으로 만든 뒤 지정 크기로 .zip.001, .002 … 볼륨 분할
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

  // --- 선택 ---
  const selectClick = (e: React.MouseEvent, entry: FileEntry, index: number) => {
    const entries = listing?.entries ?? []
    if (e.shiftKey && anchorRef.current >= 0) {
      const [a, b] = [anchorRef.current, index].sort((x, y) => x - y)
      setSelected(new Set(entries.slice(a, b + 1).map((en) => en.fullPath)))
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
    if (entry.isDirectory) load(entry.fullPath)
    else if (isVideoFile(entry.name)) setPlaying({ path: entry.fullPath, name: entry.name })
    else fetchFiles([entry])
  }

  // --- 파일 조작 ---
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
    // 즐겨찾기: 폴더 대상 또는 현재 폴더
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
    // 선택에 없는 항목을 우클릭하면 그 항목만 선택
    let targetSet = selected
    if (!selected.has(entry.fullPath)) {
      targetSet = new Set([entry.fullPath])
      setSelected(targetSet)
      anchorRef.current = index
    }
    const targets = (listing?.entries ?? []).filter((en) => targetSet.has(en.fullPath))
    setMenu({ x: e.clientX, y: e.clientY, targets: targets.length ? targets : [entry], folder: entry.isDirectory ? entry.fullPath : null })
  }

  const openEmptyMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, targets: [], folder: null })
  }

  const style = width && height ? { width, height } : undefined

  return (
    <section ref={sectionRef} className="panel pane" style={style} onMouseUp={saveSizeIfChanged}>
      <div className="panel-head pane-head">
        <span
          className="pane-title"
          draggable
          title="드래그해서 위치 이동"
          onDragStart={(e) => {
            e.dataTransfer.setData(PANE_MIME, paneId)
            e.dataTransfer.effectAllowed = 'move'
          }}
        >
          <span className={`dot ${online ? 'on' : 'off'}`} />
          <span className="ellipsis">{machineName}</span>
          {selected.size > 0 && <span className="muted small">· {selected.size}개 선택</span>}
        </span>
        <span className="pane-head-actions">
          <button type="button" className="icon" title="터미널 열기" onClick={() => setTerminal(true)}>
            {'>_'}
          </button>
          <button type="button" className="icon" title="상위 폴더" disabled={loading || listing?.parentPath == null} onClick={() => listing?.parentPath != null && load(listing.parentPath)}>
            ↑
          </button>
          <button type="button" className="icon" title="새로 고침" disabled={loading} onClick={refresh}>
            ⟳
          </button>
          <button type="button" className="icon" title={path ? '올리기' : '폴더를 연 뒤 올리기'} disabled={!path} onClick={() => fileInputRef.current?.click()}>
            ⬆
          </button>
          <button type="button" className="icon" title="닫기" onClick={onClose}>
            ✕
          </button>
          <input ref={fileInputRef} type="file" multiple hidden onChange={(e) => e.target.files && void pushFiles(e.target.files)} />
        </span>
      </div>

      <form
        className="pane-path"
        onSubmit={(e) => {
          e.preventDefault()
          load(pathInput.trim())
        }}
      >
        <input className="mono" aria-label="경로" value={pathInput} placeholder="드라이브 목록 (경로 입력 후 Enter)" onChange={(e) => setPathInput(e.target.value)} />
      </form>

      {error && <div className="output-error">{error}</div>}

      <div className="pane-body">
        <div className="pane-side">
          <div className="pane-side-section">
            <div className="pane-side-title">즐겨찾기</div>
            {favorites.length === 0 && <div className="drive-hint small muted">폴더 우클릭 → 즐겨찾기에 추가</div>}
            <ul className="fav-list">
              {favorites.map((fp) => (
                <li key={fp} className={`fav-item${samePath(fp, path) ? ' current' : ''}`}>
                  <button type="button" className="drive-name ellipsis" title={fp} onClick={() => load(fp)}>
                    ⭐ {favName(fp)}
                  </button>
                  <button type="button" className="icon-mini" title="즐겨찾기 제거" onClick={() => onRemoveFavorite(fp)}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
          <DriveTree agentId={agentId} currentPath={path} onNavigate={load} />
        </div>

        <div
          className={`table-wrap${dragOver ? ' drop-active' : ''}`}
          onContextMenu={openEmptyMenu}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes(PANE_MIME)) {
            e.preventDefault()
            setDragOver(true)
          }
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          setDragOver(false)
          const from = e.dataTransfer.getData(PANE_MIME)
          if (from && from !== paneId) {
            e.preventDefault()
            onReorderDrop(from)
          }
        }}
      >
        <table className="noselect">
          <colgroup>
            <col />
            <col style={{ width: 90 }} />
            <col style={{ width: 130 }} />
          </colgroup>
          <thead>
            <tr>
              <th>이름</th>
              <th>크기</th>
              <th>수정</th>
            </tr>
          </thead>
          <tbody>
            {!online && (
              <tr>
                <td colSpan={3} className="placeholder">
                  오프라인 PC
                </td>
              </tr>
            )}
            {online && listing && listing.entries.length === 0 && (
              <tr>
                <td colSpan={3} className="placeholder">
                  빈 폴더입니다 (우클릭으로 새 폴더·붙여넣기)
                </td>
              </tr>
            )}
            {listing?.entries.map((entry, index) => {
              const isSel = selected.has(entry.fullPath)
              const cut = clipboard?.mode === 'cut' && clipboard.agentId === agentId && clipboard.items.some((i) => i.path === entry.fullPath)
              return (
                <tr
                  key={entry.fullPath}
                  className={`${entry.isDirectory ? 'dir' : isVideoFile(entry.name) ? 'file video' : 'file'}${isSel ? ' selected' : ''}${cut ? ' cut' : ''}`}
                  onClick={(e) => selectClick(e, entry, index)}
                  onDoubleClick={() => openEntry(entry)}
                  onContextMenu={(e) => openRowMenu(e, entry, index)}
                >
                  <td className="ellipsis">
                    <span className="file-icon" aria-hidden="true">
                      {entry.isDirectory ? '📁' : isVideoFile(entry.name) ? '🎬' : '📄'}
                    </span>
                    {entry.name}
                  </td>
                  <td>{entry.isDirectory ? '' : formatBytes(entry.size)}</td>
                  <td>{entry.modifiedAt ? formatTime(entry.modifiedAt) : ''}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        </div>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.targets, menu.folder)} onClose={() => setMenu(null)} />}

      {playing && (
        <VideoViewer agentId={agentId} path={playing.path} name={playing.name} onFetch={() => fetchFiles([{ fullPath: playing.path, name: playing.name, isDirectory: false, size: 0, modifiedAt: null }])} onClose={() => setPlaying(null)} />
      )}

      {terminal && (
        <TerminalModal agentId={agentId} machineName={machineName} path={path} watchRun={watchRun} onClose={() => setTerminal(false)} />
      )}

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
