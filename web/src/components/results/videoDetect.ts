// 영상 분석 판정: ReplayKit_FailAnalyzer의 analyze/video_analysis.py(_Detector) · analyze/blink.py를 옮김.
// 다른 점: 깜박임은 급격히 꺼졌다가(꺼진 수준까지 어두워졌다가) 2초 안에 다시 켜지는 것 (원본은 0.6초 안에 원래 밝기 ±10%로 돌아오는 것,
// 밝게 번쩍이는 것도) · 꺼진 화면은 베젤 대신 기준 밝기(영상에서 가장 어두웠던 밝기)와의 차이로 본다 (원본의 화면−베젤 대비 판정에서
// 베젤 밝기 자리에 기준 밝기) · 급격히 꺼져 2초 넘게 꺼져 있으면 아이콘·글자 윤곽이 남아도 검은 화면.
// 프레임별 밝기(꺼진 화면은 기준 밝기와의 차이) · 윤곽 · 프레임 차이 → 검은 화면 · 깜박임 · 정지 구간 · 화면 전환.
// 앞에서부터 이어 붙는 프레임 열에서 새로 들어온 부분만 판단한다 (Detector.feed — 100시간 영상도 끝까지 같은 속도).
// 기준값(상위 25% 밝기·윤곽, 평소 변화)은 직전 10분 창에서 구해 조명 변화를 따라간다

const REF_WIN_S = 600            // 기준값을 구하는 창 (직전 10분)
const HOLD_S = 2                 // 끝 2초는 다음 조각과 이어서 판단 (경계에 걸친 구간)
const TRANSITION_MERGE_S = 0.5   // 이 간격 안에 이어진 "프레임 차이 큼"은 전환 1건 (애니메이션이 여러 프레임에 걸쳐 찍힘)
const MAX_TRANSITIONS = 20000    // 화면 전환 시점은 이만큼만 목록으로 둔다 (개수는 전부 센다)
const OFF_GRID_ABS = 6           // 완전히 꺼진 화면: 윤곽이 가장 많은 칸(8×4)도 이 값 이하 (빈 화면 바닥값 ≈ 3)
const OFF_GRID_REL = 0.15        // …또는 평소(직전 10분 상위 25%)의 15% 이하 중 큰 쪽
const OFF_FLOOR_ABS = 5          // 기준 밝기가 있으면: 꺼진 수준 = 밝기 − 기준 밝기(차이)가 이 값 이하
const OFF_FLOOR_REL = 0.15       // …또는 기준 밝기의 15% 이하
const OFF_FLOOR_ON = 0.2         // …또는 켜진 평소 차이의 20% 이하 중 큰 쪽 (꺼진 패널의 반사광 여유)
const BLANK_SAT_MAX = 40         // 꺼진 화면은 색이 없다: 평균 색의 채도(RGB 최대−최소)가 이보다 크면 꺼진 수준이 아니다
/** 검은 화면의 가장 짧은 길이 (초): 더 짧은 빈 화면은 검은 화면이 아니다 (제외 구간으로 잘려 남은 것도 같은 기준) */
export const MIN_BLACK_S = 0.3
// 급격히 꺼짐: 꺼지기 전 밝기(앞 DROP_WIN_S초의 가장 밝은 값)보다 25%(최소 12단계) 넘게 어두워지고 DROP_S초 안에 꺼진 수준까지 내려감.
// 서서히 어두워지는 것은 깜박임이 아니다 (꺼진 채 있으면 완전히 꺼진 부분만 검은 화면)
const DROP_WIN_S = 2
const DROP_S = 0.3
const DROP_REL = 0.25
const DROP_ABS = 12
const DROP_TOL = 1               // 되짚을 때 이만큼 어두워진 것은 잡음으로 (밝기 단계)
// 급격히 꺼졌다가 이 시간 안에 다시 켜지면 깜박임 (돌아온 밝기는 안 따진다), 넘게 꺼져 있으면 검은 화면 (아이콘·글자 윤곽이 남아도).
// 밝게 번쩍였다 돌아오는 것은 깜박임이 아니다 (프레임 차이가 크면 화면 전환으로 센다)
const BLINK_MAX_S = 2
// 첫 깜박임부터 이 간격 안에 이어지는 깜박임은 한 묶음
const BLINK_GROUP_S = 3

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

/** 깜박임 하나: 어두워지기 시작한 프레임(i0) ~ 마지막 꺼진 프레임(i1) */
export interface Blink {
  i0: number
  i1: number
  /** 꺼지기 전 밝기 대비 가장 어두워진 정도 (%) */
  depth: number
  /** 꺼져 있던 시간 (초): 어두워지기 시작해서 다시 켜질 때까지 */
  dur: number
  t0: number
}

