import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type ResultSet, type ResultSetSummary } from '../../api'
import { formatBytes } from '../../format'
import { type ClipItem, FILES_MIME, type FilesDragPayload } from '../explorer/pcGroups'
import {
  type AtsImages, compareCells, formatSeconds, formatWall, type ParsedResult, parseAts, parseRfw, shortMessage, type TableSpec,
  RESULT_MODE_LABEL, type ResultMapping, type ResultMode, type ResultRow, statusTone, timeFromName,
} from './resultCsv'
import {
  addSessionVideo, autoAssign, baseName, closeSets, closeSetup, closeViewer, convertVideo, dirName, dismissToast, type LoadProgress, openSets, openSetup,
  openViewer, ORIGINAL_NOTE, playOriginal, type RawVideo, rememberedRefDir, rememberRefDir, type ResultSession, saveSessionConfig, sessionFileUrl, sessionTitle, setSessionSet,
  type SetupState, type Source, startSession, toMessage, updateSessionVideo, useResults, type ViewConfig,
} from './resultSessions'
import {
  type Anchor, baseSeconds, emptySync, resolveStart, rowAtTime, START_SOURCE_LABEL, type SyncState,
  toRowTime, toVideoTime, type VideoInfo, videoForRow,
} from './sync'
import { openResultTab, readResultTab, RESULT_TAB_ID, type ResultTabRequest, updateResultTab } from './resultTab'
import { findRun } from './resultFinder'
import { type ColFilters, ColumnFilterMenu, type ColSort } from './ColumnFilter'
import { VideoTransport } from './VideoTransport'
import { CropOverlay, ImageSearchPanel } from './ImageSearch'
import { type SearchVideo, type StepSource, useImageSearch } from './imageSearchState'

type PutSlot = 'result' | 'video' | 'image' | 'ref'
type Dialog = null | 'save' | 'trim'

const ROW_HEIGHT = 26

const sourceFromSet = (set: ResultSet): Source => ({
  mode: (set.config as ViewConfig | null)?.mode ?? 'rfw',
  agentId: set.agentId, machineName: set.machineName, resultPath: set.resultPath,
  videoPaths: set.videoPaths, imageDir: set.imageDir, refDir: (set.config as ViewConfig | null)?.refDir ?? null,
})

/**
 * 결과 확인 (앱 전체에 하나): 경로 지정 창 · 다 불러온 결과의 전체 화면 · 저장된 셋 · 준비 완료 알림.
 * Result(CSV)·영상·이미지를 시각으로 맞춰 본다 (ReplayKit 시나리오 상세결과 방식).
 * 결과 화면은 새 브라우저 탭(?result=…)에서 연다: 대시보드 탭은 경로 지정·셋 고르기만 하고, 결과 확인 탭이 불러와 보여 준다
 */
export function ResultHost({ machineName }: { machineName: (agentId: string) => string }) {
  const { sessions, activeId, setup, setsOpen, toasts } = useResults()
  // 불러오는 중에도 화면을 연다 (Result·영상은 오는 대로 채우고 진행은 위에 따로)
  const active = sessions.find((s) => s.id === activeId && s.state !== 'failed') ?? null
  const [dialog, setDialog] = useState<Dialog>(null)
  const [preview, setPreview] = useState<string | null>(null)
  // 결과 확인 탭: 주소의 id로 적어 둔 내용(경로·셋)을 읽어 불러오고, 다 되면 바로 연다
  const tabId = RESULT_TAB_ID
  const [tabError, setTabError] = useState<string | null>(null)
  // PC별 결과 폴더에서 찾는 중이면 그 안내 (찾은 뒤에는 찾은 내용)
  const [tabFinding, setTabFinding] = useState<string | null>(null)
  const tabStarted = useRef(false)
  useEffect(() => {
    if (!tabId || tabStarted.current) return
    // 부모(App)의 effect(사용자 id 설정 등)가 먼저 돌고 나서 불러온다 (자식 effect가 먼저 실행되므로 한 틱 미룸)
    // 시작 표시는 타이머 안에서 (개발 모드 StrictMode가 effect를 두 번 돌려 첫 타이머를 지워도 두 번째가 시작하게)
    const timer = window.setTimeout(() => {
      tabStarted.current = true
      const request = readResultTab(tabId)
      if (request?.setId) {
        api.resultSet(request.setId).then((full) => startSession(sourceFromSet(full), full), (err) => setTabError(`저장한 결과를 읽지 못했습니다: ${toMessage(err)}`))
      } else if (request?.source) {
        startSession(request.source)
      } else if (request?.find) {
        void findInTab(tabId, request.find, setTabFinding, setTabError)
      } else {
        setTabError('열 결과를 찾지 못했습니다. 대시보드에서 다시 여세요.')
      }
    })
    return () => window.clearTimeout(timer)
  }, [tabId])

  // 보고 있는 게 없으면 불러오기를 시작하자마자 연다 (처음 불러올 때, '경로'에서 다시 열었을 때)
  useEffect(() => {
    if (!tabId || activeId) return
    const fresh = sessions.find((s) => s.state !== 'failed' && !s.opened)
    if (fresh) openViewer(fresh.id)
  }, [tabId, sessions, activeId])
  // 탭 제목
  useEffect(() => {
    if (!tabId) return
    const s = sessions.find((x) => x.id === activeId) ?? sessions[0]
    document.title = s ? `${sessionTitle(s)} · 결과 확인` : '결과 확인'
  }, [tabId, sessions, activeId])

  // 다른 결과로 바꾸면 열린 창은 닫는다
  useEffect(() => {
    setDialog(null)
    setPreview(null)
  }, [activeId])

  // 전체 화면이라 전송·알림 PiP가 표를 가리지 않게 (백업 진행은 저장 창에서 보여 준다)
  const viewing = !!active
  useEffect(() => {
    if (!viewing) return
    document.body.classList.add('rv-open')
    return () => document.body.classList.remove('rv-open')
  }, [viewing])

  // Esc: 열린 창 먼저, 없으면 결과 확인 닫기 → 경로 지정 창 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (preview) setPreview(null)
      else if (setsOpen) closeSets()
      else if (dialog) setDialog(null)
      else if (viewing) closeViewer()
      else if (setup) closeSetup()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, preview, setsOpen, viewing, setup])

  const [setsError, setSetsError] = useState<string | null>(null)
  const openSet = async (summary: ResultSetSummary) => {
    // 대시보드: 새 탭에서 (누른 직후 동기로 열어야 팝업 차단에 안 걸린다)
    if (!tabId) {
      if (!openResultTab({ setId: summary.id })) {
        setSetsError('새 탭을 열지 못했습니다 (팝업 차단). 이 사이트의 팝업을 허용해 주세요.')
        return
      }
      closeSets()
      closeSetup()
      return
    }
    const full = await api.resultSet(summary.id)
    closeSets()
    closeSetup()
    updateResultTab(tabId, { setId: full.id })
    const loaded = sessions.find((s) => s.set?.id === full.id && s.state !== 'failed')
    if (loaded && loaded.state !== 'failed') openViewer(loaded.id)
    else if (!loaded) startSession(sourceFromSet(full), full)
  }

  // 결과 확인 탭에서 보고 있는 게 없을 때: 불러오는 진행·실패·다시 열기
  const latest = sessions[0] ?? null
  const tabPanel = tabId && !active && (
    <div className="rv-page rv-tab">
      <div className="rv-tab-box panel">
        <h2>결과 확인</h2>
        {tabError ? <p className="error">{tabError}</p> : !latest ? <p className="muted">{tabFinding ?? '불러오는 중…'}</p> : (
          <>
            <p>
              <strong>{RESULT_MODE_LABEL[latest.source.mode]} · {sessionTitle(latest)}</strong>
              <span className="muted small"> {latest.source.machineName}</span>
            </p>
            {latest.state === 'loading' && (
              <>
                <progress max={Math.max(1, latest.total)} value={latest.done} />
                <p className="small muted">{latest.step} ({latest.done}/{latest.total})</p>
                {latest.progress && <ProgressLine progress={latest.progress} />}
              </>
            )}
            {latest.state === 'failed' && <p className="error small">{latest.error ?? '불러오지 못했습니다'}</p>}
            {latest.state === 'ready' && <p className="small muted">준비 완료</p>}
            {tabFinding && <p className="small muted">{tabFinding}</p>}
          </>
        )}
        <div className="rv-setup-actions">
          {latest && latest.state !== 'failed' && <button type="button" className="primary" onClick={() => openViewer(latest.id)}>열기</button>}
          {latest?.state === 'failed' && <button type="button" onClick={() => startSession(latest.source, latest.set, latest.id)}>다시 불러오기</button>}
          {latest && <button type="button" onClick={() => openSetup(latest.source, latest.id)}>경로 수정</button>}
          <button type="button" onClick={openSets}>불러오기</button>
          <button type="button" onClick={() => window.close()}>탭 닫기</button>
        </div>
      </div>
    </div>
  )

  return (
    <>
      {tabPanel}
      {setup && <SetupPopup key={setup.key} setup={setup} machineName={machineName} />}
      {active && createPortal(
        <div className="rv-page" role="dialog" aria-label="결과 확인">
          <Viewer
            key={active.id}
            session={active}
            sessions={sessions}
            dialog={dialog}
            setDialog={setDialog}
            setPreview={setPreview}
          />
        </div>,
        document.body,
      )}
      {setsOpen && createPortal(<SetsDialog onOpen={(s) => void openSet(s)} onClose={closeSets} notice={setsError} />, document.body)}
      {preview && createPortal(
        <div className="rv-preview" onClick={() => setPreview(null)}>
          <img src={preview} alt="" />
        </div>,
        document.body,
      )}
      {toasts.length > 0 && !tabId && createPortal(
        <div className="rv-toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`rv-toast panel${t.failed ? ' failed' : ''}`}>
              <span className="ellipsis" title={t.text}>{t.failed ? '⚠' : '✔'} {t.text}</span>
              {!t.failed && <button type="button" className="primary" onClick={() => openViewer(t.sessionId)}>열기</button>}
              <button type="button" className="icon" aria-label="닫기" onClick={() => dismissToast(t.id)}>✕</button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </>
  )
}

/** 결과 확인 탭(PC별 결과 폴더)에서 연 것: 결과 폴더에서 실행을 찾아 불러온다. F5로 다시 열면 찾은 그 실행으로 */
async function findInTab(
  id: string, find: NonNullable<ResultTabRequest['find']>, setFinding: (text: string | null) => void, setError: (text: string) => void,
) {
  setFinding(`${find.machineName} · ${find.path ? baseName(find.path) : find.day ? `${find.day} 최신 결과` : '최신 결과'} 찾는 중…`)
  try {
    const profile = (await api.resultProfiles()).profiles[find.agentId]
    if (!profile) throw new Error('이 PC의 결과 폴더가 정해져 있지 않습니다. Result 탭에서 정하세요.')
    const found = await findRun(find.agentId, find.machineName, profile, find)
    setFinding(found.notes.join(' · '))
    updateResultTab(id, { source: found.source })
    startSession(found.source)
  } catch (err) {
    setFinding(null)
    setError(`결과를 찾지 못했습니다: ${toMessage(err)}`)
  }
}

// ─────────────────────────────── 경로 지정: 떠 있는 작은 창 (탐색기에서 끌어다 놓기)

/** 형식을 바꾸면 원본 이미지 폴더도 그 형식의 기억한 경로로 (직접 놓은 경로는 그대로) */
function switchRefDir(s: Source, mode: ResultMode): string | null {
  const before = rememberedRefDir(s.agentId, s.mode)
  if (s.refDir && s.refDir !== before) return s.refDir
  return rememberedRefDir(s.agentId, mode)
}

function SetupPopup({ setup, machineName }: { setup: SetupState; machineName: (agentId: string) => string }) {
  const [source, setSource] = useState<Source>(setup.source)
  const [warn, setWarn] = useState<string | null>(null)
  const [pos, setPos] = useState(() => ({ x: Math.max(8, window.innerWidth - 500), y: 70 }))
  const ats = source.mode === 'ats'
  // 원본 이미지 폴더를 기억해 둔 값으로 미리 채웠으면 '비어 있음'으로 본다 (다른 PC 파일을 놓을 수 있게)
  const empty = !source.resultPath && source.videoPaths.length === 0 && !source.imageDir
    && (!source.refDir || source.refDir === rememberedRefDir(source.agentId, source.mode))

  const put = (slot: PutSlot, item: ClipItem) =>
    setSource((s) =>
      slot === 'result' ? { ...s, resultPath: item.path }
        : slot === 'video' ? { ...s, videoPaths: s.videoPaths.includes(item.path) ? s.videoPaths : [...s.videoPaths, item.path] }
          : slot === 'ref' ? { ...s, refDir: item.isDir ? item.path : dirName(item.path) }
            : { ...s, imageDir: item.isDir ? item.path : dirName(item.path) },
    )

  /** 끌어온 항목 (탐색기 창). 다른 PC 파일은 비어 있을 때만 그 PC로 바꾼다 */
  const dropped = (e: React.DragEvent): ClipItem[] | null => {
    e.preventDefault()
    e.stopPropagation()
    const json = e.dataTransfer.getData(FILES_MIME)
    if (!json) return null
    const payload = JSON.parse(json) as FilesDragPayload
    if (payload.agentId !== source.agentId) {
      if (!empty) {
        setWarn(`다른 PC(${machineName(payload.agentId)})의 파일입니다. 한 결과의 파일은 모두 같은 PC(${source.machineName})에 있어야 합니다.`)
        return null
      }
      setSource((s) => ({ ...s, agentId: payload.agentId, machineName: machineName(payload.agentId), refDir: rememberedRefDir(payload.agentId, s.mode) }))
    }
    setWarn(null)
    return payload.items
  }
  const dropInto = (slot: PutSlot) => (e: React.DragEvent) => {
    const items = dropped(e)
    if (!items) return
    for (const item of slot === 'video' ? items : items.slice(0, 1)) put(slot, item)
  }
  // 칸 밖에 놓으면 확장자로 알아서 (Result·영상·폴더 = 결과 이미지 폴더)
  const dropAnywhere = (e: React.DragEvent) => {
    const items = dropped(e)
    if (items) setSource((s) => autoAssign(s, items))
  }
  const allowDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(FILES_MIME)) e.preventDefault()
  }

  const startMove = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    e.preventDefault()
    const sx = e.clientX
    const sy = e.clientY
    const base = pos
    const onMove = (ev: MouseEvent) => setPos({
      x: Math.max(0, Math.min(window.innerWidth - 120, base.x + ev.clientX - sx)),
      y: Math.max(0, Math.min(window.innerHeight - 40, base.y + ev.clientY - sy)),
    })
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return createPortal(
    <div className="rv-setup-pop panel" style={{ left: pos.x, top: pos.y }} onDragOver={allowDrop} onDrop={dropAnywhere}>
      <header className="rv-setup-pop-head" onMouseDown={startMove} title="끌어서 이동">
        <strong>결과 확인</strong>
        <span className="rv-mode" role="group" aria-label="결과 형식">
          {(['ats', 'rfw'] as const).map((m) => (
            <button key={m} type="button" className={source.mode === m ? 'active' : ''} onClick={() => setSource((s) => ({ ...s, mode: m, refDir: switchRefDir(s, m) }))}>
              {RESULT_MODE_LABEL[m]}
            </button>
          ))}
        </span>
        <span className="muted small ellipsis">{source.machineName}</span>
        <span className="rv-spacer" />
        <button type="button" className="small" onClick={openSets} title="저장해 둔 결과 확인 불러오기">불러오기</button>
        <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={closeSetup}>✕</button>
      </header>
      <p className="hint">탐색기 창에서 파일·폴더를 아래 칸으로 끌어다 놓으세요 (칸 밖에 놓으면 확장자로 알아서 넣습니다)</p>
      <div className="rv-slots">
        <Slot title={`Result 파일 (${RESULT_MODE_LABEL[source.mode]} CSV)`} hint="CSV 파일을 끌어다 놓으세요" onDrop={dropInto('result')} onDragOver={allowDrop}
          items={source.resultPath ? [source.resultPath] : []} onRemove={() => setSource((s) => ({ ...s, resultPath: '' }))} />
        <Slot title="영상 (여러 개 가능)" hint="영상 파일을 끌어다 놓으세요 (회차별 녹화 등)" onDrop={dropInto('video')} onDragOver={allowDrop}
          items={source.videoPaths} onRemove={(p) => setSource((s) => ({ ...s, videoPaths: s.videoPaths.filter((v) => v !== p) }))} />
        {(
          <Slot title="원본 이미지 폴더" hint={ats ? '비교 기준 이미지 폴더 (예: D:\excelrunner_report\captured_image)' : '비교 기준 이미지 폴더 (예: rnavn_project/Image)'} onDrop={dropInto('ref')} onDragOver={allowDrop}
            items={source.refDir ? [source.refDir] : []} onRemove={() => setSource((s) => ({ ...s, refDir: null }))} />
        )}
        <Slot
          title="결과 이미지 폴더"
          hint={ats ? '실행 때 캡처한 이미지 폴더 (예: D:\\excelrunner_report\\2026-10-06-1403\\RVC_001)' : '실행 때 캡처한 이미지 폴더 (예: RF_TESTLOG/…/Image)'}
          onDrop={dropInto('image')} onDragOver={allowDrop}
          items={source.imageDir ? [source.imageDir] : []} onRemove={() => setSource((s) => ({ ...s, imageDir: null }))} />
      </div>
      {warn && <p className="error small">{warn}</p>}
      <p className="hint">
        {RESULT_TAB_ID
          ? "'열기'를 누르면 이 탭에서 모두 불러오고(영상은 필요하면 재생용으로 변환), 다 되면 바로 보여 줍니다."
          : "'열기'를 누르면 새 탭에서 모두 불러오고(영상은 필요하면 재생용으로 변환), 다 되면 바로 보여 줍니다."}
      </p>
      <div className="rv-setup-actions">
        <button
          type="button"
          className="primary"
          disabled={!source.resultPath}
          onClick={() => {
            rememberRefDir(source.agentId, source.mode, source.refDir)
            if (RESULT_TAB_ID) {
              // 결과 확인 탭: 이 탭에서 불러온다 (F5로 다시 열면 바뀐 경로로)
              startSession(source, null, setup.replaceId)
              updateResultTab(RESULT_TAB_ID, { source })
            } else if (!openResultTab({ source })) {
              setWarn('새 탭을 열지 못했습니다 (팝업 차단). 이 사이트의 팝업을 허용해 주세요.')
              return
            }
            closeSetup()
          }}
        >
          열기
        </button>
      </div>
    </div>,
    document.body,
  )
}

