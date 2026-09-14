import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from 'react'
import { api, type Agent, type Artifact, type DirectoryListing, type Transfer } from '../api'
import { formatBytes, formatTime } from '../format'
import type { SubscribeTransfers } from '../useDashboard'
import { StateBadge } from './StateBadge'

interface Props {
  agents: Agent[]
  selectedAgentIds: ReadonlySet<string>
  subscribeTransfers: SubscribeTransfers
}

const MAX_TRANSFERS = 30

const joinPath = (directory: string, name: string) =>
  /[\\/]$/.test(directory) ? directory + name : `${directory}\\${name}`

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

// POST 응답(대기)이 먼저 도착한 완료 이벤트를 덮어쓰지 않게 한다
function upsertTransfer(prev: Transfer[], transfer: Transfer) {
  const existing = prev.find((t) => t.id === transfer.id)
  if (existing && existing.state !== 'Pending' && transfer.state === 'Pending') return prev
  return [transfer, ...prev.filter((t) => t.id !== transfer.id)].slice(0, MAX_TRANSFERS)
}

export function FileExplorer({ agents, selectedAgentIds, subscribeTransfers }: Props) {
  const onlineAgents = agents.filter((a) => a.online)
  const [chosenAgentId, setChosenAgentId] = useState<string | null>(null)
  const agentId =
    (chosenAgentId && onlineAgents.some((a) => a.id === chosenAgentId) ? chosenAgentId : null) ??
    onlineAgents.find((a) => selectedAgentIds.has(a.id))?.id ??
    onlineAgents[0]?.id ??
    null

  const picker = (
    <select
      className="agent-select"
      aria-label="PC 선택"
      value={agentId ?? ''}
      onChange={(e) => setChosenAgentId(e.target.value)}
    >
      {onlineAgents.length === 0 && <option value="">온라인 PC 없음</option>}
      {onlineAgents.map((a) => (
        <option key={a.id} value={a.id}>
          {a.machineName}
        </option>
      ))}
    </select>
  )

  // PC가 바뀌면 탐색 상태를 새로 시작한다
  return (
    <ExplorerPane
      key={agentId ?? 'none'}
      agentId={agentId}
      picker={picker}
      subscribeTransfers={subscribeTransfers}
    />
  )
}

interface PaneProps {
  agentId: string | null
  picker: ReactNode
  subscribeTransfers: SubscribeTransfers
}

