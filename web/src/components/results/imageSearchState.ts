import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ImageSearchChunk, type ImageSearchProgress, type ImageSearchRequest } from '../../api'
import type { ResultRow } from './resultCsv'
import { findJob } from './resultJobs'
import { toMessage } from './resultSessions'
import type { JobContext } from './videoAnalysisState'

// 결과 확인: 크롭한 이미지가 영상에 나타나는 구간 찾기
//   1) 지금 프레임을 크롭 창에 띄워 찾을 이미지를 고른다 (확대해 픽셀 단위로, 회색조로 떼어 냄)
//   2) 검색 영역: 크롭 위치 그대로 · 직접 지정(크롭 창) · 화면 전체
//   3) 테스트 PC 에이전트가 이 실행의 모든 영상을 프레임마다 재 유사도 시계열을 돌려준다
//   4) 유사도 기준 이상이 이어지는 구간마다 첫 프레임만 표시 (기준을 바꾸면 다시 찾지 않고 바로 다시 나눔)
//   5) 찾은 프레임은 목록에서 누르거나 슬라이드 쇼(정한 초마다 다음 줄)로 차례로 본다
//   6) 결과 확인을 닫거나 탭을 새로 고쳐도 테스트 PC에서 계속 돈다 (멈춤은 사용자가). 시작하면 서버 작업 목록에 적어 두고
//      (크롭 이미지·기준 등도 함께), 다시 열면 이 결과의 마지막 찾기를 찾아 되살리고 처음부터 다시 받는다

/** 영상 원래 크기 기준 픽셀 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type AreaMode = 'same' | 'custom' | 'full'

/** 찾을 범위: 영상 전체 · 고른 스텝 앞뒤 몇 초 (훨씬 빠르다) */
export type SearchScope = 'all' | 'steps'

/** 찾은 구간 목록의 열 (머리글에서 체크한 열만 내보낸다) */
export const RESULT_COLUMNS = ['time', 'cycle', 'step', 'name', 'offset', 'length', 'peak', 'frame', 'video'] as const
export type ResultColumn = (typeof RESULT_COLUMNS)[number]

/** 훑을 구간 (원래 영상 경로 · 초). steps: 이 구간을 만든 스텝 (행 번호 · 영상 위치) */
export interface SearchWindow {
  path: string
  start: number
  end: number
  steps: { index: number; at: number }[]
}

/** 스텝 고르기에 쓰는 Result 표 */
export interface StepSource {
  headers: string[]
  rows: ResultRow[]
  /** 표에 보이는 글 (시각 열은 [] 없이, 긴 메시지는 줄여서) */
  label: (col: number, value: string) => string
  /** 스텝의 영상 위치 (영상 시작 시각을 몰라 계산할 수 없으면 null) */
  position: (row: ResultRow) => { path: string; seconds: number } | null
}

export interface SearchVideo {
  /** 원래 경로 (영상 목록의 키) */
  path: string
  /** ffmpeg가 읽을 파일 (재생용 사본이 있으면 그것: 브라우저와 같은 시각) */
  readPath: string
  name: string
  duration: number | null
}

/** 크롭 창에 띄운 프레임 (영상 원래 크기로 떠 둔 것) */
export interface FrameShot {
  canvas: HTMLCanvasElement
  width: number
  height: number
  /** 원래 영상 경로 · 위치(초) */
  path: string
  time: number
}

/** 크롭 창: 찾을 이미지 또는 검색 영역을 그 프레임에서 고르는 중 */
export interface CropTarget {
  kind: 'template' | 'area'
  frame: FrameShot
}

