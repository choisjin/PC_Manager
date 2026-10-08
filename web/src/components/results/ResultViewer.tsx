import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type ResultSet, type ResultSetSummary } from '../../api'
import { formatBytes } from '../../format'
import { type ClipItem, FILES_MIME, type FilesDragPayload } from '../explorer/pcGroups'
import {
  type AtsImages, compareCells, formatSeconds, formatWall, type ParsedResult, parseAts, parseRfw, type TableSpec,
  RESULT_MODE_LABEL, type ResultMapping, type ResultRow, statusTone, timeFromName,
} from './resultCsv'
import {
  addSessionVideo, autoAssign, baseName, closeSets, closeSetup, closeViewer, dirName, dismissToast, openSets, openSetup, openViewer,
  type RawVideo, type ResultSession, saveSessionConfig, sessionFileUrl, sessionTitle, setSessionSet,
  type SetupState, type Source, startSession, toMessage, updateSessionVideo, useResults, type ViewConfig,
} from './resultSessions'
import {
  type Anchor, baseSeconds, emptySync, resolveStart, rowAtTime, START_SOURCE_LABEL, type SyncState,
  toRowTime, toVideoTime, type VideoInfo, videoForRow,
} from './sync'
import { type ColFilters, ColumnFilterMenu, type ColSort } from './ColumnFilter'
import { VideoTransport } from './VideoTransport'

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
 * Result(CSV)·영상·이미지를 시각으로 맞춰 본다 (ReplayKit 시나리오 상세결과 방식)
 */