function ExplorerPane({ agentId, picker, subscribeTransfers }: PaneProps) {
  const [path, setPath] = useState('')
  const [pathInput, setPathInput] = useState('')
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [loading, setLoading] = useState(agentId !== null)
  const [error, setError] = useState<string | null>(null)
  const [transfers, setTransfers] = useState<Transfer[]>([])
  const [artifactByTransfer, setArtifactByTransfer] = useState<Record<string, Artifact>>({})
  const fileInputRef = useRef<HTMLInputElement>(null)
  const requestRef = useRef(0)

  // 늦게 도착한 이전 요청의 응답은 버린다
  const showListing = (requestId: number, result: DirectoryListing) => {
    if (requestId !== requestRef.current) return
    setLoading(false)
    if (result.error) {
      setError(result.error) // 이전 목록은 유지
      return
    }
    setError(null)
    setListing(result)
    setPath(result.path)
    setPathInput(result.path)
  }

  const showLoadError = (requestId: number, err: unknown) => {
    if (requestId !== requestRef.current) return
    setLoading(false)
    setError(toMessage(err))
  }

  const load = (target: string) => {
    if (!agentId) return
    const requestId = ++requestRef.current
    setLoading(true)
    api.listFiles(agentId, target).then(
      (result) => showListing(requestId, result),
      (err) => showLoadError(requestId, err),
    )
  }

  const resolveArtifact = (transfer: Transfer) => {
    if (transfer.kind !== 'Fetch' || transfer.state !== 'Succeeded') return
    api
      .artifacts({ transferId: transfer.id })
      .then((list) => {
        if (list[0]) setArtifactByTransfer((prev) => ({ ...prev, [transfer.id]: list[0] }))
      })
      .catch(console.error)
  }

  const loadDrives = useEffectEvent(() => {
    if (!agentId) return
    const requestId = ++requestRef.current
    api.listFiles(agentId, '').then(
      (result) => showListing(requestId, result),
      (err) => showLoadError(requestId, err),
    )
  })

  const onTransfersLoaded = useEffectEvent((list: Transfer[]) => {
    const manual = list.filter((t) => t.kind !== 'Collect').slice(0, MAX_TRANSFERS)
    setTransfers(manual)
    manual.forEach(resolveArtifact)
  })

  const onTransferUpdated = useEffectEvent((transfer: Transfer) => {
    if (transfer.agentId !== agentId || transfer.kind === 'Collect') return
    setTransfers((prev) => upsertTransfer(prev, transfer))
    resolveArtifact(transfer)
    // 올리기가 끝나면 보고 있는 폴더를 새로 고친다
    if (transfer.kind === 'Push' && transfer.state === 'Succeeded' && path) load(path)
  })

  useEffect(() => {
    loadDrives()
  }, [])

  useEffect(() => {
    if (!agentId) return
    let active = true
    api
      .transfers({ agentId })
      .then((list) => {
        if (active) onTransfersLoaded(list)
      })
      .catch(console.error)
    const unsubscribe = subscribeTransfers((transfer) => onTransferUpdated(transfer))
    return () => {
      active = false
      unsubscribe()
    }
  }, [agentId, subscribeTransfers])

  const fetchFile = async (fullPath: string) => {
    if (!agentId) return
    try {
      const transfer = await api.fetchFile(agentId, fullPath)
      setTransfers((prev) => upsertTransfer(prev, transfer))
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const pushFiles = async (files: FileList) => {
    if (!agentId || !path) return
    try {
      for (const file of Array.from(files)) {
        const transfer = await api.pushFile(agentId, joinPath(path, file.name), file)
        setTransfers((prev) => upsertTransfer(prev, transfer))
      }
    } catch (err) {
      setError(toMessage(err))
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  return (
    <div className="explorer-layout">
      <section className="panel explorer">
        <div className="panel-head explorer-head">
          {picker}
          <button
            type="button"
            className="icon"
            title="상위 폴더"
            disabled={loading || listing?.parentPath == null}
            onClick={() => listing?.parentPath != null && load(listing.parentPath)}
          >
            ↑
          </button>
          <form
            className="path-form"
            onSubmit={(e) => {
              e.preventDefault()
              load(pathInput.trim())
            }}
          >
            <input
              className="mono"
              aria-label="경로"
              value={pathInput}
              placeholder="드라이브 목록 (경로 입력 후 Enter)"
              onChange={(e) => setPathInput(e.target.value)}
            />
          </form>
          <button type="button" disabled={!agentId || loading} onClick={() => load(path)}>
            {loading ? '불러오는 중…' : '새로 고침'}
          </button>
          <button
            type="button"
            className="primary"
            disabled={!agentId || !path}
            title={path ? `${path}에 올리기` : '폴더를 연 뒤 올릴 수 있습니다'}
            onClick={() => fileInputRef.current?.click()}
          >
            올리기
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            onChange={(e) => e.target.files && void pushFiles(e.target.files)}
          />
        </div>

        {error && <div className="output-error">{error}</div>}

        <div className="table-wrap">
          <table>
            <colgroup>
              <col />
              <col style={{ width: 100 }} />
              <col style={{ width: 130 }} />
              <col style={{ width: 90 }} />
            </colgroup>
            <thead>
              <tr>
                <th>이름</th>
                <th>크기</th>
                <th>수정 시각</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {!agentId && (
                <tr>
                  <td colSpan={4} className="placeholder">
                    온라인 PC가 없습니다
                  </td>
                </tr>
              )}
              {listing && listing.entries.length === 0 && (
                <tr>
                  <td colSpan={4} className="placeholder">
                    빈 폴더입니다
                  </td>
                </tr>
              )}
              {listing?.entries.map((entry) => (
                <tr
                  key={entry.fullPath}
                  className={entry.isDirectory ? 'dir' : 'file'}
                  title={entry.isDirectory ? '열기' : undefined}
                  onClick={() => entry.isDirectory && load(entry.fullPath)}
                >
                  <td className="ellipsis">
                    <span className="file-icon" aria-hidden="true">
                      {entry.isDirectory ? '📁' : '📄'}
                    </span>
                    {entry.name}
                  </td>
                  <td>{entry.isDirectory ? '' : formatBytes(entry.size)}</td>
                  <td>{entry.modifiedAt ? formatTime(entry.modifiedAt) : ''}</td>
                  <td>
                    {!entry.isDirectory && (
                      <button
                        type="button"
                        className="link"
                        onClick={(e) => {
                          e.stopPropagation()
                          void fetchFile(entry.fullPath)
                        }}
                      >
                        가져오기
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel transfers">
        <div className="panel-head">
          <h2>파일 전송 기록</h2>
          <span className="muted small">가져온 파일은 완료 후 다운로드할 수 있습니다</span>
        </div>
        <ul className="transfer-list">
          {transfers.length === 0 && <li className="placeholder">전송 기록이 없습니다</li>}
          {transfers.map((transfer) => {
            const artifact = artifactByTransfer[transfer.id]
            return (
              <li key={transfer.id} className="transfer">
                <StateBadge state={transfer.state} />
                <span className="small">{transfer.kind === 'Fetch' ? '가져오기' : '올리기'}</span>
                <span className="mono ellipsis" title={transfer.path ?? undefined}>
                  {transfer.path}
                </span>
                <span
                  className={`small ellipsis ${transfer.state === 'Failed' ? 'error' : 'muted'}`}
                  title={transfer.error ?? undefined}
                >
                  {transfer.state === 'Succeeded'
                    ? formatBytes(transfer.totalBytes)
                    : transfer.state === 'Failed'
                      ? transfer.error
                      : '전송 중…'}
                </span>
                {artifact ? (
                  <a className="small" href={api.artifactUrl(artifact.id)} download>
                    다운로드
                  </a>
                ) : (
                  <span />
                )}
              </li>
            )
          })}
        </ul>
      </section>
    </div>
  )
}
