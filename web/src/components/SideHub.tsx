import { useState } from 'react'
import { api, type ResultJob, type Transfer } from '../api'
import { formatBytes, formatDuration } from '../format'
import { ChatPanel } from './ChatPanel'
import { kindLabel } from './explorer/useTransfers'
import { NotesPanel } from './NotesPanel'
import { RESULT_MODE_LABEL } from './results/resultCsv'
import { JOB_KIND_LABEL, JOB_STATE_LABEL, openJob, scheduleTimeText, useNow } from './results/resultJobs'
import { openViewer, removeSession, type ResultSession, sessionTitle, startSession } from './results/resultSessions'
import type { HubTab, SideHub } from './sideHubState'

// 채팅·메모·진행상황 화면 조각: 사이드바(PcTree)와 떠 있는 PiP(TransfersPip)가 함께 쓴다. 상태·알림은 sideHubState

/** 탭 이름 옆 배지: 채팅 = 안 읽은 메시지, 진행상황 = 진행 중 · 열어 볼 것 */
export function HubBadges({ hub, tab }: { hub: SideHub; tab: HubTab }) {
  if (tab === 'chat') return hub.unread > 0 ? <span className="pip-count chat">{hub.unread}</span> : null
  if (tab !== 'transfers') return null
  return (
    <>
      {hub.busy > 0 && <span className="pip-count">{hub.busy}</span>}
      {hub.fresh > 0 && <span className="pip-count ready" title="열어 볼 수 있는 결과 확인·끝난 분석">{hub.fresh}</span>}
    </>
  )
}

/** 채팅·메모·진행상황 내용 (PiP·사이드바가 감싸는 칸 안에). shown: 펼쳐 보이는 중 (채팅 읽음 처리) */
export function HubPanel({ hub, tab, shown }: { hub: SideHub; tab: HubTab; shown: boolean }) {
  if (tab === 'chat') {
    return (
      <ChatPanel
        rooms={hub.chatRooms}
        messages={hub.chatMessages}
        actions={hub.chatActions}
        org={hub.org}
        selfUserId={hub.selfUserId}
        activeRoomId={hub.activeRoomId}
        onActiveRoomChange={hub.changeRoom}
        visible={shown && hub.focused}
      />
    )
  }
  if (tab === 'notes') return <NotesPanel selfUserId={hub.selfUserId} nameOf={(id) => hub.userName(id) ?? '(알 수 없음)'} subscribeNotes={hub.subscribeNotes} />
  return <HubProgress hub={hub} />
}

const leafOf = (path: string | null) => path?.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** 어디서 → 어디로 (간략) */
const flowText = (t: Transfer, machine: string) => {
  if (t.kind === 'Fetch') return `${machine} → 서버`
  if (t.kind === 'Push') return `서버 → ${machine}`
  return `${machine} 내부` // 압축
}

