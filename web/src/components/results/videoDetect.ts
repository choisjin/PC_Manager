// 영상 분석 판정: ReplayKit_FailAnalyzer의 analyze/video_analysis.py(_Detector) · analyze/blink.py를 옮김.
// 다른 점: 꺼짐(깜박임·검은 화면)은 1차 밝기(기준 밝기 — 영상에서 가장 어두웠던 밝기 — 가까이까지 떨어지고 색 없음) → 2차 윤곽(윤곽이
// 꺼지기 전의 절반 아래로 줄었거나 완전히 꺼진 수준) → 길이로 나눈다: 급격히 꺼졌다 2초 안에 다시 켜지면 깜박임, 2초 넘게 꺼져 있으면
// 검은 화면 (원본은 깜박임 = 0.6초 안에 원래 밝기 ±10%로 돌아옴·밝게 번쩍임도, 검은 화면 = 베젤 대비·윤곽 없음 0.3초 이상).
// 프레임별 밝기(꺼진 화면은 기준 밝기와의 차이) · 윤곽 · 프레임 차이 → 검은 화면 · 깜박임 · 정지 구간 · 화면 전환.
// 앞에서부터 이어 붙는 프레임 열에서 새로 들어온 부분만 판단한다 (Detector.feed — 100시간 영상도 끝까지 같은 속도).
// 기준값(상위 25% 밝기·윤곽, 평소 변화)은 직전 10분 창에서 구해 조명 변화를 따라간다

const REF_WIN_S = 600            // 기준값을 구하는 창 (직전 10분)
const HOLD_S = 2                 // 끝 2초는 다음 조각과 이어서 판단 (경계에 걸친 구간)
const TRANSITION_MERGE_S = 0.5   // 이 간격 안에 이어진 "프레임 차이 큼"은 전환 1건 (애니메이션이 여러 프레임에 걸쳐 찍힘)
const MAX_TRANSITIONS = 20000    // 화면 전환 시점은 이만큼만 목록으로 둔다 (개수는 전부 센다)
const OFF_GRID_ABS = 6           // 완전히 꺼진 화면: 윤곽이 가장 많은 칸(8×4)도 이 값 이하 (빈 화면 바닥값 ≈ 3)
const OFF_GRID_REL = 0.15        // …또는 평소(직전 10분 상위 25%)의 15% 이하 중 큰 쪽
const OFF_FLOOR_ABS = 5          // 1차 밝기 — 기준 밝기가 있으면: 꺼진 수준 = 밝기 − 기준 밝기(차이)가 이 값 이하
const OFF_FLOOR_REL = 0.15       // …또는 기준 밝기의 15% 이하
const OFF_FLOOR_ON = 0.2         // …또는 켜진 평소 차이의 20% 이하 중 큰 쪽 (꺼진 패널의 반사광 여유)
const BLANK_SAT_MAX = 40         // 꺼진 화면은 색이 없다: 평균 색의 채도(RGB 최대−최소)가 이보다 크면 꺼진 수준이 아니다
// 2차 윤곽: 꺼진 동안 윤곽이 꺼지기 전(어두워지기 전 최대 LIT_EDGE_S초) 윤곽의 이 비율 이하 (완전히 꺼진 수준 이하면 늘 통과).
// 밝기만 꺼진 수준인 어두운 테마·로고 화면은 윤곽이 남거나 늘어 꺼짐이 아니다 (시험 영상: 실제 꺼짐 33% 이하, 어두운 로고 화면 130%)
const OFF_EDGE_REL = 0.5
const LIT_EDGE_S = 1
/** 제외 구간으로 잘려 남은 검은 화면 조각의 가장 짧은 길이 (초): 더 짧으면 버린다 */
export const MIN_BLACK_S = 0.3
// 급격히 꺼짐: 떨어지는 구간(꺼지기 직전 RAMP_WIN_S초 ~ 직후에서 가장 크게 떨어진 프레임을 가운데로, 그 RAMP_REL배 넘게 떨어진 프레임이
// 이어진 곳 — 한 프레임 멈칫한 것은 이어 봄)이 RAMP_S초 안이고 그동안 (켜져 있던 동안 — 최대 DROP_WIN_S초 — 가장 밝은 값의 25%, 최소 12단계)
// 넘게 떨어짐. 그 전에 서서히 어두워지던 것은 세지 않는다 (빛 번짐이 줄며 어두워지다 끊기듯 꺼진 것도 급격). 고르게 조금씩 어두워진 화면
// 페이드는 0.2초 남짓이어도 서서히 (시험 영상: 실제 깜박임·꺼짐 18건 모두 0.1초 안, 1:34.6 페이드는 8프레임 0.27초)
const DROP_WIN_S = 2
const RAMP_WIN_S = 0.3
const RAMP_S = 0.15
const RAMP_REL = 0.25
const DROP_REL = 0.25
const DROP_ABS = 12
const DROP_TOL = 1               // 되짚을 때 이만큼 어두워진 것은 잡음으로 (밝기 단계)
// 급격히 꺼졌다가 이 시간 안에 다시 켜지면 깜박임 (돌아온 밝기는 안 따진다), 넘게 꺼져 있으면 급격·서서히 모두 검은 화면.
// 서서히 꺼졌다 이 시간 안에 켜진 것은 어느 쪽도 아니다. 밝게 번쩍였다 돌아오는 것은 깜박임이 아니다 (프레임 차이가 크면 화면 전환으로 센다)
const BLINK_MAX_S = 2
// 첫 깜박임부터 이 간격 안에 이어지는 깜박임은 한 묶음
const BLINK_GROUP_S = 3
// 화면 전환: 프레임 차이가 평소 변화의 이 배(최소 이 값) 넘게 튐
const TRANSITION_X = 8
const TRANSITION_MIN = 6

