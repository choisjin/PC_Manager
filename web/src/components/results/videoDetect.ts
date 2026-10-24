// 영상 분석 판정: ReplayKit_FailAnalyzer의 analyze/video_analysis.py(_Detector) · analyze/blink.py를 옮김.
// 다른 점: 깜박임은 어두워졌다 돌아오는 것만 (원본은 밝게 번쩍이는 것도) · 꺼진 화면은 베젤 대신 기준 밝기(영상에서 가장 어두웠던
// 밝기)와의 차이로 본다 (원본의 화면−베젤 대비 판정에서 베젤 밝기 자리에 기준 밝기).
// 프레임별 밝기(꺼진 화면은 기준 밝기와의 차이) · 윤곽 · 프레임 차이 → 검은 화면 · 깜박임 · 정지 구간 · 화면 전환.
// 앞에서부터 이어 붙는 프레임 열에서 새로 들어온 부분만 판단한다 (Detector.feed — 100시간 영상도 끝까지 같은 속도).
// 기준값(상위 25% 밝기·윤곽, 평소 변화)은 직전 10분 창에서 구해 조명 변화를 따라간다

const REF_WIN_S = 600            // 기준값을 구하는 창 (직전 10분)
const HOLD_S = 2                 // 끝 2초는 다음 조각과 이어서 판단 (깜박임 복귀·경계에 걸친 구간)
const TRANSITION_MERGE_S = 0.5   // 이 간격 안에 이어진 "프레임 차이 큼"은 전환 1건 (애니메이션이 여러 프레임에 걸쳐 찍힘)
const MAX_TRANSITIONS = 20000    // 화면 전환 시점은 이만큼만 목록으로 둔다 (개수는 전부 센다)
const OFF_GRID_ABS = 6           // 꺼진 화면: 윤곽이 가장 많은 칸(8×4)도 이 값 이하 (빈 화면 바닥값 ≈ 3)
const OFF_GRID_REL = 0.15        // …또는 평소(직전 10분 상위 25%)의 15% 이하 중 큰 쪽
const OFF_FLOOR_ABS = 5          // 기준 밝기가 있으면: 꺼진 화면 = 밝기 − 기준 밝기(차이)가 이 값 이하
const OFF_FLOOR_REL = 0.15       // …또는 기준 밝기의 15% 이하
const OFF_FLOOR_ON = 0.2         // …또는 켜진 평소 차이의 20% 이하 중 큰 쪽 (꺼진 패널의 반사광 여유)
const BLANK_SAT_MAX = 40         // 꺼진 화면은 색이 없다: 평균 색의 채도(RGB 최대−최소)가 이보다 크면 검은 화면이 아니다
// 깜박임: 평소 밝기(직전 1초 중앙값)보다 25%(최소 12단계) 이상 어두워졌다가 0.6초 안에 ±10%로 돌아오면.
// 기준 밝기가 있으면 가장 어두운 프레임이 기준 밝기까지 5% 미만(평소 밝기 − 기준 밝기의 5%)으로 내려가야 한다 (잠깐 꺼짐).
// 밝게 번쩍였다 돌아오는 것은 깜박임이 아니다 (프레임 차이가 크면 화면 전환으로 센다)
const BLINK_REL = 0.25
const BLINK_ABS = 12
const BLINK_MAX_S = 0.6
const BLINK_BACK = 0.1
const BLINK_FLOOR = 0.05

export type SegmentKind = 'black_screen' | 'flicker' | 'static'

/** 판정에 쓰는 프레임 열 (앞 n개만 유효) */
export interface FrameArrays {
  n: number
  /** 영상 안 초 */
  t: Float64Array
  /** 화면 밝기 (깜박임은 늘 이것으로) */
  y: Float32Array
  /** 밝기 − 기준 밝기 (0 아래는 0): 있으면 꺼진 화면·기준값을 이것으로 본다 */
  c: Float32Array | null
  /** 윤곽 (화면 평균) */
  e: Float32Array
  /** 직전 프레임과의 차이 */
  d: Float32Array
  /** 윤곽이 가장 많은 칸 (8×4) */
  g: Float32Array | null
  /** 기준 밝기: 꺼진 화면의 밝기 (영상에서 가장 어두웠던 밝기, c와 함께). null이면 평소 밝기의 절반 아래를 어둡다고 본다 (원본의 베젤 없는 판정) */
  floor: number | null
  /** 평균 색 채도 (RGB 최대 − 최소) */
  sat: Uint8Array | null
}

