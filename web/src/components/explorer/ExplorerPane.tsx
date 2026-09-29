import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { api, type DirectoryListing, type Transfer } from '../../api'
import { isVideoFile } from '../../fileTypes'
import { formatBytes, formatTime } from '../../format'
import type { SubscribeTransfers } from '../../useDashboard'
import { VideoViewer } from '../VideoViewer'
import { PANE_MIME } from './pcGroups'

export interface Pane {
  paneId: string
  agentId: string
}

interface Props {
  paneId: string
  agentId: string
  machineName: string
  online: boolean
  subscribeTransfers: SubscribeTransfers
  onClose: () => void
  /** 패널 재배치용 드롭 (다른 패널을 이 자리로) */
  onReorderDrop: (fromPaneId: string) => void
}

const joinPath = (directory: string, name: string) =>
  /[\\/]$/.test(directory) ? directory + name : `${directory}\\${name}`

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function ExplorerPane({ paneId, agentId, machineName, online, subscribeTransfers, onClose, onReorderDrop }: Props) {
  const [path, setPath] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(online)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<{ path: string; name: string } | null>(null)
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

  const loadDrives = useEffectEvent(() => load(''))

  // 이 PC의 현재 폴더로 올리기가 끝나면 새로 고친다
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
          <button type="button" className="icon" title="상위 폴더" disabled={loading || listing?.parentPath == null} onClick={() => listing?.parentPath != null && load(listing.parentPath)}>
            ↑
          </button>
          <button type="button" className="icon" title="새로 고침" disabled={loading} onClick={() => load(path)}>
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
                  빈 폴더입니다
                </td>
              </tr>
            )}
            {listing?.entries.map((entry) => (
              <tr
                key={entry.fullPath}
                className={entry.isDirectory ? 'dir' : isVideoFile(entry.name) ? 'file video' : 'file'}
                title={entry.isDirectory ? '열기' : isVideoFile(entry.name) ? '재생' : undefined}
                onClick={() => {
                  if (entry.isDirectory) load(entry.fullPath)
                  else if (isVideoFile(entry.name)) setPlaying({ path: entry.fullPath, name: entry.name })
                }}
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
            ))}
          </tbody>
        </table>
      </div>

      {playing && (
        <VideoViewer agentId={agentId} path={playing.path} name={playing.name} onFetch={() => void fetchFile(playing.path)} onClose={() => setPlaying(null)} />
      )}
    </section>
  )
}
