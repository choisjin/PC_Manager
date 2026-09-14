import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Agent, type UpdateStatus } from '../api'
import { formatTime } from '../format'

interface Props {
  status: UpdateStatus | null
  agents: Agent[]
  onClose: () => void
}

const PHASE_LABEL: Record<string, string> = {
  Downloading: '다운로드 중…',
  Installing: '설치 중…',
  Restarting: '서버 재시작 중…',
  Failed: '실패',
}

/** 버전을 숫자로 비교 (a<b → 음수) */
function compareVersion(a: string, b: string) {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

export function UpdateDialog({ status, agents, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [busy, setBusy] = useState<'check' | 'server' | 'agents' | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // 서버 버전보다 구버전인 온라인 에이전트
  const outdatedAgents = useMemo(() => {
    if (!status) return []
    return agents.filter((a) => a.online && compareVersion(a.agentVersion, status.currentVersion) < 0)
  }, [agents, status])

  const serverBusy = status?.serverPhase === 'Downloading' || status?.serverPhase === 'Installing' || status?.serverPhase === 'Restarting'

  const run = async (kind: 'check' | 'server' | 'agents', fn: () => Promise<string | null>) => {
    setBusy(kind)
    setError(null)
    setMessage(null)
    try {
      const msg = await fn()
      if (msg) setMessage(msg)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="dialog update-dialog"
      aria-labelledby="update-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current.close()
      }}
    >
      <div className="dialog-head">
        <h2 id="update-title">업데이트</h2>
        <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>
          ✕
        </button>
      </div>

      <div className="dialog-body">
        {!status ? (
          <p className="muted">업데이트 정보를 불러오는 중…</p>
        ) : (
          <>
            <div className="version-row">
              <div>
                <span className="muted small">서버 현재 버전</span>
                <div className="version-value mono">{status.currentVersion}</div>
              </div>
              <div className="version-arrow">→</div>
              <div>
                <span className="muted small">최신 릴리스</span>
                <div className="version-value mono">
                  {status.latestVersion ?? '확인 안 됨'}
                  {status.updateAvailable && <span className="badge Running new-badge">NEW</span>}
                </div>
              </div>
            </div>

            {status.checkError && (
              <p className="warning-box">최신 버전 확인 실패: {status.checkError}</p>
            )}
            {status.checkedAt && (
              <p className="muted small">마지막 확인: {formatTime(status.checkedAt)}</p>
            )}

            {status.releaseNotes && (
              <div className="release-notes">
                <div className="release-notes-head">
                  <strong>{status.releaseName ?? status.latestVersion}</strong>
                  {status.releaseUrl && (
                    <a href={status.releaseUrl} target="_blank" rel="noreferrer" className="small">
                      GitHub에서 보기
                    </a>
                  )}
                </div>
                <pre className="release-notes-body">{status.releaseNotes}</pre>
              </div>
            )}

            {error && <p className="error">{error}</p>}
            {message && <p className="muted small">{message}</p>}

            <div className="update-actions">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('check', async () => {
                  await api.checkUpdate()
                  return '최신 버전을 다시 확인했습니다.'
                })}
              >
                {busy === 'check' ? '확인 중…' : '지금 확인'}
              </button>

              <div className="update-action-group">
                <div className="update-action">
                  <div>
                    <b>서버 업데이트</b>
                    <div className="muted small">
                      {serverBusy
                        ? PHASE_LABEL[status.serverPhase]
                        : status.serverPhase === 'Failed'
                          ? `실패: ${status.serverError ?? ''}`
                          : status.updateAvailable
                            ? status.serverAssetAvailable
                              ? '새 버전으로 교체 후 자동 재시작'
                              : '릴리스에 서버 설치 파일이 없습니다'
                            : '최신 버전입니다'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy !== null || serverBusy || !status.updateAvailable || !status.serverAssetAvailable}
                    onClick={() => run('server', async () => {
                      await api.updateServer()
                      return '서버 업데이트를 시작했습니다. 잠시 후 서버가 재시작되며 연결이 잠깐 끊깁니다.'
                    })}
                  >
                    {serverBusy ? '진행 중…' : '서버 업데이트'}
                  </button>
                </div>

                <div className="update-action">
                  <div>
                    <b>에이전트 업데이트</b>
                    <div className="muted small">
                      {outdatedAgents.length > 0
                        ? `구버전 ${outdatedAgents.length}대 (온라인)를 서버 버전으로 업데이트`
                        : '모든 온라인 에이전트가 최신입니다'}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy !== null || outdatedAgents.length === 0}
                    onClick={() => run('agents', async () => {
                      const result = await api.updateAgents()
                      return `${result.dispatched}대에 업데이트를 지시했습니다. 각 PC가 잠시 후 재시작됩니다.`
                    })}
                  >
                    {busy === 'agents' ? '전송 중…' : `${outdatedAgents.length}대 업데이트`}
                  </button>
                </div>
              </div>
            </div>

            <p className="hint">
              서버 업데이트는 이 PC(서버)가 새 버전을 내려받아 자동 설치·재시작합니다. 에이전트 업데이트는 각 테스트 PC가 서버에서 설치
              파일을 받아 스스로 갱신합니다(관리자 조작 불필요).
            </p>
          </>
        )}
      </div>
    </dialog>
  )
}