export interface Blink {
  i0: number
  i1: number
  /** 평소 대비 가장 어두워진 정도 (%) */
  depth: number
  /** 원래 밝기로 돌아오기까지 (초) */
  dur: number
  t0: number
}

/** 검은 화면 근거: 기준 밝기와의 차이나 밝기 · 윤곽이 가장 많은 칸(또는 평균 윤곽)의 중앙값과 꺼짐 기준 */
export interface BlackInfo {
  type: 'black_screen'
  /** 기준 밝기와의 차이(중앙값) · 꺼짐 기준 · 기준 밝기 · 켜진 평소 차이 */
  contrast?: { value: number; off: number; floor: number; on: number }
  bright?: { value: number; ref: number }
  grid?: { value: number; off: number }
  edge?: { value: number; ref: number }
}
export interface FlickerInfo {
  type: 'flicker'
  count: number
  depth: number
  dur: number
}
export interface StaticInfo {
  type: 'static'
  seconds: number
}

export interface DetectedSegment {
  kind: SegmentKind
  start: number
  end: number
  dur: number
  info: BlackInfo | FlickerInfo | StaticInfo
}

/** 기준값: 직전 10분의 상위 25% 밝기(기준 밝기와의 차이)·윤곽·칸 윤곽, 평소 변화(프레임 차이 중앙값) */
export interface DetectRef {
  bright: number
  edge: number
  noise: number
  grid?: number
}

export interface DetectResult {
  segments: DetectedSegment[]
  transitions: number[]
  nTransitions: number
  ref: DetectRef | null
  fps: number | null
}

