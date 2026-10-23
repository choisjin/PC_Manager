import { useCallback, useEffect, useEffectEvent, useMemo, useRef, useState } from 'react'
import { formatDuration } from '../../format'
import { tr } from '../../i18n/engine'
import { ColumnFilterMenu } from './ColumnFilter'
import { clamp, formatFrameTime, scaleRect, useVideoView } from './frameUtil'
import { RectPickerDialog } from './RectPicker'
import { formatWall, type ResultRow } from './resultCsv'
import { toMessage } from './resultSessions'
import { rowAtTime } from './sync'
import { copyTable, downloadXlsx } from './tableExport'
import {
  type AreaMode, areaOf, type CropTarget, type FrameShot, type ImageSearchState, type Rect, RESULT_COLUMNS, type ResultColumn, type SearchScope,
  type SearchVideo, type Segment, type StepSource, stepWindows,
} from './imageSearchState'

// 결과 확인 이미지 찾기 화면: 영상 위 크롭·영역 표시(CropOverlay) · 크롭 창(CropDialog) · 설정·진행·찾은 구간(ImageSearchPanel).
// 상태·찾기 작업은 imageSearchState

/** 프레임의 rect 부분을 회색조로 (BT.601 밝기) */
function captureTemplate(source: CanvasImageSource, rect: Rect): { gray: Uint8Array; preview: string } {
  const canvas = document.createElement('canvas')
  canvas.width = rect.w
  canvas.height = rect.h
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('캔버스를 만들지 못했습니다')
  context.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h)
  const data = context.getImageData(0, 0, rect.w, rect.h).data
  const gray = new Uint8Array(rect.w * rect.h)
  for (let i = 0; i < gray.length; i++) gray[i] = Math.round(data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114)
  return { gray, preview: canvas.toDataURL('image/png') }
}

// ─────────────────────────────── 영상 위 크롭·영역 표시 (VideoTransport의 영상 칸 안, 고르기는 크롭 창에서)

export function CropOverlay({ state, videoRef, currentPath }: {
  state: ImageSearchState
  videoRef: React.RefObject<HTMLVideoElement | null>
  currentPath: string | null
}) {
  const { boxRef, view } = useVideoView(videoRef, state.open, currentPath)

  if (!state.open) return null
  const template = state.template
  // 크롭·영역은 크롭한 영상 크기 기준: 크기가 다른 영상에서는 늘려 그린다 (에이전트도 같은 크기로 맞춰 비교)
  /** 크롭한 영상 픽셀 사각형 → 오버레이 안 위치 */
  const place = (r: Rect) => view && template && ({
    left: view.left + (r.x * view.vw / template.frameWidth) * view.scale,
    top: view.top + (r.y * view.vh / template.frameHeight) * view.scale,
    width: (r.w * view.vw / template.frameWidth) * view.scale,
    height: (r.h * view.vh / template.frameHeight) * view.scale,
  })
  const area = areaOf(state)
  return (
    <div ref={boxRef} className="rv-crop">
      {template && area && area !== template.rect && <div className="rv-crop-area" style={place(area) ?? undefined} />}
      {template && <div className="rv-crop-rect" style={place(template.rect) ?? undefined} />}
    </div>
  )
}

// ─────────────────────────────── 크롭 창: 찾을 이미지 또는 검색 영역을 지금 프레임에서 고른다 (RectPickerDialog)

const MIN_CROP = 8

