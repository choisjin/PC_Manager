// 결과 확인 세션: 경로를 정하고 '열기'를 누르면 화면을 바로 열고, Result·영상·이미지는 뒤에서 읽으며
// 받는 속도·남은 시간을 보여 준다 (다 되면 알린다). 진행상황(PiP)에서 목록을 보고 서로 오갈 수 있다.
import { useSyncExternalStore } from 'react'
import { api, type FileEntry, type ResultSet, type VideoPrepareProgress } from '../../api'
import { isImageFile, isVideoFile } from '../../fileTypes'
import { type ClipItem, newId } from '../explorer/pcGroups'
import { decodeText, detectResultMode, type ResultMapping, type ResultMode } from './resultCsv'
import { type SyncState, wallFromIso } from './sync'

/** 셋에 저장하는 화면 설정 */
export interface ViewConfig {
  /** 결과 형식 (없으면 예전 셋 = RFW 자동 판별) */
  mode?: ResultMode
  /** ATS 원본 이미지 폴더 (결과 이미지 폴더는 셋의 imageDir) */
  refDir?: string | null
  mapping: Partial<ResultMapping>
  sync: SyncState
  /** 원본 영상 → 재생용 사본 (탐색 색인을 넣거나 변환한 것). 셋에 사본을 백업해 PC가 꺼져 있어도 탐색되게 */
  playPaths?: Record<string, { playPath: string; duration: number | null; fps: number | null }>
}

export interface Source {
  mode: ResultMode
  agentId: string
  machineName: string | null
  resultPath: string
  videoPaths: string[]
  /** 이미지 폴더 (ATS: 결과 이미지 폴더) */
  imageDir: string | null
  /** ATS 원본 이미지 폴더 (captured_image 등) */
  refDir: string | null
}

/** 받는·만드는 중인 것의 진행. rate: 바이트/초 · eta: 남은 초 (최근 변화로 계산, 모르면 null) */
export interface LoadProgress {
  label: string
  /** 0~1 (모르면 null) */
  fraction: number | null
  bytes: number
  total: number | null
  rate: number | null
  eta: number | null
}

/** 바로 재생할 수 없어 변환이 필요한 까닭과 변환 내용 (사용자가 승인해야 변환한다) */
export interface ConvertInfo {
  reason: string | null
  /** 변환이 무엇을 하는지 */
  what: string | null
  transcode: boolean
  sourceBytes: number | null
  cacheDrive: string | null
  cacheFreeBytes: number | null
}

export interface RawVideo {
  path: string
  name: string
  duration: number | null
  modified: number | null
  size: number | null
  metaStarted: string | null
  /** 브라우저가 재생할 파일 (원본 또는 재생용 사본) */
  playPath: string | null
  fps: number | null
  /** waiting: 앞 영상 준비를 기다림 · checking: 길이·형식 확인 중 · needs-convert: 바로 재생할 수 없어 변환 승인을 기다림 ·
   *  converting: 재생용 사본 만드는 중 · ready · failed */
  prep: 'waiting' | 'checking' | 'needs-convert' | 'converting' | 'ready' | 'failed'
  prepNote: string | null
  /** needs-convert일 때 까닭·변환 내용 */
  convert: ConvertInfo | null
  /** 사본 만드는·ffmpeg 받는 진행 */
  progress: LoadProgress | null
}

export interface ResultSession {
  id: string
  source: Source
  set: ResultSet | null
  /** 열 지정·동기화 보정 (셋에서 불러오거나 화면에서 바꾼 것) */
  config: Partial<ViewConfig> | null
  state: 'loading' | 'ready' | 'failed'
  error: string | null
  rawText: string | null
  videos: RawVideo[]
  images: FileEntry[]
  refImages: FileEntry[]
  /** 진행: 끝난 일 / 전체 일 · 지금 하는 일 · 지금 받는·만드는 것의 속도·남은 시간 */
  done: number
  total: number
  step: string
  progress: LoadProgress | null
  startedAt: number
  readyAt: number | null
  /** 한 번이라도 열어 봤는지 (불러오는 중에도 바로 열 수 있다) */
  opened: boolean
}