/** 지금 영상 프레임을 원래 크기로 떠 둔다 (영상은 멈춤). 아직 보이는 프레임이 없으면 null */
export function grabFrame(video: HTMLVideoElement | null, path: string | null): FrameShot | null {
  if (!video || !path || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return null
  video.pause()
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(video, 0, 0)
  return { canvas, width: canvas.width, height: canvas.height, path, time: video.currentTime }
}

export interface Template {
  rect: Rect
  frameWidth: number
  frameHeight: number
  gray: Uint8Array
  preview: string
  /** 크롭한 영상과 위치 (안내용) */
  path: string
  time: number
}

export interface Found {
  path: string
  fps: number
  scores: Uint8Array
  error: string | null
  /** 다 훑었다 (아니면 확정된 프레임까지만 와 있다) */
  done: boolean
}

/** 받는 중인 영상 결과: 조각을 이어 붙인다 (20시간 60fps 영상은 4MB) */
interface Part {
  path: string
  fps: number
  buffer: Uint8Array
  length: number
  done: boolean
  error: string | null
}

// 에이전트가 잠깐 다시 연결하는 동안 묻기 실패를 견디는 횟수 (1초 간격 → 약 30초, 작업은 에이전트에 그대로 있다)
const MAX_FAILURES = 30

/** 다시 열 때 되살리는 이미지 찾기 설정 (서버 작업 목록에 함께 적는다). 크롭 이미지는 base64 */
interface SearchParams {
  template: Omit<Template, 'gray'> & { gray: string }
  areaMode: AreaMode
  customArea: Rect | null
  threshold: number
  gap: number
  scope: SearchScope
  stepColumn: number | null
  stepValues: string[]
  before: number
  after: number
  searched: SearchWindow[] | null
}

/** 찾은 구간: 프레임 번호 [first, last] */
export interface Segment {
  path: string
  first: number
  last: number
  fps: number
  peak: number
}

/**
 * 오버레이(영상 위 크롭·영역 표시)·패널·크롭 창이 함께 쓰는 상태와 찾기 작업.
 * 패널을 닫아도(스텝 이미지를 보려고) 크롭·결과·진행 중인 찾기는 그대로 두고, 다시 열면 이어서 본다
 */
export function useImageSearch(ctx: JobContext, videos: SearchVideo[]) {
  const agentId = ctx.agentId
  const [open, setOpen] = useState(false)
  const [template, setTemplate] = useState<Template | null>(null)
  // 열린 크롭 창
  const [crop, setCrop] = useState<CropTarget | null>(null)
  const [areaMode, setAreaMode] = useState<AreaMode>('same')
  const [customArea, setCustomArea] = useState<Rect | null>(null)
  const [threshold, setThreshold] = useState(90)
  const [gap, setGap] = useState(0.3)
  const [scope, setScope] = useState<SearchScope>('all')
  // 고른 스텝: 이 머리글(열)의 이 값들인 행
  const [stepColumn, setStepColumn] = useState<number | null>(null)
  const [stepValues, setStepValues] = useState<string[]>([])
  const [before, setBefore] = useState(2)
  const [after, setAfter] = useState(5)
  // 지금 결과를 찾은 구간 (영상 전체로 찾았으면 null)
  const [searched, setSearched] = useState<SearchWindow[] | null>(null)
  // 목록에서 마지막으로 누른 구간 (`경로:첫 프레임`) — 스크롤해도 어디를 봤는지 보이게
  const [picked, setPicked] = useState<string | null>(null)
  // 내보낼 열 (목록 머리글의 체크)
  const [exportColumns, setExportColumns] = useState<ResultColumn[]>([...RESULT_COLUMNS])
  // 슬라이드 쇼에서 한 장을 보여 주는 시간(초)
  const [slideSeconds, setSlideSeconds] = useState(2)
  const [found, setFound] = useState<Found[]>([])
  const [status, setStatus] = useState<ImageSearchProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  // 찾기를 시작한 시각 (ms) · 걸린 시간 (초, 끝났을 때)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState<number | null>(null)
  // 묻기가 실패해 다시 묻는 중 (에이전트 연결이 잠깐 끊김)
  const [retrying, setRetrying] = useState(false)
  const jobRef = useRef<string | null>(null)

  // 보이는 결과의 찾기 (끝난 뒤에도: 기준을 바꾸면 서버에 다시 적는다)
  const shownJobRef = useRef<string | null>(null)

  // 결과 화면을 벗어나면 받기만 그만둔다 (찾기는 테스트 PC에서 계속 돈다 — 다시 열면 이어 받는다)
  useEffect(() => () => {
    jobRef.current = null
  }, [agentId])

  const params = (): SearchParams | null => template && {
    template: { ...template, gray: toBase64(template.gray) },
    areaMode, customArea, threshold, gap, scope, stepColumn, stepValues, before, after, searched,
  }

  // 다시 열었을 때: 이 결과의 마지막 찾기를 찾아 설정을 되살리고 처음부터 다시 받는다 (영상 목록이 정해진 뒤 한 번)
  const attachedRef = useRef(false)
  useEffect(() => {
    if (attachedRef.current || !videos.length) return
    attachedRef.current = true
    void (async () => {
      const job = await findJob(ctx.sourceKey, 'search')
      if (!job || job.state === 'lost' || jobRef.current) return
      const p = (await api.resultJobParams(job.id).catch(() => null)) as SearchParams | null
      if (!p || jobRef.current) return
      setTemplate({ ...p.template, gray: fromBase64(p.template.gray) })
      setAreaMode(p.areaMode)
      setCustomArea(p.customArea)
      setThreshold(p.threshold)
      setGap(p.gap)
      setScope(p.scope)
      setStepColumn(p.stepColumn)
      setStepValues(p.stepValues)
      setBefore(p.before)
      setAfter(p.after)
      reset(p.searched)
      void follow(job.id, Date.parse(job.started), job.finished ? Date.parse(job.finished) : null)
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videos.length])

  // 기준·설정을 바꾸면 다시 열 때 그대로 되살리게 서버에 다시 적는다 (잠시 모아서)
  useEffect(() => {
    const id = shownJobRef.current
    const p = params()
    if (!id || !p) return
    const timer = window.setTimeout(() => void api.saveResultJobParams(id, p).catch(() => {}), 1000)
    return () => window.clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threshold, gap, areaMode, customArea, scope, stepColumn, stepValues, before, after])

  // 끝난 결과를 패널에서 봤으면 PC 목록의 '분석 완료'를 지운다 (찾기마다 한 번)
  const seenRef = useRef<string | null>(null)
  useEffect(() => {
    const id = shownJobRef.current
    if (!open || !id || seenRef.current === id || !status || status.state === 'running') return
    seenRef.current = id
    void api.markResultJobSeen(id).catch(() => {})
  }, [open, status])

  /** 패널 열기: 크롭한 이미지가 아직 없으면 지금 프레임(frame)으로 크롭 창도 연다 */
  const start = (frame: FrameShot | null) => {
    setOpen(true)
    if (!template && frame) setCrop({ kind: 'template', frame })
  }
  const close = () => {
    setOpen(false)
    setCrop(null)
  }

  /** windows: 이 구간만 훑는다 (고른 스텝 앞뒤). 없으면 영상 전체 */
  /** 찾기 요청 (영상 전체): 크롭 이미지·검색 영역 */
  const requestFor = (t: Template, area: Rect): ImageSearchRequest => ({
    paths: videos.map((v) => v.readPath),
    frameWidth: t.frameWidth,
    frameHeight: t.frameHeight,
    templateWidth: t.rect.w,
    templateHeight: t.rect.h,
    template: toBase64(t.gray),
    searchX: area.x,
    searchY: area.y,
    searchWidth: area.w,
    searchHeight: area.h,
  })

  /**
   * 예약 분석에 넣을 요청·설정 (크롭한 이미지가 없으면 null). 예약은 영상 전체에서 찾는다
   * (스텝 앞뒤는 그때의 Result·영상 위치를 알아야 해서). 영상은 서버가 시작할 때 채운다
   */
  const schedulePayload = (): { request: ImageSearchRequest; params: SearchParams } | null => {
    const p = params()
    if (!template || !p) return null
    const area = areaMode === 'full' ? { x: 0, y: 0, w: template.frameWidth, h: template.frameHeight }
      : areaMode === 'custom' && customArea ? customArea : template.rect
    return { request: { ...requestFor(template, area), paths: [] }, params: { ...p, scope: 'all', searched: null } }
  }

  /** 받은 것을 모두 비우고 받기 시작 상태로 (searched: 찾는 구간) */
  const reset = (windows: SearchWindow[] | null) => {
    jobRef.current = null
    setError(null)
    setFound([])
    setStatus(null)
    setRetrying(false)
    setSearched(windows)
    setPicked(null)
    setStartedAt(null)
    setElapsed(null)
    setRunning(true)
  }

  const run = async (area: Rect, windows?: SearchWindow[]) => {
    if (!template) return
    if (jobRef.current) void api.cancelImageSearch(agentId, jobRef.current).catch(() => {})
    reset(windows ?? null)
    const started = Date.now()
    const ranges = windows?.flatMap((w) => {
      const video = videos.findIndex((v) => v.path === w.path)
      return video < 0 ? [] : [{ video, start: w.start, end: w.end }]
    })
    let id: string
    try {
      id = (await api.startImageSearch(agentId, { ...requestFor(template, area), ranges })).id
    } catch (err) {
      setError(toMessage(err))
      setRunning(false)
      return
    }
    // 서버 작업 목록에 적는다: 결과 확인을 닫아도 PiP·PC 목록에 진행·완료가 보이고, 다시 열면 이어 받는다
    const p = params()
    void api.registerResultJob({
      id, kind: 'search', agentId, machineName: ctx.machineName, title: ctx.title, sourceKey: ctx.sourceKey, open: ctx.open,
      params: p && { ...p, searched: windows ?? null },
    }).catch(() => {})
    await follow(id, started, null)
  }

  /** id 찾기의 결과를 처음부터 받는다 (진행 중이면 끝날 때까지). started·finished: 걸린 시간 표시용 (다시 열어 끝난 찾기를 받으면 finished가 있다) */
  const follow = async (id: string, started: number, finished: number | null) => {
    setStartedAt(started)
    jobRef.current = id
    shownJobRef.current = id
    try {
      // 결과는 (영상, 프레임) 위치부터 1MB씩 조각으로 받는다. 훑는 중인 영상도 확정된 프레임까지 바로 보인다
      const parts: Part[] = []
      let video = 0
      let offset = 0
      let more = false
      let failures = 0
      for (;;) {
        if (!more) await new Promise((r) => window.setTimeout(r, 1000))
        // 다른 찾기를 시작했거나 결과 화면을 벗어남
        if (jobRef.current !== id) return
        let next: ImageSearchProgress
        try {
          next = await api.imageSearchChunks(agentId, id, video, offset)
        } catch (err) {
          // 작업이 없어졌으면(에이전트 다시 시작) 바로 그만, 아니면 다시 연결될 때까지 묻는다
          if ((err as { status?: number }).status === 404 || ++failures > MAX_FAILURES) throw err
          setRetrying(true)
          more = false
          continue
        }
        if (jobRef.current !== id) return
        failures = 0
        setRetrying(false)
        for (const chunk of next.chunks) {
          const part = (parts[chunk.video] ??= newPart(chunk, videos))
          const bytes = fromBase64(chunk.scores)
          write(part, chunk.offset, bytes)
          if (chunk.done) {
            part.done = true
            part.error = chunk.error
            video = chunk.video + 1
            offset = 0
          } else {
            video = chunk.video
            offset = chunk.offset + bytes.length
          }
        }
        // 이 화면에 없는 영상(예약 찾기가 더 모은 영상)은 뺀다
        setFound(parts.filter((p) => p && videos.some((v) => v.path === p.path)).map((p) => ({ path: p.path, fps: p.fps, scores: p.buffer.subarray(0, p.length), error: p.error, done: p.done })))
        setStatus(next)
        more = next.more
        if (next.state !== 'running' && !more) {
          if (next.state === 'failed') setError(next.error ?? '찾지 못했습니다')
          break
        }
      }
      setElapsed(((finished ?? Date.now()) - started) / 1000)
      jobRef.current = null
      setRunning(false)
    } catch (err) {
      setError(toMessage(err))
      setRetrying(false)
      jobRef.current = null
      setRunning(false)
    }
  }

  const stop = () => {
    if (jobRef.current) void api.cancelImageSearch(agentId, jobRef.current).catch(() => {})
  }

  const segments = useMemo(() => {
    const all = found.flatMap((f) => findSegments(f, threshold, gap))
    if (!searched) return all
    // 고른 스텝 앞뒤: 그 구간 안에서 시작한 것만 (옛 에이전트는 구간을 몰라 영상 전체를 훑어 돌려준다)
    return all.filter((s) => searched.some((w) => w.path === s.path && s.first >= Math.floor(w.start * s.fps) && s.first < Math.ceil(w.end * s.fps)))
  }, [found, threshold, gap, searched])

  return {
    schedulePayload,
    open, setOpen, start, close, template, setTemplate, crop, setCrop, areaMode, setAreaMode, customArea, setCustomArea,
    threshold, setThreshold, gap, setGap, found, status, error, running, startedAt, elapsed, retrying, run, stop, segments,
    scope, setScope, stepColumn, setStepColumn, stepValues, setStepValues, before, setBefore, after, setAfter, searched,
    picked, setPicked, exportColumns, setExportColumns, slideSeconds, setSlideSeconds,
  }
}

/** 고른 스텝 앞뒤 구간: 영상 밖은 잘라 내고 겹치는 구간은 합친다. outside: 영상 위치를 몰라 뺀 스텝 수 */
export function stepWindows(steps: ResultRow[], source: StepSource, videos: SearchVideo[], before: number, after: number) {
  const list: SearchWindow[] = []
  let outside = 0
  for (const row of steps) {
    const at = source.position(row)
    const video = at ? videos.find((v) => v.path === at.path) : undefined
    const start = at ? Math.max(0, at.seconds - before) : 0
    const end = at ? Math.min(video?.duration ?? Infinity, at.seconds + after) : 0
    if (!at || !video || end <= start) {
      outside++
      continue
    }
    list.push({ path: at.path, start, end, steps: [{ index: row.index, at: at.seconds }] })
  }
  list.sort((a, b) => a.path.localeCompare(b.path) || a.start - b.start)
  const windows: SearchWindow[] = []
  for (const w of list) {
    const prev = windows.at(-1)
    if (prev && prev.path === w.path && w.start <= prev.end) {
      prev.end = Math.max(prev.end, w.end)
      prev.steps.push(...w.steps)
    } else windows.push({ ...w, steps: [...w.steps] })
  }
  return { windows, outside }
}

/** 훑은 영상 → 이 화면의 영상: 경로로 맞춘다 (재생용 사본 · 원본, 예약 찾기는 영상 차례가 다를 수 있다) */
function newPart(chunk: ImageSearchChunk, videos: SearchVideo[]): Part {
  const video = videos.find((v) => v.readPath === chunk.path || v.path === chunk.path)
  return { path: video?.path ?? chunk.path, fps: chunk.fps, buffer: new Uint8Array(0), length: 0, done: false, error: null }
}

/** offset 자리에 쓴다 (모자라면 두 배로 늘림. 같은 조각을 다시 받아도 그대로) */
function write(part: Part, offset: number, bytes: Uint8Array) {
  const end = offset + bytes.length
  if (end > part.buffer.length) {
    const grown = new Uint8Array(Math.max(end, part.buffer.length * 2, 1 << 16))
    grown.set(part.buffer.subarray(0, part.length))
    part.buffer = grown
  }
  part.buffer.set(bytes, offset)
  part.length = Math.max(part.length, end)
}

export type ImageSearchState = ReturnType<typeof useImageSearch>

/** 지금 고른 검색 영역 (크롭한 영상 크기 기준) */
export function areaOf(state: ImageSearchState): Rect | null {
  const t = state.template
  if (!t) return null
  if (state.areaMode === 'full') return { x: 0, y: 0, w: t.frameWidth, h: t.frameHeight }
  if (state.areaMode === 'custom' && state.customArea) return state.customArea
  return t.rect
}

function toBase64(bytes: Uint8Array): string {
  let text = ''
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(text)
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text)
  const bytes = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

/** 기준(%) 이상이 이어지는 구간. 기준 아래로 gap초 이하 끊긴 것은 한 구간으로 (20시간 영상은 수백만 프레임 → 받을 때마다 다시 나눈다) */
function findSegments(found: Found, threshold: number, gap: number): Segment[] {
  const limit = threshold * 2
  const gapFrames = Math.round(gap * found.fps)
  const scores = found.scores
  const list: Segment[] = []
  let cur: Segment | null = null
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i]
    if (s < limit) continue
    if (cur && i - cur.last - 1 <= gapFrames) {
      cur.last = i
      if (s > cur.peak) cur.peak = s
    } else {
      cur = { path: found.path, first: i, last: i, fps: found.fps, peak: s }
      list.push(cur)
    }
  }
  return list
}