function CropDialog({ state, crop }: { state: ImageSearchState; crop: CropTarget }) {
  const { kind, frame } = crop
  const template = state.template
  // 크롭한 영상 크기 → 이 프레임 배율 (검색 영역은 크롭한 영상 크기 기준으로 둔다)
  const sx = template ? frame.width / template.frameWidth : 1
  const sy = template ? frame.height / template.frameHeight : 1
  // 처음 선택: 지금 크롭(같은 크기 영상일 때) 또는 지금 검색 영역
  const initial = kind === 'area'
    ? (state.customArea ? scaleRect(state.customArea, sx, sy, frame) : null)
    : (template && template.frameWidth === frame.width && template.frameHeight === frame.height ? template.rect : null)
  const close = () => state.setCrop(null)
  const apply = (sel: Rect): string | null => {
    if (sel.w < MIN_CROP || sel.h < MIN_CROP) return null
    if (kind === 'template') {
      try {
        const { gray, preview } = captureTemplate(frame.canvas, sel)
        state.setTemplate({ rect: sel, frameWidth: frame.width, frameHeight: frame.height, gray, preview, path: frame.path, time: frame.time })
      } catch (err) {
        return `이미지를 떼어 내지 못했습니다: ${toMessage(err)}`
      }
      state.setCustomArea(null)
      state.setAreaMode('same')
    } else {
      state.setCustomArea({ x: Math.round(sel.x / sx), y: Math.round(sel.y / sy), w: Math.round(sel.w / sx), h: Math.round(sel.h / sy) })
      state.setAreaMode('custom')
    }
    close()
    return null
  }
  return (
    <RectPickerDialog
      frame={frame}
      title={kind === 'template' ? '찾을 이미지 크롭' : '검색 영역 지정'}
      confirmLabel={kind === 'template' ? '이 부분으로 크롭' : '이 영역으로 지정'}
      initial={initial}
      // 검색 영역을 고를 때는 크롭한 이미지 위치도 보여 준다
      reference={kind === 'area' && template ? scaleRect(template.rect, sx, sy, frame) : null}
      variant={kind}
      onApply={apply}
      onCancel={close}
    />
  )
}

// ─────────────────────────────── 패널: 설정·진행·찾은 구간

/** 찾은 구간 목록의 열: 머리글(내보내는 표의 머리글도 같음) · 화면 폭 · 가장 좁은 폭(px) · 칸 모양 */
const COLUMN_SPEC: Record<ResultColumn, { label: string; width: string; min: number; className: string }> = {
  time: { label: '시각', width: '168px', min: 168, className: '' },
  cycle: { label: 'Cycle', width: '46px', min: 46, className: 'small mono' },
  step: { label: '스텝', width: '46px', min: 46, className: 'small' },
  name: { label: '스텝 이름', width: 'minmax(72px, 1fr)', min: 72, className: 'small ellipsis' },
  offset: { label: '스텝부터(초)', width: '74px', min: 74, className: 'small muted mono rv-search-num' },
  length: { label: '길이(초)', width: '54px', min: 54, className: 'small muted mono rv-search-num' },
  peak: { label: '유사도(%)', width: '64px', min: 64, className: 'small muted mono rv-search-num' },
  frame: { label: '프레임', width: '54px', min: 54, className: 'small muted mono rv-search-num' },
  video: { label: '영상', width: 'minmax(80px, 0.7fr)', min: 80, className: 'small muted ellipsis' },
}
// 칸 사이 · 줄 양옆 여백 (CSS와 같게)
const COLUMN_GAP = 8
const ROW_PADDING = 12

/** 파일 이름에 넣을 시각 20261023_101530 */
const fileStamp = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

// 슬라이드 쇼: 프레임이 이만큼 지나도 안 나오면(영상을 열지 못함) 다음 줄로
const SLIDE_WAIT_MS = 10_000

/** 초 입력 칸: 쓰는 동안은 쓴 그대로 두고(비워도 됨) 숫자면 min~max로 바로 반영, 칸을 떠나면 반영된 값을 보여 준다 */
function SecondsField({ value, min, max, onChange }: { value: number; min: number; max: number; onChange: (seconds: number) => void }) {
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={0.5}
      defaultValue={value}
      onChange={(e) => {
        const n = e.target.valueAsNumber
        if (Number.isFinite(n)) onChange(clamp(n, min, max))
      }}
      onBlur={(e) => {
        e.target.value = String(value)
      }}
    />
  )
}