/** 경로 지정 창 (떠 있는 작은 창, 탐색기에서 끌어다 놓는다) */
export interface SetupState {
  key: number
  source: Source
  /** '경로 수정'으로 열었으면 열기 때 이 세션을 바꾼다 */
  replaceId: string | null
}

export interface Toast {
  id: string
  sessionId: string
  text: string
  failed: boolean
}

interface State {
  sessions: ResultSession[]
  activeId: string | null
  setup: SetupState | null
  setsOpen: boolean
  toasts: Toast[]
}

let state: State = { sessions: [], activeId: null, setup: null, setsOpen: false, toasts: [] }
const listeners = new Set<() => void>()
const emit = (next: Partial<State>) => {
  state = { ...state, ...next }
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useResults(): State {
  return useSyncExternalStore(subscribe, () => state)
}

export const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
export const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
export const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
export const sessionTitle = (s: ResultSession) => s.set?.name ?? baseName(s.source.resultPath)

export const newRawVideo = (p: string): RawVideo => ({
  path: p, name: baseName(p), duration: null, modified: null, size: null, metaStarted: null,
  playPath: null, fps: null, prep: 'waiting', prepNote: null, progress: null, convert: null,
})

/** 셋에 백업된 파일이면 서버에서, 아니면 테스트 PC에서 바로 */
export const sessionFileUrl = (set: ResultSet | null, agentId: string, path: string) =>
  set && set.files[path] ? api.resultSetFileUrl(set.id, path) : api.mediaUrl(agentId, path)

const find = (id: string) => state.sessions.find((s) => s.id === id)
const patch = (id: string, p: Partial<ResultSession> | ((s: ResultSession) => Partial<ResultSession>)) =>
  emit({ sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...(typeof p === 'function' ? p(s) : p) } : s)) })

// ── 경로 지정 창
const RESULT_EXT = /\.(csv|tsv|txt|log|json)$/i

// 원본 이미지 폴더는 PC·형식(ATS·RFW)마다 마지막으로 쓴 경로를 기억해 다음에 미리 채운다
const REF_DIR_KEY = 'results.refDir'
const refDirKey = (agentId: string, mode: ResultMode) => `${agentId}|${mode}`
const readRefDirs = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(REF_DIR_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}
export const rememberedRefDir = (agentId: string, mode: ResultMode): string | null =>
  readRefDirs()[refDirKey(agentId, mode)] ?? null
export function rememberRefDir(agentId: string, mode: ResultMode, dir: string | null) {
  if (!dir) return
  try {
    localStorage.setItem(REF_DIR_KEY, JSON.stringify({ ...readRefDirs(), [refDirKey(agentId, mode)]: dir }))
  } catch {
    // 저장이 막힌 브라우저면 기억만 못 한다
  }
}

/** 탐색기 '결과 확인' 버튼: 고른 항목을 확장자로 나눠 넣고 경로 지정 창을 연다 */
export function openResultSetup(agentId: string, machineName: string, items: ClipItem[]) {
  const refDir = rememberedRefDir(agentId, 'ats')
  openSetup(autoAssign({ mode: 'ats', agentId, machineName, resultPath: '', videoPaths: [], imageDir: null, refDir }, items))
}

/** 항목들을 확장자로 나눠 넣는다 (Result 파일·영상·폴더) */
export function autoAssign(source: Source, items: ClipItem[]): Source {
  const result = items.find((i) => !i.isDir && RESULT_EXT.test(i.name))
  const videos = items.filter((i) => !i.isDir && isVideoFile(i.name)).map((i) => i.path)
  const dir = items.find((i) => i.isDir)?.path
  return {
    ...source,
    resultPath: result?.path ?? source.resultPath,
    videoPaths: [...source.videoPaths, ...videos.filter((v) => !source.videoPaths.includes(v))],
    imageDir: dir ?? source.imageDir,
  }
}