/** 검은 화면 근거: 기준 밝기와의 차이나 밝기 · 윤곽이 가장 많은 칸(또는 평균 윤곽)의 중앙값과 꺼짐 기준 */
export interface BlackInfo {
  type: 'black_screen'
  /** 급격히 꺼져 BLINK_MAX_S 넘게 꺼져 있던 것 (완전히 꺼지지 않고 아이콘·글자 윤곽이 남았을 수 있다) */
  sudden?: boolean
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
  // 전환 후보는 깜박임 묶음이 확정될 때까지 기다렸다가, 묶음 구간 안이면 버린다
  private trPending: number[] = []
  private flSpans: [number, number][] = []
  // 꺼진 수준(기준 밝기 가까움·색 없음)이 이어지는 프레임 [a, b]: 급격히 꺼진 것이면 어두워지기 시작한 프레임과 그 전 밝기(drop),
  // 그중 윤곽까지 없는(완전히 꺼진) 프레임이 이어진 조각들(fulls, 아직 이어지는 것은 full)
  private off: { a: number; b: number; drop: { i0: number; base: number } | null; fulls: [number, number][]; full: [number, number] | null } | null = null
  // [시작, 끝, 그중 완전히 꺼진 프레임 수] 변화 없는 프레임
  private quiet: [number, number, number] | null = null
  // 아직 안 닫힌 깜박임 묶음 (첫 깜박임부터 BLINK_GROUP_S초 안에 시작한 것들)
  private group: Blink[] = []
  // 깜박임(어두워지기 시작 ~ 마지막 꺼진 프레임): 그 안과 다시 켜진 프레임의 큰 차이는 전환이 아니다
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
      // 아직 판단 못 함: 최근 4초 안(꺼진 구간이 깜박임이 될 수 있는 동안)이거나, 열려 있는 깜박임 묶음에 들 수 있음
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

  /**
   * a가 급격히 꺼진 첫 프레임인지: 꺼지기 전 밝기(그 전에 켜져 있던 동안 — 최대 DROP_WIN_S초 — 가장 밝은 값)보다 25%(최소 12) 넘게
   * 어두워지기 시작한 지 DROP_S초 안에 꺼진 수준에 들었으면. 맞으면 어두워지기 시작한 프레임(i0)과 꺼지기 전 밝기 (서서히 어두워진 것은 null)
   */
  private dropAt(f: FrameArrays, a: number): { i0: number; base: number } | null {
    const { t, y } = f
    const w = bisectLeft(t, t[a] - DROP_WIN_S, a)
    if (a - 1 < w) return null
    // 켜져 있던 동안의 시작까지 되짚는다: 앞 프레임들이 비슷하거나 더 밝으면(평평하거나 서서히 어두워지는 중) 계속, 더 어두우면(그 전에 켜짐) 멈춤
    let k = a - 1
    while (k - 1 >= w) {
      let before = -Infinity
      for (let j = Math.max(w, k - 3); j < k; j++) if (y[j] > before) before = y[j]
      if (before < y[k] - DROP_TOL) break
      k--
    }
    // 꺼지기 전 밝기 = 그동안 가장 밝은 값
    let base = y[k]
    for (let j = k + 1; j < a; j++) if (y[j] > base) base = y[j]
    const need = Math.max(DROP_REL * base, DROP_ABS)
    if (base - y[a] < need) return null
    // 어두워지기 시작한 프레임 = 마지막으로 꺼지기 전 밝기에서 25% 안에 있던 프레임의 다음. 거기서 꺼진 수준까지 DROP_S초 안이어야 급격
    let s = a - 1
    while (s >= k && base - y[s] >= need) s--
    if (s < k || t[a] - t[s] > DROP_S) return null
    return { i0: s + 1, base }
  }

  /** 검은 화면 [a, b]: 근거는 기준 밝기와의 차이(또는 밝기)·윤곽이 가장 많은 칸(또는 평균 윤곽)의 중앙값과 꺼짐 기준 */
  private black(f: FrameArrays, level: Float32Array, e: Float32Array, a: number, b: number, sudden: boolean) {
    const med = (arr: ArrayLike<number>) => median(sampled(arr, a, b + 1, 1))
    const th = this.thr
    const ref = this.ref!
    const info: BlackInfo = { type: 'black_screen' }
    if (sudden) info.sudden = true
    if (th.floor !== null) info.contrast = { value: med(level), off: th.cOff, floor: pyRound(th.floor, 1), on: ref.bright }
    else info.bright = { value: med(level), ref: ref.bright }
    if (th.g) info.grid = { value: med(th.g), off: th.gOff }
    else info.edge = { value: med(e), ref: ref.edge }
    this.seg(f, 'black_screen', a, b, info)
  }