export function ImageSearchPanel({ state, videos, steps, currentPath, videoRef, grab, escape, nowSeconds, wallOf, onSeek }: {
  state: ImageSearchState
  videos: SearchVideo[]
  /** 찾을 범위를 고른 스텝 앞뒤로 할 때 쓰는 Result 표 */
  steps: StepSource
  currentPath: string | null
  /** 영상 요소 (슬라이드 쇼: 시작하면 멈추고, 재생하면 슬라이드 쇼를 끝낸다) */
  videoRef: React.RefObject<HTMLVideoElement | null>
  /** 크롭 창에 띄울 지금 프레임 (아직 보이는 프레임이 없으면 null) */
  grab: () => FrameShot | null
  /** Esc를 이 패널이 받을지 (자르기·저장 창이 열려 있으면 false: 그 창이 닫히게) */
  escape: boolean
  /** 지금 영상 위치(초) */
  nowSeconds: number
  /** 영상 위치 → 벽시계 ms (모르면 null): 영상 여러 개를 한 시간축에 */
  wallOf: (path: string, seconds: number) => number | null
  onSeek: (path: string, seconds: number) => void
}) {
  const { template, threshold, setThreshold, gap, setGap, found, status, error, running, segments } = state
  // 스텝 값 고르기 창 (머리글 거르기와 같은 창)
  const [picker, setPicker] = useState<{ x: number; y: number } | null>(null)
  // 슬라이드 쇼 중 (패널을 닫으면 끝)
  const [sliding, setSliding] = useState(false)
  // 크롭 창 열기: 지금 프레임을 떠서 (영상이 아직 안 보이면 안내)
  const [grabError, setGrabError] = useState<string | null>(null)
  const openCrop = (kind: CropTarget['kind']) => {
    const frame = grab()
    setGrabError(frame ? null : '영상 프레임을 아직 읽지 못했습니다. 영상이 보이면 다시 누르세요')
    if (!frame) return
    setSliding(false)
    state.setCrop({ kind, frame })
  }

  // Esc: 크롭 창 → 값 고르기 창 → 슬라이드 쇼 → 패널 닫기 순 (결과 확인 창이 닫히지 않게 먼저 받는다)
  useEffect(() => {
    if (!escape) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      if (state.crop) state.setCrop(null)
      else if (picker) setPicker(null)
      else if (sliding) setSliding(false)
      else state.close()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [state, escape, picker, sliding])

  // 고른 스텝: 머리글(열) 하나를 고르고 그 열의 값으로 → 스텝 시각 앞뒤 구간 (겹치면 합침)
  const column = state.stepColumn
  const pickerValues = useMemo(() => (column === null ? [] : steps.rows.map((r) => r.cells[column] ?? '')), [steps.rows, column])
  const pickerFilter = useMemo(() => (state.stepValues.length > 0 ? { values: state.stepValues } : undefined), [state.stepValues])
  const chosen = useMemo(() => {
    if (column === null) return []
    const values = new Set(state.stepValues)
    return steps.rows.filter((r) => r.time !== null && values.has(r.cells[column] ?? ''))
  }, [steps.rows, column, state.stepValues])
  const plan = useMemo(() => stepWindows(chosen, steps, videos, state.before, state.after), [chosen, steps, videos, state.before, state.after])
  const planSeconds = plan.windows.reduce((n, w) => n + w.end - w.start, 0)
  const videoSeconds = videos.reduce((n, v) => n + (v.duration ?? 0), 0)
  const valueText = (v: string) => (column === null ? v : steps.label(column, v)) || '(빈 값)'
  const pickedText = state.stepValues.length === 0 ? '값 고르기'
    : state.stepValues.length === 1 ? valueText(state.stepValues[0])
      : `${valueText(state.stepValues[0])} 외 ${state.stepValues.length - 1}개`
  const stepScope = state.scope === 'steps'
  const rowByIndex = useMemo(() => new Map(steps.rows.map((r) => [r.index, r])), [steps.rows])
  const timedRows = useMemo(() => steps.rows.filter((r) => r.time !== null).sort((a, b) => a.time! - b.time! || a.index - b.index), [steps.rows])
  // 테스트가 끝난 시각 (마지막 스텝이 끝난 때): 그 뒤에 찾은 것은 스텝이 없다
  const runEnd = useMemo(() => timedRows.reduce((end, r) => Math.max(end, r.time! + (r.durationMs ?? 0)), -Infinity), [timedRows])
  /**
   * 찾은 구간의 스텝과 그 스텝 시각부터 몇 초 뒤인지: 고른 스텝 앞뒤로 찾았으면 가장 가까운 고른 스텝,
   * 영상 전체로 찾았으면 그때 하던 스텝 (영상 시작 시각을 몰라 벽시계를 모르면 없음)
   */
  const stepOf = (s: Segment): { row: ResultRow; offset: number } | null => {
    const t = s.first / s.fps
    if (state.searched) {
      const w = state.searched.find((x) => x.path === s.path && s.first >= Math.floor(x.start * s.fps) && t < x.end)
      const near = w?.steps.reduce((a, b) => (Math.abs(b.at - t) < Math.abs(a.at - t) ? b : a))
      const row = near ? rowByIndex.get(near.index) : undefined
      return near && row ? { row, offset: t - near.at } : null
    }
    const wall = wallOf(s.path, t)
    const row = wall === null || wall > runEnd ? null : rowAtTime(timedRows, wall)
    return wall !== null && row?.time != null ? { row, offset: (wall - row.time) / 1000 } : null
  }
  const keyOf = (s: Segment) => `${s.path}:${s.first}`
  /** 목록 한 줄의 칸 (내보내기와 같은 값, 숫자는 단위 없이) */
  const cellsOf = (s: Segment): Record<ResultColumn, string> => {
    const t = s.first / s.fps
    const wall = wallOf(s.path, t)
    const step = stepOf(s)
    return {
      // 실제 시각 (영상 시작 시각을 모르면 영상 위치)
      time: wall !== null ? formatWall(wall, true) : formatFrameTime(t),
      cycle: step?.row.cycle ?? '',
      step: step ? String(step.row.index + 1) : '',
      name: step?.row.name ?? '',
      offset: step ? step.offset.toFixed(2) : '',
      length: ((s.last - s.first + 1) / s.fps).toFixed(2),
      peak: (s.peak / 2).toFixed(1),
      frame: String(s.first),
      video: nameOf(s.path),
    }
  }
  // 열: 영상이 하나면 '영상' 열은 없다
  const columns = RESULT_COLUMNS.filter((c) => c !== 'video' || videos.length > 1)
  const toggleColumn = (c: ResultColumn) =>
    state.setExportColumns(state.exportColumns.includes(c) ? state.exportColumns.filter((x) => x !== c) : [...state.exportColumns, c])
  const [exportNotice, setExportNotice] = useState<string | null>(null)
  /** 목록·시간축에서 누름: 하이라이트하고 그 구간 첫 프레임으로 */
  const pick = (s: Segment) => {
    state.setPicked(keyOf(s))
    onSeek(s.path, (s.first + 0.5) / s.fps)
  }
  // 시간축에서 누른 구간이 목록에서 안 보이면 보이게
  const listRef = useRef<HTMLOListElement>(null)
  useEffect(() => {
    if (!state.picked) return
    listRef.current?.querySelector('li.picked')?.scrollIntoView({ block: 'nearest' })
  }, [state.picked])

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

  // 슬라이드 쇼: 누른 줄부터 목록 차례로 첫 프레임을 slideSeconds초씩 (영상은 멈춘 채, 끝 줄에서 멈춤).
  // 시간은 그 프레임이 화면에 나온 뒤부터 센다 (테스트 PC에서 받는 영상은 옮겨 가는 데 시간이 걸린다). 줄을 누르면 거기서 이어 간다
  const slideIndex = sliding ? ordered.findIndex((s) => keyOf(s) === state.picked) : -1
  const slide = slideIndex >= 0 ? ordered[slideIndex] : null
  // 찾는 중에는 목록을 계속 다시 만들므로 구간 객체 대신 키로 본다
  const slideKey = slide ? keyOf(slide) : null
  const shown = slide !== null && slide.path === currentPath && Math.abs(nowSeconds - (slide.first + 0.5) / slide.fps) < 0.5 / slide.fps
  const nextSlide = useEffectEvent(() => {
    const i = ordered.findIndex((s) => keyOf(s) === state.picked)
    if (i < 0 || i === ordered.length - 1) setSliding(false)
    else pick(ordered[i + 1])
  })
  useEffect(() => {
    if (!sliding) return
    // 보던 줄이 목록에서 없어졌으면(다시 찾음·기준 바꿈) 바로 끝
    const id = window.setTimeout(nextSlide, slideKey === null ? 0 : shown ? state.slideSeconds * 1000 : SLIDE_WAIT_MS)
    return () => window.clearTimeout(id)
  }, [sliding, slideKey, shown, state.slideSeconds])
  // 영상을 재생하면 슬라이드 쇼는 끝 (Space·▶)
  useEffect(() => {
    if (!sliding) return
    const onPlay = (e: Event) => {
      if (e.target === videoRef.current) setSliding(false)
    }
    window.addEventListener('play', onPlay, true)
    return () => window.removeEventListener('play', onPlay, true)
  }, [sliding, videoRef])
  const toggleSlides = () => {
    if (sliding) return setSliding(false)
    if (ordered.length === 0) return
    const i = ordered.findIndex((s) => keyOf(s) === state.picked)
    videoRef.current?.pause()
    // 마지막 줄을 보고 있었으면 처음부터
    pick(ordered[i >= 0 && i < ordered.length - 1 ? i : 0])
    setSliding(true)
  }
  // 내보내기: 머리글에서 체크한 열만, 목록과 같은 차례
  const canExport = ordered.length > 0 && columns.some((c) => state.exportColumns.includes(c))
  const exportLines = () => {
    const chosen = columns.filter((c) => state.exportColumns.includes(c))
    // 머리글은 화면 언어로 (English면 영어)
    return [chosen.map((c) => tr(COLUMN_SPEC[c].label)), ...ordered.map((s) => {
      const v = cellsOf(s)
      return chosen.map((c) => v[c])
    })]
  }
  const exportXlsx = () => {
    const name = (videos[0]?.name ?? '영상').replace(/\.[^.]+$/, '')
    downloadXlsx(`이미지찾기_${name}_${fileStamp(new Date())}.xlsx`, tr('이미지 찾기'), exportLines())
  }
  const copyRows = () => {
    copyTable(exportLines())
    setExportNotice('표를 복사했습니다 (엑셀에 붙여 넣기)')
    window.setTimeout(() => setExportNotice(null), 2500)
  }
  const nameOf = (path: string) => videos.find((v) => v.path === path)?.name ?? path
  const area = areaOf(state)
  // 직접 지정한 영역 크기 (크롭한 영상 픽셀)
  const areaText = state.areaMode === 'custom' && state.customArea ? `${state.customArea.w}×${state.customArea.h}` : ''

  return (
    <div className="rv-search">
      {/* 옵션 두 줄 (좁으면 무리 단위로 줄바꿈): 찾을 이미지·검색 영역·유사도·끊김·찾기 | 찾을 범위 */}
      <div className="rv-search-bar">
        <strong title={`이 실행의 영상 ${videos.length}개에서 크롭한 이미지가 나타나는 구간의 첫 프레임`}>이미지 찾기</strong>
        <span className="rv-search-group">
          {template
            ? (
              <img
                className="rv-search-thumb"
                src={template.preview}
                alt=""
                title={`크롭: ${template.rect.w}×${template.rect.h} · ${template.path.split(/[\\/]/).pop()} ${formatFrameTime(template.time)}`}
              />
            )
            : <span className="muted small">[크롭]으로 고르기</span>}
          <button type="button" onClick={() => openCrop('template')} title="지금 프레임을 크게 띄워 찾을 이미지를 고릅니다 (확대해 픽셀 단위로)">
            {template ? '다시 크롭' : '크롭'}
          </button>
        </span>
        <span className="rv-search-group">
          <label className="small" title="이 영역 안에서 크롭한 이미지와 비슷한 곳을 찾습니다">
            검색 영역
            <select
              value={state.areaMode}
              disabled={!template}
              onChange={(e) => {
                const mode = e.target.value as AreaMode
                state.setAreaMode(mode)
                if (mode === 'custom' && !state.customArea) openCrop('area')
              }}
            >
              <option value="same">크롭 위치 그대로</option>
              <option value="custom">직접 지정</option>
              <option value="full">화면 전체</option>
            </select>
          </label>
          {state.areaMode === 'custom' && (
            <button type="button" disabled={!template} onClick={() => openCrop('area')} title="지금 프레임을 크게 띄워 검색할 영역을 고릅니다">
              영역 지정
            </button>
          )}
          {template && areaText && <span className="muted small mono">{areaText}</span>}
        </span>
        <label className="small" title="이 값 이상이면 나타난 것으로 봅니다. 바꾸면 다시 찾지 않고 바로 다시 나눕니다">
          유사도
          <input type="range" min={50} max={100} step={0.5} value={threshold} onChange={(e) => setThreshold(Number(e.target.value))} />
          <span className="mono">{threshold.toFixed(1)}%</span>
        </label>
        <label className="small" title="기준 아래로 이 시간 이하 끊긴 것은 한 번 나타난 것으로 봅니다 (깜빡임·인코딩 잡음)">
          끊김 무시
          <select value={gap} onChange={(e) => setGap(Number(e.target.value))}>
            {[0, 0.1, 0.3, 0.5, 1, 2].map((g) => <option key={g} value={g}>{g}초</option>)}
          </select>
        </label>
        <span className="rv-search-go">
          {running
            ? <button type="button" onClick={state.stop}>멈춤</button>
            : (
              <button
                type="button"
                className="primary"
                disabled={!area || videos.length === 0 || state.crop !== null || (stepScope && plan.windows.length === 0)}
                onClick={() => area && void state.run(area, stepScope ? plan.windows : undefined)}
              >
                찾기
              </button>
            )}
          <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={state.close}>✕</button>
        </span>
      </div>
      <div className="rv-search-bar">
        <label className="small" title="영상 전체를 훑거나, 고른 스텝의 앞뒤 몇 초만 훑습니다 (훨씬 빠름)">
          찾을 범위
          <select value={state.scope} onChange={(e) => state.setScope(e.target.value as SearchScope)}>
            <option value="all">영상 전체</option>
            <option value="steps">고른 스텝 앞뒤</option>
          </select>
        </label>
        {stepScope && (
          <>
            <select
              value={column ?? ''}
              title="스텝을 고를 머리글"
              onChange={(e) => {
                state.setStepColumn(e.target.value === '' ? null : Number(e.target.value))
                state.setStepValues([])
                setPicker(null)
              }}
            >
              <option value="">머리글 고르기</option>
              {steps.headers.map((h, i) => <option key={i} value={i}>{h || `열 ${i + 1}`}</option>)}
            </select>
            <button
              type="button"
              className="rv-search-pick"
              data-colfilter-trigger
              disabled={column === null}
              title="이 머리글의 값 중에서 찾을 스텝 고르기"
              onClick={(e) => {
                if (picker) return setPicker(null)
                const r = e.currentTarget.getBoundingClientRect()
                setPicker({ x: r.left, y: r.bottom + 2 })
              }}
            >
              <span className="ellipsis">{pickedText}</span> ▾
            </button>
            <span className="rv-search-group">
              <label className="small" title="스텝 시각보다 이만큼 앞부터">
                앞
                <SecondsField value={state.before} min={0} max={3600} onChange={state.setBefore} />
                초
              </label>
              <label className="small" title="스텝 시각보다 이만큼 뒤까지">
                뒤
                <SecondsField value={state.after} min={0} max={3600} onChange={state.setAfter} />
                초
              </label>
            </span>
          </>
        )}
        <span className="rv-search-plan small muted">
          {!stepScope ? <span>{`영상 ${videos.length}개${videoSeconds > 0 ? ` · ${formatDuration(videoSeconds * 1000)}` : ''}`}</span>
            : column === null ? <span>머리글을 고르고, 그 열의 값 중에서 찾을 스텝을 고르세요</span>
              : chosen.length === 0 ? <span>찾을 스텝의 값을 고르세요</span>
                : (
                  <>
                    <span>{`스텝 ${chosen.length}개 → 구간 ${plan.windows.length}개 · ${formatDuration(planSeconds * 1000)}`}</span>
                    {videoSeconds > 0 && <span>{`영상의 ${((planSeconds / videoSeconds) * 100).toFixed(1)}%`}</span>}
                    {plan.outside > 0 && <span className="rv-search-warn" title="영상 시작 시각을 모르거나 영상 밖의 스텝">{`영상 밖 ${plan.outside}개 뺌`}</span>}
                  </>
                )}
        </span>
      </div>
      {running && (
        <div className="small muted">
          <progress max={1} value={status?.progress ?? 0} />{' '}
          {`찾는 중 ${Math.round((status?.progress ?? 0) * 100)}%`}{status?.current ? ` · ${status.current}` : ''}
          {status && status.scale > 1 && ` · 영역이 넓어 1/${status.scale}로 훑은 뒤 원래 크기로 확인`}
        </div>
      )}
      {running && state.retrying && <p className="small muted">테스트 PC 연결이 잠깐 끊겨 다시 묻는 중… (찾기는 테스트 PC에서 계속됩니다)</p>}
      {grabError && <p className="error small">{grabError}</p>}
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
            {state.searched?.map((w, i) => {
              const left = posOf(w.path, w.start)
              return <div key={`w${i}`} className="rv-search-window" style={{ left: `${left}%`, width: `max(2px, ${posOf(w.path, w.end) - left}%)` }} />
            })}
            {ordered.map((s) => (
              <button
                key={keyOf(s)}
                type="button"
                className={`rv-search-hit${keyOf(s) === state.picked ? ' picked' : ''}`}
                style={{ left: `${posOf(s.path, s.first / s.fps)}%`, width: `max(3px, ${((s.last - s.first + 1) / s.fps / axis.length) * 100}%)` }}
                title={`${nameOf(s.path)} ${formatFrameTime(s.first / s.fps)}`}
                onClick={() => pick(s)}
              />
            ))}
            {currentPath && <div className="rv-search-now" style={{ left: `${posOf(currentPath, nowSeconds)}%` }} />}
          </div>
          <div className="rv-search-summary small">
            <span className="muted">{`찾은 구간 ${ordered.length}개`}{running ? ' (찾는 중)' : ''}{' · 누르면 그 구간의 첫 프레임으로 이동'}</span>
            <span className="rv-spacer" />
            <span className="rv-search-slide">
              <button
                type="button"
                className={`small-btn${sliding ? ' active' : ''}`}
                disabled={!sliding && ordered.length === 0}
                onClick={toggleSlides}
                title={sliding ? '슬라이드 쇼 멈춤 (Esc)' : '찾은 프레임을 목록 차례로 한 장씩 보여 줍니다 (누른 줄부터)'}
              >
                {sliding ? '❚❚' : '▶'} 슬라이드 쇼
              </button>
              <label title="한 장을 보여 주는 시간 (프레임이 화면에 나온 뒤부터)">
                <SecondsField value={state.slideSeconds} min={0.5} max={60} onChange={state.setSlideSeconds} />
                초
              </label>
              {slide && <span className="mono muted">{`${slideIndex + 1}/${ordered.length}`}</span>}
            </span>
            {exportNotice && <span className="muted">{exportNotice}</span>}
            <button type="button" className="small-btn" disabled={!canExport} onClick={exportXlsx} title="머리글에서 체크한 열만 엑셀 파일(.xlsx)로">
              엑셀로 내보내기
            </button>
            <button type="button" className="small-btn" disabled={!canExport} onClick={copyRows} title="머리글에서 체크한 열만 표로 복사 (엑셀에 붙이면 칸마다)">
              표 복사
            </button>
          </div>
          {/* 머리글 있는 표: 체크한 열만 내보낸다 */}
          <ol
            className="rv-search-list"
            ref={listRef}
            style={{
              '--search-cols': columns.map((c) => COLUMN_SPEC[c].width).join(' '),
              // 줄마다 같은 폭이어야 칸이 맞는다: 패널이 좁으면 이 폭에서 가로로 스크롤
              '--search-min': `${columns.reduce((sum, c) => sum + COLUMN_SPEC[c].min, 0) + COLUMN_GAP * (columns.length - 1) + ROW_PADDING}px`,
            } as React.CSSProperties}
          >
            <li className="rv-search-head">
              {columns.map((c) => {
                const on = state.exportColumns.includes(c)
                return (
                  <label key={c} className={on ? '' : 'off'} title={on ? '내보낼 열 (누르면 뺌)' : '내보내지 않는 열 (누르면 넣음)'}>
                    <input type="checkbox" checked={on} onChange={() => toggleColumn(c)} />
                    {COLUMN_SPEC[c].label}
                  </label>
                )
              })}
            </li>
            {ordered.map((s) => {
              const key = keyOf(s)
              const v = cellsOf(s)
              return (
                <li key={key} className={key === state.picked ? 'picked' : ''} onClick={() => pick(s)}>
                  {columns.map((c) => {
                    // 내보내지 않는 열은 흐리게
                    const off = state.exportColumns.includes(c) ? '' : ' off'
                    return c === 'time'
                      ? <button key={c} type="button" className={`link mono${off}`}>{v.time}</button>
                      : (
                        <span key={c} className={COLUMN_SPEC[c].className + off} title={c === 'name' || c === 'video' ? v[c] : undefined}>
                          {c === 'step' && v.step ? `#${v.step}` : c === 'offset' && v.offset && !v.offset.startsWith('-') ? `+${v.offset}` : v[c]}
                        </span>
                      )
                  })}
                </li>
              )
            })}
          </ol>
        </>
      )}
      {state.crop && <CropDialog state={state} crop={state.crop} />}
      {picker && column !== null && (
        <ColumnFilterMenu
          x={picker.x}
          y={picker.y}
          title={steps.headers[column] || `열 ${column + 1}`}
          values={pickerValues}
          label={(v) => steps.label(column, v)}
          filter={pickerFilter}
          onApply={(f) => state.setStepValues(f?.values ?? [])}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  )
}