let setupKey = 0
export function openSetup(source: Source, replaceId: string | null = null) {
  emit({ setup: { key: ++setupKey, source, replaceId } })
}
export const closeSetup = () => emit({ setup: null })
export const openSets = () => emit({ setsOpen: true })
export const closeSets = () => emit({ setsOpen: false })

// ── 세션
export function startSession(source: Source, set: ResultSet | null = null, replaceId: string | null = null): string {
  const id = newId()
  const config = (set?.config ?? null) as Partial<ViewConfig> | null
  const session: ResultSession = {
    id, source, set, config, state: 'loading', error: null, rawText: null,
    videos: source.videoPaths.map(newRawVideo), images: [], refImages: [],
    done: 0, total: 1 + source.videoPaths.length + (source.imageDir ? 1 : 0) + (source.refDir ? 1 : 0),
    step: '준비 중', progress: null, startedAt: Date.now(), readyAt: null, opened: false,
  }
  const sessions = replaceId ? state.sessions.filter((s) => s.id !== replaceId) : state.sessions
  emit({
    sessions: [session, ...sessions],
    activeId: replaceId && state.activeId === replaceId ? null : state.activeId,
  })
  void load(id)
  return id
}

export function removeSession(id: string) {
  emit({
    sessions: state.sessions.filter((s) => s.id !== id),
    activeId: state.activeId === id ? null : state.activeId,
    toasts: state.toasts.filter((t) => t.sessionId !== id),
  })
}

/** 결과 화면 열기: 불러오는 중이어도 연다 (Result·영상은 오는 대로 채운다) */
export function openViewer(id: string) {
  const s = find(id)
  if (!s || s.state === 'failed') return
  patch(id, { opened: true })
  emit({ activeId: id, toasts: state.toasts.filter((t) => t.sessionId !== id) })
}
export const closeViewer = () => emit({ activeId: null })
export const dismissToast = (id: string) => emit({ toasts: state.toasts.filter((t) => t.id !== id) })

export const setSessionSet = (id: string, set: ResultSet) => patch(id, { set })
export const saveSessionConfig = (id: string, config: Partial<ViewConfig>) =>
  patch(id, (s) => ({ config: { ...s.config, ...config } }))
export const updateSessionVideo = (id: string, path: string, p: Partial<RawVideo>) =>
  patch(id, (s) => ({ videos: s.videos.map((v) => (v.path === path ? { ...v, ...p } : v)) }))

/** 자른 영상 등 영상 하나 더 (불러온 뒤 목록에) */
export function addSessionVideo(id: string, path: string) {
  const s = find(id)
  if (!s || s.source.videoPaths.includes(path)) return
  patch(id, {
    source: { ...s.source, videoPaths: [...s.source.videoPaths, path] },
    videos: [...s.videos, newRawVideo(path)],
  })
  void loadVideo(id, path)
}

// ── 불러오기
const step = (id: string, text: string) => patch(id, { step: text })
const tick = (id: string) => patch(id, (s) => ({ done: s.done + 1 }))

/** 속도(바이트/초)·남은 시간: 0.5초 넘게 떨어진 두 표본의 순간 속도를 지수 평활 (처음에는 평균 속도) */
class RateMeter {
  private last: { at: number; bytes: number } | null = null
  private rate: number | null = null

  measure(bytes: number, total: number | null, average: number | null = null): { rate: number | null; eta: number | null } {
    const now = performance.now()
    if (!this.last) this.last = { at: now, bytes }
    else if (now - this.last.at >= 500) {
      const r = ((bytes - this.last.bytes) * 1000) / (now - this.last.at)
      this.rate = this.rate === null ? r : this.rate * 0.6 + r * 0.4
      this.last = { at: now, bytes }
    }
    const rate = this.rate ?? average
    return { rate, eta: rate && rate > 0 && total ? Math.max(0, (total - bytes) / rate) : null }
  }
}

