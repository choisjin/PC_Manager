import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { formatWall } from './resultCsv'
import { toMessage } from './resultSessions'
import { type AreaMode, areaOf, type ImageSearchState, type Rect, type SearchVideo, type Segment } from './imageSearchState'

// 결과 확인 이미지 찾기 화면: 영상 위 크롭·영역 드래그(CropOverlay) · 설정·진행·찾은 구간(ImageSearchPanel). 상태·찾기 작업은 imageSearchState

/** 지금 프레임의 rect 부분을 회색조로 (BT.601 밝기) */
function captureTemplate(video: HTMLVideoElement, rect: Rect): { gray: Uint8Array; preview: string } {
  const canvas = document.createElement('canvas')
  canvas.width = rect.w
  canvas.height = rect.h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('캔버스를 만들지 못했습니다')
  context.drawImage(video, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  const data = context.getImageData(0, 0, rect.w, rect.h).data
  const gray = new Uint8Array(rect.w * rect.h)
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114)
  return { gray, preview: canvas.toDataURL('image/png') }
}

/** 초 → m:ss.mmm (프레임 단위로 보이게) */
function formatFrameTime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${s.toFixed(3).padStart(6, '0')}`
}

// ─────────────────────────────── 영상 위 드래그 (VideoTransport의 영상 칸 안)

export function CropOverlay({ state, videoRef, currentPath }: {
  state: ImageSearchState
  videoRef: React.RefObject<HTMLVideoElement | null>
  currentPath: string | null
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  // 영상이 실제로 그려진 칸 (object-fit: contain의 여백 제외): 오버레이 기준 화면 좌표 + 배율 + 지금 영상의 원래 크기
  const [view, setView] = useState<{ left: number; top: number; scale: number; vw: number; vh: number } | null>(null)
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useLayoutEffect(() => {
    const video = videoRef.current
    const box = boxRef.current
    if (!video || !box) return
    const measure = () => {
      if (!video.videoWidth || !video.videoHeight) return setView(null)
      const v = video.getBoundingClientRect()
      const b = box.getBoundingClientRect()
      const scale = Math.min(v.width / video.videoWidth, v.height / video.videoHeight)
      setView({
        left: v.left - b.left + (v.width - video.videoWidth * scale) / 2,
        top: v.top - b.top + (v.height - video.videoHeight * scale) / 2,
        scale,
        vw: video.videoWidth,
        vh: video.videoHeight,
      })
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(video)
    observer.observe(box)
    video.addEventListener('loadedmetadata', measure)
    return () => {
      observer.disconnect()
      video.removeEventListener('loadedmetadata', measure)
    }
  }, [videoRef, currentPath, state.open])

  if (!state.open) return null
  // 크롭·영역은 크롭한 영상 크기 기준: 크기가 다른 영상에서는 늘려 그리고, 드래그한 영역은 그 크기로 바꿔 둔다 (에이전트도 같은 크기로 맞춰 비교)
  const frame = state.template ? { w: state.template.frameWidth, h: state.template.frameHeight } : view ? { w: view.vw, h: view.vh } : null
  const fx = view && frame ? view.vw / frame.w : 1
  const fy = view && frame ? view.vh / frame.h : 1
  /** 화면 좌표 → 지금 영상 픽셀 */
  const toSource = (clientX: number, clientY: number) => {
    const b = boxRef.current!.getBoundingClientRect()
    return {
      x: Math.max(0, Math.min(view!.vw, (clientX - b.left - view!.left) / view!.scale)),
      y: Math.max(0, Math.min(view!.vh, (clientY - b.top - view!.top) / view!.scale)),
    }
  }
  const toRect = (d: { x0: number; y0: number; x1: number; y1: number }): Rect => ({
    x: Math.round(Math.min(d.x0, d.x1)),
    y: Math.round(Math.min(d.y0, d.y1)),
    w: Math.round(Math.abs(d.x1 - d.x0)),
    h: Math.round(Math.abs(d.y1 - d.y0)),
  })
  const onDown = (e: React.PointerEvent) => {
    const video = videoRef.current
    if (!state.drawing || !view || !video) return
    e.preventDefault()
    e.stopPropagation()
    video.pause()
    const p = toSource(e.clientX, e.clientY)
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
    setError(null)
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return
    const p = toSource(e.clientX, e.clientY)
    setDrag({ ...drag, x1: p.x, y1: p.y })
  }
  const onUp = () => {
    const video = videoRef.current
    if (!drag || !video) return
    const rect = toRect(drag)
    setDrag(null)
    if (rect.w < 8 || rect.h < 8) return setError('8×8 픽셀보다 크게 드래그하세요')
    if (state.drawing === 'template') {
      try {
        const { gray, preview } = captureTemplate(video, rect)
        state.setTemplate({ rect, frameWidth: video.videoWidth, frameHeight: video.videoHeight, gray, preview, path: currentPath ?? '', time: video.currentTime })
        state.setCustomArea(null)
        state.setAreaMode('same')
      } catch (err) {
        return setError(`이미지를 떼어 내지 못했습니다: ${toMessage(err)}`)
      }
    } else {
      state.setCustomArea({ x: Math.round(rect.x / fx), y: Math.round(rect.y / fy), w: Math.round(rect.w / fx), h: Math.round(rect.h / fy) })
      state.setAreaMode('custom')
    }
    state.setDrawing(null)
  }

  /** 지금 영상 픽셀 사각형 → 오버레이 안 위치 (sx·sy: 크롭한 영상 크기 → 지금 영상 배율) */
  const place = (r: Rect, sx = 1, sy = 1) => view && ({
    left: view.left + r.x * sx * view.scale,
    top: view.top + r.y * sy * view.scale,
    width: r.w * sx * view.scale,
    height: r.h * sy * view.scale,
  })
  const area = areaOf(state)
  const live = drag && toRect(drag)
  return (
    <div
      ref={boxRef}
      className={`rv-crop${state.drawing ? ' drawing' : ''}`}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
    >
      {view && area && state.template && area !== state.template.rect && <div className="rv-crop-area" style={place(area, fx, fy) ?? undefined} />}
      {view && state.template && <div className="rv-crop-rect" style={place(state.template.rect, fx, fy) ?? undefined} />}
      {view && live && <div className={state.drawing === 'area' ? 'rv-crop-area' : 'rv-crop-rect'} style={place(live) ?? undefined} />}
      {state.drawing && (
        <div className="rv-crop-hint">
          {state.drawing === 'template' ? '찾을 이미지를 드래그하세요 (지금 프레임에서 떼어 냄)' : '검색할 영역을 드래그하세요'}
          {error && <> · <span className="error">{error}</span></>}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────── 패널: 설정·진행·찾은 구간

export function ImageSearchPanel({ state, videos, currentPath, escape, nowSeconds, wallOf, onSeek }: {
  state: ImageSearchState
  videos: SearchVideo[]
  currentPath: string | null
  /** Esc를 이 패널이 받을지 (자르기·저장 창이 열려 있으면 false: 그 창이 닫히게) */
  escape: boolean
  /** 지금 영상 위치(초) */
  nowSeconds: number
  /** 영상 위치 → 벽시계 ms (모르면 null): 영상 여러 개를 한 시간축에 */
  wallOf: (path: string, seconds: number) => number | null
  onSeek: (path: string, seconds: number) => void
}) {
  const { template, threshold, setThreshold, gap, setGap, found, status, error, running, segments } = state

  // Esc: 그리는 중이면 그리기만, 아니면 패널 닫기 (결과 확인 창이 닫히지 않게 먼저 받는다)
  useEffect(() => {
    if (!escape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (state.drawing) state.setDrawing(null)
      else state.close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, escape])

  // 한 시간축: 모든 영상의 시작 시각을 알면 벽시계, 아니면 영상을 순서대로 이어 붙인다
  const axis = useMemo(() => {
    const walls = videos.map((v) => wallOf(v.path, 0))
    const useWall = walls.every((w) => w !== null)
    const spans: { path: string; name: string; begin: number; end: number }[] = []
    videos.forEach((v, i) => {
      const f = found.find((x) => x.path === v.path)
      const seconds = v.duration ?? (f && f.fps ? f.scores.length / f.fps : 0)
      const begin = useWall ? walls[i]! / 1000 : (spans.at(-1)?.end ?? 0)
      spans.push({ path: v.path, name: v.name, begin, end: begin + seconds })
    })
    const min = Math.min(...spans.map((s) => s.begin))
    const max = Math.max(...spans.map((s) => s.end))
    return { useWall, spans, min, length: Math.max(1, max - min) }
  }, [videos, found, wallOf])
  /** 영상 위치 → 시간축 위치(%) */
  const posOf = useCallback((path: string, seconds: number) => {
    const span = axis.spans.find((s) => s.path === path)
    return span ? ((span.begin + seconds - axis.min) / axis.length) * 100 : 0
  }, [axis])
  const ordered = useMemo(
    () => [...segments].sort((a, b) => posOf(a.path, a.first / a.fps) - posOf(b.path, b.first / b.fps)),
    [segments, posOf],
  )
  const seek = (s: Segment) => onSeek(s.path, (s.first + 0.5) / s.fps)
  const nameOf = (path: string) => videos.find((v) => v.path === path)?.name ?? path
  const area = areaOf(state)
  // 직접 지정한 영역 크기 (크롭한 영상 픽셀)
  const areaText = state.areaMode === 'custom' && state.customArea ? `${state.customArea.w}×${state.customArea.h}` : ''

  return (
    <div className="rv-search">
      <div className="rv-drawer-head">
        <strong>이미지 찾기</strong>
        <span className="muted small">{`이 실행의 영상 ${videos.length}개에서 크롭한 이미지가 나타나는 구간의 첫 프레임`}</span>
        <span className="rv-spacer" />
        <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={state.close}>✕</button>
      </div>
      <div className="rv-search-setup">
        <figure className="rv-search-template" title={template ? `크롭: ${template.path.split(/[\\/]/).pop()} ${formatFrameTime(template.time)}` : undefined}>
          {template ? <img src={template.preview} alt="" /> : <span className="muted small">영상 위에서 드래그</span>}
          <figcaption className="small muted">
            {template ? `${template.rect.w}×${template.rect.h}` : ''}
          </figcaption>
        </figure>
        <div className="rv-search-options">
          <div className="rv-inline">
            <button type="button" className={state.drawing === 'template' ? 'active' : ''} onClick={() => state.setDrawing(state.drawing === 'template' ? null : 'template')}>
              {template ? '다시 크롭' : '크롭'}
            </button>
            <label className="small" title="이 영역 안에서 크롭한 이미지와 비슷한 곳을 찾습니다">
              검색 영역{' '}
              <select
                value={state.areaMode}
                disabled={!template}
                onChange={(e) => {
                  const mode = e.target.value as AreaMode
                  state.setAreaMode(mode)
                  state.setDrawing(mode === 'custom' && !state.customArea ? 'area' : null)
                }}
              >
                <option value="same">크롭 위치 그대로</option>
                <option value="custom">직접 지정</option>
                <option value="full">화면 전체</option>
              </select>
            </label>
            {state.areaMode === 'custom' && (
              <button type="button" className={state.drawing === 'area' ? 'active' : ''} disabled={!template} onClick={() => state.setDrawing(state.drawing === 'area' ? null : 'area')}>
                영역 드래그
              </button>
            )}
            <span className="muted small">{template ? areaText : ''}</span>
          </div>
          <div className="rv-inline">
            <label className="small" title="이 값 이상이면 나타난 것으로 봅니다. 바꾸면 다시 찾지 않고 바로 다시 나눕니다">
              유사도 기준{' '}
              <input type="range" min={50} max={100} step={0.5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
              {' '}<span className="mono">{threshold.toFixed(1)}%</span>
            </label>
            <label className="small" title="기준 아래로 이 시간 이하 끊긴 것은 한 번 나타난 것으로 봅니다 (깜빡임·인코딩 잡음)">
              끊김 무시{' '}
              <select value={gap} onChange={(e) => setGap(Number(e.target.value))}>
                {[0, 0.1, 0.3, 0.5, 1, 2].map((g) => <option key={g} value={g}>{g}초</option>)}
              </select>
            </label>
            <span className="rv-spacer" />
            {running
              ? <button type="button" onClick={state.stop}>멈춤</button>
              : <button type="button" className="primary" disabled={!area || videos.length === 0 || state.drawing !== null} onClick={() => area && void state.run(area)}>찾기</button>}
          </div>
        </div>
      </div>
      {running && (
        <div className="small muted">
          <progress max={1} value={status?.progress ?? 0} />{' '}
          {`찾는 중 ${Math.round((status?.progress ?? 0) * 100)}%`}{status?.current ? ` · ${status.current}` : ''}
          {status && status.scale > 1 && ` · 영역이 넓어 1/${status.scale}로 훑은 뒤 원래 크기로 확인`}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
      {found.filter((f) => f.error).map((f) => <p key={f.path} className="error small">{`${nameOf(f.path)}: ${f.error}`}</p>)}
      {found.length > 0 && (
        <>
          <div className="rv-search-axis" title="이 실행의 영상 전체 (누르면 그 구간으로 이동)">
            {axis.spans.map((s) => (
              <div
                key={s.path}
                className={`rv-search-span${s.path === currentPath ? ' current' : ''}`}
                style={{ left: `${((s.begin - axis.min) / axis.length) * 100}%`, width: `${((s.end - s.begin) / axis.length) * 100}%` }}
                title={s.name}
              />
            ))}
            {ordered.map((s) => (
              <button
                key={`${s.path}:${s.first}`}
                type="button"
                className="rv-search-hit"
                style={{ left: `${posOf(s.path, s.first / s.fps)}%`, width: `max(3px, ${((s.last - s.first + 1) / s.fps / axis.length) * 100}%)` }}
                title={`${nameOf(s.path)} ${formatFrameTime(s.first / s.fps)}`}
                onClick={() => seek(s)}
              />
            ))}
            {currentPath && <div className="rv-search-now" style={{ left: `${posOf(currentPath, nowSeconds)}%` }} />}
          </div>
          <div className="small muted">
            {`찾은 구간 ${ordered.length}개`}{running ? ' (찾는 중)' : ''}{' · 누르면 그 구간의 첫 프레임으로 이동'}
          </div>
          <ol className="rv-search-list">
            {ordered.map((s) => {
              const t = s.first / s.fps
              const wall = wallOf(s.path, t)
              return (
                <li key={`${s.path}:${s.first}`}>
                  <button type="button" className="link mono" onClick={() => seek(s)}>{formatFrameTime(t)}</button>
                  {wall !== null && axis.useWall && <span className="mono small">{formatWall(wall)}</span>}
                  {videos.length > 1 && <span className="small muted ellipsis" title={s.path}>{nameOf(s.path)}</span>}
                  <span className="small muted">{`프레임 ${s.first} · ${((s.last - s.first + 1) / s.fps).toFixed(2)}초 · 최고 ${(s.peak / 2).toFixed(1)}%`}</span>
                </li>
              )
            })}
          </ol>
        </>
      )}
    </div>
  )
}
