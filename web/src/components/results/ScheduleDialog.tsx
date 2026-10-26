import { useState } from 'react'
import { api } from '../../api'
import { formatDuration } from '../../format'
import type { ImageSearchState, SearchVideo } from './imageSearchState'
import { scheduleTimeText, useResultSchedules } from './resultJobs'
import { baseName, type Source, toMessage } from './resultSessions'
import type { VideoAnalysisState } from './videoAnalysisState'

// 예약 분석: 테스트·녹화가 진행 중일 때(첫 Cycle이 지난 뒤) 영상 분석의 화면 영역·제외 구간, 이미지 찾기의 크롭 이미지를 미리 정해 두고
// 시각을 정하면, 그 시각에 서버가 영상을 다시 모아(같은 폴더에 그 뒤 저장된 영상까지 — 사이클마다 나눠 저장해도) 테스트 PC에서 시작한다.
// 시작한 분석은 PiP 진행상황·Result PC 목록에 보이고, 결과 확인을 다시 열면 이어 받는다

const STATE_TEXT = { pending: '대기', started: '시작함', failed: '실패' } as const

/** datetime-local 칸의 값 (지역 시각) */
function localInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}

export interface FirstCycle {
  name: string
  /** 첫 Cycle 길이 (초, 모르면 null) */
  seconds: number | null
  /** 첫 Cycle이 끝났다 (다음 Cycle 행이 있다) */
  done: boolean
}

export function ScheduleDialog({ source, title, sourceKey, videos, starts, analysis, search, firstCycle, onClose }: {
  source: Source
  title: string
  sourceKey: string
  videos: SearchVideo[]
  /** videos마다 테스트 시작 초 */
  starts: number[]
  analysis: VideoAnalysisState
  search: ImageSearchState
  firstCycle: FirstCycle | null
  onClose: () => void
}) {
  const analysisPayload = analysis.schedulePayload()
  const searchPayload = search.schedulePayload()
  const [useAnalysis, setUseAnalysis] = useState(!!analysisPayload)
  const [useSearch, setUseSearch] = useState(!!searchPayload)
  const [at, setAt] = useState(() => {
    // 기본: 지금부터 첫 Cycle 길이 뒤 (모르면 1시간), 5분 단위로 올림
    const ms = Date.now() + (firstCycle?.seconds ?? 3600) * 1000
    return localInput(new Date(Math.ceil(ms / 300_000) * 300_000))
  })
  // 창을 연 시각 (지난 시각 안내용)
  const [openedAt] = useState(Date.now)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mine = useResultSchedules().filter((s) => s.sourceKey === sourceKey)

  const when = new Date(at)
  const valid = !Number.isNaN(when.getTime())
  const past = valid && when.getTime() <= openedAt
  const picked = (useAnalysis && analysisPayload) || (useSearch && searchPayload)

  const submit = () => {
    if (!valid || !picked) return
    setBusy(true)
    setError(null)
    api.addResultSchedule({
      agentId: source.agentId, machineName: source.machineName, title, sourceKey, source, at: when.toISOString(),
      videos: videos.map((v) => v.path), starts,
      analysis: useAnalysis && analysisPayload ? analysisPayload.request : null,
      analysisParams: useAnalysis && analysisPayload ? analysisPayload.params : null,
      search: useSearch && searchPayload ? searchPayload.request : null,
      searchParams: useSearch && searchPayload ? searchPayload.params : null,
    }).then(onClose, (err) => setError(toMessage(err))).finally(() => setBusy(false))
  }

  const p = analysisPayload?.params
  const t = search.template
  return (
    <div className="rv-modal">
      <div className="rv-modal-box panel rv-schedule">
        <div className="rv-drawer-head">
          <strong>예약 분석</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <p className="hint">
          설정해 둔 영상 분석·이미지 찾기를 정한 시각에 테스트 PC에서 시작합니다. 결과 확인 탭을 닫아도 되고, 끝나면 알림과 Result PC 목록에 표시됩니다.
        </p>
        {firstCycle && (
          firstCycle.done
            ? <p className="small muted">{`첫 Cycle(${firstCycle.name}) 길이 ${firstCycle.seconds !== null ? formatDuration(firstCycle.seconds * 1000) : '-'}`}</p>
            : <p className="small rv-search-warn">아직 첫 Cycle이 끝나지 않았습니다. 제외 구간·화면 영역은 첫 Cycle이 지난 뒤 정하는 것이 좋습니다.</p>
        )}
        <label className="rv-block">
          시작 시각
          <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
        </label>
        {past && <p className="small rv-search-warn">지난 시각입니다 — 예약하면 바로 시작합니다.</p>}

        <label className={`rv-schedule-kind${analysisPayload ? '' : ' disabled'}`}>
          <input type="checkbox" disabled={!analysisPayload} checked={useAnalysis && !!analysisPayload} onChange={(e) => setUseAnalysis(e.target.checked)} />
          <span>
            <strong>영상 분석</strong>
            <span className="small muted">
              {p
                ? ` 화면 영역 지정됨 · 정지 기준 ${p.staticS}초 · 제외 구간 ${p.excludes.length}개 · Cycle 비교 기준 ${p.cycleDiff}`
                : ' 영상 분석 패널에서 [화면 영역]을 먼저 지정하세요'}
            </span>
          </span>
        </label>
        <label className={`rv-schedule-kind${searchPayload ? '' : ' disabled'}`}>
          <input type="checkbox" disabled={!searchPayload} checked={useSearch && !!searchPayload} onChange={(e) => setUseSearch(e.target.checked)} />
          <span>
            <strong>이미지 찾기</strong>
            <span className="small muted">
              {t
                ? ` 크롭 ${t.rect.w}×${t.rect.h} · 기준 ${search.threshold}% · 영상 전체에서 찾음 (스텝 앞뒤 범위는 예약에서 쓰지 않음)`
                : ' 이미지 찾기 패널에서 찾을 이미지를 먼저 크롭하세요'}
            </span>
          </span>
        </label>

        <div className="small">
          <div>{`영상: 지금 ${videos.length}개 + 그 시각에 같은 폴더에 이후 저장된 영상 (사이클마다 나눠 저장해도 함께, 수정 시각순)`}</div>
          <ul className="rv-schedule-videos muted">
            {videos.map((v) => <li key={v.path} className="ellipsis" title={v.path}>{v.name}</li>)}
          </ul>
        </div>

        {mine.length > 0 && (
          <div className="small">
            <div className="muted">이 결과의 예약</div>
            <ul className="rv-schedule-list">
              {mine.map((s) => (
                <li key={s.id}>
                  <span>{scheduleTimeText(s.at)}</span>
                  <span className="muted">{[s.analysis && '영상 분석', s.search && '이미지 찾기'].filter(Boolean).join(' + ')}</span>
                  <span className={s.state === 'failed' ? 'error' : 'muted'} title={s.error ?? s.startedVideos?.map(baseName).join(', ')}>
                    {STATE_TEXT[s.state]}{s.state === 'started' && s.startedVideos ? ` (영상 ${s.startedVideos.length}개)` : ''}
                  </span>
                  <button type="button" className="icon-mini" title={s.state === 'pending' ? '예약 취소' : '목록에서 빼기'} onClick={() => void api.removeResultSchedule(s.id).catch(() => {})}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && <p className="error small">{error}</p>}
        <div className="rv-setup-actions">
          <button type="button" onClick={onClose}>닫기</button>
          <button type="button" className="primary" disabled={busy || !valid || !picked} onClick={submit}>예약</button>
        </div>
      </div>
    </div>
  )
}