/** 응답 본문을 받으며 진행을 알린다 (0.25초마다, 마지막에 한 번 더) */
async function readWithProgress(res: Response, report: (bytes: number, total: number | null) => void): Promise<ArrayBuffer> {
  const total = Number(res.headers.get('Content-Length')) || null
  if (!res.body) return res.arrayBuffer()
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let bytes = 0
  let reported = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    bytes += value.length
    if (performance.now() - reported >= 250) {
      reported = performance.now()
      report(bytes, total)
    }
  }
  report(bytes, total)
  const all = new Uint8Array(bytes)
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all.buffer
}

const PREPARE_LABEL: Record<VideoPrepareProgress['stage'], string> = {
  ffmpeg: '테스트 PC가 서버에서 ffmpeg 받는 중 (처음 한 번)',
  convert: '재생용 영상 만드는 중',
}

/** 재생 준비 진행을 1초마다 물어 영상·세션에 적는다. 옛 에이전트(진행을 모름)면 조용히 그만둔다. 돌려준 함수로 멈춤 */
function watchPrepare(id: string, agentId: string, path: string): () => void {
  let stopped = false
  let stage: string | null = null
  let meter = new RateMeter()
  void (async () => {
    while (!stopped) {
      await new Promise((r) => window.setTimeout(r, 1000))
      if (stopped || !find(id)) return
      let p: VideoPrepareProgress | undefined
      try {
        p = await api.prepareProgress(agentId, path)
      } catch {
        return
      }
      if (stopped || !p) continue
      if (p.stage !== stage) {
        stage = p.stage
        meter = new RateMeter()
      }
      const total = p.totalBytes || null
      const progress: LoadProgress = {
        label: PREPARE_LABEL[p.stage] ?? p.stage, fraction: p.fraction, bytes: p.bytes, total,
        ...meter.measure(p.bytes, total, p.elapsedSeconds > 1 ? p.bytes / p.elapsedSeconds : null),
      }
      updateSessionVideo(id, path, { progress })
      patch(id, { progress })
    }
  })()
  return () => {
    stopped = true
    updateSessionVideo(id, path, { progress: null })
    patch(id, { progress: null })
  }
}

async function load(id: string) {
  const s = find(id)
  if (!s) return
  const { source, set } = s
  try {
    // Result·이미지 폴더는 함께, 영상은 테스트 PC에서 변환할 수 있어 하나씩
    step(id, 'Result 읽는 중')
    const csv = (async () => {
      const res = await fetch(sessionFileUrl(set, source.agentId, source.resultPath))
      if (!res.ok) throw new Error(`Result 파일을 읽지 못했습니다 (${res.status}): ${await res.text()}`)
      const meter = new RateMeter()
      const buffer = await readWithProgress(res, (bytes, total) => patch(id, {
        progress: { label: 'Result 받는 중', fraction: total ? bytes / total : null, bytes, total, ...meter.measure(bytes, total) },
      }))
      patch(id, { progress: null })
      const text = decodeText(buffer)
      // 고른 형식과 파일 내용이 다르면 내용을 따른다 (ATS로 두고 RFW 결과를 연 경우 등)
      const mode = detectResultMode(text)
      patch(id, (cur) => ({ rawText: text, source: mode && mode !== cur.source.mode ? { ...cur.source, mode } : cur.source }))
      tick(id)
    })()
    const folders = (async () => {
      if (source.imageDir) {
        const images = await listImages(source.agentId, source.imageDir, set)
        patch(id, { images })
        tick(id)
      }
      if (source.refDir) {
        const refImages = await listImages(source.agentId, source.refDir, set)
        patch(id, { refImages })
        tick(id)
      }
    })()
    await csv
    await folders
    for (const [i, v] of source.videoPaths.entries()) {
      if (!find(id)) return
      step(id, `영상 준비 중 (${i + 1}/${source.videoPaths.length}) · ${baseName(v)}`)
      await loadVideo(id, v)
      tick(id)
    }
    if (!find(id)) return
    patch(id, { state: 'ready', step: '완료', readyAt: Date.now() })
    announce(id, false)
  } catch (err) {
    if (!find(id)) return
    patch(id, { state: 'failed', error: toMessage(err), step: '실패' })
    announce(id, true)
  }
}

