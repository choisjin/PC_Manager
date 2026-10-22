import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ImageSearchStatus } from '../../api'
import { toMessage } from './resultSessions'

// 결과 확인: 크롭한 이미지가 영상에 나타나는 구간 찾기
//   1) 영상 위에서 찾을 이미지를 드래그 (지금 프레임에서 회색조로 떼어 냄)
//   2) 검색 영역: 크롭 위치 그대로 · 직접 지정 · 화면 전체
//   3) 테스트 PC 에이전트가 이 실행의 모든 영상을 프레임마다 재 유사도 시계열을 돌려준다
//   4) 유사도 기준 이상이 이어지는 구간마다 첫 프레임만 표시 (기준을 바꾸면 다시 찾지 않고 바로 다시 나눔)

/** 영상 원래 크기 기준 픽셀 */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export type AreaMode = 'same' | 'custom' | 'full'

export interface SearchVideo {
  /** 원래 경로 (영상 목록의 키) */
  path: string
  /** ffmpeg가 읽을 파일 (재생용 사본이 있으면 그것: 브라우저와 같은 시각) */
  readPath: string
  name: string
  duration: number | null
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
 * 오버레이(영상 위 드래그)·패널이 함께 쓰는 상태와 찾기 작업.
 * 패널을 닫아도(스텝 이미지를 보려고) 크롭·결과·진행 중인 찾기는 그대로 두고, 다시 열면 이어서 본다
 */
export function useImageSearch(agentId: string, videos: SearchVideo[]) {
  const [open, setOpen] = useState(false)
  const [template, setTemplate] = useState<Template | null>(null)
  // 드래그해서 정하는 중인 것
  const [drawing, setDrawing] = useState<'template' | 'area' | null>(null)
  const [areaMode, setAreaMode] = useState<AreaMode>('same')
  const [customArea, setCustomArea] = useState<Rect | null>(null)
  const [threshold, setThreshold] = useState(90)
  const [gap, setGap] = useState(0.3)
  const [found, setFound] = useState<Found[]>([])
  const [status, setStatus] = useState<ImageSearchStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const jobRef = useRef<string | null>(null)

  // 결과 화면을 벗어나면 진행 중인 찾기를 멈춘다
  useEffect(() => () => {
    const id = jobRef.current
    jobRef.current = null
    if (id) void api.cancelImageSearch(agentId, id).catch(() => {})
  }, [agentId])

  const start = () => {
    setOpen(true)
    if (!template) setDrawing('template')
  }
  const close = () => {
    setOpen(false)
    setDrawing(null)
  }

  const run = async (area: Rect) => {
    if (!template) return
    if (jobRef.current) void api.cancelImageSearch(agentId, jobRef.current).catch(() => {})
    jobRef.current = null
    setError(null)
    setFound([])
    setStatus(null)
    setRunning(true)
    try {
      const { id } = await api.startImageSearch(agentId, {
        paths: videos.map((v) => v.readPath),
        frameWidth: template.frameWidth,
        frameHeight: template.frameHeight,
        templateWidth: template.rect.w,
        templateHeight: template.rect.h,
        template: toBase64(template.gray),
        searchX: area.x,
        searchY: area.y,
        searchWidth: area.w,
        searchHeight: area.h,
      })
      jobRef.current = id
      const got: Found[] = []
      for (;;) {
        await new Promise((r) => window.setTimeout(r, 1000))
        // 다른 찾기를 시작했거나 결과 화면을 벗어남
        if (jobRef.current !== id) return
        const next = await api.imageSearchStatus(agentId, id, got.length)
        for (const v of next.videos) {
          const video = videos.find((x) => x.readPath === v.path)
          got.push({ path: video?.path ?? v.path, fps: v.fps, scores: fromBase64(v.scores), error: v.error })
        }
        setFound([...got])
        setStatus(next)
        if (next.state !== 'running') {
          if (next.state === 'failed') setError(next.error ?? '찾지 못했습니다')
          break
        }
      }
      jobRef.current = null
      setRunning(false)
    } catch (err) {
      setError(toMessage(err))
      jobRef.current = null
      setRunning(false)
    }
  }

  const stop = () => {
    if (jobRef.current) void api.cancelImageSearch(agentId, jobRef.current).catch(() => {})
  }

  const segments = useMemo(() => found.flatMap((f) => findSegments(f, threshold, gap)), [found, threshold, gap])

  return {
    open, start, close, template, setTemplate, drawing, setDrawing, areaMode, setAreaMode, customArea, setCustomArea,
    threshold, setThreshold, gap, setGap, found, status, error, running, run, stop, segments,
  }
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

/** 기준(%) 이상이 이어지는 구간. 기준 아래로 gap초 이하 끊긴 것은 한 구간으로 */
function findSegments(found: Found, threshold: number, gap: number): Segment[] {
  const limit = threshold * 2
  const gapFrames = Math.round(gap * found.fps)
  const list: Segment[] = []
  let cur: Segment | null = null
  found.scores.forEach((s, i) => {
    if (s < limit) return
    if (cur && i - cur.last - 1 <= gapFrames) {
      cur.last = i
      cur.peak = Math.max(cur.peak, s)
    } else {
      cur = { path: found.path, first: i, last: i, fps: found.fps, peak: s }
      list.push(cur)
    }
  })
  return list
}
