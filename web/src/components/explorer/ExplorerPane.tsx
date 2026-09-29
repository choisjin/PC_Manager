import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { api, type DirectoryListing, type FileEntry, type Transfer } from '../../api'
import { isVideoFile } from '../../fileTypes'
import { formatBytes, formatTime } from '../../format'
import type { SubscribeTransfers, WatchRun } from '../../useDashboard'
import { VideoViewer } from '../VideoViewer'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { copyText, type FileClipboard, PANE_MIME } from './pcGroups'
import { TerminalModal } from './TerminalModal'

export interface Pane {
  paneId: string
  agentId: string
}

interface Props {
  paneId: string
  agentId: string
  machineName: string
  online: boolean
  clipboard: FileClipboard | null
  setClipboard: (clipboard: FileClipboard | null) => void
  subscribeTransfers: SubscribeTransfers
  watchRun: WatchRun
  onClose: () => void
  onReorderDrop: (fromPaneId: string) => void
}

const joinPath = (directory: string, name: string) =>
  /[\\/]$/.test(directory) ? directory + name : `${directory}\\${name}`

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ExplorerPane({
  paneId,
  agentId,
  machineName,
  online,
  clipboard,
  setClipboard,
  subscribeTransfers,
  watchRun,
  onClose,
  onReorderDrop,
}: Props) {
  const [path, setPath] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(online)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<{ path: string; name: string } | null>(null)
  const [terminal, setTerminal] = useState(false)
  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)

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
    if (transfer.agentId === agentId && transfer.kind === 'Push' && transfer.state === 'Succeeded' && path) load(path)
  })

  useEffect(() => {
    loadDrives()
  }, [])

  useEffect(() => {
    const unsubscribe = subscribeTransfers((transfer) => onTransferUpdated(transfer))
    return () => unsubscribe()
  }, [subscribeTransfers])

  const fetchFile = async (fullPath: string) => {
    try {
      await api.fetchFile(agentId, fullPath)
    } catch (err) {
      setError(toMessage(err))
    }
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

  // --- 우클릭 메뉴 동작 ---
  const paste = async (targetFolder: string) => {
    if (!clipboard || !targetFolder) return
    setError(null)
    try {
      if (clipboard.agentId === agentId) {
        const result = await api.fileOp(agentId, clipboard.mode === 'cut' ? 'Move' : 'Copy', clipboard.path, targetFolder)
        if (!result.success) throw new Error(result.error ?? '붙여넣기 실패')
      } else {
        if (clipboard.isDir) throw new Error('PC 간에는 폴더 복사를 아직 지원하지 않습니다 (파일만 가능).')
        const result = await api.crossCopy({
          sourceAgentId: clipboard.agentId,
          sourcePath: clipboard.path,
          destAgentId: agentId,
          destFolder: targetFolder,
          move: clipboard.mode === 'cut',
        })
        if (!result.success) throw new Error(result.error ?? '붙여넣기 실패')
      }
      if (clipboard.mode === 'cut') setClipboard(null)
      refresh()
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const remove = async (entry: FileEntry) => {
    if (!window.confirm(`'${entry.name}'을(를) 삭제합니다. 되돌릴 수 없습니다. 계속할까요?`)) return
    const result = await api.fileOp(agentId, 'Delete', entry.fullPath)
    if (!result.success) setError(result.error ?? '삭제 실패')
    else refresh()
  }

  const rename = async (entry: FileEntry) => {
    const name = window.prompt('새 이름', entry.name)
    if (!name || name === entry.name) return
    const result = await api.fileOp(agentId, 'Rename', entry.fullPath, name)
    if (!result.success) setError(result.error ?? '이름 바꾸기 실패')
    else refresh()
  }

  const createFolder = async () => {
    if (!path) {
      setError('폴더를 먼저 여세요.')
      return
    }
    const name = window.prompt('새 폴더 이름', '새 폴더')
    if (!name) return
    const result = await api.fileOp(agentId, 'CreateDirectory', path, name)
    if (!result.success) setError(result.error ?? '폴더 생성 실패')
    else refresh()
  }

  const buildMenu = (entry: FileEntry | null): MenuItem[] => {
    const pasteTarget = entry?.isDirectory ? entry.fullPath : path
    const items: MenuItem[] = []
    if (entry) {
      const clip = (mode: 'copy' | 'cut') => () =>
        setClipboard({ agentId, path: entry.fullPath, name: entry.name, isDir: entry.isDirectory, mode })
      items.push({ label: '복사', onClick: clip('copy') })
      items.push({ label: '잘라내기', onClick: clip('cut') })
    }
    items.push({
      label: clipboard ? `붙여넣기${entry?.isDirectory ? ' (폴더 안)' : ''}` : '붙여넣기',
      disabled: !clipboard || !pasteTarget,
      onClick: () => void paste(pasteTarget),
    })
    if (entry) {
      items.push({ label: '경로 복사', onClick: () => void copyText(entry.fullPath) })
      items.push({ separator: true })
      items.push({ label: '이름 바꾸기', onClick: () => void rename(entry) })
      items.push({ label: '삭제', danger: true, onClick: () => void remove(entry) })
    }
    items.push({ separator: true })
    items.push({ label: '새 폴더', disabled: !path, onClick: () => void createFolder() })
    items.push({ label: '터미널 열기', onClick: () => setTerminal(true) })
    return items
  }

  const openMenu = (e: React.MouseEvent, entry: FileEntry | null) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, entry })
  }

  return (
    <section className="panel pane">
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

      <div
        className={`table-wrap${dragOver ? ' drop-active' : ''}`}
        onContextMenu={(e) => openMenu(e, null)}
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
        <table>
          <colgroup>
            <col />
            <col style={{ width: 84 }} />
            <col style={{ width: 116 }} />
            <col style={{ width: 118 }} />
          </colgroup>
          <thead>
            <tr>
              <th>이름</th>
              <th>크기</th>
              <th>수정</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {!online && (
              <tr>
                <td colSpan={4} className="placeholder">
                  오프라인 PC
                </td>
              </tr>
            )}
            {online && listing && listing.entries.length === 0 && (
              <tr>
                <td colSpan={4} className="placeholder">
                  빈 폴더입니다 (우클릭으로 새 폴더·붙여넣기)
                </td>
              </tr>
            )}
            {listing?.entries.map((entry) => {
              const cut = clipboard?.mode === 'cut' && clipboard.agentId === agentId && clipboard.path === entry.fullPath
              return (
                <tr
                  key={entry.fullPath}
                  className={`${entry.isDirectory ? 'dir' : isVideoFile(entry.name) ? 'file video' : 'file'}${cut ? ' cut' : ''}`}
                  title={entry.isDirectory ? '열기' : isVideoFile(entry.name) ? '재생' : undefined}
                  onClick={() => {
                    if (entry.isDirectory) load(entry.fullPath)
                    else if (isVideoFile(entry.name)) setPlaying({ path: entry.fullPath, name: entry.name })
                  }}
                  onContextMenu={(e) => openMenu(e, entry)}
                >
                  <td className="ellipsis">
                    <span className="file-icon" aria-hidden="true">
                      {entry.isDirectory ? '📁' : isVideoFile(entry.name) ? '🎬' : '📄'}
                    </span>
                    {entry.name}
                  </td>
                  <td>{entry.isDirectory ? '' : formatBytes(entry.size)}</td>
                  <td>{entry.modifiedAt ? formatTime(entry.modifiedAt) : ''}</td>
                  <td className="row-actions">
                    {!entry.isDirectory && isVideoFile(entry.name) && (
                      <button type="button" className="link" onClick={(e) => { e.stopPropagation(); setPlaying({ path: entry.fullPath, name: entry.name }) }}>
                        재생
                      </button>
                    )}
                    {!entry.isDirectory && (
                      <button type="button" className="link" onClick={(e) => { e.stopPropagation(); void fetchFile(entry.fullPath) }}>
                        가져오기
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} items={buildMenu(menu.entry)} onClose={() => setMenu(null)} />}

      {playing && (
        <VideoViewer agentId={agentId} path={playing.path} name={playing.name} onFetch={() => void fetchFile(playing.path)} onClose={() => setPlaying(null)} />
      )}

      {terminal && (
        <TerminalModal agentId={agentId} machineName={machineName} path={path} watchRun={watchRun} onClose={() => setTerminal(false)} />
      )}
    </section>
  )
}
