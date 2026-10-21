// 결과 확인 탭: PC별로 정해 둔 결과 폴더에서 실행(Result 파일)을 찾고, 고른 실행의 영상·결과 이미지 폴더를 알아서 고른다
//
//   실행 = Result 폴더(하위 폴더까지)의 Result 파일 하나. 시작 시각은 파일·폴더 이름의 날짜·시각, 없으면 수정 시각
//   영상 = 영상 폴더에서 실행 시간(Result 첫 행 ~ 마지막 행)에 걸친 것
//   결과 이미지 폴더 = Result에 적힌 이미지 경로의 폴더 → 이미지 폴더(고정 폴더 / 실행 시각의 날짜 폴더) → Result 옆 폴더
import { api, type FileEntry, type ResultProfile } from '../../api'
import { isImageFile, isVideoFile } from '../../fileTypes'
import { decodeText, detectResultMode, formatWall, parseAts, parseRfw, type ResultMode, timeFromName } from './resultCsv'
import { baseName, dirName, rememberedRefDir, type Source, toMessage } from './resultSessions'
import { wallFromIso } from './sync'

export interface ResultRun {
  path: string
  name: string
  /** 실행 시작 (벽시계 ms): 파일·폴더 이름의 시각, 없으면 수정 시각 */
  time: number
  /** 시각을 어디서 알았는지 */
  timeFrom: 'name' | 'folder' | 'mtime'
  /** 마지막으로 기록한 시각 (수정 시각) */
  modified: number | null
  size: number
  /** YYYY-MM-DD */
  day: string
}

export interface RunScan {
  /** 최신순 */
  runs: ResultRun[]
  truncated: boolean
  scannedAt: number
}

export interface FoundSource {
  source: Source
  /** 찾은 것 설명 (화면에 보여 준다) */
  notes: string[]
}

const DEFAULT_PATTERN = '*.csv'
const VIDEO_EXTS = ['mp4', 'mkv', 'avi', 'mov', 'webm', 'wmv', 'ts']
const MARGIN = 60_000

const pad = (n: number) => String(n).padStart(2, '0')
/** 벽시계 ms → YYYY-MM-DD */
export const dayOf = (ms: number) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}
/** 오늘 (YYYY-MM-DD, 이 PC 기준) */
export const today = () => {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 이름의 날짜·시각: 초까지 있는 것(timeFromName) → 날짜만·시분까지 (2026-10-06-1403, 20261006) */
export function stampFromName(name: string): number | null {
  const full = timeFromName(name)
  if (full !== null) return full
  const m = /(?<!\d)(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_ T]?(\d{2})[-_.:]?(\d{2}))?(?!\d)/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || (h && +h > 23) || (mi && +mi > 59)) return null
  return Date.UTC(+y, +mo - 1, +d, h ? +h : 0, mi ? +mi : 0)
}

const sameDir = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** 실행 시각: 파일 이름 → Result 폴더 아래 폴더 이름(가까운 것부터) → 수정 시각 */
function runTime(entry: FileEntry, root: string): { time: number; from: ResultRun['timeFrom'] } | null {
  const named = stampFromName(entry.name)
  if (named !== null) return { time: named, from: 'name' }
  for (let dir = dirName(entry.fullPath); dir.length > root.length && !sameDir(dir, root); dir = dirName(dir)) {
    const t = stampFromName(baseName(dir))
    if (t !== null) return { time: t, from: 'folder' }
    if (dirName(dir) === dir) break
  }
  const modified = wallFromIso(entry.modifiedAt)
  return modified === null ? null : { time: modified, from: 'mtime' }
}

// ── 실행 목록 (PC마다 기억, '새로 고침'으로 다시)
const scans = new Map<string, { key: string; scan: Promise<RunScan> }>()
const profileKey = (p: ResultProfile) => JSON.stringify([p.resultDir, p.pattern])