export function ResultHost({ machineName }: { machineName: (agentId: string) => string }) {
  const { sessions, activeId, setup, setsOpen, toasts } = useResults()
  const active = sessions.find((s) => s.id === activeId && s.state === 'ready') ?? null
  const [dialog, setDialog] = useState<Dialog>(null)
  const [preview, setPreview] = useState<string | null>(null)

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

  const openSet = async (summary: ResultSetSummary) => {
    const full = await api.resultSet(summary.id)
    closeSets()
    closeSetup()
    const loaded = sessions.find((s) => s.set?.id === full.id && s.state !== 'failed')
    if (loaded?.state === 'ready') openViewer(loaded.id)
    else if (!loaded) startSession(sourceFromSet(full), full)
  }

  return (
    <>
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
      {setsOpen && createPortal(<SetsDialog onOpen={(s) => void openSet(s)} onClose={closeSets} />, document.body)}
      {preview && createPortal(
        <div className="rv-preview" onClick={() => setPreview(null)}>
          <img src={preview} alt="" />
        </div>,
        document.body,
      )}
      {toasts.length > 0 && createPortal(
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

// ─────────────────────────────── 경로 지정: 떠 있는 작은 창 (탐색기에서 끌어다 놓기)

function SetupPopup({ setup, machineName }: { setup: SetupState; machineName: (agentId: string) => string }) {
  const [source, setSource] = useState<Source>(setup.source)
  const [warn, setWarn] = useState<string | null>(null)
  const [pos, setPos] = useState(() => ({ x: Math.max(8, window.innerWidth - 500), y: 70 }))
  const ats = source.mode === 'ats'
  const empty = !source.resultPath && source.videoPaths.length === 0 && !source.imageDir && !source.refDir

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
      setSource((s) => ({ ...s, agentId: payload.agentId, machineName: machineName(payload.agentId) }))
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
            <button key={m} type="button" className={source.mode === m ? 'active' : ''} onClick={() => setSource((s) => ({ ...s, mode: m }))}>
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
        {ats && (
          <Slot title="원본 이미지 폴더" hint="비교 기준 이미지 폴더 (예: D:\excelrunner_report\captured_image)" onDrop={dropInto('ref')} onDragOver={allowDrop}
            items={source.refDir ? [source.refDir] : []} onRemove={() => setSource((s) => ({ ...s, refDir: null }))} />
        )}
        <Slot
          title={ats ? '결과 이미지 폴더' : '이미지 폴더'}
          hint={ats ? '실행 때 캡처한 이미지 폴더 (예: D:\\excelrunner_report\\2026-10-06-1403\\RVC_001)' : '폴더를 끌어다 놓으세요'}
          onDrop={dropInto('image')} onDragOver={allowDrop}
          items={source.imageDir ? [source.imageDir] : []} onRemove={() => setSource((s) => ({ ...s, imageDir: null }))} />
      </div>
      {warn && <p className="error small">{warn}</p>}
      <p className="hint">'열기'를 누르면 뒤에서 모두 불러오고(영상은 필요하면 재생용으로 변환), 다 되면 알려 줍니다. 진행은 진행상황 탭에서 볼 수 있습니다.</p>
      <div className="rv-setup-actions">
        <button
          type="button"
          className="primary"
          disabled={!source.resultPath}
          onClick={() => {
            startSession(source, null, setup.replaceId)
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
  const absolute = parsed?.timeKind === 'absolute'
  const rows = useMemo(() => parsed?.rows ?? [], [parsed])
  const sortedRows = useMemo(() => rows.filter((r) => r.time !== null).sort((a, b) => a.time! - b.time! || a.index - b.index), [rows])
  const firstTime = sortedRows[0]?.time ?? null

  const updateVideo = useCallback((path: string, p: Partial<RawVideo>) => updateSessionVideo(id, path, p), [id])
  const currentRaw = rawVideos.find((v) => v.path === current) ?? null

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
  const resolveImage = useCallback((p: string) => imagesByName.get(baseName(p).toLowerCase()) ?? p, [imagesByName])
  const timedImages = useMemo(
    () => images.filter((i) => !ats || !ATS_VARIANT.test(i.name))
      .map((i) => ({ entry: i, time: timeFromName(i.name) })).filter((x) => x.time !== null).sort((a, b) => a.time! - b.time!),
    [images, ats],
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
    const wall = toRowTime(t, currentVideo, absolute, sync)
    setWallNow(wall)
    if (wall === null) return
    // 스텝 시작 직전(0.5초)부터 그 스텝으로 본다 (ReplayKit과 같음)
    const row = rowAtTime(sortedRows, wall + 500)
    if (row && row.index !== playing) setPlaying(row.index)
  }

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
      {/* RFW는 열이 11개라 표 쪽을 넓게 */}
      <div className={`rv-main${parsed?.table && !ats ? ' wide' : ''}`}>
        <section className={`rv-left${ats ? ' fit' : ''}`}>
          <VideoTransport
            src={currentRaw?.prep === 'ready' && currentRaw.playPath ? fileUrl(currentRaw.playPath) : null}
            waiting={
              !currentRaw ? null
                : currentRaw.prep === 'checking' ? '영상 확인 중…'
                  : currentRaw.prep === 'converting' || currentRaw.prep === 'needs-convert'
                    ? `탐색할 수 있는 재생용 영상을 테스트 PC에서 만드는 중… (${currentRaw.prepNote ?? ''}, 한 번 만들면 다시 쓰고 원본은 그대로)`
                    : currentRaw.prep === 'failed' ? `재생용 영상을 만들지 못했습니다: ${currentRaw.prepNote ?? ''}` : null
            }
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
            extra={
              <>
                {videos.length > 1 && (
                  <select value={current ?? ''} onChange={(e) => setCurrent(e.target.value)} title="영상 (F/R)">
                    {videos.map((v) => <option key={v.path} value={v.path}>{v.name}</option>)}
                  </select>
                )}
                <button type="button" onMouseDown={(e) => e.preventDefault()} disabled={!current} onClick={() => setDialog('trim')} title="영상 구간 자르기 (테스트 PC에서 ffmpeg, 원래 영상 폴더에 저장)">✂ 자르기</button>
              </>
            }
          />
          {currentRaw?.prep === 'ready' && currentRaw.playPath === currentRaw.path && currentRaw.prepNote && (
            <div className="rv-notice small" title={currentRaw.prepNote}>
              ⚠ {currentRaw.prepNote} — 길이가 안 나오거나 스텝 위치가 어긋나면 이 PC의 에이전트를 업데이트하세요 (업데이트 → 에이전트 업데이트)
            </div>
          )}
          <div className="rv-sync-line small muted">
            {currentVideo
              ? <>영상 시작: {currentVideo.start !== null ? formatWall(currentVideo.start, true) : '모름'} ({START_SOURCE_LABEL[currentVideo.startSource]})</>
              : 'Result만 보는 중 (영상 없음)'}
            {wallNow !== null && absolute && <> · 지금 {formatWall(wallNow)}</>}
          </div>
          {notice && <div className="rv-notice small">{notice}</div>}
          <div className="rv-images">
            {ats ? (
              <AtsImagePanel
                row={focusRow}
                byName={imagesByName}
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
            {!ats && timedImages.length > 0 && (
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
          label={filterMenu.col === parsed.table?.timeCell ? (v) => v.replace(/^\[|\]$/g, '') : (v) => v.replace(/\s+/g, ' ')}
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
      {dialog === 'trim' && current && (
        <TrimDialog
          agentId={source.agentId}
          path={current}
          now={videoRef.current?.currentTime ?? 0}
          duration={currentVideo?.duration ?? null}
          readNow={() => videoRef.current?.currentTime ?? 0}
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
            ...images.filter((i) => !ats || !/_full\.\w+$/i.test(i.name)).map((i) => i.fullPath),
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
          <option key={s.id} value={s.id} disabled={s.state !== 'ready'}>
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
      <button type="button" className="primary" onClick={() => setDialog('save')} title="Result·이미지(·영상)를 서버에 저장">저장</button>
      <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc) — 진행상황에서 다시 열 수 있습니다" onClick={closeViewer}>✕</button>
    </header>
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
function AtsImagePanel({ row, byName, url, onPreview }: {
  row: ResultRow | null
  byName: Map<string, string>
  url: (path: string) => string
  onPreview: (url: string) => void
}) {
  const [view, setView] = useState<'capture' | 'diff' | 'full'>('capture')
  const ats = row?.ats ?? null
  const v = variantsOf(ats?.result ?? null, byName)
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
        {ats && <span className={`rv-ats-kind kind-${ats.kind}`}>{ATS_KIND_LABEL[ats.kind]}</span>}
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
          empty={emptyText ?? (ats?.kind === 'p' ? '결과 이미지 없음 — 화면에서 찾지 못함' : '결과 이미지 없음')}
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
  const [scroll, setScroll] = useState(0)
  const [height, setHeight] = useState(400)
  const lastUserScroll = useRef(0)

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
  const grid = spec ? { gridTemplateColumns: `40px ${spec.columns}` } : undefined

  return (
    <div className={`rv-table${spec ? ' fixed' : ''}`}>
      <div className="rv-row rv-row-head small" style={grid}>
        {headers
          ? <><span>#</span>{headers.map((h, i) => (
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
            ))}</>
          : <><span>#</span><span>시간</span><span>회차</span><span>스텝</span><span>결과</span><span>걸린 시간</span><span>메시지</span><span>영상</span></>}
      </div>
      <div
        className="rv-table-body"
        ref={bodyRef}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        onWheel={() => (lastUserScroll.current = Date.now())}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.slice(first, last).map((row, i) => (
            <div
              key={row.index}
              className={`rv-row${row.index === selected ? ' selected' : ''}${row.index === playing ? ' playing' : ''} tone-${statusTone(row.status) || 'none'}`}
              style={{ position: 'absolute', top: (first + i) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT, ...grid }}
              onClick={() => onPick(row)}
              title="누르면 영상의 이 시점으로"
            >
              <span className="muted">{anchorRows.has(row.index) ? '📍' : row.index + 1}</span>
              {headers && spec ? row.cells.map((c, i) => {
                const tone = statusTone(c)
                // 결과 열은 늘 색, 알림 열(ACTION CHECK·Message Level)은 실패·경고일 때만
                const colored = spec.statusCells.includes(i) || (spec.alertCells.includes(i) && (tone === 'bad' || tone === 'warn'))
                return (
                  <span
                    key={i}
                    className={`${i === spec.timeCell ? 'mono' : colored ? `rv-status cell-${tone || 'none'}` : 'ellipsis'}${center.has(i) ? ' rv-center' : ''}`}
                    title={c}
                  >
                    {i === spec.timeCell ? formatWall(row.time) || c : c}
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
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────── 자르기

function TrimDialog({ agentId, path, now, duration, readNow, onAdd, onClose }: {
  agentId: string
  path: string
  now: number
  duration: number | null
  readNow: () => number
  onAdd: (path: string) => void
  onClose: () => void
}) {
  const [start, setStart] = useState(Math.max(0, Math.round((now - 5) * 10) / 10))
  const [end, setEnd] = useState(Math.round(Math.min(duration ?? now + 5, now + 5) * 10) / 10)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setError(null)
    api.trimVideo(agentId, path, start, end).then(
      (r) => setResult(r.outputPath),
      (err) => setError(toMessage(err)),
    ).finally(() => setBusy(false))
  }

  return (
    <div className="rv-modal">
      <div className="rv-modal-box panel">
        <div className="rv-drawer-head">
          <strong>영상 자르기</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <p className="hint ellipsis" title={path}>{baseName(path)} · 테스트 PC에서 ffmpeg로 잘라 같은 폴더에 저장합니다 (프레임 단위로 정확하게 다시 인코딩)</p>
        <div className="rv-form">
          <label>
            시작 (초)
            <span className="rv-inline">
              <input type="number" min={0} step={0.1} value={start} onChange={(e) => setStart(Number(e.target.value))} />
              <button type="button" onClick={() => setStart(Math.round(readNow() * 10) / 10)}>지금 위치</button>
            </span>
          </label>
          <label>
            끝 (초)
            <span className="rv-inline">
              <input type="number" min={0} step={0.1} value={end} onChange={(e) => setEnd(Number(e.target.value))} />
              <button type="button" onClick={() => setEnd(Math.round(readNow() * 10) / 10)}>지금 위치</button>
            </span>
          </label>
        </div>
        <p className="small muted">길이 {formatSeconds(Math.max(0, end - start))}</p>
        {error && <p className="error small">{error}</p>}
        {result && (
          <p className="small">
            저장했습니다: <span className="mono">{result}</span>{' '}
            <button type="button" className="link" onClick={() => { onAdd(result); onClose() }}>영상 목록에 추가</button>
          </p>
        )}
        <div className="rv-setup-actions">
          <button type="button" className="primary" disabled={busy || end <= start} onClick={run}>{busy ? '자르는 중…' : '자르기'}</button>
        </div>
      </div>
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

function SetsDialog({ onOpen, onClose }: { onOpen: (s: ResultSetSummary) => void; onClose: () => void }) {
  const [sets, setSets] = useState<ResultSetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
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
