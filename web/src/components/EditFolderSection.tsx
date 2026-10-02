import { useCallback, useEffect, useState } from 'react'
import { api, type EditFolderInfo } from '../api'
import { formatBytes } from '../format'

interface Props {
  /** 대시보드를 연 PC의 에이전트 (온라인일 때만) */
  selfAgentId: string | null
  selfName: string | null
}

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/**
 * Setting: 내 PC 프로그램으로 연 파일의 사본이 받아지는 편집 폴더(문서\PC Manager 편집).
 * 폴더 바로 열기와 정리(다 보냈고 닫힌 사본 삭제).
 */
export function EditFolderSection({ selfAgentId, selfName }: Props) {
  const [info, setInfo] = useState<EditFolderInfo | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    if (!selfAgentId) return
    api.editFolderInfo(selfAgentId).then(
      (result) => {
        setInfo(result)
        setError(null)
      },
      (err) => setError(toMessage(err)),
    )
  }, [selfAgentId])

  useEffect(() => {
    refresh()
  }, [refresh])

  const open = async () => {
    if (!selfAgentId) return
    setError(null)
    try {
      await api.openEditFolder(selfAgentId)
      setMessage('편집 폴더를 열었습니다.')
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const clean = async () => {
    if (!selfAgentId || busy) return
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      const result = await api.cleanEditFolder(selfAgentId)
      setInfo(result.info)
      const kept = [
        result.inUse ? `열려 있는 ${result.inUse}개` : '',
        result.pending ? `아직 원래 PC로 못 보낸 ${result.pending}개` : '',
      ].filter(Boolean)
      setMessage(
        `${result.deleted}개(${formatBytes(result.bytes)}) 정리했습니다.${kept.length ? ` ${kept.join(', ')}는 남겼습니다.` : ''}`,
      )
    } catch (err) {
      setError(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="panel settings-section">
      <div className="settings-section-head">
        <h2>편집 폴더 (내 PC 프로그램으로 연 파일)</h2>
      </div>
      {!selfAgentId ? (
        <p className="muted small">
          이 대시보드를 연 PC에서 에이전트를 찾지 못했습니다(또는 오프라인). 에이전트 트레이의 '대시보드 열기'로 열면 이 PC가 연결됩니다.
        </p>
      ) : (
        <>
          <p className="muted small">
            파일을 더블클릭하면 이 PC({selfName})의 편집 폴더로 받아 기본 프로그램으로 엽니다. 저장하면 원래 PC로 되돌아가고,
            프로그램을 닫은 뒤 10분이 지나면 받은 사본은 자동으로 지워집니다. 직접 '다른 이름으로 저장'한 파일은 지우지 않습니다.
          </p>
          <div className="edit-folder-row">
            <code className="edit-folder-path" title={info?.path ?? ''}>
              {info?.path ?? '(로그인한 사용자가 없음)'}
            </code>
            <span className="small muted">
              {info ? `받은 사본 ${info.files}개 · ${formatBytes(info.bytes)}${info.pending ? ` · 못 보낸 변경 ${info.pending}개` : ''}` : ''}
            </span>
            <span className="win-spacer" />
            <button type="button" className="small-btn" onClick={() => void open()} disabled={!info?.path}>
              폴더 열기
            </button>
            <button type="button" className="small-btn" onClick={() => void clean()} disabled={busy}>
              {busy ? '정리 중…' : '정리'}
            </button>
            <button type="button" className="small-btn" onClick={refresh} title="새로 고침">
              ↻
            </button>
          </div>
          {message && <p className="small edit-folder-msg">{message}</p>}
        </>
      )}
      {error && <p className="output-error">{error}</p>}
    </section>
  )
}