export function scanRuns(agentId: string, profile: ResultProfile, refresh = false): Promise<RunScan> {
  const key = profileKey(profile)
  const cached = scans.get(agentId)
  if (cached && cached.key === key && !refresh) return cached.scan
  const scan = (async () => {
    const root = profile.resultDir
    const listing = await api.searchFiles(agentId, root, profile.pattern?.trim() || DEFAULT_PATTERN)
    if (listing.error && listing.entries.length === 0) throw new Error(listing.error)
    const runs: ResultRun[] = []
    for (const e of listing.entries) {
      if (e.isDirectory) continue
      const t = runTime(e, root)
      if (!t) continue
      runs.push({
        path: e.fullPath, name: e.name, time: t.time, timeFrom: t.from,
        modified: wallFromIso(e.modifiedAt), size: e.size, day: dayOf(t.time),
      })
    }
    runs.sort((a, b) => b.time - a.time || (b.modified ?? 0) - (a.modified ?? 0))
    return { runs, truncated: !!listing.truncated, scannedAt: Date.now() }
  })()
  scans.set(agentId, { key, scan })
  // 실패한 건 기억하지 않는다 (다음에 다시)
  scan.catch(() => {
    if (scans.get(agentId)?.scan === scan) scans.delete(agentId)
  })
  return scan
}

/** 기억해 둔 실행 목록 (없으면 null): 화면을 다시 열 때 바로 보여 준다 */
export async function cachedRuns(agentId: string, profile: ResultProfile): Promise<RunScan | null> {
  const cached = scans.get(agentId)
  if (!cached || cached.key !== profileKey(profile)) return null
  return cached.scan.catch(() => null)
}

// ── 고른 실행의 영상·이미지 폴더
interface CsvInfo {
  mode: ResultMode | null
  first: number | null
  last: number | null
  /** Result에 적힌 결과 이미지 경로 (절대 경로) */
  images: string[]
}

async function readCsv(agentId: string, path: string, mode: ResultMode): Promise<CsvInfo> {
  const res = await fetch(api.mediaUrl(agentId, path))
  if (!res.ok) throw new Error(`Result 파일을 읽지 못했습니다 (${res.status}): ${await res.text()}`)
  const text = decodeText(await res.arrayBuffer())
  const detected = detectResultMode(text)
  const parsed = (detected ?? mode) === 'ats' ? parseAts(text) : parseRfw(text)
  const times = parsed.rows.map((r) => r.time).filter((t): t is number => t !== null)
  // 이미지 비교 행의 결과 이미지 (없으면 행에 적힌 이미지 전부)
  const absolute = (p: string | null): p is string => !!p && /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(p)
  const compared = parsed.rows.flatMap((r) => (r.ats ? [r.ats.result, r.ats.diff] : [])).filter(absolute)
  const images = compared.length ? compared : parsed.rows.flatMap((r) => r.images).filter(absolute)
  return {
    mode: detected,
    first: times.length ? Math.min(...times) : null,
    last: times.length ? Math.max(...times) : null,
    images,
  }
}

const list = (agentId: string, dir: string) =>
  api.listFiles(agentId, dir).then((l) => (l.error ? null : l.entries), () => null)
const hasImages = (entries: FileEntry[] | null) => !!entries?.some((e) => !e.isDirectory && isImageFile(e.name))

/** 폴더 안 또는 바로 아래에서 이미지가 든 폴더 (prefer 이름 우선) */
async function imageFolderIn(agentId: string, dir: string, prefer: string[]): Promise<string | null> {
  const entries = await list(agentId, dir)
  if (!entries) return null
  if (hasImages(entries)) return dir
  const subs = entries.filter((e) => e.isDirectory)
  const rank = (e: FileEntry) => {
    const i = prefer.findIndex((p) => p.toLowerCase() === e.name.toLowerCase())
    return i < 0 ? prefer.length : i
  }
  for (const sub of [...subs].sort((a, b) => rank(a) - rank(b)).slice(0, 8)) {
    if (hasImages(await list(agentId, sub.fullPath))) return sub.fullPath
  }
  return null
}