/** 영상 하나: 수정 시각·크기, 메타(started_at), 길이·fps·형식 → 탐색이 안 되면 재생용 사본까지 만든다 */
async function loadVideo(id: string, v: string) {
  const s = find(id)
  if (!s) return
  const { agentId } = s.source
  const update = (p: Partial<RawVideo>) => updateSessionVideo(id, v, p)
  update({ prep: 'checking' })

  const info = api.listFiles(agentId, dirName(v)).then(
    async (l) => {
      const entry = l.entries.find((e) => e.fullPath === v || e.name === baseName(v))
      if (entry) update({ modified: wallFromIso(entry.modifiedAt), size: entry.size })
      // 녹화 시작 시각 사이드카 (ReplayKit: 영상.meta.json) — 있을 때만 읽는다
      const metaName = `${baseName(v)}.meta.json`.toLowerCase()
      if (!l.entries.some((e) => e.name.toLowerCase() === metaName)) return
      const res = await fetch(api.mediaUrl(agentId, `${v}.meta.json`))
      const meta = res.ok ? ((await res.json()) as { started_at?: string }) : null
      if (meta?.started_at) update({ metaStarted: meta.started_at })
    },
    () => {},
  ).catch(() => {})

  // 브라우저가 그대로 재생할 수 있으면 원본, 아니면 까닭을 보여 주고 사용자가 승인해야 변환한다 (처음이면 테스트 PC가 ffmpeg를 받는 진행도)
  const stopWatch = watchPrepare(id, agentId, v)
  try {
    const r = await api.prepareVideo(agentId, v, false)
    stopWatch()
    const saved = (s.config?.playPaths ?? {})[v]
    if (r.playPath) update({ playPath: r.playPath, duration: r.duration, fps: r.fps, prep: 'ready', prepNote: r.note })
    else if (r.needsConvert && saved && s.set?.files[saved.playPath]) {
      // 셋에 백업해 둔 재생용 사본이 있으면 그걸로 (다시 변환하지 않는다)
      update({ playPath: saved.playPath, duration: saved.duration, fps: saved.fps, prep: 'ready' })
    } else if (r.needsConvert) {
      update({
        duration: r.duration, fps: r.fps, prep: 'needs-convert', prepNote: r.note,
        convert: {
          reason: r.reason ?? null, what: r.note, transcode: r.transcode ?? false, sourceBytes: r.sourceBytes || null,
          cacheDrive: r.cacheDrive ?? null, cacheFreeBytes: r.cacheFreeBytes || null,
        },
      })
    } else update({ prep: 'failed', prepNote: r.error ?? r.note })
  } catch (err) {
    stopWatch()
    // PC가 꺼졌거나 옛 에이전트: 셋에 백업한 재생용 사본 → 원본을 브라우저가 읽는 만큼
    const saved = (s.config?.playPaths ?? {})[v]
    if (saved && s.set?.files[saved.playPath]) {
      update({ playPath: saved.playPath, duration: saved.duration, fps: saved.fps, prep: 'ready' })
    } else {
      // 원본 그대로 재생: 길이·탐색 색인이 없는 영상(mkv·webm 등)은 위치가 어긋날 수 있어 알린다
      update({ playPath: v, prep: 'ready', prepNote: `재생용 영상을 준비하지 못해 원본을 그대로 재생합니다 (${toMessage(err)})` })
      const duration = await probeDuration(sessionFileUrl(s.set, agentId, v))
      if (duration !== null) update({ duration })
    }
  }
  await info
}