/** 진행상황: 예약 분석 · 영상 분석·이미지 찾기 · 결과 확인 불러오기 · 파일 전송 · 최근 알림 */
function HubProgress({ hub }: { hub: SideHub }) {
  const { activeList, recent, sessions, jobs, schedules, machineName, userName } = hub
  return (
    <>
      {activeList.length === 0 && recent.length === 0 && sessions.length === 0 && jobs.length === 0 && schedules.length === 0 && <div className="pip-empty muted small">진행 중인 작업 없음</div>}

      {schedules.length > 0 && (
        <div className="pip-results">
          <div className="pip-recent-title muted small">예약 분석</div>
          {schedules.map((s) => (
            <div key={s.id} className={`pip-note small${s.state === 'failed' ? ' error' : ''}`} title={s.error ?? s.videos.join(', ')}>
              <span className="ellipsis">
                ⏰ {scheduleTimeText(s.at)} · {[s.analysis && JOB_KIND_LABEL.analysis, s.search && JOB_KIND_LABEL.search].filter(Boolean).join(' + ')} · {s.title}
              </span>
              <span className="muted">{s.state === 'failed' ? '실패' : s.machineName ?? ''}</span>
              <button type="button" className="icon-mini" title={s.state === 'pending' ? '예약 취소' : '목록에서 빼기'} onClick={() => void api.removeResultSchedule(s.id).catch(() => {})}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {jobs.length > 0 && (
        <div className="pip-results">
          <div className="pip-recent-title muted small">영상 분석 · 이미지 찾기</div>
          {jobs.map((j) => <JobItem key={j.id} job={j} />)}
        </div>
      )}

      {sessions.length > 0 && (
        <div className="pip-results">
          <div className="pip-recent-title muted small">결과 확인</div>
          {sessions.map((s) => <ResultItem key={s.id} session={s} />)}
        </div>
      )}
      {(activeList.length > 0 || recent.length > 0) && sessions.length > 0 && <div className="pip-recent-title muted small">파일 전송</div>}

      {activeList.map((t) => {
        const who = userName(t.startedByUserId)
        return (
          <div key={t.id} className="pip-item active" title={t.path ?? undefined}>
            <div className="pip-item-top">
              <span className="pip-flow small ellipsis">{flowText(t, machineName(t.agentId))}</span>
              <span className="pip-pct small">{typeof t.percent === 'number' ? `${t.percent}%` : '…'}</span>
              <CancelButton transfer={t} />
            </div>
            <div className="pip-bar">
              <div className={`pip-bar-fill${typeof t.percent !== 'number' ? ' indet' : ''}`} style={{ width: `${typeof t.percent === 'number' ? t.percent : 100}%` }} />
            </div>
            <div className="pip-sub small muted ellipsis">
              {kindLabel(t.kind)} · {leafOf(t.path)}{who ? ` · ${who}` : ''}
            </div>
          </div>
        )
      })}

      {recent.length > 0 && (
        <div className="pip-recent">
          <div className="pip-recent-title muted small">최근 알림</div>
          {recent.map((t) => (
            <div key={t.id} className={`pip-note small${t.state === 'Failed' ? ' error' : ''}`} title={t.error ?? t.path ?? undefined}>
              <span className={`pip-dot ${t.state === 'Failed' ? 'fail' : 'ok'}`} />
              <span className="ellipsis">
                {kindLabel(t.kind)} · {t.path?.split(/[\\/]/).pop()}
              </span>
              <span className="muted">{t.state === 'Succeeded' ? formatBytes(t.totalBytes) : '실패'}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

/** 진행상황: 결과 확인 불러오기 한 건 (불러오는 중에도 바로 전체 화면으로) */
function ResultItem({ session: s }: { session: ResultSession }) {
  const pct = s.total ? Math.round((s.done / s.total) * 100) : 0
  const title = sessionTitle(s)
  const ready = s.state === 'ready'
  const openable = s.state !== 'failed'
  return (
    <div className={`pip-item pip-result ${s.state}${ready && !s.opened ? ' fresh' : ''}`} title={s.source.resultPath}>
      <div className="pip-item-top">
        <button type="button" className="pip-result-name small ellipsis" disabled={!openable} onClick={() => openViewer(s.id)}>
          {RESULT_MODE_LABEL[s.source.mode]} · {title}
        </button>
        {s.state === 'loading' && <span className="pip-pct small">{s.done}/{s.total}</span>}
        {openable && <button type="button" className="primary small pip-result-open" onClick={() => openViewer(s.id)}>열기</button>}
        {s.state === 'failed' && (
          <button type="button" className="small" title="다시 불러오기" onClick={() => startSession(s.source, s.set, s.id)}>다시</button>
        )}
        <button type="button" className="icon-mini" title="목록에서 빼기" onClick={() => removeSession(s.id)}>✕</button>
      </div>
      {s.state === 'loading' && (
        <div className="pip-bar">
          <div className="pip-bar-fill" style={{ width: `${Math.max(4, pct)}%` }} />
        </div>
      )}
      <div className={`pip-sub small ellipsis${s.state === 'failed' ? ' error' : ' muted'}`} title={s.error ?? s.step}>
        {s.source.machineName}
        {s.state === 'loading' ? ` · ${s.step}` : s.state === 'failed' ? ` · ${s.error ?? '실패'}` : ` · 준비 완료 (영상 ${s.videos.length}개${s.videos.some((v) => v.prep === 'failed') ? ', 일부 실패' : ''})`}
      </div>
    </div>
  )
}

/** 진행상황: 영상 분석·이미지 찾기 한 건 (결과 확인 탭을 닫아도 테스트 PC에서 계속 돈다) */
function JobItem({ job: j }: { job: ResultJob }) {
  const running = j.state === 'running'
  const pct = Math.round(j.progress * 100)
  // 진행 중이면 경과 시간 (1초마다), 끝났으면 걸린 시간
  const now = useNow(running)
  const started = Date.parse(j.started)
  const took = running ? now - started : j.finished ? Date.parse(j.finished) - started : null
  const tone = running ? 'loading' : j.state === 'done' ? 'ready' : 'failed'
  const stop = () => {
    const call = j.kind === 'analysis' ? api.cancelVideoAnalysis(j.agentId, j.id) : api.cancelImageSearch(j.agentId, j.id)
    call.catch((err: unknown) => window.alert(`멈추지 못했습니다: ${err instanceof Error ? err.message : String(err)}`))
  }
  const remove = () => {
    if (running && !window.confirm(`진행 중인 ${JOB_KIND_LABEL[j.kind]}을(를) 멈추고 목록에서 뺄까요?`)) return
    void api.removeResultJob(j.id).catch(() => {})
  }
  const open = () => {
    if (!openJob(j)) window.alert('새 탭을 열지 못했습니다 (팝업 차단). 이 사이트의 팝업을 허용해 주세요.')
  }
  return (
    <div className={`pip-item pip-result ${tone}${j.state === 'done' && !j.seen ? ' fresh' : ''}`} title={j.sourceKey}>
      <div className="pip-item-top">
        <button type="button" className="pip-result-name small ellipsis" onClick={open}>
          {JOB_KIND_LABEL[j.kind]} · {j.title}
        </button>
        {running && <span className="pip-pct small">{pct}%</span>}
        <button type="button" className="primary small pip-result-open" onClick={open}>열기</button>
        {running && <button type="button" className="small" title="거기까지 잰 결과는 남깁니다" onClick={stop}>멈춤</button>}
        <button type="button" className="icon-mini" title="목록에서 빼기" onClick={remove}>✕</button>
      </div>
      {running && (
        <div className="pip-bar">
          <div className="pip-bar-fill" style={{ width: `${Math.max(4, pct)}%` }} />
        </div>
      )}
      <div className={`pip-sub small ellipsis${j.state === 'failed' || j.state === 'lost' ? ' error' : ' muted'}`} title={j.error ?? j.current ?? undefined}>
        {j.machineName ?? ''}
        {running ? ` · 경과 ${formatDuration(took ?? 0)} · ${j.current ?? '진행 중'}` : ` · ${JOB_STATE_LABEL[j.state]}${took !== null ? ` · 걸린 시간 ${formatDuration(took)}` : ''}${j.error ? ` (${j.error})` : ''}`}
      </div>
    </div>
  )
}

/** 진행 중인 전송 취소 (압축·풀기·가져오기·올리기·PC 간 복사·이동) */
function CancelButton({ transfer }: { transfer: Transfer }) {
  const [busy, setBusy] = useState(false)
  return (
    <button
      type="button"
      className="icon-mini pip-cancel"
      title="취소"
      disabled={busy}
      onClick={() => {
        if (!window.confirm(`'${leafOf(transfer.path) || kindLabel(transfer.kind)}' ${kindLabel(transfer.kind)}을(를) 취소할까요?`)) return
        setBusy(true)
        api.cancelTransfer(transfer.id).catch((err) => {
          setBusy(false)
          window.alert(`취소하지 못했습니다: ${err instanceof Error ? err.message : String(err)}`)
        })
      }}
    >
      {busy ? '…' : '✕'}
    </button>
  )
}