async function findImageDir(agentId: string, profile: ResultProfile, run: ResultRun, csv: CsvInfo, start: number, end: number): Promise<{ dir: string | null; how: string }> {
  const prefer = [run.name.replace(/\.[^.]+$/, ''), 'Image', 'Images', 'image', 'img']
  // 1) Result에 적힌 결과 이미지가 가장 많이 든 폴더
  const counts = new Map<string, number>()
  for (const p of csv.images) counts.set(dirName(p), (counts.get(dirName(p)) ?? 0) + 1)
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([dir]) => dir)
  for (const dir of top) {
    if (hasImages(await list(agentId, dir))) return { dir, how: 'Result에 적힌 이미지 경로' }
  }
  // 1-2) 다른 PC(리눅스 등)에서 적힌 경로: 그 폴더 이름으로 이 PC의 이미지·Result 폴더 아래를 찾는다
  //      …/RVC_Performance_2026-10-01_17_25_06/Image → 'RVC_Performance_2026-10-01_17_25_06' 폴더를 찾아 그 안의 Image
  if (top.length > 0) {
    const parts = top[0].split(/[\\/]/).filter(Boolean)
    const leaf = parts[parts.length - 1] ?? ''
    const generic = parts.length > 1 && /^(?:images?|img|capture[sd]?)$/i.test(leaf)
    const name = generic ? parts[parts.length - 2] : leaf
    for (const root of name ? [profile.imageDir, profile.resultDir] : []) {
      if (!root) continue
      const found = await api.searchFiles(agentId, root, name).catch(() => null)
      for (const e of (found?.entries ?? []).filter((x) => x.isDirectory && x.name.toLowerCase() === name.toLowerCase()).slice(0, 3)) {
        const sep = e.fullPath.includes('\\') ? '\\' : '/'
        const dir = generic ? `${e.fullPath.replace(/[\\/]+$/, '')}${sep}${leaf}` : e.fullPath
        if (hasImages(await list(agentId, dir))) return { dir, how: `Result에 적힌 폴더 이름(${name})` }
      }
    }
  }
  // 2) 이미지 폴더: 바로 이미지가 있으면 고정 폴더, 아니면 실행 시각에 맞는 날짜 폴더
  if (profile.imageDir) {
    const entries = await list(agentId, profile.imageDir)
    if (hasImages(entries)) return { dir: profile.imageDir, how: '이미지 폴더' }
    const dated = (entries ?? [])
      .filter((e) => e.isDirectory)
      .map((e) => ({ e, t: stampFromName(e.name) }))
      .filter((x): x is { e: FileEntry; t: number } => x.t !== null && x.t <= end + MARGIN && dayOf(x.t) === dayOf(start))
      .sort((a, b) => Math.abs(a.t - start) - Math.abs(b.t - start))
    for (const { e } of dated.slice(0, 3)) {
      const dir = await imageFolderIn(agentId, e.fullPath, prefer)
      if (dir) return { dir, how: '이미지 폴더의 날짜 폴더' }
    }
  }
  // 3) Result 파일 옆
  const near = await imageFolderIn(agentId, dirName(run.path), prefer)
  return near ? { dir: near, how: 'Result 파일 옆 폴더' } : { dir: null, how: '' }
}

// 영상 목록은 폴더마다 잠깐 기억한다 (같은 날 실행을 이것저것 고를 때 다시 뒤지지 않게)
const videoLists = new Map<string, { at: number; list: Promise<FileEntry[]> }>()

function listVideos(agentId: string, dir: string, refresh: boolean): Promise<FileEntry[]> {
  const key = `${agentId}|${dir.toLowerCase()}`
  const cached = videoLists.get(key)
  if (cached && !refresh && Date.now() - cached.at < 60_000) return cached.list
  const listP = Promise.all(VIDEO_EXTS.map((ext) => api.searchFiles(agentId, dir, `*.${ext}`).catch(() => null))).then((all) => {
    const ok = all.filter((l) => l !== null)
    if (ok.length === 0 || ok.every((l) => l.error && l.entries.length === 0)) throw new Error(ok.find((l) => l.error)?.error ?? '영상 폴더를 읽지 못했습니다.')
    const seen = new Set<string>()
    return ok.flatMap((l) => l.entries).filter((e) => {
      const k = e.fullPath.toLowerCase()
      // 결과 확인에서 자른 영상(trim_…)은 뺀다
      if (e.isDirectory || !isVideoFile(e.name) || /^trim_/i.test(e.name) || seen.has(k)) return false
      seen.add(k)
      return true
    })
  })
  videoLists.set(key, { at: Date.now(), list: listP })
  listP.catch(() => videoLists.delete(key))
  return listP
}