  /**
   * 꺼진 구간이 끝났다 (cut: 다시 켜진 게 아니라 영상이 끝남). 급격히 꺼졌다 BLINK_MAX_S 안에 다시 켜지면 깜박임, 급격히 꺼져 더 오래
   * 꺼져 있었으면 통째로 검은 화면, 그 밖에는(서서히 꺼짐) 완전히 꺼진(윤곽 없는) 조각만 검은 화면 — 아이콘·글자가 남은 어두운 테마는 켜진 화면
   */
  private closeOff(f: FrameArrays, level: Float32Array, e: Float32Array, cut: boolean) {
    const { a, b, drop, fulls, full } = this.off!
    this.off = null
    if (full) fulls.push(full)
    const dt = this.dt || 0.1
    const dur = f.t[b] - f.t[a] + dt
    if (drop && !cut && dur <= BLINK_MAX_S) {
      let low = f.y[a]
      for (let m = a + 1; m <= b; m++) low = Math.min(low, f.y[m])
      const bl: Blink = {
        i0: drop.i0, i1: b, depth: pyRound(((drop.base - low) / Math.max(drop.base, 1)) * 100),
        dur: pyRound(f.t[b] - f.t[drop.i0] + dt, 2), t0: f.t[drop.i0],
      }
      if (this.group.length && bl.t0 - this.group[0].t0 > BLINK_GROUP_S) this.closeGroup(f)
      this.group.push(bl)
      this.flick.push([bl.i0, b])
      return
    }
    if (drop && dur > BLINK_MAX_S) {
      this.black(f, level, e, a, b, true)
      return
    }
    for (const [s, x] of fulls) if (f.t[x] - f.t[s] + dt >= MIN_BLACK_S) this.black(f, level, e, s, x, false)
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
    // 꺼진 수준(밝기가 꺼진 수준이고 색 없음)이 이어지는 구간 → 깜박임·검은 화면 (closeOff) · 변화 없음 · 화면 전환
    const blankY = 0.5 * py
    const blankE = 0.4 * Math.max(pe, 0.05)
    const gOff = this.thr.gOff
    const cOff = Math.max(OFF_FLOOR_ABS, OFF_FLOOR_REL * (floor ?? 0), OFF_FLOOR_ON * py)
    this.thr.cOff = cOff
    const quiet = Math.max(0.3, 2 * nd)
    const big = Math.max(6, 8 * nd)
    for (let i = this.pos; i < upto; i++) {
      // 꺼진 수준 = ① 밝기가 꺼진 수준 ② 색 없음. ③ 윤곽까지 없으면 완전히 꺼짐 (어둡지만 아이콘·글자가 남으면 켜진 화면 — 급격히 꺼진 것은 예외)
      const dark = floor !== null ? level[i] <= cOff : y[i] < blankY
      const flat = g ? g[i] <= gOff : e[i] < blankE
      const off = dark && (!sat || i >= sat.length || sat[i] <= BLANK_SAT_MAX)
      const isBlank = off && flat
      if (off) {
        const run = (this.off ??= { a: i, b: i, drop: this.dropAt(f, i), fulls: [], full: null })
        run.b = i
        if (flat) {
          if (run.full) run.full[1] = i
          else run.full = [i, i]
        } else if (run.full) {
          run.fulls.push(run.full)
          run.full = null
        }
      } else if (this.off) this.closeOff(f, level, e, false)
      if (i === 0) continue
      if (d[i] < quiet) {
        if (this.quiet) {
          this.quiet[1] = i
          this.quiet[2] += isBlank ? 1 : 0
        } else this.quiet = [i, i, isBlank ? 1 : 0]
      } else if (this.quiet) this.closeQuiet(f)
      // 깜박임(어두워지기 시작 ~ 다시 켜진 프레임)의 큰 차이는 전환이 아니다 (꺼지는 순간의 차이는 묶음이 닫힐 때 뺀다 — flushTransitions)
      if (d[i] > big && !this.flick.some(([f0, f1]) => f0 <= i && i <= f1 + 1)) {
        // 직전 "크게 바뀐 프레임"에서 0.5초 안이면 같은 전환의 이어지는 프레임 → 새로 세지 않음 (시작 시각만 남김)
        if (this.trLast === null || t[i] - this.trLast > TRANSITION_MERGE_S) this.trPending.push(pyRound(t[i], 2))
        this.trLast = t[i]
      }
    }
    this.pos = upto
    if (final) {
      if (this.off) this.closeOff(f, level, e, true)
      if (this.quiet) this.closeQuiet(f)
    }
    // 깜박임 묶음은 첫 깜박임부터 BLINK_GROUP_S초 안에 시작한 깜박임이 다 끝날 수 있을 때(+BLINK_MAX_S) 닫는다
    if (this.group.length && (final || t[upto - 1] - this.group[0].t0 > BLINK_GROUP_S + BLINK_MAX_S)) this.closeGroup(f)
    this.flushTransitions(t[upto - 1], final)
    // 지난 깜박임 범위는 버린다 (열린 꺼진 구간과 겹칠 수 있는 것만 남김)
    const keep = this.off ? this.off.a : upto
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