/**
 * 판정 기준값 (프로젝트별로 바꾼다 — analysisDefaults.DetectParams와 같은 이름). 비율은 %.
 * 위 상수가 기본값이고, 이름이 없는 상수(잡음·여유 등)는 바꾸지 않는다
 */
export interface DetectorParams {
  blinkMaxS: number
  rampS: number
  dropPct: number
  dropAbs: number
  offAbs: number
  offOnPct: number
  edgeOffPct: number
  satMax: number
  blinkGroupS: number
  transitionX: number
  transitionMin: number
  transitionMergeS: number
}
export const DETECTOR_DEFAULTS: DetectorParams = {
  blinkMaxS: BLINK_MAX_S, rampS: RAMP_S, dropPct: DROP_REL * 100, dropAbs: DROP_ABS, offAbs: OFF_FLOOR_ABS, offOnPct: OFF_FLOOR_ON * 100,
  edgeOffPct: OFF_EDGE_REL * 100, satMax: BLANK_SAT_MAX, blinkGroupS: BLINK_GROUP_S, transitionX: TRANSITION_X, transitionMin: TRANSITION_MIN,
  transitionMergeS: TRANSITION_MERGE_S,
}

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
  /** 급격히 꺼짐 (떨어지는 구간이 RAMP_S초 안) */
  sudden?: boolean
  /** 기준 밝기와의 차이(중앙값) · 꺼짐 기준 · 기준 밝기 · 켜진 평소 차이 */
  contrast?: { value: number; off: number; floor: number; on: number }
  bright?: { value: number; ref: number }
  /** 윤곽이 가장 많은 칸 (중앙값) · 꺼짐 기준(2차 윤곽) · 완전히 꺼진 기준 · 꺼지기 전 윤곽 (모르면 없음) */
  grid?: { value: number; off: number; full: number; lit?: number }
  /** 평균 윤곽 (칸 윤곽을 모르는 옛 에이전트): 중앙값 · 평소 · 꺼짐 기준 · 완전히 꺼진 기준 · 꺼지기 전 윤곽 */
  edge?: { value: number; ref: number; off: number; full: number; lit?: number }
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

/** 꺼진 구간 앞: 켜져 있던 동안의 시작(k)·가장 밝은 값(base), 어두워지기 시작한 프레임(i0), 급격히 꺼졌는지 */
interface Onset {
  k: number
  base: number
  i0: number
  sudden: boolean
}

/**
 * 꺼진 구간 [a, b]: 1차 밝기(꺼진 수준·색 없음)와 2차 윤곽(edgeOff 이하)을 통과한 프레임이 이어짐.
 * on: 꺼지기 전 (영상 첫머리부터 꺼져 있으면 null) · lit: 꺼지기 전 윤곽 (모르면 null)
 */