/** 실행 시간 [start, end]에 걸친 영상. 이름에 시각이 없으면 수정 시각(녹화 끝)이 실행 시작 ~ 실행 끝 2시간 뒤(다음 실행 전)인 것 */
function pickVideos(videos: FileEntry[], start: number, end: number, next: number | null): FileEntry[] {
  const limit = Math.min(next ?? Infinity, end + 2 * 3600_000)
  return videos
    .map((v) => ({ v, from: stampFromName(v.name), to: wallFromIso(v.modifiedAt) }))
    .filter(({ from, to }) => {
      if (from !== null) return from <= end + MARGIN && Math.max(to ?? from, from) >= start - MARGIN
      return to !== null && to >= start - MARGIN && to <= limit
    })
    .sort((a, b) => (a.from ?? a.to ?? 0) - (b.from ?? b.to ?? 0))
    .map(({ v }) => v)
}

/** 고른 실행으로 결과 확인 경로를 채운다 */
export async function buildSource(
  agentId: string, machineName: string, profile: ResultProfile, run: ResultRun, runs: ResultRun[], refresh = false,
): Promise<FoundSource> {
  const notes: string[] = []
  const csv = await readCsv(agentId, run.path, profile.mode)
  const mode = csv.mode ?? profile.mode
  if (csv.mode && csv.mode !== profile.mode) notes.push(`Result 내용이 ${csv.mode.toUpperCase()} 형식이라 그 형식으로 엽니다`)
  // 실행 시간: Result 첫 행 ~ 마지막 행 (없으면 이름 시각 ~ 수정 시각)
  const start = csv.first ?? run.time
  const end = Math.max(csv.last ?? run.modified ?? start, start)
  const next = runs.filter((r) => r.time > run.time && r.path !== run.path).reduce<number | null>((m, r) => (m === null || r.time < m ? r.time : m), null)
  if (csv.first !== null) notes.push(`실행 ${formatWall(start, true).slice(0, 19)} ~ ${dayOf(end) === dayOf(start) ? formatWall(end).slice(0, 8) : formatWall(end, true).slice(0, 19)}`)

  let videoPaths: string[] = []
  if (profile.videoDir) {
    try {
      videoPaths = pickVideos(await listVideos(agentId, profile.videoDir, refresh), start, end, next).map((v) => v.fullPath)
      notes.push(videoPaths.length ? `영상 ${videoPaths.length}개` : '실행 시간에 맞는 영상이 없습니다')
    } catch (err) {
      notes.push(`영상 폴더를 읽지 못했습니다: ${toMessage(err)}`)
    }
  }
  const image = await findImageDir(agentId, profile, run, csv, start, end)
  notes.push(image.dir ? `결과 이미지: ${image.how}` : '결과 이미지 폴더를 찾지 못했습니다')

  return {
    source: {
      mode, agentId, machineName, resultPath: run.path, videoPaths,
      imageDir: image.dir,
      refDir: profile.refDir ?? rememberedRefDir(agentId, mode),
    },
    notes,
  }
}

/** 프로필로 실행을 찾아 경로를 채운다 (결과 확인 탭이 바로 열 때): 그 Result 파일 → 그날 최신 → 가장 최신 */
export async function findRun(
  agentId: string, machineName: string, profile: ResultProfile, want: { path?: string; day?: string | null },
): Promise<FoundSource & { run: ResultRun }> {
  const { runs } = await scanRuns(agentId, profile, true)
  const run = want.path ? runs.find((r) => r.path.toLowerCase() === want.path!.toLowerCase())
    : want.day ? runs.find((r) => r.day === want.day) : runs[0]
  if (!run) {
    throw new Error(want.path ? `Result 파일이 없습니다: ${want.path}`
      : want.day ? `${want.day}에 실행한 결과가 없습니다.` : 'Result 폴더에 결과가 없습니다.')
  }
  return { ...(await buildSource(agentId, machineName, profile, run, runs, true)), run }
}