/** Python round(x, digits): 딱 반이면 짝수 쪽 */
export function pyRound(x: number, digits = 0): number {
  const k = 10 ** digits
  const s = x * k
  const r = Math.round(s)
  return (Math.abs(s % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) / k
}

/** t[0..n)에서 x 이상인 첫 위치 */
export function bisectLeft(t: Float64Array, x: number, n: number, lo = 0): number {
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** t[0..n)에서 x보다 큰 첫 위치 */
function bisectRight(t: Float64Array, x: number, n: number): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (t[mid] <= x) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** a[lo:hi:step] (Python 슬라이스) */
function sampled(a: ArrayLike<number>, lo: number, hi: number, step: number): Float64Array {
  const out = new Float64Array(Math.max(0, Math.ceil((hi - lo) / step)))
  for (let i = lo, k = 0; i < hi; i += step, k++) out[k] = a[i]
  return out
}

/** 정렬 후 75% 위치 (비어 있으면 0) — 값을 정렬해 버리므로 복사본으로 */
function q75(v: Float64Array): number {
  if (!v.length) return 0
  v.sort()
  return v[Math.min(v.length - 1, Math.floor(v.length * 0.75))]
}

/** 중앙값 (짝수 개면 가운데 둘의 평균) — 값을 정렬해 버리므로 복사본으로 */
function median(v: Float64Array): number {
  const n = v.length
  v.sort()
  return n % 2 ? v[(n - 1) >> 1] : (v[n / 2 - 1] + v[n / 2]) / 2
}

// 깜박임 판정의 직전 1초 값 (프레임마다 새로 만들지 않게)
let scratch = new Float64Array(256)

/**
 * 평소 밝기(직전 winS초의 중앙값)보다 잠깐 어두워졌다가 돌아오는 구간 (프레임 [a, b)에서, 위치는 그대로).
 * floor(기준 밝기)가 있으면 가장 어두운 프레임이 기준 밝기까지 남은 차이가 평소 차이의 5% 미만이어야 한다.
 * 웹캠 프레임 간격(약 0.13초)보다 짧은 깜박임은 영상에 남지 않을 수 있다
 */
export function blinks(t: Float64Array, y: Float32Array, a: number, b: number, floor: number | null = null, winS = 1): Blink[] {
  const out: Blink[] = []
  let lo = a
  let i = a + 1
  while (i < b - 1) {
    while (t[lo] < t[i] - winS) lo++
    const k = i - lo
    if (k < 2) {
      i++
      continue
    }
    if (scratch.length < k) scratch = new Float64Array(k * 2)
    const prev = scratch.subarray(0, k)
    for (let j = 0; j < k; j++) prev[j] = y[lo + j]
    const base = median(prev)
    // 어두워진 것만 (밝아진 것은 깜박임이 아니다)
    if (base - y[i] < Math.max(BLINK_REL * Math.max(base, 1), BLINK_ABS)) {
      i++
      continue
    }
    const back = Math.max(BLINK_BACK * base, 6)
    let j = i + 1
    while (j < b && t[j] - t[i] <= BLINK_MAX_S && Math.abs(y[j] - base) > back) j++
    if (j < b && t[j] - t[i] <= BLINK_MAX_S) {
      // 가장 어두웠던 프레임
      let low = y[i]
      for (let m = i + 1; m < j; m++) low = Math.min(low, y[m])
      // 기준 밝기 가까이까지 내려가지 않았으면 깜박임이 아니다
      if (floor !== null && low - floor >= BLINK_FLOOR * (base - floor)) {
        i++
        continue
      }
      out.push({
        i0: i, i1: j - 1,
        depth: pyRound(((base - low) / Math.max(base, 1)) * 100), dur: pyRound(t[j] - t[i], 2), t0: t[i],
      })
      i = j + 1
    } else i++
  }
  return out
}

function flickerInfo(group: Blink[]): FlickerInfo {
  return {
    type: 'flicker', count: group.length,
    depth: Math.max(...group.map((b) => b.depth)), dur: Math.max(...group.map((b) => b.dur)),
  }
}

/**
 * 앞에서부터 이어 붙는 프레임 열에서 새로 들어온 부분만 검출한다.
 * 검출 구간은 끝난(닫힌) 순서대로 뒤에 붙기만 한다
 */
export class Detector {
  readonly staticS: number
  /** 판단이 끝난 프레임 수 */
  pos = 0
  dt: number | null = null
  ref: DetectRef | null = null
  segments: DetectedSegment[] = []
  transitions: number[] = []
  nTransitions = 0
  // 마지막으로 크게 바뀐 프레임 시각 (전환 합치기용)
  private trLast: number | null = null
  // 전환 후보는 깜박임 묶음이 확정될 때까지(첫 깜박임 + 3초) 기다렸다가, 묶음 구간 안이면 버린다
  private trPending: number[] = []
  private flSpans: [number, number][] = []
  // [시작, 끝] 이어지는 빈 화면 프레임 · [시작, 끝, 그중 빈 화면 프레임 수] 변화 없는 프레임
  private blank: [number, number] | null = null
  private quiet: [number, number, number] | null = null
  // 아직 안 닫힌 깜박임 묶음 (첫 깜박임부터 3초 안)
  private group: Blink[] = []
  private flick: [number, number][] = []
  private thr: { g: Float32Array | null; floor: number | null; gOff: number; cOff: number } = { g: null, floor: null, gOff: 0, cOff: 0 }

  constructor(staticS: number) {
    this.staticS = staticS
  }

  private seg(f: FrameArrays, kind: SegmentKind, a: number, b: number, info: DetectedSegment['info']) {
    const dt = this.dt || 0.1
    this.segments.push({
      kind, start: pyRound(f.t[a], 2), end: pyRound(f.t[b] + dt, 2), dur: pyRound(f.t[b] - f.t[a] + dt, 2), info,
    })
  }

  private closeGroup(f: FrameArrays) {
    if (!this.group.length) return
    this.seg(f, 'flicker', this.group[0].i0, this.group[this.group.length - 1].i1, flickerInfo(this.group))
    const last = this.segments[this.segments.length - 1]
    this.flSpans.push([last.start, last.end])
    this.group = []
  }

  /** 깜박임 구간 앞뒤 여유: 어두워지는·밝아지는 도중을 반쯤 찍은 프레임 (1~2 프레임) */
  private margin() {
    return Math.max(0.25, 2 * (this.dt || 0.1))
  }

  private flushTransitions(now: number, final: boolean) {
    const m = this.margin()
    const g0 = this.group.length ? this.group[0].t0 : null
    const keep: number[] = []
    for (const x of this.trPending) {
      // 아직 판단 못 함: 최근 4초 안이거나, 열려 있는 깜박임 묶음에 들 수 있음
      if (!final && (now - x < 4 || (g0 !== null && x >= g0 - m))) {
        keep.push(x)
        continue
      }
      // 깜박임 묶음 안(앞뒤 여유 포함) → 전환 아님
      if (this.flSpans.some(([a, b]) => a - m <= x && x <= b + m)) continue
      this.nTransitions++
      if (this.transitions.length < MAX_TRANSITIONS) this.transitions.push(x)
    }
    this.trPending = keep
    this.flSpans = this.flSpans.filter((s) => s[1] >= now - 30)
  }

  private closeBlank(f: FrameArrays, y: Float32Array, e: Float32Array) {
    const [a, b] = this.blank!
    this.blank = null
    const dt = this.dt || 0.1
    // 짧은 빈 화면과 깜박임으로 잡힌 구간은 검은 화면이 아니다
    if (f.t[b] - f.t[a] + dt < 0.3 || this.flick.some(([fa, fb]) => fa <= b && a <= fb)) return
    const med = (arr: ArrayLike<number>) => median(sampled(arr, a, b + 1, 1))
    const th = this.thr
    const ref = this.ref!
    const info: BlackInfo = { type: 'black_screen' }
    if (th.floor !== null) info.contrast = { value: med(y), off: th.cOff, floor: pyRound(th.floor, 1), on: ref.bright }
    else info.bright = { value: med(y), ref: ref.bright }
    if (th.g) info.grid = { value: med(th.g), off: th.gOff }
    else info.edge = { value: med(e), ref: ref.edge }
    this.seg(f, 'black_screen', a, b, info)
  }

  private closeQuiet(f: FrameArrays) {
    const [a, b, nb] = this.quiet!
    this.quiet = null
    const dt = this.dt || 0.1
    const seconds = f.t[b] - f.t[a] + dt
    if (seconds >= this.staticS && nb < b - a + 1) this.seg(f, 'static', a, b, { type: 'static', seconds })
  }

  /**
   * 새로 들어온 프레임까지 판단한다 (끝 HOLD_S초는 다음 조각과 이어서, final이면 끝까지).
   * f.sat: 색이 뚜렷하면 어두워도 켜진 화면 · f.g: 윤곽이 가장 많은 칸 (아이콘·시계만 있는 어두운 테마도 켜진 화면) ·
   * f.floor·f.c: 기준 밝기와 밝기 − 기준 밝기 (있으면 꺼짐 = 기준 밝기에 가까움. 깜박임은 늘 화면 밝기 f.y로 — 꺼진 화면이 없는
   * 영상은 기준 밝기가 평소 밝기라 차이로는 어두워짐이 보이지 않는다)
   */
  feed(f: FrameArrays, final = false) {
    const { n, t, y, e, d, sat } = f
    const floor = f.c ? f.floor : null
    // 꺼진 화면·기준값을 보는 밝기
    const level = floor !== null && f.c ? f.c : y
    if (n < 3) {
      if (final) this.pos = n
      return
    }
    if (this.dt === null || this.pos < 3000) {
      const k = Math.min(n, 3000)
      const gaps = new Float64Array(k - 1)
      for (let i = 0; i < k - 1; i++) gaps[i] = t[i + 1] - t[i]
      this.dt = median(gaps) || 0.1
    }
    const upto = final ? n : bisectLeft(t, t[n - 1] - HOLD_S, n)
    if (upto <= this.pos) return
    // 기준값: 이번에 판단할 부분의 끝 기준 직전 REF_WIN_S초 (표본 최대 2만 개)
    const lo = bisectLeft(t, t[upto - 1] - REF_WIN_S, n)
    const st = Math.max(1, Math.floor((upto - lo) / 20000))
    const py = q75(sampled(level, lo, upto, st))
    const pe = q75(sampled(e, lo, upto, st))
    const noise = sampled(d, Math.max(lo, 1), upto, st)
    const nd = noise.length ? median(noise) : 0
    this.ref = { bright: pyRound(py, 1), edge: pyRound(pe, 2), noise: pyRound(nd, 2) }
    const g = f.g && f.g.length >= upto ? f.g : null
    const pg = g ? q75(sampled(g, lo, upto, st)) : 0
    if (g) this.ref.grid = pyRound(pg, 1)
    this.thr = { g, floor, gOff: Math.max(OFF_GRID_ABS, OFF_GRID_REL * pg), cOff: 0 }
    // 깜박임: 앞 1.2초(평소 밝기) + 뒤 0.8초(복귀 확인)를 붙여 검사하고, 시작이 이번 부분인 것만 쓴다
    const a = bisectLeft(t, t[this.pos] - 1.2, n)
    const b = Math.min(n, bisectRight(t, t[upto - 1] + 0.8, n))
    for (const bl of blinks(t, y, a, b, f.floor)) {
      if (!(this.pos <= bl.i0 && bl.i0 < upto)) continue
      if (this.group.length && bl.t0 - this.group[0].t0 > 3) this.closeGroup(f)
      this.group.push(bl)
      this.flick.push([bl.i0, bl.i1])
    }
    // 빈 화면(밝기·윤곽 모두 크게 낮음 — 어두운 테마는 윤곽이 남아 제외) · 변화 없음 · 화면 전환
    const blankY = 0.5 * py
    const blankE = 0.4 * Math.max(pe, 0.05)
    const gOff = this.thr.gOff
    const cOff = Math.max(OFF_FLOOR_ABS, OFF_FLOOR_REL * (floor ?? 0), OFF_FLOOR_ON * py)
    this.thr.cOff = cOff
    const quiet = Math.max(0.3, 2 * nd)
    const big = Math.max(6, 8 * nd)
    for (let i = this.pos; i < upto; i++) {
      // 꺼진 화면 = ① 밝기가 꺼진 수준 ② 윤곽 없음 ③ 색 없음 — 셋 다 (어둡지만 아이콘·색이 있으면 켜진 화면)
      const dark = floor !== null ? level[i] <= cOff : y[i] < blankY
      const flat = g ? g[i] <= gOff : e[i] < blankE
      const isBlank = dark && flat && (!sat || i >= sat.length || sat[i] <= BLANK_SAT_MAX)
      if (isBlank) {
        if (this.blank) this.blank[1] = i
        else this.blank = [i, i]
      } else if (this.blank) this.closeBlank(f, level, e)
      if (i === 0) continue
      if (d[i] < quiet) {
        if (this.quiet) {
          this.quiet[1] = i
          this.quiet[2] += isBlank ? 1 : 0
        } else this.quiet = [i, i, isBlank ? 1 : 0]
      } else if (this.quiet) this.closeQuiet(f)
      // 깜박임(벗어난 첫 프레임 ~ 돌아온 프레임)의 큰 차이는 전환이 아니다
      if (d[i] > big && !this.flick.some(([f0, f1]) => f0 <= i && i <= f1 + 1)) {
        // 직전 "크게 바뀐 프레임"에서 0.5초 안이면 같은 전환의 이어지는 프레임 → 새로 세지 않음 (시작 시각만 남김)
        if (this.trLast === null || t[i] - this.trLast > TRANSITION_MERGE_S) this.trPending.push(pyRound(t[i], 2))
        this.trLast = t[i]
      }
    }
    this.pos = upto
    if (this.group.length && (final || t[upto - 1] - this.group[0].t0 > 3)) this.closeGroup(f)
    if (final) {
      if (this.blank) this.closeBlank(f, level, e)
      if (this.quiet) this.closeQuiet(f)
    }
    this.flushTransitions(t[upto - 1], final)
    // 지난 깜박임 범위는 버린다 (열린 빈 화면 구간과 겹칠 수 있는 것만 남김)
    const keep = this.blank ? this.blank[0] : upto
    this.flick = this.flick.filter((x) => x[1] >= Math.min(keep, upto) - 2)
  }

  result(): DetectResult {
    return {
      segments: [...this.segments].sort((a, b) => a.start - b.start),
      transitions: this.transitions,
      nTransitions: this.nTransitions,
      ref: this.ref,
      fps: this.dt ? pyRound(1 / this.dt, 1) : null,
    }
  }
}