/** 사용자가 승인한 변환: 재생용 사본을 만들며 진행(속도·남은 시간)을 보여 준다 */
export async function convertVideo(id: string, v: string) {
  const s = find(id)
  if (!s) return
  const { agentId } = s.source
  const update = (p: Partial<RawVideo>) => updateSessionVideo(id, v, p)
  update({ prep: 'converting' })
  const stopWatch = watchPrepare(id, agentId, v)
  try {
    const r = await api.prepareVideo(agentId, v, true)
    stopWatch()
    update(r.playPath
      ? { playPath: r.playPath, duration: r.duration, fps: r.fps, prep: 'ready', prepNote: r.note, convert: null }
      : { prep: 'failed', prepNote: r.error ?? r.note })
  } catch (err) {
    stopWatch()
    update({ prep: 'failed', prepNote: toMessage(err) })
  }
}

export const ORIGINAL_NOTE = '변환하지 않고 원본을 그대로 재생합니다 — 원하는 위치로 이동이 느리거나 안 될 수 있습니다'

/** 변환하지 않고 원본을 그대로 재생 (이동이 느리거나 안 될 수 있다) */
export function playOriginal(id: string, v: string) {
  const s = find(id)
  if (!s) return
  updateSessionVideo(id, v, { playPath: v, prep: 'ready', convert: null, prepNote: ORIGINAL_NOTE })
}

function probeDuration(url: string): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = document.createElement('video')
    let finished = false
    const finish = (d: number | null) => {
      if (finished) return
      finished = true
      probe.removeAttribute('src')
      probe.load()
      resolve(d)
    }
    probe.preload = 'metadata'
    probe.muted = true
    probe.onloadedmetadata = () => finish(Number.isFinite(probe.duration) ? probe.duration : null)
    probe.onerror = () => finish(null)
    window.setTimeout(() => finish(null), 15_000)
    probe.src = url
  })
}

/** 폴더의 이미지 목록 (테스트 PC가 꺼져 있으면 셋에 백업된 목록) */
async function listImages(agentId: string, dir: string, set: ResultSet | null): Promise<FileEntry[]> {
  try {
    const l = await api.listFiles(agentId, dir)
    if (l.error) throw new Error(l.error)
    return l.entries.filter((e) => !e.isDirectory && isImageFile(e.name))
  } catch {
    if (!set) return []
    const lower = dir.toLowerCase()
    return Object.keys(set.files).filter((p) => p.toLowerCase().startsWith(lower) && isImageFile(p))
      .map((p) => ({ name: baseName(p), fullPath: p, isDirectory: false, size: 0, modifiedAt: null }))
  }
}

// ── 알림: 화면 안 알림 + (창이 뒤에 있으면) 윈도우 알림 + 짧은 소리
let audioCtx: AudioContext | null = null
function beep() {
  try {
    audioCtx ??= new AudioContext()
    const o = audioCtx.createOscillator()
    const g = audioCtx.createGain()
    o.frequency.value = 660
    g.gain.value = 0.08
    o.connect(g).connect(audioCtx.destination)
    o.start()
    o.stop(audioCtx.currentTime + 0.2)
  } catch {
    // 소리 못 내면 무시
  }
}

function announce(id: string, failed: boolean) {
  const s = find(id)
  if (!s) return
  const title = sessionTitle(s)
  const text = failed ? `결과 확인 불러오기 실패 · ${title}` : `결과 확인 준비 완료 · ${title}`
  const toast: Toast = { id: newId(), sessionId: id, text, failed }
  emit({ toasts: [...state.toasts.filter((t) => t.sessionId !== id), toast] })
  window.setTimeout(() => dismissToast(toast.id), 12_000)
  beep()
  if ((document.hidden || !document.hasFocus()) && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(text, { body: s.source.machineName ?? '', tag: `pcm-result-${id}`, silent: true })
      n.onclick = () => {
        window.focus()
        if (!failed) openViewer(id)
        n.close()
      }
    } catch {
      // 알림 못 띄우면 무시
    }
  }
}