interface OffRun {
  a: number
  b: number
  on: Onset | null
  edgeOff: number
  lit: number | null
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
  /** 기준값 (안 준 것은 기본값) */
  readonly p: DetectorParams
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
  // 이어지는 꺼진 구간 (OffRun)
  private off: OffRun | null = null
  // [시작, 끝, 그중 꺼진 프레임 수] 변화 없는 프레임
  private quiet: [number, number, number] | null = null
  // 아직 안 닫힌 깜박임 묶음 (첫 깜박임부터 묶음 시간(p.blinkGroupS) 안에 시작한 것들)
  private group: Blink[] = []
  // 깜박임(어두워지기 시작 ~ 마지막 꺼진 프레임): 그 안과 다시 켜진 프레임의 큰 차이는 전환이 아니다
  private flick: [number, number][] = []
  // 이번 조각의 기준: 칸 윤곽 · 기준 밝기 · 완전히 꺼진 칸 윤곽 · 꺼진 수준(1차 밝기) · 2차 윤곽의 완전히 꺼진 기준 (칸 윤곽 또는 평균 윤곽)
  private thr: { g: Float32Array | null; floor: number | null; gOff: number; cOff: number; full: number } = { g: null, floor: null, gOff: 0, cOff: 0, full: 0 }

  constructor(staticS: number, params?: Partial<DetectorParams>) {
    this.staticS = staticS
    this.p = { ...DETECTOR_DEFAULTS, ...params }
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
      // 아직 판단 못 함: 최근 (깜박임 최대 길이 + 2)초 안(꺼진 구간이 깜박임이 될 수 있는 동안)이거나, 열려 있는 깜박임 묶음에 들 수 있음
      if (!final && (now - x < this.p.blinkMaxS + 2 || (g0 !== null && x >= g0 - m))) {
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
   * 떨어지는 구간 [from, to] (떨어지기 전 마지막 프레임 ~ 다 떨어진 프레임): 꺼진 첫 프레임 a 앞 RAMP_WIN_S초 ~ 뒤 2프레임에서 가장 크게
   * 떨어진 프레임을 가운데로, 그 RAMP_REL배(최소 DROP_TOL) 넘게 떨어진 프레임이 이어진 곳 (한 프레임 멈칫한 것은 이어 봄 — 반쯤 꺼졌다 꺼짐).
   * 앞으로는 켜져 있던 동안의 시작(k)까지, 뒤로는 a 뒤 RAMP_WIN_S초까지. 떨어진 곳이 없으면 null
   */
  private ramp(f: FrameArrays, k: number, a: number): { from: number; to: number } | null {
    const { t, y } = f
    const fall = (j: number) => y[j - 1] - y[j]
    let top = -1
    const hi = Math.min(f.n - 1, a + 2)
    for (let j = Math.max(k + 1, bisectLeft(t, t[a] - RAMP_WIN_S, a)); j <= hi; j++) if (top < 0 || fall(j) > fall(top)) top = j
    if (top < 0 || fall(top) < DROP_TOL) return null
    const thr = Math.max(RAMP_REL * fall(top), DROP_TOL)
    let first = top
    for (;;) {
      if (first - 1 > k && fall(first - 1) >= thr) first--
      else if (first - 2 > k && fall(first - 2) >= thr) first -= 2
      else break
    }
    let last = top
    const end = Math.min(f.n - 1, bisectLeft(t, t[a] + RAMP_WIN_S, f.n))
    for (;;) {
      if (last + 1 <= end && fall(last + 1) >= thr) last++
      else if (last + 2 <= end && fall(last + 2) >= thr) last += 2
      else break
    }
    return { from: first - 1, to: last }
  }

  /**
   * 꺼진 수준에 든 첫 프레임 a의 앞: 켜져 있던 동안(최대 DROP_WIN_S초)을 되짚어 가장 밝은 값(base)을 찾고 급격히 꺼졌는지 본다.
   * 급격 = 떨어지는 구간(ramp)이 RAMP_S초 안이고 그동안 (base의 25%, 최소 12) 넘게 떨어짐 — 떨어지기 시작한 프레임이 i0.
   * 서서히면 base에서 그만큼 어두워지기 시작한 프레임이 i0. 앞에 프레임이 없으면(영상 첫머리부터 꺼져 있음) null
   */
  private onset(f: FrameArrays, a: number): Onset | null {
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
    let base = y[k]
    for (let j = k + 1; j < a; j++) if (y[j] > base) base = y[j]
    const need = Math.max((this.p.dropPct / 100) * base, this.p.dropAbs)
    // 떨어지는 구간만 본다 (그 전에 서서히 어두워지던 것은 세지 않는다). 0.001초는 프레임 시각 반올림 여유
    const r = this.ramp(f, k, a)
    if (r && y[r.from] - y[r.to] >= need && t[r.to] - t[r.from] <= this.p.rampS + 0.001) return { k, base, i0: r.from + 1, sudden: true }
    // 서서히: 가장 밝은 값에서 need 넘게 어두워지기 시작한 프레임
    let q = a - 1
    while (q >= k && base - y[q] >= need) q--
    return { k, base, i0: q + 1, sudden: false }
  }

  /** 2차 윤곽 기준: 꺼지기 전(어두워지기 전 최대 LIT_EDGE_S초, 켜져 있던 동안) 윤곽의 p.edgeOffPct% — 완전히 꺼진 기준보다 작으면 그것 */
  private edgeRef(f: FrameArrays, on: Onset | null, edges: ArrayLike<number>): { off: number; lit: number | null } {
    const full = this.thr.full
    if (!on) return { off: full, lit: null }
    const from = Math.max(on.k, bisectLeft(f.t, f.t[on.i0] - LIT_EDGE_S, on.i0))
    if (from >= on.i0) return { off: full, lit: null }
    const lit = median(sampled(edges, from, on.i0, 1))
    return { off: Math.max(full, (this.p.edgeOffPct / 100) * lit), lit }
  }

  /** 검은 화면 start ~ b: 근거는 꺼진 구간(a ~ b)의 기준 밝기와의 차이(또는 밝기)·윤곽이 가장 많은 칸(또는 평균 윤곽)의 중앙값과 기준 */
  private black(f: FrameArrays, level: Float32Array, edges: ArrayLike<number>, start: number, run: OffRun) {
    const { a, b } = run
    const med = (arr: ArrayLike<number>) => median(sampled(arr, a, b + 1, 1))
    const th = this.thr
    const ref = this.ref!
    const info: BlackInfo = { type: 'black_screen' }
    if (run.on?.sudden) info.sudden = true
    if (th.floor !== null) info.contrast = { value: med(level), off: th.cOff, floor: pyRound(th.floor, 1), on: ref.bright }
    else info.bright = { value: med(level), ref: ref.bright }
    const digits = th.g ? 1 : 2
    const edge = { value: med(edges), off: pyRound(run.edgeOff, digits), full: pyRound(th.full, digits), ...(run.lit !== null ? { lit: pyRound(run.lit, digits) } : {}) }
    if (th.g) info.grid = edge
    else info.edge = { ...edge, ref: ref.edge }
    this.seg(f, 'black_screen', start, b, info)
  }

  /**
   * 꺼진 구간이 끝났다 (cut: 다시 켜진 게 아니라 영상이 끝남). 길이는 급격히 꺼진 것이면 어두워지기 시작한 프레임부터 잰다:
   * 깜박임 최대 길이(p.blinkMaxS) 넘으면 검은 화면 (급격·서서히 모두), 안이면 급격히 꺼졌다 다시 켜진 것만 깜박임 (서서히 꺼졌다 켜짐·끝에서 끊김은 판정하지 않음)
   */
  private closeOff(f: FrameArrays, level: Float32Array, edges: ArrayLike<number>, cut: boolean) {
    const run = this.off!
    this.off = null
    const { a, b, on } = run
    const dt = this.dt || 0.1
    const start = on?.sudden ? on.i0 : a
    const dur = f.t[b] - f.t[start] + dt
    if (dur > this.p.blinkMaxS) {
      this.black(f, level, edges, start, run)
      return
    }
    if (!on?.sudden || cut) return
    let low = f.y[a]
    for (let m = a + 1; m <= b; m++) low = Math.min(low, f.y[m])
    const bl: Blink = { i0: start, i1: b, depth: pyRound(((on.base - low) / Math.max(on.base, 1)) * 100), dur: pyRound(dur, 2), t0: f.t[start] }
    if (this.group.length && bl.t0 - this.group[0].t0 > this.p.blinkGroupS) this.closeGroup(f)
    this.group.push(bl)
    this.flick.push([start, b])
    // 꺼지는 순간의 큰 차이(묶음이 닫힐 때 빠질 전환 후보)에 뒤의 전환이 합쳐져 사라지지 않게
    if (this.trLast !== null && this.trLast >= f.t[start] - this.margin()) this.trLast = null
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
   * f.sat: 색이 뚜렷하면 어두워도 켜진 화면 · f.g: 윤곽이 가장 많은 칸 (2차 윤곽 — 꺼지기 전보다 크게 줄지 않은 어두운 화면은 켜진 화면) ·
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
    // 꺼짐: 1차 밝기(꺼진 수준·색 없음) → 2차 윤곽(꺼지기 전의 절반 아래 또는 완전히 꺼진 수준) → 길이 (closeOff) · 변화 없음 · 화면 전환
    const blankY = 0.5 * py
    const blankE = 0.4 * Math.max(pe, 0.05)
    const gOff = Math.max(OFF_GRID_ABS, OFF_GRID_REL * pg)
    const cOff = Math.max(this.p.offAbs, OFF_FLOOR_REL * (floor ?? 0), (this.p.offOnPct / 100) * py)
    // 2차 윤곽에 쓰는 값: 윤곽이 가장 많은 칸 (옛 에이전트면 평균 윤곽)과 그 완전히 꺼진 기준
    const edges = g ?? e
    this.thr = { g, floor, gOff, cOff, full: g ? gOff : blankE }
    const quiet = Math.max(0.3, 2 * nd)
    const big = Math.max(this.p.transitionMin, this.p.transitionX * nd)
    for (let i = this.pos; i < upto; i++) {
      // 1차 밝기: 밝기가 꺼진 수준이고 색이 없음 (어두워도 색이 뚜렷하면 켜진 화면)
      const dim = (floor !== null ? level[i] <= cOff : y[i] < blankY) && (!sat || i >= sat.length || sat[i] <= this.p.satMax)
      // 2차 윤곽: 이어지는 꺼진 구간은 그 기준으로, 새로 꺼지면 꺼지기 전 윤곽과 견줘서
      // (밝기만 꺼진 수준인 어두운 화면은 윤곽이 남아 켜진 화면, 아이콘·글자가 남아도 윤곽이 크게 줄었으면 꺼짐)
      let isOff = false
      if (this.off) {
        if (dim && edges[i] <= this.off.edgeOff) {
          this.off.b = i
          isOff = true
        } else this.closeOff(f, level, edges, false)
      }
      if (dim && !this.off) {
        const on = this.onset(f, i)
        const ref = this.edgeRef(f, on, edges)
        if (edges[i] <= ref.off) {
          this.off = { a: i, b: i, on, edgeOff: ref.off, lit: ref.lit }
          isOff = true
        }
      }
      if (i === 0) continue
      if (d[i] < quiet) {
        if (this.quiet) {
          this.quiet[1] = i
          this.quiet[2] += isOff ? 1 : 0
        } else this.quiet = [i, i, isOff ? 1 : 0]
      } else if (this.quiet) this.closeQuiet(f)
      // 깜박임(어두워지기 시작 ~ 다시 켜진 뒤 여유까지)의 큰 차이는 전환이 아니다 (꺼지는 순간의 차이는 묶음이 닫힐 때 뺀다 — flushTransitions).
      // 여유 안 프레임은 전환 합치기 기준에도 넣지 않는다 (뒤따르는 진짜 전환이 빠질 전환에 합쳐지지 않게)
      const m = this.margin()
      if (d[i] > big && !this.flick.some(([f0, f1]) => t[f0] - m <= t[i] && t[i] <= t[f1] + (this.dt || 0.1) + m)) {
        // 직전 "크게 바뀐 프레임"에서 0.5초 안이면 같은 전환의 이어지는 프레임 → 새로 세지 않음 (시작 시각만 남김)
        if (this.trLast === null || t[i] - this.trLast > this.p.transitionMergeS) this.trPending.push(pyRound(t[i], 2))
        this.trLast = t[i]
      }
    }
    this.pos = upto
    if (final) {
      if (this.off) this.closeOff(f, level, edges, true)
      if (this.quiet) this.closeQuiet(f)
    }
    // 깜박임 묶음은 첫 깜박임부터 묶음 시간 안에 시작한 깜박임이 다 끝날 수 있을 때(+깜박임 최대 길이) 닫는다
    if (this.group.length && (final || t[upto - 1] - this.group[0].t0 > this.p.blinkGroupS + this.p.blinkMaxS)) this.closeGroup(f)
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