function Slot({ title, hint, items, onDrop, onDragOver, onRemove }: {
  title: string
  hint: string
  items: string[]
  onDrop: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onRemove: (path: string) => void
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={`rv-slot${over ? ' over' : ''}`}
      onDragOver={(e) => {
        onDragOver(e)
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        onDrop(e)
      }}
    >
      <div className="rv-slot-title">{title}</div>
      {items.length === 0 ? <div className="muted small">{hint}</div> : (
        <ul>
          {items.map((p) => (
            <li key={p} className="mono small">
              <span className="ellipsis" title={p}>{p}</span>
              <button type="button" className="icon" aria-label="빼기" onClick={() => onRemove(p)}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─────────────────────────────── 보기

function Viewer({ session, sessions, dialog, setDialog, setPreview }: {
  session: ResultSession
  sessions: ResultSession[]
  dialog: Dialog
  setDialog: (d: Dialog) => void
  setPreview: (url: string | null) => void
}) {
  const { id, source, set, rawText, videos: rawVideos, images, refImages } = session
  const savedConfig = session.config
  const [mapping] = useState<Partial<ResultMapping>>(savedConfig?.mapping ?? {})
  const [sync] = useState<SyncState>(savedConfig?.sync ?? emptySync())
  // 열 지정·보정은 세션에 남겨 다른 결과로 갔다 와도 그대로
  useEffect(() => saveSessionConfig(id, { mapping, sync }), [id, mapping, sync])
  const [current, setCurrent] = useState<string | null>(source.videoPaths[0] ?? null)
  const [notice, setNotice] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const [wallNow, setWallNow] = useState<number | null>(null)
  const [videoNow, setVideoNow] = useState(0)
  // 영상 자르기 구간 (시작·끝 스텝): 창을 닫아도 남겨 껐다 켜며 조절한다
  const [trimSel, setTrimSel] = useState<TrimSelection>(EMPTY_TRIM)
  // 이미지 찾기: 크롭한 이미지가 이 실행의 영상들에 나타나는 구간
  const searchVideos: SearchVideo[] = useMemo(
    () => rawVideos.map((v) => ({ path: v.path, readPath: v.playPath ?? v.path, name: v.name, duration: v.duration })),
    [rawVideos],
  )
  const search = useImageSearch(source.agentId, searchVideos)
  const [query, setQuery] = useState('')
  const [onlyFail, setOnlyFail] = useState(false)
  const [cycle, setCycle] = useState('')
  // ATS: 엑셀처럼 머리글마다 거르기·정렬
  const [colFilters, setColFilters] = useState<ColFilters>({})
  const [colSort, setColSort] = useState<ColSort | null>(null)
  const [filterMenu, setFilterMenu] = useState<{ col: number; x: number; y: number } | null>(null)
  const [follow, setFollow] = useState(true)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pendingSeek = useRef<number | null>(null)
  // 누른 스텝: 시각이 같거나 몇 ms 차이인 다음 스텝으로 바로 넘어가지 않게 잠시 붙잡는다
  const picked = useRef<{ index: number; time: number } | null>(null)

  const fileUrl = useCallback((path: string) => sessionFileUrl(set, source.agentId, path), [set, source.agentId])
  const onBack = () => {
    closeViewer()
    openSetup(source, id)
  }

  const ats = source.mode === 'ats'
  const parsed: ParsedResult | null = useMemo(
    () => (rawText === null ? null : ats ? parseAts(rawText) : parseRfw(rawText)),
    [rawText, mapping, ats],
  )
  // ATS·RFW(형식이 정해진 결과): 영상 아래 원본 · 결과 두 장
  const pairImages = !!parsed?.table
  const absolute = parsed?.timeKind === 'absolute'
  const rows = useMemo(() => parsed?.rows ?? [], [parsed])
  const sortedRows = useMemo(() => rows.filter((r) => r.time !== null).sort((a, b) => a.time! - b.time! || a.index - b.index), [rows])
  const firstTime = sortedRows[0]?.time ?? null
  // 표 위 요약: 시작 · 종료(마지막 스텝이 끝난 시각) · 총 시간 · Cycle(돈 횟수 / 계획)
  const runInfo = useMemo<RunInfo | null>(() => {
    if (sortedRows.length === 0) return null
    const start = sortedRows[0].time!
    let end = start
    for (const r of sortedRows) end = Math.max(end, r.time! + (r.durationMs ?? 0))
    const cycles = new Set(rows.map((r) => r.cycle).filter(Boolean)).size
    return { absolute, start, end, cycles, cycleTotal: parsed?.cycleTotal ?? null }
  }, [sortedRows, rows, absolute, parsed])

  const updateVideo = useCallback((path: string, p: Partial<RawVideo>) => updateSessionVideo(id, path, p), [id])
  const currentRaw = rawVideos.find((v) => v.path === current) ?? null
  // 다 불러온 뒤 사용자가 승인한 변환 · 승인을 기다리는 영상
  const converting = rawVideos.find((v) => v.prep === 'converting')
  const needsConvert = rawVideos.filter((v) => v.prep === 'needs-convert')

  const videos: VideoInfo[] = useMemo(
    () => rawVideos.map((v) => {
      const { start, source: from } = resolveStart(v, v.metaStarted, sync.manualStarts[v.path], firstTime)
      return { path: v.path, name: v.name, start, startSource: from, duration: v.duration, modified: v.modified }
    }),
    [rawVideos, sync.manualStarts, firstTime],
  )
  const currentVideo = videos.find((v) => v.path === current) ?? null

  // 파일 이름으로 찾기: 결과 폴더 → 원본 폴더 → Result에 적힌 경로 그대로
  const imagesByName = useMemo(
    () => new Map([...refImages, ...images].map((i) => [i.name.toLowerCase(), i.fullPath])),
    [images, refImages],
  )
  // 결과 폴더의 '날짜_시각_이름' 파일: 이름별로 시각을 모아 둔다 (CSV와 몇 초 다르게 저장된 캡처도 찾게)
  const stamped = useMemo(() => {
    const map = new Map<string, { time: number; path: string }[]>()
    for (const i of images) {
      const m = /^\d{8}_\d{6}_(.+)$/.exec(i.name.toLowerCase())
      const time = m ? timeFromName(i.name) : null
      if (!m || time === null) continue
      const list = map.get(m[1]) ?? []
      list.push({ time, path: i.fullPath })
      map.set(m[1], list)
    }
    return map
  }, [images])
  /** 파일 이름으로 찾기 → 없으면 같은 이름 중 시각이 2분 안으로 가장 가까운 결과 캡처 → 그래도 없으면 Result에 적힌 경로 */
  const resolveImage = useCallback((p: string) => {
    const name = baseName(p).toLowerCase()
    const exact = imagesByName.get(name)
    if (exact) return exact
    const m = /^\d{8}_\d{6}_(.+)$/.exec(name)
    const t0 = m ? timeFromName(name) : null
    const list = m ? stamped.get(m[1]) : undefined
    if (t0 !== null && list) {
      let best: { time: number; path: string } | null = null
      for (const c of list) if (Math.abs(c.time - t0) <= 120_000 && (!best || Math.abs(c.time - t0) < Math.abs(best.time - t0))) best = c
      if (best) return best.path
    }
    return p
  }, [imagesByName, stamped])
  const timedImages = useMemo(
    () => images.filter((i) => !pairImages || !ATS_VARIANT.test(i.name))
      .map((i) => ({ entry: i, time: timeFromName(i.name) })).filter((x) => x.time !== null).sort((a, b) => a.time! - b.time!),
    [images, pairImages],
  )

  const videoTimeOf = useCallback(
    (row: ResultRow, video: VideoInfo | null) => {
      if (row.time === null) return null
      const base = baseSeconds(row.time, video, absolute)
      return base === null ? null : toVideoTime(base, sync)
    },
    [absolute, sync],
  )

  const seekVideo = (t: number) => {
    const video = videoRef.current
    if (!video) return
    const length = Number.isFinite(video.duration) ? video.duration : currentRaw?.duration
    const max = length ? length - 0.05 : t
    if (t < 0 || t > max) setNotice(t < 0 ? '이 스텝은 영상 시작 전입니다' : '이 스텝은 영상이 끝난 뒤입니다')
    video.currentTime = Math.max(0, Math.min(max, t))
  }

  const seekToRow = (row: ResultRow) => {
    setSelected(row.index)
    setNotice(null)
    picked.current = row.index >= 0 && row.time !== null ? { index: row.index, time: row.time } : null
    if (picked.current) setPlaying(row.index)
    const video = videoForRow(row, videos, currentVideo, absolute)
    if (!video) return setNotice('영상이 없습니다')
    const t = videoTimeOf(row, video)
    if (t === null) return setNotice('영상 시작 시각을 몰라 이 스텝의 영상 위치를 계산할 수 없습니다')
    if (video.path !== current) {
      pendingSeek.current = t
      setCurrent(video.path)
    } else seekVideo(t)
  }

  const seekToWall = (wall: number) => {
    const row: ResultRow = { index: -1, cells: [], time: wall, cycle: '', status: '', name: '', durationMs: null, message: '', images: [] }
    seekToRow(row)
  }

  const onTime = (t: number) => {
    setVideoNow(t)
    const wall = toRowTime(t, currentVideo, absolute, sync)
    setWallNow(wall)
    if (wall === null) return
    // 스텝 시작 직전(0.5초)부터 그 스텝으로 본다 (ReplayKit과 같음)
    const row = rowAtTime(sortedRows, wall + 500)
    // 누른 스텝은 다른 곳으로 옮기거나, 재생이 그 시각을 0.3초 넘기고 다음 시각의 스텝에 닿을 때까지 유지
    const pin = picked.current
    if (pin) {
      const moved = wall < pin.time - 1000 || (wall > pin.time + 300 && (row?.time ?? -Infinity) > pin.time)
      if (!moved) return
      picked.current = null
    }
    if (row && row.index !== playing) setPlaying(row.index)
  }

  /** 영상·위치로 이동 (다른 영상이면 바꾼 뒤) */
  const seekTo = (path: string, t: number) => {
    setNotice(null)
    if (path !== current) {
      pendingSeek.current = t
      setCurrent(path)
    } else seekVideo(t)
  }
  const wallOf = useCallback((path: string, t: number) => {
    if (!absolute) return null
    return toRowTime(t, videos.find((v) => v.path === path) ?? null, absolute, sync)
  }, [absolute, videos, sync])

  /** 머리글 거르기·스텝 고르기에 보이는 값: 시각 열은 [] 없이, 긴 메시지는 줄여서 */
  const cellLabel = useCallback((col: number, v: string) =>
    col === parsed?.table?.timeCell ? v.replace(/^\[|\]$/g, '')
      : parsed?.table?.pathCells?.includes(col) ? shortMessage(v).replace(/\s+/g, ' ')
        : v.replace(/\s+/g, ' '), [parsed])
  // 이미지 찾기를 고른 스텝 앞뒤로만: Result 표와 스텝의 영상 위치
  const stepSource = useMemo<StepSource>(() => ({
    headers: parsed?.headers ?? [],
    rows,
    label: cellLabel,
    position: (row) => {
      const video = videoForRow(row, videos, videos.find((v) => v.path === current) ?? null, absolute)
      const t = video ? videoTimeOf(row, video) : null
      return video && t !== null ? { path: video.path, seconds: t } : null
    },
  }), [parsed, rows, cellLabel, videos, current, absolute, videoTimeOf])

  const switchVideo = (step: 1 | -1) => {
    if (videos.length < 2) return
    const i = videos.findIndex((v) => v.path === current)
    setCurrent(videos[(i + step + videos.length) % videos.length].path)
  }

  // 목록 필터
  const cycles = useMemo(() => [...new Set(rows.map((r) => r.cycle).filter(Boolean))], [rows])
  const filterSets = useMemo(
    () => Object.entries(colFilters).map(([c, f]) => [Number(c), new Set(f.values ?? [])] as const),
    [colFilters],
  )
  // 머리글 거르기를 뺀 나머지 조건 (검색·실패만·회차)
  const baseRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) =>
      (!onlyFail || statusTone(r.status) === 'bad')
      && (!cycle || r.cycle === cycle)
      && (!q || r.cells.some((c) => c.toLowerCase().includes(q))))
  }, [rows, query, onlyFail, cycle])
  const visible = useMemo(() => {
    const list = baseRows.filter((r) => filterSets.every(([c, set]) => set.has(r.cells[c] ?? '')))
    if (!colSort) return list
    const dir = colSort.asc ? 1 : -1
    return [...list].sort((a, b) => compareCells(a.cells[colSort.col] ?? '', b.cells[colSort.col] ?? '') * dir || a.index - b.index)
  }, [baseRows, filterSets, colSort])
  // 거르기 메뉴의 값 목록: 다른 열 거르기만 적용한 행들 (엑셀처럼)
  const menuValues = useMemo(() => {
    if (!filterMenu) return []
    return baseRows.filter((r) => filterSets.every(([c, set]) => c === filterMenu.col || set.has(r.cells[c] ?? '')))
      .map((r) => r.cells[filterMenu.col] ?? '')
  }, [filterMenu, baseRows, filterSets])

  const focusRow = rows.find((r) => r.index === (playing ?? selected)) ?? null
  const nearImage = useMemo(() => {
    if (wallNow === null || timedImages.length === 0) return null
    let best = timedImages[0]
    for (const x of timedImages) if (Math.abs(x.time! - wallNow) < Math.abs(best.time! - wallNow)) best = x
    return best.entry.fullPath
  }, [wallNow, timedImages])

  return (
    <>
      <ViewerHead session={session} sessions={sessions} onBack={onBack} setDialog={setDialog} />
      {(session.state === 'loading' || converting) && <LoadingBar session={session} converting={converting} />}
      {/* RFW는 열이 11개라 표 쪽을 넓게 */}
      <div className={`rv-main${parsed?.table && !ats ? ' wide' : ''}`}>
        <section className={`rv-left${pairImages ? ' fit' : ''}`}>
          <VideoTransport
            src={currentRaw?.prep === 'ready' && currentRaw.playPath ? fileUrl(currentRaw.playPath) : null}
            waiting={currentRaw && (
              <VideoWaiting
                video={currentRaw}
                onConvert={() => void convertVideo(id, currentRaw.path)}
                onOriginal={() => playOriginal(id, currentRaw.path)}
                othersToConvert={needsConvert.filter((v) => v.path !== currentRaw.path).length}
                onConvertAll={() => needsConvert.forEach((v) => void convertVideo(id, v.path))}
              />
            )}
            durationHint={currentRaw?.duration ?? null}
            fps={currentRaw?.fps ?? null}
            videoRef={videoRef}
            keysEnabled={dialog === null}
            error={videoError}
            onTime={onTime}
            onLoaded={(duration) => {
              setVideoError(null)
              if (current && Number.isFinite(duration)) updateVideo(current, { duration })
              if (pendingSeek.current !== null) {
                seekVideo(pendingSeek.current)
                pendingSeek.current = null
              }
            }}
            onSwitch={videos.length > 1 ? switchVideo : undefined}
            overlay={<CropOverlay state={search} videoRef={videoRef} currentPath={current} />}
            marks={search.open ? search.segments.filter((m) => m.path === current).map((m) => ({ start: m.first / m.fps, end: (m.last + 1) / m.fps })) : undefined}
            extra={
              <>
                {videos.length > 1 && (
                  <select value={current ?? ''} onChange={(e) => setCurrent(e.target.value)} title="영상 (F/R)">
                    {videos.map((v) => <option key={v.path} value={v.path}>{`${v.name}${PREP_TAG[rawVideos.find((r) => r.path === v.path)?.prep ?? 'ready'] ?? ''}`}</option>)}
                  </select>
                )}
                <button type="button" onMouseDown={(e) => e.preventDefault()} disabled={!currentRaw?.playPath} className={search.open ? 'active' : ''} onClick={() => (search.open ? search.close() : search.start())} title="크롭한 이미지가 이 실행의 영상에 나타나는 구간 찾기 (테스트 PC에서 ffmpeg)">🔍 이미지 찾기</button>
                <button type="button" onMouseDown={(e) => e.preventDefault()} disabled={!current} onClick={() => setDialog('trim')} title="영상 구간 자르기 (테스트 PC에서 ffmpeg, 원래 영상 폴더에 저장)">✂ 자르기</button>
              </>
            }
          />
          {currentRaw?.prep === 'ready' && currentRaw.playPath === currentRaw.path && currentRaw.prepNote && (
            <div className="rv-notice small" title={currentRaw.prepNote}>
              ⚠ {currentRaw.prepNote}{currentRaw.prepNote !== ORIGINAL_NOTE && ' — 길이가 안 나오거나 스텝 위치가 어긋나면 이 PC의 에이전트를 업데이트하세요 (업데이트 → 에이전트 업데이트)'}
            </div>
          )}
          <div className="rv-sync-line small muted">
            {currentVideo
              ? <>영상 시작: {currentVideo.start !== null ? formatWall(currentVideo.start, true) : '모름'} ({START_SOURCE_LABEL[currentVideo.startSource]})</>
              : 'Result만 보는 중 (영상 없음)'}
            {wallNow !== null && absolute && <> · 지금 {formatWall(wallNow)}</>}
          </div>
          {notice && <div className="rv-notice small">{notice}</div>}
          {search.open && (
            <ImageSearchPanel
              state={search}
              videos={searchVideos}
              steps={stepSource}
              currentPath={current}
              escape={dialog === null}
              nowSeconds={videoNow}
              wallOf={wallOf}
              onSeek={seekTo}
            />
          )}
          <div className="rv-images" hidden={search.open}>
            {pairImages ? (
              <AtsImagePanel
                row={focusRow}
                byName={imagesByName}
                resolve={resolveImage}
                url={(p) => fileUrl(resolveImage(p))}
                onPreview={setPreview}
              />
            ) : <>
            <div className="rv-images-title small muted">스텝 이미지 {focusRow ? `· #${focusRow.index + 1} ${focusRow.name}` : ''}</div>
            <div className="rv-thumbs">
              {(focusRow?.images ?? []).map((p) => (
                <figure key={p} onClick={() => setPreview(fileUrl(resolveImage(p)))} title={p}>
                  <img src={fileUrl(resolveImage(p))} alt="" loading="lazy" />
                  <figcaption className="ellipsis small">{baseName(p)}</figcaption>
                </figure>
              ))}
              {focusRow && focusRow.images.length === 0 && <span className="muted small">이 스텝에 적힌 이미지가 없습니다</span>}
            </div>
            </>}
            {!pairImages && timedImages.length > 0 && (
              <>
                <div className="rv-images-title small muted">이미지 폴더 ({timedImages.length}) · 누르면 그 시각으로 이동</div>
                <div className="rv-strip">
                  {timedImages.map(({ entry, time }) => (
                    <figure
                      key={entry.fullPath}
                      className={entry.fullPath === nearImage ? 'near' : ''}
                      onClick={() => seekToWall(time!)}
                      onDoubleClick={() => setPreview(fileUrl(entry.fullPath))}
                      title={`${entry.name} · ${formatWall(time, true)} (더블클릭: 크게)`}
                    >
                      <img src={fileUrl(entry.fullPath)} alt="" loading="lazy" />
                      <figcaption className="small">{formatWall(time)}</figcaption>
                    </figure>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
        <section className="rv-right">
          {parsed?.table ? (Object.keys(colFilters).length > 0 || colSort) && (
            // ATS·RFW: 거르기·정렬은 머리글에서, 표는 항상 재생 중인 스텝을 따라간다
            <div className="rv-filters">
              <button type="button" className="link small" onClick={() => {
                setColFilters({})
                setColSort(null)
              }}>
                머리글 필터·정렬 지우기 ({Object.keys(colFilters).length})
              </button>
            </div>
          ) : (
            <div className="rv-filters">
              <input placeholder="검색 (모든 열)" value={query} onChange={(e) => setQuery(e.target.value)} />
              <select value={cycle} onChange={(e) => setCycle(e.target.value)} title="회차">
                <option value="">전체 회차</option>
                {cycles.map((c) => <option key={c} value={c}>회차 {c}</option>)}
              </select>
              <label className="small"><input type="checkbox" checked={onlyFail} onChange={(e) => setOnlyFail(e.target.checked)} /> 실패만</label>
              <label className="small" title="재생 중인 스텝으로 표를 따라 움직임"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 따라가기</label>
              <span className="muted small">{visible.length.toLocaleString()} / {rows.length.toLocaleString()}행</span>
            </div>
          )}
          {runInfo && <RunSummary info={runInfo} />}
          {!parsed ? <p className="muted rv-loading">Result 읽는 중…</p> : (
            <RowTable
              headers={parsed.table ? parsed.headers : null}
              spec={parsed.table ?? null}
              filtered={colFilters}
              sort={colSort}
              onHeader={(col, rect) => setFilterMenu((m) => (m?.col === col ? null : { col, x: rect.left, y: rect.bottom + 2 }))}
              rows={visible}
              selected={selected}
              playing={playing}
              follow={!!parsed.table || follow}
              anchors={sync.anchors}
              videoTime={(row) => {
                const t = videoTimeOf(row, videoForRow(row, videos, currentVideo, absolute))
                return t === null ? '' : formatSeconds(t)
              }}
              onPick={seekToRow}
            />
          )}
        </section>
      </div>

      {filterMenu && parsed && (
        <ColumnFilterMenu
          key={filterMenu.col}
          x={filterMenu.x}
          y={filterMenu.y}
          title={parsed.headers[filterMenu.col]}
          values={menuValues}
          label={(v) => cellLabel(filterMenu.col, v)}
          filter={colFilters[filterMenu.col]}
          sort={colSort?.col === filterMenu.col ? (colSort.asc ? 'asc' : 'desc') : null}
          onApply={(f) => setColFilters((all) => {
            const next = { ...all }
            if (f) next[filterMenu.col] = f
            else delete next[filterMenu.col]
            return next
          })}
          onSort={(asc) => setColSort({ col: filterMenu.col, asc })}
          onClose={() => setFilterMenu(null)}
        />
      )}
      {dialog === 'trim' && (
        <TrimDialog
          agentId={source.agentId}
          rows={sortedRows}
          absolute={absolute}
          selection={trimSel}
          onChange={setTrimSel}
          position={stepSource.position}
          videoDuration={(path) => videos.find((v) => v.path === path)?.duration ?? null}
          previewUrl={(path) => {
            const raw = rawVideos.find((v) => v.path === path)
            return raw?.prep === 'ready' && raw.playPath ? fileUrl(raw.playPath) : null
          }}
          onAdd={(path) => addSessionVideo(id, path)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'save' && parsed && (
        <SaveDialog
          source={source}
          set={set}
          config={{
            mode: source.mode,
            refDir: source.refDir,
            mapping,
            sync,
            playPaths: Object.fromEntries(rawVideos.filter((v) => v.playPath && v.playPath !== v.path)
              .map((v) => [v.path, { playPath: v.playPath!, duration: v.duration, fps: v.fps }])),
          }}
          videos={rawVideos}
          backupFiles={[...new Set([
            ...images.filter((i) => !pairImages || !/_full\.\w+$/i.test(i.name)).map((i) => i.fullPath),
            ...rows.flatMap((r) => [...r.images, ...atsVariants(r.ats, imagesByName)].map(resolveImage)),
          ])]}
          onSaved={(saved) => setSessionSet(id, saved)}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}

function ViewerHead({ session, sessions, onBack, setDialog }: {
  session: ResultSession
  sessions: ResultSession[]
  onBack: () => void
  setDialog: (d: Dialog) => void
}) {
  const { source, set } = session
  return (
    <header className="rv-head">
      <button type="button" onClick={onBack} title="Result·영상·이미지 다시 고르기 (다시 불러옴)">← 경로</button>
      <strong>결과 확인 · {RESULT_MODE_LABEL[source.mode]}</strong>
      {/* 불러온 다른 결과로 바로 전환 */}
      <select
        className="rv-switch"
        value={session.id}
        title={`${source.machineName} · ${source.resultPath}`}
        onChange={(e) => openViewer(e.target.value)}
      >
        {sessions.map((s) => (
          <option key={s.id} value={s.id} disabled={s.state === 'failed'}>
            {sessionTitle(s)} · {s.source.machineName}{s.state === 'loading' ? ` (불러오는 중 ${s.done}/${s.total})` : s.state === 'failed' ? ' (실패)' : ''}
          </option>
        ))}
      </select>
      {set && set.backup.state !== 'done' && (
        <span className={`small ${set.backup.state === 'failed' ? 'error' : 'muted'}`}>
          백업 {set.backup.state === 'failed' ? '실패' : `중 ${set.backup.filesDone}/${set.backup.filesTotal}`}
        </span>
      )}
      <span className="rv-spacer" />
      <button type="button" onClick={openSets} title="저장해 둔 결과 확인 불러오기">불러오기</button>
      <button
        type="button"
        className="primary"
        disabled={session.state === 'loading'}
        onClick={() => setDialog('save')}
        title={session.state === 'loading' ? '불러오는 중에는 저장할 수 없습니다 (다 되면 저장)' : 'Result·이미지(·영상)를 서버에 저장'}
      >
        저장
      </button>
      {RESULT_TAB_ID ? (
        <button
          type="button"
          className="icon"
          aria-label="탭 닫기"
          title="탭 닫기 (Esc: 화면만 닫기)"
          onClick={() => {
            // 스크립트로 연 탭이라 닫힌다. 못 닫으면(직접 연 주소 등) 화면만 닫아 '탭 닫기' 단추가 있는 안내로
            window.close()
            closeViewer()
          }}
        >
          ✕
        </button>
      ) : (
        <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc) — 진행상황에서 다시 열 수 있습니다" onClick={closeViewer}>✕</button>
      )}
    </header>
  )
}

// ─────────────────────────────── 불러오는 중: 화면은 먼저 열고 진행(받는 속도·남은 시간)은 따로

const pad2 = (n: number) => String(n).padStart(2, '0')
/** 남은 초 → m:ss (한 시간 넘으면 h:mm:ss) */
const formatEta = (sec: number) => {
  const t = Math.ceil(sec)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  return h ? `${h}:${pad2(m)}:${pad2(t % 60)}` : `${m}:${pad2(t % 60)}`
}

/** 진행 막대 + 무엇을 · 몇 % · 받은 양 · 속도 · 남은 시간 */
function ProgressLine({ progress: p }: { progress: LoadProgress }) {
  return (
    <div className="rv-progress">
      <progress max={1} value={p.fraction ?? undefined} />
      <span className="rv-progress-text small">
        <span>{p.label}</span>
        {p.fraction !== null && <span className="mono">{`${Math.floor(p.fraction * 100)}%`}</span>}
        {p.total !== null && <span className="mono muted">{`${formatBytes(p.bytes)} / ${formatBytes(p.total)}`}</span>}
        {p.rate !== null && <span className="mono">{`${formatBytes(p.rate)}/s`}</span>}
        <span>{p.eta !== null ? `남은 시간 약 ${formatEta(p.eta)}` : '남은 시간 계산 중'}</span>
      </span>
    </div>
  )
}

/** 머리글 아래: 불러오는 중이거나, 다 불러온 뒤 승인한 변환을 하는 중 */
function LoadingBar({ session, converting }: { session: ResultSession; converting: RawVideo | undefined }) {
  const loading = session.state === 'loading'
  const progress = session.progress ?? converting?.progress ?? null
  const step = loading ? session.step : converting?.name ?? ''
  return (
    <div className="rv-loadbar" role="status">
      <strong className="small">{loading ? `불러오는 중 ${session.done}/${session.total}` : '재생용 영상 만드는 중'}</strong>
      <span className="small muted ellipsis" title={step}>{step}</span>
      {progress && <ProgressLine progress={progress} />}
    </div>
  )
}

/** 영상 고르기 목록에 붙이는 상태 */
const PREP_TAG: Partial<Record<RawVideo['prep'], string>> = {
  'needs-convert': ' (변환 필요)',
  converting: ' (변환 중)',
  failed: ' (실패)',
}

/** 영상 자리: 준비 단계와 진행. 바로 재생할 수 없으면 까닭·변환 내용·사본 크기를 보여 주고 승인을 받는다 */
function VideoWaiting({ video, onConvert, onOriginal, othersToConvert, onConvertAll }: {
  video: RawVideo
  onConvert: () => void
  onOriginal: () => void
  /** 이 영상 말고도 변환을 기다리는 영상 수 */
  othersToConvert: number
  onConvertAll: () => void
}) {
  if (video.prep === 'needs-convert') {
    const c = video.convert
    return (
      <div className="rv-video-wait rv-convert">
        <strong>바로 재생할 수 없는 영상입니다</strong>
        <div>{c?.reason ?? '브라우저가 이 영상을 그대로 재생·탐색할 수 없습니다'}</div>
        <div className="small">
          {`변환하면: ${c?.what ?? video.prepNote ?? '탐색할 수 있는 재생용 사본'}`}
          {c?.transcode ? ' — 다시 인코딩이라 시간이 오래 걸립니다' : ' — 화질 그대로, 비교적 빠릅니다'}
        </div>
        {c?.sourceBytes && (
          <div className="small">
            {`사본: 테스트 PC ${c.cacheDrive ?? ''}에 약 ${formatBytes(c.sourceBytes)}${c.cacheFreeBytes ? ` (남은 공간 ${formatBytes(c.cacheFreeBytes)})` : ''}`}
            {' · 원본은 그대로이고, 사본은 Result 탭에서 지울 수 있습니다'}
          </div>
        )}
        <div className="rv-convert-actions">
          <button type="button" className="primary" onClick={onConvert}>변환 시작</button>
          {othersToConvert > 0 && <button type="button" onClick={onConvertAll}>{`변환이 필요한 영상 ${othersToConvert + 1}개 모두 변환`}</button>}
          <button type="button" onClick={onOriginal} title="이동이 느리거나 안 될 수 있습니다">변환 없이 원본 재생</button>
        </div>
      </div>
    )
  }
  const text = video.prep === 'waiting' ? '앞 영상을 준비한 뒤 이 영상을 준비합니다…'
    : video.prep === 'checking' ? '영상 확인 중…'
      : video.prep === 'failed' ? `재생용 영상을 만들지 못했습니다: ${video.prepNote ?? ''}`
        : video.prep === 'ready' ? null
          : `탐색할 수 있는 재생용 영상을 테스트 PC에서 만드는 중… (${video.prepNote ?? ''}, 한 번 만들면 다시 쓰고 원본은 그대로)`
  return (
    <div className="rv-video-wait">
      {text && <div>{text}</div>}
      {video.progress && <ProgressLine progress={video.progress} />}
      {video.prep === 'failed' && (
        <div className="rv-convert-actions">
          <button type="button" onClick={onConvert}>다시 변환</button>
          <button type="button" onClick={onOriginal}>변환 없이 원본 재생</button>
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────── ATS 원본·결과 이미지

/** 결과 폴더의 같은 캡처 변형: _result(차이 표시) · _full(전체 화면) */
const ATS_VARIANT = /_(full|result)\.\w+$/i

/** 결과 이미지 파일 이름 → 같은 캡처의 변형 경로 (결과 폴더에 있을 때만) */
function variantsOf(result: string | null, byName: Map<string, string>) {
  if (!result) return { full: null, diff: null }
  const name = baseName(result)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  return {
    full: byName.get(`${stem}_full${ext}`.toLowerCase()) ?? null,
    diff: byName.get(`${stem}_result${ext}`.toLowerCase()) ?? null,
  }
}

function atsVariants(ats: AtsImages | undefined, byName: Map<string, string>): string[] {
  if (!ats) return []
  const v = variantsOf(ats.result, byName)
  return [ats.target, ats.ref, ats.result, ats.diff, v.diff].filter((p): p is string => !!p)
}

const ATS_KIND_LABEL: Record<AtsImages['kind'], string> = {
  p: '이미지 찾기 (STATUS)',
  y: '이미지 비교 (STEP RESULT)',
  py: '이미지 찾기 + 비교 (STATUS · STEP RESULT)',
}

/** 영상 아래: 원본 · 결과 두 장. P열(찾을 이미지)과 Y열(비교 이미지)을 구분해 보여 준다 */
function AtsImagePanel({ row, byName, resolve, url, onPreview }: {
  row: ResultRow | null
  byName: Map<string, string>
  /** Result에 적힌 경로 → 실제로 찾은 파일 (차이·전체 화면 사본은 찾은 캡처 이름으로) */
  resolve: (path: string) => string
  url: (path: string) => string
  onPreview: (url: string) => void
}) {
  const [view, setView] = useState<'capture' | 'diff' | 'full'>('capture')
  const ats = row?.ats ?? null
  const v = variantsOf(ats?.result ? resolve(ats.result) : null, byName)
  const diff = v.diff ?? ats?.diff ?? null
  const result = view === 'full' && v.full ? v.full : view === 'diff' && diff ? diff : ats?.result ?? null
  // 원본: 비교(Y)가 있으면 비교 기준 이미지, 찾기(P)만 있으면 찾을 이미지
  const original = ats ? ats.ref ?? ats.target : null
  const tone = row ? statusTone(row.status) : ''
  const emptyText = !row ? '스텝을 고르거나 영상을 재생하세요' : !ats ? '이 스텝에는 이미지가 없습니다' : null

  // 이미지가 없어도 같은 칸을 그대로 그려 영상 크기가 바뀌지 않게 한다 (제목 한 줄 + 두 칸)
  return (
    <div className="rv-ats-images">
      <div className="rv-images-title small">
        {ats && <span className={`rv-ats-kind kind-${ats.kind}`}>{ats.label ?? ATS_KIND_LABEL[ats.kind]}</span>}
        {row ? <span className="muted"> #{row.index + 1} {row.name}</span> : <span className="muted">원본 · 결과 이미지</span>}
        {row?.status && <span className={`rv-ats-status tone-${tone || 'none'}`}> {row.status}</span>}
        {ats?.kind === 'py' && ats.target && (
          <span className="muted"> · 찾을 이미지 <button type="button" className="link" title={ats.target} onClick={() => onPreview(url(ats.target!))}>{baseName(ats.target)}</button></span>
        )}
        {ats?.note && <span className="muted ellipsis rv-ats-note" title={ats.note}> · {ats.note}</span>}
      </div>
      <div className="rv-ats-pair">
        <AtsImageCard title={ats?.ref ? '원본 (REF)' : ats?.target ? '원본 (찾을 이미지)' : '원본'} path={original} url={url} onPreview={onPreview} empty={emptyText ?? '원본 이미지 없음'} />
        <AtsImageCard
          title="결과"
          path={result}
          url={url}
          onPreview={onPreview}
          empty={emptyText ?? (ats?.kind !== 'p' ? '결과 이미지 없음' : ats.label ? '결과 이미지 없음 (원본과의 일치율만 기록됨)' : '결과 이미지 없음 — 화면에서 찾지 못함')}
          tools={ats?.result && (diff || v.full) ? (
            <span className="rv-ats-views">
              <button type="button" className={view === 'capture' ? 'active' : ''} onClick={() => setView('capture')}>캡처</button>
              {diff && <button type="button" className={view === 'diff' ? 'active' : ''} onClick={() => setView('diff')}>차이</button>}
              {v.full && <button type="button" className={view === 'full' ? 'active' : ''} onClick={() => setView('full')}>전체 화면</button>}
            </span>
          ) : null}
        />
      </div>
    </div>
  )
}

function AtsImageCard({ title, path, url, onPreview, empty, tools }: {
  title: string
  path: string | null
  url: (path: string) => string
  onPreview: (url: string) => void
  empty?: string
  tools?: React.ReactNode
}) {
  const [failed, setFailed] = useState<string | null>(null)
  return (
    <figure className="rv-ats-card">
      <figcaption className="small">
        <strong>{title}</strong>
        {path && <span className="muted ellipsis" title={path}> {baseName(path)}</span>}
        <span className="rv-spacer" />
        {tools}
      </figcaption>
      {!path ? <div className="rv-ats-empty muted small">{empty ?? '이미지 없음'}</div>
        : failed === path ? <div className="rv-ats-empty error small" title={path}>이미지를 열지 못했습니다 — 원본·결과 이미지 폴더를 지정해 보세요</div>
          : <img src={url(path)} alt="" onClick={() => onPreview(url(path))} onError={() => setFailed(path)} title="누르면 크게" />}
    </figure>
  )
}

// ─────────────────────────────── 스텝 표 (행이 많아 보이는 부분만 그린다)

/** 선택한 칸: row = ResultRow.index, col = 열 번호 (-1 = # 열, 행 전체) */
type CellPos = { row: number; col: number }

// 앞자리 0이 없는 숫자만 엑셀이 숫자로 받게 두고, 나머지는 글자 그대로 (1/2 → 날짜, 007 → 7 같은 변환 막기)
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

/**
 * 표 칸을 클립보드로: 엑셀에 붙이면 칸마다 들어가게 TSV와 HTML 표를 함께 넣는다.
 * http 접속에서도 되게 navigator.clipboard 대신 copy 이벤트로
 */
function copyTable(lines: string[][]) {
  const tsv = lines.map((line) => line.map((v) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\r\n')
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const td = (v: string) => (PLAIN_NUMBER.test(v) ? `<td>${v}</td>`
    : `<td style="mso-number-format:'\\@'">${esc(v).replace(/\r?\n/g, '<br style="mso-data-placement:same-cell">')}</td>`)
  const html = `<html><head><meta charset="utf-8"></head><body><table>${lines.map((line) => `<tr>${line.map(td).join('')}</tr>`).join('')}</table></body></html>`
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault()
    e.clipboardData?.setData('text/plain', tsv)
    e.clipboardData?.setData('text/html', html)
  }
  document.addEventListener('copy', onCopy)
  try {
    document.execCommand('copy')
  } finally {
    document.removeEventListener('copy', onCopy)
  }
}

function RowTable({ headers, spec, filtered, sort, onHeader, rows, selected, playing, follow, anchors, videoTime, onPick }: {
  /** ATS·RFW: 이 열 이름으로 행의 칸을 그대로 보여 준다 (null이면 자동 판별 공통 열) */
  headers: string[] | null
  spec: TableSpec | null
  filtered: ColFilters
  sort: ColSort | null
  /** ATS 머리글 누름 → 거르기 메뉴 */
  onHeader: (col: number, rect: DOMRect) => void
  rows: ResultRow[]
  selected: number | null
  playing: number | null
  follow: boolean
  anchors: Anchor[]
  videoTime: (row: ResultRow) => string
  onPick: (row: ResultRow) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const headRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState(0)
  // [전체 보기]: 앞 열을 줄이고 그 열(RFW Message)을 가장 긴 내용만큼 넓힌다. 다시 누르면 원래대로
  const [expanded, setExpanded] = useState(false)
  const expandCell = spec?.expandCell
  const canExpand = !!headers && expandCell !== undefined && !!spec?.expandColumns
  const expandWidth = useMemo(() => {
    if (!expanded || !canExpand || !bodyRef.current) return 0
    const context = document.createElement('canvas').getContext('2d')
    if (!context) return 0
    // 표 칸과 같은 글꼴로 잰다
    const sample = bodyRef.current.querySelector('.rv-row > span') ?? bodyRef.current
    context.font = getComputedStyle(sample).font || '12px sans-serif'
    const show = (c: string) => (spec?.pathCells?.includes(expandCell) ? shortMessage(c) : c)
    let widest = 0
    for (const row of rows) widest = Math.max(widest, context.measureText(show(row.cells[expandCell] ?? '')).width)
    // 칸 여백(좌우 5px) · 테두리 · 반올림 여유
    return Math.min(20000, Math.ceil(widest) + 16)
  }, [expanded, canExpand, rows, spec, expandCell])
  const wide = expanded && canExpand && expandWidth > 0
  const [height, setHeight] = useState(400)
  const lastUserScroll = useRef(0)

  // 칸 선택 (ATS·RFW): 누르고 끌면 여러 칸·행, # 열은 행 전체, Shift+누르기로 넓히기, Ctrl+A 전체, Ctrl+C 복사(엑셀에 칸마다)
  const [sel, setSel] = useState<{ anchor: CellPos; focus: CellPos } | null>(null)
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const posOf = useMemo(() => new Map(rows.map((r, i) => [r.index, i])), [rows])
  const range = useMemo(() => {
    if (!sel || !headers) return null
    const a = posOf.get(sel.anchor.row)
    const f = posOf.get(sel.focus.row)
    if (a === undefined || f === undefined) return null
    const whole = sel.anchor.col < 0 || sel.focus.col < 0
    return {
      top: Math.min(a, f),
      bottom: Math.max(a, f),
      left: whole ? 0 : Math.min(sel.anchor.col, sel.focus.col),
      right: whole ? headers.length - 1 : Math.max(sel.anchor.col, sel.focus.col),
    }
  }, [sel, posOf, headers])
  const drag = useRef<{ x: number; y: number; col: number } | null>(null)
  const stopDrag = useRef<(() => void) | null>(null)
  useEffect(() => () => stopDrag.current?.(), [])

  /** 끄는 중인 마우스 위치의 칸까지 선택 (표 밖이면 가장자리 칸) */
  const dragTo = () => {
    const d = drag.current
    const body = bodyRef.current
    const list = rowsRef.current
    if (!d || !body || list.length === 0) return
    const rect = body.getBoundingClientRect()
    const pos = Math.max(0, Math.min(list.length - 1, Math.floor((d.y - rect.top + body.scrollTop) / ROW_HEIGHT)))
    const hit = document.elementFromPoint(
      Math.max(rect.left + 1, Math.min(rect.left + body.clientWidth - 1, d.x)),
      Math.max(rect.top + 1, Math.min(rect.top + body.clientHeight - 1, d.y)),
    )?.closest<HTMLElement>('[data-col]')
    if (hit && body.contains(hit)) {
      const col = Number(hit.dataset.col)
      // 칸에서 시작했으면 # 열로 끌어도 칸 선택 그대로
      if (col >= 0 || d.col < 0) d.col = col
    }
    setSel((s) => (s ? { anchor: s.anchor, focus: { row: list[pos].index, col: d.col } } : s))
  }

  const onCellDown = (e: React.MouseEvent) => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-col]')
    const rowEl = cell?.closest<HTMLElement>('[data-pos]')
    const row = rowEl ? rows[Number(rowEl.dataset.pos)] : undefined
    if (e.button !== 0 || !cell || !row) return
    // 글자 선택 대신 칸 선택 (누르기는 그대로 영상 이동)
    e.preventDefault()
    bodyRef.current?.focus({ preventScroll: true })
    stopDrag.current?.()
    const at = { row: row.index, col: Number(cell.dataset.col) }
    const extend = e.shiftKey && !!sel && posOf.has(sel.anchor.row)
    setSel((s) => (extend && s ? { anchor: s.anchor, focus: at } : { anchor: at, focus: at }))
    const d = { x: e.clientX, y: e.clientY, col: extend && sel ? (sel.anchor.col < 0 ? -1 : at.col) : at.col }
    drag.current = d
    // 표 위·아래(옆) 밖으로 끌면 그쪽으로 스크롤하며 넓힌다
    const timer = window.setInterval(() => {
      const body = bodyRef.current
      if (!body) return
      const rect = body.getBoundingClientRect()
      const out = (v: number, lo: number, hi: number) => (v < lo ? v - lo : v > hi ? v - hi : 0)
      const dy = out(d.y, rect.top, rect.top + body.clientHeight)
      const dx = out(d.x, rect.left, rect.left + body.clientWidth)
      if (!dy && !dx) return
      body.scrollTop += Math.max(-300, Math.min(300, dy))
      body.scrollLeft += Math.max(-300, Math.min(300, dx))
      lastUserScroll.current = Date.now()
      dragTo()
    }, 50)
    const onMove = (ev: MouseEvent) => {
      d.x = ev.clientX
      d.y = ev.clientY
      lastUserScroll.current = Date.now()
      dragTo()
    }
    const stop = () => {
      window.clearInterval(timer)
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', stop)
      drag.current = null
      stopDrag.current = null
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', stop)
    stopDrag.current = stop
  }

  const onTableKey = (e: React.KeyboardEvent) => {
    if (!headers || !spec) return
    const ctrl = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (ctrl && key === 'a' && rows.length > 0) {
      e.preventDefault()
      e.stopPropagation()
      setSel({ anchor: { row: rows[0].index, col: -1 }, focus: { row: rows[rows.length - 1].index, col: -1 } })
    } else if (ctrl && key === 'c' && range) {
      e.preventDefault()
      e.stopPropagation()
      copyTable(rows.slice(range.top, range.bottom + 1).map((row) => {
        const line: string[] = []
        for (let c = range.left; c <= range.right; c++)
          line.push(c === spec.timeCell ? formatWall(row.time, true) || (row.cells[c] ?? '') : row.cells[c] ?? '')
        return line
      }))
    } else if (e.key === 'Escape' && sel) {
      // Esc: 선택 먼저 지우고, 한 번 더 누르면 닫기
      e.stopPropagation()
      setSel(null)
    }
  }

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const observer = new ResizeObserver(() => setHeight(body.clientHeight))
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  // 재생 중인 스텝을 따라 스크롤 (사용자가 막 스크롤했으면 잠시 두기)
  useEffect(() => {
    const body = bodyRef.current
    if (!follow || playing === null || !body || Date.now() - lastUserScroll.current < 2000) return
    const i = rows.findIndex((r) => r.index === playing)
    if (i < 0) return
    const top = i * ROW_HEIGHT
    if (top < body.scrollTop || top > body.scrollTop + body.clientHeight - ROW_HEIGHT * 2)
      body.scrollTop = Math.max(0, top - body.clientHeight / 3)
  }, [playing, follow, rows])

  const first = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 10)
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW_HEIGHT) + 10)
  const anchorRows = new Set(anchors.map((a) => a.row))
  const center = new Set(spec?.center ?? [])
  const grid = spec
    ? { gridTemplateColumns: wide ? `40px ${spec.expandColumns} minmax(${expandWidth}px, 1fr)` : `40px ${spec.columns}` }
    : undefined
  // 넓힌 표는 가로로 스크롤 (머리글도 같이)
  const wideWidth = wide ? 40 + (spec?.expandColumns ?? '').split(/\s+/).reduce((sum, w) => sum + (parseFloat(w) || 0), 0) + expandWidth : 0

  const colHead = (h: string, i: number) => (
    <button
      key={i}
      type="button"
      className={`rv-colhead${filtered[i] ? ' filtered' : ''}${center.has(i) ? ' center' : ''}`}
      title={`${h} — 눌러서 거르기·정렬`}
      onClick={(e) => onHeader(i, e.currentTarget.getBoundingClientRect())}
    >
      {/* 짧은 열은 낱말마다 줄을 바꿔 좁게 (ACTION / CHECK) */}
      <span className="rv-colhead-label">{center.has(i) ? h.replace(/\s+/g, '\n') : h}</span>
      <span className="rv-colhead-ico">{sort?.col === i ? (sort.asc ? '↑' : '↓') : ''}{filtered[i] ? '⧩' : '▾'}</span>
    </button>
  )

  return (
    <div className={`rv-table${spec ? ' fixed' : ''}${wide ? ' expanded' : ''}`}>
      <div className="rv-head-scroll" ref={headRef}>
        <div className="rv-row rv-row-head small" style={{ ...grid, ...(wide ? { minWidth: wideWidth } : null) }}>
          {headers
            ? <><span>#</span>{headers.map((h, i) => (canExpand && i === expandCell ? (
                <span key={i} className="rv-colhead-wrap">
                  {colHead(h, i)}
                  <button
                    type="button"
                    className={`rv-colhead-expand${expanded ? ' on' : ''}`}
                    title={expanded ? '원래 폭으로' : '전체 보기 — 앞 열을 줄이고 이 열을 내용 전체 길이로'}
                    aria-pressed={expanded}
                    onClick={() => setExpanded((v) => !v)}
                  >
                    {expanded ? '⇤' : '⇔'}
                  </button>
                </span>
              ) : colHead(h, i)))}</>
            : <><span>#</span><span>시간</span><span>회차</span><span>스텝</span><span>결과</span><span>걸린 시간</span><span>메시지</span><span>영상</span></>}
        </div>
      </div>
      <div
        className="rv-table-body"
        ref={bodyRef}
        onScroll={(e) => {
          setScroll(e.currentTarget.scrollTop)
          if (headRef.current) headRef.current.scrollLeft = e.currentTarget.scrollLeft
        }}
        onWheel={() => (lastUserScroll.current = Date.now())}
        onMouseDown={headers && spec ? onCellDown : undefined}
        onKeyDown={onTableKey}
        tabIndex={headers && spec ? 0 : undefined}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative', ...(wide ? { minWidth: wideWidth } : null) }}>
          {rows.slice(first, last).map((row, i) => {
            const pos = first + i
            const inRows = !!range && pos >= range.top && pos <= range.bottom
            const isCur = (c: number) => !!sel && sel.focus.row === row.index && sel.focus.col === c
            const cellClass = (c: number) => (inRows && c >= range!.left && c <= range!.right ? ' rv-cell-sel' : '') + (isCur(c) ? ' rv-cell-cur' : '')
            return (
            <div
              key={row.index}
              data-pos={pos}
              className={`rv-row${row.index === selected ? ' selected' : ''}${row.index === playing ? ' playing' : ''} tone-${statusTone(row.status) || 'none'}`}
              style={{ position: 'absolute', top: pos * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT, ...grid }}
              onClick={() => onPick(row)}
              title="누르면 영상의 이 시점으로"
            >
              <span className={`muted${inRows ? ' rv-cell-rowsel' : ''}`} data-col={headers && spec ? -1 : undefined}>{anchorRows.has(row.index) ? '📍' : row.index + 1}</span>
              {headers && spec ? row.cells.map((c, i) => {
                const tone = statusTone(c)
                // 결과 열은 늘 색, 알림 열(ACTION CHECK·Message Level)은 실패·경고일 때만
                const colored = spec.statusCells.includes(i) || (spec.alertCells.includes(i) && (tone === 'bad' || tone === 'warn'))
                return (
                  <span
                    key={i}
                    data-col={i}
                    className={`${i === spec.timeCell ? 'mono' : colored ? `rv-status cell-${tone || 'none'}` : 'ellipsis'}${center.has(i) ? ' rv-center' : ''}${cellClass(i)}`}
                    title={c}
                  >
                    {i === spec.timeCell ? formatWall(row.time, true) || c : spec.pathCells?.includes(i) ? shortMessage(c) : c}
                  </span>
                )
              }) : (
                <>
                  <span className="mono">{formatWall(row.time)}</span>
                  <span>{row.cycle}</span>
                  <span className="ellipsis" title={row.name}>{row.name}</span>
                  <span className="rv-status">{row.status}</span>
                  <span className="mono">{row.durationMs === null ? '' : `${(row.durationMs / 1000).toFixed(2)}s`}</span>
                  <span className="ellipsis" title={row.message}>{row.message}</span>
                </>
              )}
              {!headers && <span className="mono muted">{videoTime(row)}</span>}
            </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────── 표 머리글 위 요약

interface RunInfo {
  absolute: boolean
  /** 첫 스텝 시각 · 마지막 스텝이 끝난 시각 (벽시계 ms, 경과 시간 Result면 경과 ms) */
  start: number
  end: number
  /** 돈 Cycle 수 · 계획한 수 (모르면 null) */
  cycles: number
  cycleTotal: number | null
}

/** 시간 길이 h:mm:ss */
const formatClock = (ms: number) => {
  const total = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(total / 3600)}:${pad2(Math.floor((total % 3600) / 60))}:${pad2(total % 60)}`
}

/** 테스트 시작 · 종료 · 총 시간 · Cycle */
function RunSummary({ info }: { info: RunInfo }) {
  // 날짜까지, 밀리초는 뺀다
  const stamp = (ms: number) => formatWall(ms, true).replace(/\.\d+$/, '')
  return (
    <div className="rv-run-info small">
      {info.absolute && (
        <>
          <span><span className="muted">시작</span> <span className="mono">{stamp(info.start)}</span></span>
          <span title="마지막 스텝이 끝난 시각"><span className="muted">종료</span> <span className="mono">{stamp(info.end)}</span></span>
        </>
      )}
      <span><span className="muted">총 시간</span> <span className="mono">{formatClock(info.end - info.start)}</span></span>
      {info.cycles > 0 && (
        <span title={info.cycleTotal ? '돈 횟수 / 계획한 횟수' : undefined}>
          <span className="muted">Cycle</span> <span className="mono">{info.cycleTotal ? `${info.cycles} / ${info.cycleTotal}` : info.cycles}</span>
        </span>
      )}
    </div>
  )
}

// ─────────────────────────────── 자르기: 시작·끝 스텝으로 구간을 정한다

/** 영상 자르기 구간: 시작·끝 스텝(행 번호)과 앞뒤 여유(초). 창을 닫아도 남는다 (껐다 켜며 조절) */
interface TrimSelection {
  start: number | null
  end: number | null
  before: number
  after: number
}
const EMPTY_TRIM: TrimSelection = { start: null, end: null, before: 0, after: 0 }

function TrimDialog({ agentId, rows, absolute, selection, onChange, position, videoDuration, previewUrl, onAdd, onClose }: {
  agentId: string
  /** 시각순 스텝 */
  rows: ResultRow[]
  absolute: boolean
  selection: TrimSelection
  onChange: (s: TrimSelection) => void
  /** 스텝의 영상 위치 (영상 시작 시각을 몰라 계산할 수 없으면 null) */
  position: (row: ResultRow) => { path: string; seconds: number } | null
  videoDuration: (path: string) => number | null
  /** 미리보기로 재생할 주소 (재생 준비 전이면 null) */
  previewUrl: (path: string) => string | null
  onAdd: (path: string) => void
  onClose: () => void
}) {
  const [picking, setPicking] = useState<'start' | 'end' | null>(null)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const previewRef = useRef<HTMLVideoElement>(null)

  // 행 번호 → 시각순 차례
  const order = useMemo(() => new Map(rows.map((r, i) => [r.index, i])), [rows])
  const rowOf = (index: number | null) => (index === null ? null : rows[order.get(index) ?? -1] ?? null)
  const startRow = rowOf(selection.start)
  const endRow = rowOf(selection.end)
  /** 스텝이 걸린 시간(초): Result에 있으면 그것, 없으면 다음 스텝까지 */
  const lengthOf = (row: ResultRow) => {
    if (row.durationMs !== null) return row.durationMs / 1000
    const next = rows[(order.get(row.index) ?? rows.length) + 1]
    return next?.time != null && row.time !== null ? (next.time - row.time) / 1000 : 0
  }
  const startAt = startRow ? position(startRow) : null
  const endAt = endRow ? position(endRow) : null
  const path = startAt?.path ?? null
  const duration = path ? videoDuration(path) : null
  // 시작 스텝 시각 − 앞 여유 ~ 끝 스텝이 끝난 시각 + 뒤 여유 (영상 안으로)
  const clipStart = startAt ? Math.max(0, startAt.seconds - selection.before) : null
  const clipEnd = endAt && endRow ? Math.min(duration ?? Infinity, endAt.seconds + lengthOf(endRow) + selection.after) : null
  const problem = startRow && !startAt ? '시작 스텝의 영상 위치를 알 수 없습니다 (영상 시작 시각을 모름)'
    : endRow && !endAt ? '끝 스텝의 영상 위치를 알 수 없습니다 (영상 시작 시각을 모름)'
      : startAt && endAt && startAt.path !== endAt.path ? '시작·끝 스텝이 서로 다른 영상에 있습니다'
        : clipStart !== null && duration !== null && clipStart >= duration ? '시작 스텝이 영상이 끝난 뒤입니다'
          : clipEnd !== null && clipEnd <= 0 ? '끝 스텝이 영상 시작 전입니다'
            : null
  const ready = !problem && path !== null && clipStart !== null && clipEnd !== null && clipEnd > clipStart
  const src = ready && path ? previewUrl(path) : null

  /** 실제 시각 (경과 시간 Result면 영상 위치) */
  const stampOf = (row: ResultRow, offsetSec: number, videoSec: number | null) =>
    absolute && row.time !== null ? formatWall(row.time + offsetSec * 1000, true) : videoSec !== null ? formatSeconds(videoSec) : '-'

  const pick = (which: 'start' | 'end', row: ResultRow) => {
    setPicking(null)
    setResult(null)
    if (which === 'end') return onChange({ ...selection, end: row.index })
    // 끝 스텝이 새 시작 스텝보다 앞이면 끝은 다시 고른다
    const endBefore = selection.end !== null && (order.get(selection.end) ?? 0) < (order.get(row.index) ?? 0)
    onChange({ ...selection, start: row.index, end: endBefore ? null : selection.end })
  }

  // 구간이 바뀌면 미리보기를 시작 프레임으로 (멈춘 채)
  useEffect(() => {
    const video = previewRef.current
    if (!video || clipStart === null) return
    video.pause()
    if (video.readyState >= 1) video.currentTime = clipStart
  }, [src, clipStart, clipEnd])

  const play = () => {
    const video = previewRef.current
    if (!video || clipStart === null) return
    video.currentTime = clipStart
    void video.play()
  }

  const run = () => {
    if (!ready || path === null || clipStart === null || clipEnd === null) return
    setBusy(true)
    setError(null)
    api.trimVideo(agentId, path, clipStart, clipEnd).then(
      (r) => setResult(r.outputPath),
      (err) => setError(toMessage(err)),
    ).finally(() => setBusy(false))
  }

  const setMargin = (key: 'before' | 'after', value: string) => {
    setResult(null)
    onChange({ ...selection, [key]: Math.max(0, Number(value) || 0) })
  }

  return (
    <div className="rv-modal">
      <div className="rv-modal-box panel wide">
        <div className="rv-drawer-head">
          <strong>영상 자르기</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <p className="hint">시작·끝 스텝을 고르면 그 구간을 테스트 PC에서 ffmpeg로 잘라 원래 영상 폴더에 저장합니다 (프레임 단위로 정확하게 다시 인코딩). 창을 닫아도 고른 스텝은 남습니다.</p>
        <div className="rv-trim-steps">
          {(['start', 'end'] as const).map((which) => {
            const row = which === 'start' ? startRow : endRow
            const stamp = !row ? null
              : which === 'start' ? stampOf(row, -selection.before, clipStart)
                : stampOf(row, lengthOf(row) + selection.after, clipEnd)
            return (
              <div key={which} className="rv-trim-step">
                <span className="rv-trim-label">{which === 'start' ? '시작 스텝' : '끝 스텝'}</span>
                {row ? (
                  <span className="rv-trim-value" title={row.cells.join(' · ')}>
                    <span className="ellipsis" translate="no">{`#${row.index + 1} ${row.name}`}</span>
                    <span className="mono">{stamp}</span>
                  </span>
                ) : <span className="rv-trim-value muted">{which === 'end' && !startRow ? '시작 스텝을 먼저 고르세요' : '고르지 않음'}</span>}
                <button
                  type="button"
                  className={picking === which ? 'active' : ''}
                  disabled={which === 'end' && !startRow}
                  onClick={() => setPicking(picking === which ? null : which)}
                >
                  스텝 선택
                </button>
                {picking === which && (
                  <StepList
                    rows={rows}
                    minOrder={which === 'end' && startRow ? order.get(startRow.index) ?? 0 : 0}
                    selected={row?.index ?? (which === 'end' ? startRow?.index ?? null : null)}
                    onPick={(r) => pick(which, r)}
                    onClose={() => setPicking(null)}
                  />
                )}
              </div>
            )
          })}
        </div>
        <div className="rv-trim-margins small">
          <label title="시작 스텝보다 이만큼 앞부터">
            시작 앞 여유
            <input type="number" min={0} max={600} step={0.5} value={selection.before} onChange={(e) => setMargin('before', e.target.value)} />
            초
          </label>
          <label title="끝 스텝이 끝난 뒤 이만큼 더">
            끝 뒤 여유
            <input type="number" min={0} max={600} step={0.5} value={selection.after} onChange={(e) => setMargin('after', e.target.value)} />
            초
          </label>
          <span className="rv-spacer" />
          <button type="button" onClick={() => { onChange(EMPTY_TRIM); setPicking(null); setResult(null); setError(null) }}>초기화</button>
        </div>
        {problem && <p className="error small">{problem}</p>}
        {ready && clipStart !== null && clipEnd !== null && (
          <>
            <p className="small">{`길이 ${formatSeconds(clipEnd - clipStart)}`}</p>
            {src ? (
              <div className="rv-trim-preview">
                <video
                  ref={previewRef}
                  src={src}
                  preload="metadata"
                  controls
                  onLoadedMetadata={(e) => { e.currentTarget.currentTime = clipStart }}
                  onTimeUpdate={(e) => {
                    // 구간 끝에서 멈춘다
                    if (e.currentTarget.currentTime >= clipEnd) e.currentTarget.pause()
                  }}
                />
                <button type="button" onClick={play}>▶ 구간 미리보기</button>
              </div>
            ) : <p className="small muted">영상 재생 준비가 끝나면 미리볼 수 있습니다</p>}
          </>
        )}
        {error && <p className="error small">{error}</p>}
        {result && (
          <p className="small">
            저장했습니다: <span className="mono">{result}</span>{' '}
            <button type="button" className="link" onClick={() => { onAdd(result); onClose() }}>영상 목록에 추가</button>
          </p>
        )}
        <div className="rv-setup-actions">
          <button type="button" className="primary" disabled={busy || !ready} onClick={run}>{busy ? '자르는 중…' : '자르기'}</button>
        </div>
      </div>
    </div>
  )
}

const STEP_ITEM = 22
const STEP_LIST_HEIGHT = 264

/** 스텝 고르기 목록 (시각순 · 검색, 보이는 줄만 그린다). minOrder 앞의 스텝은 고를 수 없다 (끝 스텝은 시작 스텝보다 앞일 수 없음) */
function StepList({ rows, minOrder, selected, onPick, onClose }: {
  rows: ResultRow[]
  minOrder: number
  /** 처음 보일 스텝 */
  selected: number | null
  onPick: (row: ResultRow) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [scroll, setScroll] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const q = query.trim().toLowerCase()
  const shown = useMemo(() => {
    const list = rows.map((row, order) => ({ row, order }))
    return q ? list.filter(({ row }) => String(row.index + 1) === q.replace(/^#/, '') || row.cells.some((c) => c.toLowerCase().includes(q))) : list
  }, [rows, q])
  // 열 때 한 번: 고른 스텝(없으면 고를 수 있는 첫 스텝)이 가운데 보이게
  useLayoutEffect(() => {
    const target = shown.findIndex((x) => (selected !== null ? x.row.index === selected : x.order >= minOrder))
    const list = listRef.current
    if (!list || target <= 0) return
    list.scrollTop = Math.max(0, target * STEP_ITEM - STEP_LIST_HEIGHT / 2)
    setScroll(list.scrollTop)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const first = Math.max(0, Math.floor(scroll / STEP_ITEM) - 5)
  const last = Math.min(shown.length, Math.ceil((scroll + STEP_LIST_HEIGHT) / STEP_ITEM) + 5)

  return (
    <div
      className="rv-steplist"
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return
        // 자르기 창은 닫지 않고 목록만
        e.stopPropagation()
        onClose()
      }}
    >
      <input
        autoFocus
        placeholder="스텝 검색 (번호 · 이름 · 상태 · 메시지)"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          if (listRef.current) listRef.current.scrollTop = 0
          setScroll(0)
        }}
      />
      <div
        ref={listRef}
        className="rv-steplist-items"
        style={{ height: Math.min(STEP_LIST_HEIGHT, shown.length * STEP_ITEM + 2) }}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
      >
        <div style={{ position: 'relative', height: shown.length * STEP_ITEM }}>
          {shown.slice(first, last).map(({ row, order }, k) => {
            const disabled = order < minOrder
            return (
              <button
                key={row.index}
                type="button"
                className={`rv-steplist-item${row.index === selected ? ' active' : ''}`}
                style={{ top: (first + k) * STEP_ITEM }}
                disabled={disabled}
                title={disabled ? '시작 스텝보다 앞이라 고를 수 없습니다' : row.cells.join(' · ')}
                onClick={() => onPick(row)}
              >
                <span className="mono">{`#${row.index + 1}`}</span>
                <span className="mono">{formatWall(row.time)}</span>
                <span className="ellipsis" translate="no">{row.name}</span>
                <span className={`rv-steplist-status ${statusTone(row.status)}`}>{row.status}</span>
              </button>
            )
          })}
        </div>
      </div>
      {shown.length === 0 && <p className="small muted">맞는 스텝이 없습니다</p>}
    </div>
  )
}

// ─────────────────────────────── 셋 저장·목록

function SaveDialog({ source, set, config, videos, backupFiles, onSaved, onClose }: {
  source: Source
  set: ResultSet | null
  config: ViewConfig
  videos: RawVideo[]
  backupFiles: string[]
  onSaved: (s: ResultSet) => void
  onClose: () => void
}) {
  const [name, setName] = useState(set?.name ?? baseName(source.resultPath).replace(/\.[^.]+$/, ''))
  const [copyVideo, setCopyVideo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const videoBytes = videos.reduce((n, v) => n + (v.size ?? 0), 0)

  // 백업 진행 표시
  useEffect(() => {
    if (!saved || saved.backup.state !== 'running') return
    const id = window.setInterval(() => {
      api.resultSet(saved.id).then((s) => {
        setSaved(s)
        onSaved(s)
      }, () => {})
    }, 1000)
    return () => window.clearInterval(id)
  }, [saved, onSaved])

  const create = () => {
    setBusy(true)
    setError(null)
    api.createResultSet({
      name: name.trim(), agentId: source.agentId, machineName: source.machineName, resultPath: source.resultPath,
      videoPaths: source.videoPaths, imageDir: source.imageDir, copyVideo, config,
      // 영상을 백업하면 재생용 사본(탐색 색인)도 함께: PC가 꺼져 있어도 탐색되게
      files: copyVideo ? [...backupFiles, ...Object.values(config.playPaths ?? {}).map((p) => p.playPath)] : backupFiles,
    }).then((s) => {
      setSaved(s)
      onSaved(s)
    }, (err) => setError(toMessage(err))).finally(() => setBusy(false))
  }

  const update = () => {
    if (!set) return
    setBusy(true)
    api.updateResultSet(set.id, { name: name.trim(), config }).then((s) => {
      onSaved(s)
      onClose()
    }, (err) => setError(toMessage(err))).finally(() => setBusy(false))
  }

  return (
    <div className="rv-modal">
      <div className="rv-modal-box panel">
        <div className="rv-drawer-head">
          <strong>저장</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        {!saved ? (
          <>
            <label className="rv-block">
              이름
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="hint">
              Result 파일과 이미지 {backupFiles.length.toLocaleString()}개를 서버에 백업해 테스트 PC가 꺼져 있어도 열 수 있게 합니다.
              열 지정도 함께 저장합니다.
            </p>
            {source.videoPaths.length > 0 && (
              <label className="small">
                <input type="checkbox" checked={copyVideo} onChange={(e) => setCopyVideo(e.target.checked)} />{' '}
                영상도 백업 ({source.videoPaths.length}개{videoBytes ? `, ${formatBytes(videoBytes)}` : ''}) — 끄면 영상은 테스트 PC가 켜져 있을 때만 재생
              </label>
            )}
            {error && <p className="error small">{error}</p>}
            <div className="rv-setup-actions">
              {set && <button type="button" disabled={busy || !name.trim()} onClick={update}>'{set.name}'에 덮어쓰기 (설정·이름만)</button>}
              <button type="button" className="primary" disabled={busy || !name.trim()} onClick={create}>{set ? '새 셋으로 저장' : '저장'}</button>
            </div>
          </>
        ) : (
          <>
            <p>'{saved.name}' 저장 · 백업 {saved.backup.state === 'done' ? '완료' : saved.backup.state === 'failed' ? '일부 실패' : '중'}</p>
            <progress max={Math.max(1, saved.backup.filesTotal)} value={saved.backup.filesDone + saved.backup.skipped} />
            <p className="small muted">
              {saved.backup.filesDone}/{saved.backup.filesTotal}개 · {formatBytes(saved.backup.bytesDone)}
              {saved.backup.skipped > 0 && ` · 테스트 PC에 없는 파일 ${saved.backup.skipped}개 건너뜀`}
            </p>
            {saved.backup.error && <p className="error small">{saved.backup.error}</p>}
            <div className="rv-setup-actions">
              <button type="button" onClick={onClose}>닫기 (백업은 계속됩니다)</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SetsDialog({ onOpen, onClose, notice }: { onOpen: (s: ResultSetSummary) => void; onClose: () => void; notice?: string | null }) {
  const [sets, setSets] = useState<ResultSetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(notice ?? null)
  useEffect(() => {
    if (notice) setError(notice)
  }, [notice])
  const load = () => api.resultSets().then(setSets, (err) => setError(toMessage(err)))
  useEffect(() => {
    void load()
  }, [])

  const rename = (s: ResultSetSummary) => {
    const name = window.prompt('셋 이름', s.name)
    if (name?.trim()) api.updateResultSet(s.id, { name: name.trim() }).then(load, (err) => setError(toMessage(err)))
  }
  const remove = (s: ResultSetSummary) => {
    if (window.confirm(`'${s.name}' 셋과 서버에 백업한 파일을 지울까요? (테스트 PC의 원본은 그대로)`))
      api.deleteResultSet(s.id).then(load, (err) => setError(toMessage(err)))
  }

  return (
    <div className="rv-modal">
      <div className="rv-modal-box panel wide">
        <div className="rv-drawer-head">
          <strong>불러오기</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        {error && <p className="error small">{error}</p>}
        {!sets ? <p className="muted">불러오는 중…</p> : sets.length === 0 ? <p className="muted">저장된 결과가 없습니다</p> : (
          <ul className="rv-sets">
            {sets.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>{s.name}</strong>
                  <div className="small muted">
                    {s.machineName} · {baseName(s.resultPath)} · 영상 {s.videoCount}개{s.copyVideo ? ' (백업)' : ''} · {new Date(s.updatedAt).toLocaleString()}
                  </div>
                  <div className={`small ${s.backup.state === 'failed' ? 'error' : 'muted'}`}>
                    백업 {s.backup.state === 'done' ? `완료 (${s.backup.filesDone}개${s.backup.skipped ? `, 없는 파일 ${s.backup.skipped}개 건너뜀` : ''})` : s.backup.state === 'failed' ? `실패: ${s.backup.error ?? ''}` : `중 ${s.backup.filesDone}/${s.backup.filesTotal}`}
                  </div>
                </div>
                <span className="rv-spacer" />
                {s.backup.state === 'failed' && <button type="button" onClick={() => api.retryResultSetBackup(s.id).then(load)}>다시 백업</button>}
                <button type="button" onClick={() => rename(s)}>이름</button>
                <button type="button" onClick={() => remove(s)}>삭제</button>
                <button type="button" className="primary" onClick={() => onOpen(s)}>열기</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
