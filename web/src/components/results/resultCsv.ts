// 결과 확인 도구: Result CSV 읽기 (형식이 제각각이라 열 이름·값 모양으로 자동 판별, 화면에서 바꿀 수 있게)
//
// 시간은 모두 "벽시계 밀리초"로 통일한다: 날짜·시각 문자열을 그 지역 시각 그대로(시간대 변환 없이) Date.UTC로 센 값.
// 테스트 PC가 남긴 시각·파일 이름의 시각·영상 메타가 모두 같은 지역 시각이라는 전제(시간대가 있는 값은 화면의 시간대로 바꿈)

export type ColumnRole = 'time' | 'cycle' | 'status' | 'name' | 'duration' | 'message'

export interface ResultMapping {
  /** 역할별 열 번호 (없으면 -1) */
  time: number
  cycle: number
  status: number
  name: number
  duration: number
  message: number
  /** 걸린 시간 단위 */
  durationUnit: 's' | 'ms'
  /** 시간 해석: 'auto' 자동, 'absolute' 날짜·시각, 'elapsed' 시작부터 경과 초 */
  timeMode: 'auto' | 'absolute' | 'elapsed'
}

export interface ResultRow {
  /** 원래 데이터 행 순서 (0부터) */
  index: number
  cells: string[]
  /** 벽시계 ms (absolute) 또는 경과 ms (elapsed). 못 읽으면 null */
  time: number | null
  cycle: string
  status: string
  name: string
  durationMs: number | null
  message: string
  /** 행에 적힌 이미지 경로들 (HYPERLINK 수식·IMAGE:(…) 안 포함) */
  images: string[]
  /** ATS: 원본·결과 이미지 (P열 찾을 이미지 · Y열 비교 이미지) */
  ats?: AtsImages
}

export interface AtsImages {
  /** p: P열만(화면에서 이미지 찾기) · y: Y열만(이미지 비교) · py: 둘 다 */
  kind: 'p' | 'y' | 'py'
  /** P열: 화면에서 찾을(터치할) 이미지 */
  target: string | null
  /** Y열(REF IMAGE): 비교 기준 원본 이미지 */
  ref: string | null
  /** Y열(DEVICE IMAGE): 그때 화면에서 잘라 낸 결과 이미지 */
  result: string | null
  /** Y열(DIFF IMAGE): 차이 표시 이미지 */
  diff: string | null
  /** Y열 첫 줄 (예: IMAGE(FAIL), FIND_IMAGE_ONSCREEN_TOUCH:('Can not find…')) */
  note: string
  /** 종류 표시를 바꿀 때 (RFW) */
  label?: string
}

export interface ParsedResult {
  /** 머리말(헤더 앞 줄)에서 찾은 'START TIME' 등 시작 시각 (벽시계 ms) */
  startTime: number | null
  preamble: string[]
  headers: string[]
  mapping: ResultMapping
  /** 시간 열이 절대 시각인지 경과 시간인지 (mapping.timeMode가 auto일 때 판별 결과) */
  timeKind: 'absolute' | 'elapsed' | 'unknown'
  rows: ResultRow[]
  /** 형식이 정해진 결과(ATS·RFW): 열을 그대로 보여 주는 표 설정. 없으면 자동 판별 표 */
  table?: TableSpec
  /** 계획한 Cycle 수 (RFW 'Cycle Total' · ATS 'TOTAL TC REPEAT', Cycle이 TC REPEAT일 때만). 모르면 없음 */
  cycleTotal?: number | null
}

/** 고정 열 표: 열 폭(grid, # 열 제외) · 가운데 정렬 열 · 결과 색 열 · 실패일 때만 색 칠할 열 · 시각 열 */
export interface TableSpec {
  /** grid 열 폭 (# 열 뒤). 'fit'은 그 열의 머리글·내용 중 가장 긴 것에 딱 맞춘다 */
  columns: string
  center: number[]
  statusCells: number[]
  alertCells: number[]
  timeCell: number
  /** 핵심만 한 줄로 줄여 보여 줄 열 (shortMessage). 원래 글은 마우스를 올리면 */
  pathCells?: number[]
  /** 머리글 [전체 보기]로 내용 길이만큼 넓힐 열. expandColumns = 그때 앞 열들의 줄인 폭 */
  expandCell?: number
  expandColumns?: string
  /** 작은 글자(9px, 머리글과 같게)·좁은 칸 여백·머리글 가운데 (ATS) */
  compact?: boolean
  /** 행 번호(#) 열을 두지 않는다 */
  noIndex?: boolean
  /** 작은 글자로 줄을 바꿔 다 보여 줄 열 (행 높이 안에서 두 줄): 'fit'이면 한 줄 폭의 반으로 */
  wrapCells?: number[]
  /** 시각 칸에서 연도를 뺀다 (10-06 14:01:40.097) */
  noYear?: boolean
}

// ── RFW Message 표시: 핵심만 한 줄로 (원래 글은 마우스를 올리면)

/** 글 속 절대 경로(/home/…, /usr/bin/python3, file:////…)를 마지막 이름만 남긴다. URL(http://…)은 그대로 */
export const shortenPaths = (text: string) =>
  text.replace(/(^|[\s"'=(\[,])(?:file:)?\/+(?:[^\s"'<>,()=/]+\/)+([^\s"'<>,()=/]*)/gi,
    (m, lead: string, name: string) => lead + (name || m.slice(lead.length).split('/').filter(Boolean).pop() || ''))

// 'GET Request : url=… headers={…} body=…' 처럼 헤더·본문까지 찍힌 HTTP 로그
const HTTP_LOG = /^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) (?:Request|Response)\b/i
const MESSAGE_LIMIT = 140
const BLOCK_LIMIT = 60

// HTML 태그로 볼 이름 ('<result object with rc 0>' 같은 글은 태그가 아님)
const HTML_TAG = /<\/?(?:a|b|i|u|s|p|br|hr|img|div|span|font|center|small|big|strong|em|pre|code|sub|sup|table|thead|tbody|tr|td|th|ul|ol|li|h[1-6]|html|head|body|title|meta|link)\b[^>]*>/gi

/** 글 속 HTML 태그를 걷어 값만 남긴다: <img src="A.bmp" style="…"> → A.bmp, 그 밖의 태그·style·script·주석은 지움 */
export function stripHtml(text: string) {
  if (!/<[!/a-z]/i.test(text)) return text
  return text
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->|<!doctype[^>]*>/gi, ' ')
    .replace(/<img\b[^>]*?\bsrc\s*=\s*(["']?)([^"'\s>]+)\1[^>]*>/gi, ' $2 ')
    .replace(HTML_TAG, ' ')
}

/**
 * 여러 줄로 찍힌 구조체(Name { a: 1,\n b: Inner { … } })는 한 줄로: 안쪽 블록은 {…}, 길면 앞 필드만
 * 예: VehicleHmiState { value_state: VALUE_STATE_VALID, hmi_mode: HMI_MODE_T_MISSION, … }
 */
function flattenBlocks(text: string) {
  let out = ''
  let depth = 0
  let block = ''
  // ${var} · @{list} · &{dict} (Robot Framework 변수)는 글자 그대로
  const literal: boolean[] = []
  let prev = ''
  const put = (ch: string) => {
    if (depth === 0) out += ch
    else if (depth === 1) block += ch
  }
  for (const ch of text) {
    const before = prev
    prev = ch
    if (ch === '{' && /[$@&%]/.test(before)) {
      literal.push(true)
      put(ch)
      continue
    }
    if (ch === '}' && literal.length && literal[literal.length - 1]) {
      literal.pop()
      put(ch)
      continue
    }
    if (ch === '{') {
      literal.push(false)
      depth++
      if (depth === 1) block = ''
      else if (depth === 2) block += '{…}'
      continue
    }
    if (ch === '}' && depth > 0) {
      literal.pop()
      depth--
      if (depth === 0) {
        let inner = block.replace(/\s+/g, ' ').replace(/[,\s]+$/, '').trim()
        if (inner.length > BLOCK_LIMIT) {
          const cut = inner.lastIndexOf(', ', BLOCK_LIMIT)
          inner = (cut > 0 ? inner.slice(0, cut + 1) : inner.slice(0, BLOCK_LIMIT)) + ' …'
        }
        out += inner ? `{ ${inner} }` : '{}'
      }
      continue
    }
    put(ch)
  }
  // 닫히지 않은 블록은 그대로
  return depth > 0 ? out + '{' + block : out
}

/** 명령줄(prog --opt 값 …): 프로그램과 파일 이름 값만 (예: python3 client.py Speed.json) */
function shortenCommand(text: string) {
  const at = text.search(/\s--[A-Za-z][\w-]*(?=[\s=])/)
  if (at < 0) return text
  const files = [...text.slice(at).matchAll(/--[\w-]+[ =]("[^"]*"|'[^']*'|\S+)/g)]
    .map((m) => m[1].replace(/^["']|["']$/g, ''))
    .filter((v) => /\.[A-Za-z][A-Za-z0-9]{0,4}$/.test(v))
  return files.length ? `${text.slice(0, at)} ${files.join(' ')}` : text
}

/**
 * RFW Message 표시용: HTTP 로그는 요청·응답 줄만, HTML 태그는 값만, 구조체는 한 줄로, 줄바꿈은 ' · ',
 * 경로는 마지막 이름만, 명령줄은 프로그램 · 파일만, 그래도 길면 앞 140자
 */
export function shortMessage(text: string) {
  let t = text
  // HTTP 로그: 헤더·본문을 떼고 한 줄로
  if (HTTP_LOG.test(t)) t = t.replace(/\s*\b(?:headers|body)=[\s\S]*$/, '').replace(/\s+/g, ' ')
  t = flattenBlocks(stripHtml(t))
  // 줄마다 다듬고(빈 줄·바로 위와 같은 줄·**INFO** 표시 빼기) ' · '로 잇는다. ':'로 끝난 줄은 다음 줄과 그냥 잇기
  let joined = ''
  let last = ''
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.replace(/^\s*\*\*INFO\*\*/, '').replace(/\s+/g, ' ').trim()
    if (!line || line === last) continue
    joined += !joined ? line : last.endsWith(':') ? ' ' + line : ' · ' + line
    last = line
  }
  t = shortenCommand(shortenPaths(joined))
  return t.length > MESSAGE_LIMIT ? t.slice(0, MESSAGE_LIMIT - 1) + '…' : t
}

// ── 바이트 → 문자열 (BOM이면 UTF-8, 아니면 UTF-8 시도 후 안 되면 CP949)
export function decodeText(bytes: ArrayBuffer): string {
  const u8 = new Uint8Array(bytes)
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8)
  } catch {
    return new TextDecoder('euc-kr').decode(u8)
  }
}

// ── CSV (RFC 4180: 따옴표 안 줄바꿈·"" 이스케이프, 줄 끝 CR/LF/CRLF 섞임)
/** 구분자 고르기: 첫 줄(열 이름)에 탭이 쉼표보다 많으면 탭 (확장자는 .csv인데 탭으로 나눈 RFW 결과 등) */
function detectDelimiter(text: string): string {
  const firstLine = text.slice(0, Math.min(text.length, 4096)).split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  const count = (ch: string) => firstLine.split(ch).length - 1
  const tabs = count('\t')
  const commas = count(',')
  const semis = count(';')
  if (tabs > commas && tabs >= semis) return '\t'
  if (semis > commas && semis > tabs) return ';'
  return ','
}

export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell.trim() === '') {
      quoted = true
      cell = ''
    } else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\r' || ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      if (ch === '\r' && text[i + 1] === '\n') i++
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

// ── 시간
const DATE_TIME = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[ T_]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i
const TIME_OF_DAY = /^(\d{1,2}):(\d{2}):(\d{2})(?:[.,](\d+))?$/
const NUMBER = /^[+-]?\d+(?:\.\d+)?$/

const fraction = (f: string | undefined) => (f ? Number(`0.${f}`) * 1000 : 0)

/** 시간대가 있는 값을 화면(브라우저)의 지역 벽시계로 */
function awareToWall(utcMs: number): number {
  return utcMs - new Date(utcMs).getTimezoneOffset() * 60_000
}

export type TimeValue = { kind: 'absolute'; ms: number } | { kind: 'tod'; ms: number } | { kind: 'number'; value: number }

/** 시간 문자열 하나 → 벽시계 ms / 하루 중 시각 ms / 숫자 */
export function parseTime(raw: string): TimeValue | null {
  const s = raw.trim().replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').trim()
  if (!s) return null
  let m = DATE_TIME.exec(s)
  if (m) {
    const [, y, mo, d, h, mi, sec, frac, tz] = m
    let ms = Date.UTC(+y, +mo - 1, +d, +h, +mi, sec ? +sec : 0) + fraction(frac)
    if (tz) {
      const offset = tz.toUpperCase() === 'Z' ? 0 : (tz[0] === '-' ? -1 : 1) * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(-2)))
      ms = awareToWall(ms - offset * 60_000)
    }
    return { kind: 'absolute', ms }
  }
  m = TIME_OF_DAY.exec(s)
  if (m) {
    const [, h, mi, sec, frac] = m
    return { kind: 'tod', ms: ((+h * 60 + +mi) * 60 + +sec) * 1000 + fraction(frac) }
  }
  if (NUMBER.test(s)) {
    const v = Number(s)
    // 유닉스 시각(초 10자리·밀리초 13자리), 엑셀 날짜 숫자(1990~2100년)
    if (/^\d{13}$/.test(s)) return { kind: 'absolute', ms: awareToWall(v) }
    if (/^\d{10}$/.test(s)) return { kind: 'absolute', ms: awareToWall(v * 1000) }
    if (v > 32874 && v < 73051 && s.includes('.')) return { kind: 'absolute', ms: Math.round((v - 25569) * 86_400_000) }
    return { kind: 'number', value: v }
  }
  return null
}

/** 파일 이름 등에서 날짜·시각 찾기: 20261006_141230, 2026-10-06_14-12-30, 2026_1006_161341, 20261006_141233_123 */
export function timeFromName(name: string): number | null {
  const m = /(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})[-_ T]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})(?:[-_.](\d{1,3})(?!\d))?/.exec(name)
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms] = m
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return null
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +s) + (ms ? Number(ms.padEnd(3, '0')) : 0)
}

export function formatWall(ms: number | null, withDate = false): string {
  if (ms === null || !Number.isFinite(ms)) return ''
  const d = new Date(ms)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(d.getUTCMilliseconds(), 3)}`
  return withDate ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${time}` : time
}

export function formatSeconds(sec: number): string {
  if (!Number.isFinite(sec)) return '-'
  const sign = sec < 0 ? '-' : ''
  sec = Math.abs(sec)
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  const s = sec % 60
  return `${sign}${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${s.toFixed(1).padStart(4, '0')}`
}

// ── 열 역할 자동 판별
const NAME_PATTERNS: Record<ColumnRole, RegExp> = {
  time: /time ?stamp|^\s*time\s*$|start ?time|date ?time|^date$|시각|시간|^time\b/i,
  cycle: /cycle ?index|iteration|^cycle$|current tc repeat|current script repeat|회차|반복/i,
  status: /^status$|result$|^action check$|verdict|판정|결과/i,
  name: /kw name|keyword|step ?name|test ?step|^control$|command|^action$|description|스텝|명령/i,
  duration: /elapsed|duration|exec(ution)? ?time|소요/i,
  message: /message|remark|detail|reason|비고|메시지/i,
}
const STATUS_VALUES = /^(pass(ed)?|fail(ed)?|ok|ng|not ?run|error|skip(ped)?|warn(ing)?|block(ed)?|n\/a)$/i
const IMAGE_PATH = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^"'<>|\r\n,()[\]]*?\.(?:bmp|png|jpe?g|gif|webp)/gi

const unq = (s: string) => s.trim().replace(/^"|"$/g, '').trim()

/** 헤더 행 찾기: 시간처럼 보이는 열 이름이 있고 다음 행 그 열이 시간으로 읽히는 첫 행 */
function findHeader(rows: string[][]): number {
  for (let r = 0; r < Math.min(rows.length - 1, 60); r++) {
    const cells = rows[r].map(unq)
    if (cells.filter(Boolean).length < 3) continue
    for (let c = 0; c < cells.length; c++) {
      if (!NAME_PATTERNS.time.test(cells[c])) continue
      for (let k = r + 1; k < Math.min(rows.length, r + 4); k++) {
        if (rows[k][c] !== undefined && parseTime(rows[k][c])) return r
      }
    }
  }
  return rows.findIndex((r) => r.filter((c) => c.trim()).length >= 3)
}

function guessMapping(headers: string[], data: string[][]): ResultMapping {
  const sample = data.slice(0, 300)
  const used = new Set<number>()
  const pick = (role: ColumnRole, score: (c: number) => number) => {
    let best = -1
    let bestScore = 0
    headers.forEach((h, c) => {
      if (used.has(c) || !NAME_PATTERNS[role].test(h)) return
      const sc = score(c)
      if (sc > bestScore) {
        best = c
        bestScore = sc
      }
    })
    if (best >= 0) used.add(best)
    return best
  }
  const filled = (c: number) => sample.filter((r) => unq(r[c] ?? '') !== '').length
  const time = pick('time', (c) => sample.filter((r) => parseTime(r[c] ?? '')).length)
  const cycle = pick('cycle', (c) => sample.filter((r) => NUMBER.test(unq(r[c] ?? ''))).length + 1)
  // 결과: 이름이 맞는 열 중 PASS/FAIL 같은 값이 가장 많은 열, 없으면 값으로만
  let status = pick('status', (c) => sample.filter((r) => STATUS_VALUES.test(unq(r[c] ?? ''))).length)
  if (status < 0 || sample.filter((r) => STATUS_VALUES.test(unq(r[status] ?? ''))).length === 0) {
    if (status >= 0) used.delete(status)
    let best = -1
    let bestCount = 0
    headers.forEach((_, c) => {
      if (used.has(c)) return
      const n = sample.filter((r) => STATUS_VALUES.test(unq(r[c] ?? ''))).length
      if (n > bestCount) {
        best = c
        bestCount = n
      }
    })
    status = best
    if (best >= 0) used.add(best)
  }
  const name = pick('name', filled)
  const duration = pick('duration', (c) => sample.filter((r) => NUMBER.test(unq(r[c] ?? ''))).length)
  // 메시지: 짧은 값(INFO, None)보다 내용이 긴 열 (예: 'Message' > 'Message Level')
  const message = pick('message', (c) => sample.reduce((n, r) => n + unq(r[c] ?? '').replace(/^none$/i, '').length, 0))
  // 걸린 시간 단위: 이름에 ms, 또는 정수가 대부분이고 값이 크면 ms
  let durationUnit: 's' | 'ms' = 's'
  if (duration >= 0) {
    const values = sample.map((r) => unq(r[duration] ?? '')).filter((v) => NUMBER.test(v)).map(Number)
    const ints = values.filter((v) => Number.isInteger(v)).length
    const median = [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
    if (/ms|msec|밀리/i.test(headers[duration]) || (values.length && ints / values.length > 0.9 && median >= 100)) durationUnit = 'ms'
  }
  return { time, cycle, status, name, duration, message, durationUnit, timeMode: 'auto' }
}

/** 머리말의 시작 시각 (예: START TIME:2026-10-06 14:01:33.379000) */
function startFromPreamble(lines: string[]): number | null {
  for (const line of lines) {
    const m = /(start|시작)[^:：]*[:：]\s*(.+)$/i.exec(line)
    const v = m && parseTime(m[2])
    if (v && v.kind === 'absolute') return v.ms
  }
  return null
}

/** CSV 텍스트 → 결과. mapping을 주면 그대로 쓴다 (화면에서 바꾼 열) */
export function parseResult(text: string, override?: Partial<ResultMapping>): ParsedResult {
  const all = parseCsv(text)
  const headerIndex = Math.max(0, findHeader(all))
  const preamble = all.slice(0, headerIndex).map((r) => r.join(',').trim()).filter(Boolean)
  const headers = (all[headerIndex] ?? []).map(unq)
  const data = all.slice(headerIndex + 1).filter((r) => r.some((c) => c.trim() !== ''))
  const mapping = { ...guessMapping(headers, data), ...override }
  const startTime = startFromPreamble(preamble)

  // 시간 열 종류: 절대 시각이 대부분이면 absolute, 숫자·시각만이면 elapsed
  const kinds = { absolute: 0, tod: 0, number: 0 }
  for (const r of data.slice(0, 300)) {
    const v = mapping.time >= 0 ? parseTime(r[mapping.time] ?? '') : null
    if (v) kinds[v.kind]++
  }
  const detected: ParsedResult['timeKind'] =
    kinds.absolute >= kinds.tod + kinds.number && kinds.absolute > 0 ? 'absolute'
      : kinds.tod + kinds.number > 0 ? 'elapsed' : 'unknown'
  const mode = mapping.timeMode === 'auto' ? detected : mapping.timeMode

  // 하루 중 시각만 있으면 날짜는 머리말 시작 시각에서 (자정을 넘으면 하루씩 더함)
  const dayBase = startTime !== null ? startTime - (startTime % 86_400_000) : null
  let lastTod = -1
  let dayAdd = 0

  const cell = (r: string[], c: number) => (c >= 0 ? unq(r[c] ?? '') : '')
  const rows: ResultRow[] = data.map((r, index) => {
    let time: number | null = null
    const v = mapping.time >= 0 ? parseTime(r[mapping.time] ?? '') : null
    if (v) {
      if (v.kind === 'absolute') time = mode === 'elapsed' && startTime !== null ? v.ms - startTime : v.ms
      else if (v.kind === 'tod') {
        if (lastTod >= 0 && v.ms < lastTod - 3_600_000) dayAdd += 86_400_000
        lastTod = v.ms
        time = mode === 'absolute' && dayBase !== null ? dayBase + dayAdd + v.ms : v.ms + dayAdd
      } else time = v.value * 1000
    }
    const durRaw = cell(r, mapping.duration)
    const images = [...new Set(r.join(' ').match(IMAGE_PATH) ?? [])].map((p) => p.replace(/\\\\/g, '\\'))
    return {
      index,
      cells: r.map(unq),
      time,
      cycle: cell(r, mapping.cycle),
      status: cell(r, mapping.status),
      name: cell(r, mapping.name),
      durationMs: NUMBER.test(durRaw) ? Number(durRaw) * (mapping.durationUnit === 'ms' ? 1 : 1000) : null,
      message: cell(r, mapping.message),
      images,
    }
  })
  return { startTime, preamble, headers, mapping, timeKind: mode, rows }
}

/** 결과 값 → 색 구분 */
export function statusTone(status: string): 'ok' | 'bad' | 'warn' | 'idle' | '' {
  const s = status.trim().toLowerCase()
  if (!s) return ''
  if (/^(pass(ed)?|ok)$/.test(s)) return 'ok'
  if (/^(fail(ed)?|ng|error)$/.test(s)) return 'bad'
  if (/^(warn(ing)?|block(ed)?)$/.test(s)) return 'warn'
  if (/not ?run|skip/.test(s)) return 'idle'
  return ''
}

// ── 결과 형식: ATS(Video_editor.py와 같은 규칙) · RFW(자동 판별)
export type ResultMode = 'ats' | 'rfw'
export const RESULT_MODE_LABEL: Record<ResultMode, string> = { ats: 'ATS', rfw: 'RFW' }

/** ATS: 원본 열 A·(B 또는 I)·N·O·P·U·V·X·Y만 보여 준다 (B ITERATION IN JOB 또는 I CURRENT TC REPEAT 중 Cycle인 쪽 → CYCLE) */
const ATS_COLUMNS = [0, 8, 13, 14, 15, 20, 21, 23, 24]
const ATS_FALLBACK = ['Time Stamp', 'CURRENT TC REPEAT', 'DEVICE', 'Control', 'STATUS', 'ACTION CHECK', 'STEP REMARK', 'STEP RESULT', 'STEP RESULT(DETAIL)']
/**
 * ATS Cycle은 B열 ITERATION IN JOB(잡을 되풀이한 횟수) 또는 I열 CURRENT TC REPEAT(TC를 되풀이한 횟수) 중 하나.
 * 어느 쪽이 되풀이되는지는 파일마다 달라서(한쪽은 1 고정) 값이 1씩 올라가는 열을 Cycle로 쓴다.
 * 계획한 Cycle 수: TC REPEAT이 Cycle이면 H열 TOTAL TC REPEAT, ITERATION이면 알 수 없음(총 횟수 열이 없음)
 */
const ATS_ITERATION_COL = 1
const ATS_TC_REPEAT_COL = 8
const ATS_CYCLE_TOTAL_COL = 7

/**
 * Cycle 후보 열 중 값이 바뀌며 올라가는 열을 고른다.
 * 둘 다 안 바뀌면(한 Cycle만 돌았거나 끊김) 첫 후보. 둘 다 바뀌면 바뀔 때마다 1씩만 올라가는 쪽(되돌아가지 않는 바깥 반복),
 * 그래도 같으면 더 많이 바뀐 쪽. Cycle 값이 되돌아가는 열(1,2,3,1,2,3)을 쓰면 같은 Cycle 이름이 떨어져 두 번 나와 Cycle 단위 처리가 어긋난다
 */
function pickCycleColumn(data: string[][], candidates: number[]): number {
  const scored = candidates.map((col) => {
    let changes = 0
    let plusOne = true
    let prev: number | null = null
    for (const r of data) {
      const s = unq(r[col] ?? '')
      if (!NUMBER.test(s)) continue
      const v = Number(s)
      if (prev !== null && v !== prev) {
        changes++
        if (v !== prev + 1) plusOne = false
      }
      prev = v
    }
    return { col, changes, plusOne }
  })
  const rank = (s: { changes: number; plusOne: boolean }) => (s.changes === 0 ? 0 : s.plusOne ? 2 : 1)
  let best = scored[0]
  for (const s of scored.slice(1)) {
    if (rank(s) > rank(best) || (rank(s) === rank(best) && s.changes > best.changes)) best = s
  }
  return best.col
}
/** ATS 화면 열: ACTION CHECK(OK/ERROR) · STEP RESULT(PASS/FAIL, 판정 스텝만) */
export const ATS_ACTION_CELL = 5
export const ATS_RESULT_CELL = 7
const ATS_CONTROL_CELL = 3
const ATS_DURATION_COL = 17
const ATS_MAPPING: ResultMapping = { time: 0, cycle: 1, status: 7, name: 6, duration: -1, message: 8, durationUnit: 's', timeMode: 'absolute' }

/** 벽시계 ms → ATS Time Stamp 모양 (2026-10-06 14:01:51.642000) */
function atsStamp(ms: number): string {
  const d = new Date(ms)
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000`
}

/** ATS 데이터 줄: 첫 열이 [시각] */
const atsData = (r: string[] | undefined) => !!r && r.length > 0 && r[0].includes('[') && r[0].includes(']')

/**
 * ATS Result: 머리말 · 열 이름 줄 · 첫 열이 [시각]인 데이터 줄들. 머리말 줄 수는 파일마다 달라(앞 빈 줄·버전 줄 유무) 첫 데이터 줄로 찾는다
 * (전에는 앞 6줄을 머리말로 못 박아, 머리말이 짧은 파일은 첫 데이터 줄이 열 이름이 되고 표에서 빠졌다)
 */
export function parseAts(text: string): ParsedResult {
  const all = parseCsv(text)
  // 첫 데이터 줄: 첫 열이 시각으로 읽히는 [ ] (머리말에서 찾지 못하면 앞 6줄 뒤)
  let first = all.findIndex((r) => atsData(r) && parseTime(unq(r[0])) !== null)
  if (first < 0) first = Math.min(all.length, 6)
  // 열 이름 줄: 첫 데이터 줄 바로 위의 내용 있는 줄 (열이 24개 넘어야 — 머리말의 버전 줄은 아님). 열 자리는 이름으로 찾고, 이름이 없으면 정해진 자리
  let headerAt = first - 1
  while (headerAt >= 0 && all[headerAt].every((c) => !c.trim())) headerAt--
  const named = headerAt >= 0 && all[headerAt].length > 24 ? all[headerAt].map(unq) : []
  const preamble = all.slice(0, named.length ? headerAt : first).map((r) => r.join(',').trim()).filter(Boolean)
  const columnNamed = (pattern: RegExp, fallback: number) => {
    const i = named.findIndex((h) => pattern.test(h))
    return i >= 0 ? i : fallback
  }
  // 데이터 줄: 첫 열이 [시각]인 줄까지
  const data: string[][] = []
  for (const r of all.slice(first)) {
    if (!atsData(r)) break
    data.push(r)
  }
  // Cycle 열: 'CURRENT TC REPEAT'와 'ITERATION IN JOB' 중 값이 1씩 올라가는 쪽 → 'CYCLE'
  const tcRepeatAt = columnNamed(/^\s*current tc repeat\s*$/i, ATS_TC_REPEAT_COL)
  const iterationAt = columnNamed(/^\s*iteration in job\s*$/i, ATS_ITERATION_COL)
  const cycleAt = pickCycleColumn(data, [tcRepeatAt, iterationAt])
  const columns = ATS_COLUMNS.map((c, i) => (i === ATS_MAPPING.cycle ? cycleAt : c))
  const headers = columns.map((c, i) => (i === ATS_MAPPING.cycle ? 'CYCLE' : (named[c] || ATS_FALLBACK[i]).trim()))
  // R열 DURATION(ms): 스텝이 걸린 시간. Time Stamp는 스텝이 끝난 시각이라(앞 행과의 간격 = 이 행의 DURATION) 시작 = Time Stamp − DURATION
  const durationAt = columnNamed(/^\s*duration\s*$/i, ATS_DURATION_COL)
  // H열 TOTAL TC REPEAT: 계획한 Cycle 수 (Cycle이 TC REPEAT일 때만. ITERATION IN JOB의 총 횟수 열은 없다)
  const totalAt = cycleAt === tcRepeatAt ? columnNamed(/^\s*total tc repeat\s*$/i, ATS_CYCLE_TOTAL_COL) : -1
  let cycleTotal = 0
  const rows: ResultRow[] = []
  for (const r of data) {
    const cells = columns.map((c) => unq(r[c] ?? ''))
    const v = parseTime(cells[0])
    const dur = unq(r[durationAt] ?? '')
    const durationMs = NUMBER.test(dur) ? Number(dur) : null
    const time = v?.kind === 'absolute' ? v.ms - (durationMs ?? 0) : null
    // 표의 시각 칸도 시작 시각으로 (영상 위치와 같게)
    if (time !== null && durationMs) cells[0] = `[${atsStamp(time)}]`
    if (totalAt >= 0) cycleTotal = Math.max(cycleTotal, Number(unq(r[totalAt] ?? '')) || 0)
    rows.push({
      index: rows.length,
      cells,
      time,
      cycle: cells[ATS_MAPPING.cycle],
      // 판정 스텝은 STEP RESULT, 아니면 동작 실패(ACTION CHECK=ERROR)만 결과로
      status: cells[ATS_RESULT_CELL] || (statusTone(cells[ATS_ACTION_CELL]) === 'bad' ? cells[ATS_ACTION_CELL] : ''),
      name: cells[ATS_MAPPING.name],
      durationMs,
      message: cells[ATS_MAPPING.message],
      images: [...new Set(r.join(' ').match(IMAGE_PATH) ?? [])].map((p) => p.replace(/\\\\/g, '\\')),
      ats: atsImages(r),
    })
  }
  const table: TableSpec = {
    // 짧은 열은 내용에 딱 맞게(fit), 긴 열(STATUS·STEP REMARK·DETAIL)이 남는 폭을 나눈다
    columns: 'fit fit fit fit minmax(80px, 1fr) fit minmax(120px, 1.8fr) fit minmax(80px, 1.2fr)',
    compact: true,
    noIndex: true,
    wrapCells: [ATS_CONTROL_CELL],
    noYear: true,
    center: [1, ATS_ACTION_CELL, ATS_RESULT_CELL],
    statusCells: [ATS_RESULT_CELL],
    alertCells: [ATS_ACTION_CELL],
    timeCell: 0,
  }
  return { startTime: startFromPreamble(preamble), preamble, headers, mapping: ATS_MAPPING, timeKind: 'absolute', rows, table, cycleTotal: cycleTotal || null }
}

const IMAGE_FILE = /\.(?:bmp|png|jpe?g|gif|webp)$/i
/** =HYPERLINK("경로") → 경로 */
const hyperlink = (cell: string | undefined) => /HYPERLINK\(\s*"([^"]*)"/i.exec(cell ?? '')?.[1].trim() || null
const unescapePath = (p: string) => p.replace(/\\\\/g, '\\')

/** ATS 행의 이미지: P열(찾을 이미지) · Y열/AA~AC열(REF·DEVICE·DIFF IMAGE) */
function atsImages(r: string[]): AtsImages | undefined {
  const p = unq(r[15] ?? '')
  const target = IMAGE_FILE.test(p) ? unescapePath(p) : null
  const y = r[24] ?? ''
  // Y: IMAGE:(점수?, '원본', '결과', '차이') — 빈 칸('')도 자리를 지킨다
  const tuple = /IMAGE:\(([^)]*)\)/i.exec(y)?.[1] ?? ''
  const quoted = [...tuple.matchAll(/'([^']*)'/g)].map((m) => unescapePath(m[1].trim()))
  const ref = hyperlink(r[26]) ?? (quoted[0] || null)
  const result = hyperlink(r[27]) ?? (quoted[1] || null)
  const diff = hyperlink(r[28]) ?? (quoted[2] || null)
  const yHas = !!(ref || result)
  if (!target && !yHas) return undefined
  return {
    kind: target && yHas ? 'py' : target ? 'p' : 'y',
    target, ref, result, diff,
    note: (y.split(/[\r\n]+/).map((s) => s.trim()).find(Boolean) ?? '').replace(/''$/, ''),
  }
}

const collator = new Intl.Collator('ko', { numeric: true, sensitivity: 'base' })
/** 칸 값 비교 (숫자는 숫자 크기로) */
export const compareCells = (a: string, b: string) => collator.compare(a, b)

// ── RFW (Video_editor_2_result.py와 같은 규칙): 첫 줄이 열 이름, 아래 11개 열이 있어야 한다
export const RFW_COLUMNS = ['Test Name', 'Start Time', 'Cycle Index', 'Cycle Total', 'KW Name', 'Owner', 'Status', 'Elapsed', 'Status Message', 'Message Level', 'Message']
// 화면에 보여 주는 열 (Test Name · Cycle Total · Elapsed는 뺀다)
const RFW_SHOWN = ['Start Time', 'Cycle Index', 'KW Name', 'Owner', 'Status', 'Status Message', 'Message Level', 'Message']
const RFW_MAPPING: ResultMapping = { time: 0, cycle: 1, status: 4, name: 2, duration: -1, message: 7, durationUnit: 's', timeMode: 'absolute' }

/** RFW Result. 필수 열이 없으면 자동 판별로 읽는다 (다른 형식의 CSV) */
export function parseRfw(text: string): ParsedResult {
  const all = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''))
  const head = (all[0] ?? []).map(unq)
  if (RFW_COLUMNS.some((name) => !head.includes(name))) return parseResult(text)
  const source = RFW_SHOWN.map((name) => head.indexOf(name))
  const elapsedAt = head.indexOf('Elapsed')
  const rows: ResultRow[] = all.slice(1).map((r, index) => {
    const cells = source.map((c) => unq(r[c] ?? ''))
    // Start Time: [2026-10-02T13:07:34.900747] → 2026-10-02 13:07:34.900747
    cells[0] = cells[0].replace(/^\[|\]$/g, '').replace('T', ' ')
    const v = parseTime(cells[0])
    const elapsed = unq(r[elapsedAt] ?? '')
    return {
      index,
      cells,
      time: v?.kind === 'absolute' ? v.ms : null,
      cycle: cells[1],
      status: cells[4],
      name: cells[2],
      durationMs: NUMBER.test(elapsed) ? Number(elapsed) * 1000 : null,
      message: cells[7],
      images: [...new Set(r.join(' ').match(IMAGE_PATH) ?? [])].map((p) => p.replace(/\\\\/g, '\\')),
    }
  })
  const table: TableSpec = {
    columns: '178px 52px minmax(110px, 1.4fr) minmax(60px, 0.6fr) 60px minmax(80px, 0.9fr) 62px minmax(130px, 2fr)',
    center: [1, 4, 6],
    statusCells: [4],
    alertCells: [6],
    timeCell: 0,
    pathCells: [7],
    expandCell: 7,
    expandColumns: '178px 30px 72px 40px 44px 48px 40px',
  }
  attachRfwImages(rows, all.slice(1))
  // 계획한 Cycle 수: 'Cycle Total' 열의 가장 큰 값
  const totalAt = head.indexOf('Cycle Total')
  const cycleTotal = all.slice(1).reduce((max, r) => Math.max(max, Number(unq(r[totalAt] ?? '')) || 0), 0) || null
  return { startTime: rows.find((r) => r.time !== null)?.time ?? null, preamble: [], headers: RFW_SHOWN, mapping: RFW_MAPPING, timeKind: 'absolute', rows, table, cycleTotal }
}

/**
 * 내용으로 형식 판별: 첫 줄이 RFW 열 이름이면 RFW, 머리말(Script Name·START TIME) 뒤 첫 열이 [시각]인 줄이 있거나 7번째 줄이 [시각]으로
 * 시작하면 ATS (머리말 줄 수는 파일마다 조금 다르다), 모르면 null
 */
export function detectResultMode(text: string): ResultMode | null {
  const all = parseCsv(text.slice(0, 64 * 1024))
  const head = (all[0] ?? []).map((c) => unq(c.replace(/^﻿/, '')))
  if (RFW_COLUMNS.every((name) => head.includes(name))) return 'rfw'
  const first = all.slice(0, 20).findIndex((r) => /^\[.+\]$/.test(unq(r[0] ?? '')))
  if (first >= 3 && all.slice(0, first).some((r) => /script name|start time/i.test(r.join(',')))) return 'ats'
  if (/^\[.+\]$/.test(unq(all[6]?.[0] ?? ''))) return 'ats'
  return null
}

// RFW 이미지 비교는 여러 행에 나뉘어 적힌다:
//   Compare Images                    <img src=".../Image/20261002_131214_IMG_X.bmp">  (캡처, 실패면 ..._result.bmp)
//   Process Image Comparison Result   : Image Compare Pass|Fail: .../rnavn_project/Image/IMG_X.bmp  (원본)
//   Process Image Comparison Result   <img src=원본><img src=캡처>
//   Log                               : Image compare Result : name=원본, match=99%
// → 행마다 그 행과 앞뒤 행에서 같은 이미지 이름(IMG_X)의 원본·결과·차이를 모은다
const RFW_IMAGE = /[^\s"'<>,()=]+?\.(?:bmp|png|jpe?g)/gi
const STAMP = /^\d{8}_\d{6}_/
const rfwPaths = (r: string[]) =>
  [...new Set(r.join(' ').match(RFW_IMAGE) ?? [])].map((p) => {
    const path = p.replace(/^file:/i, '').replace(/^\/{2,}/, '/')
    return /^[A-Za-z]:/.test(path) ? path.replace(/\\\\/g, '\\') : path
  })
    // 절대 경로만 (HTML 문구 속 './img/bg2.jpg' 같은 상대 경로는 이미지 비교가 아님)
    .filter((p) => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(p))
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p
/** 이미지 이름 (날짜_시각_ 접두사·_result 접미사를 뗀 것, 소문자) */
const imageKey = (p: string) => fileName(p).replace(STAMP, '').replace(/_result(\.\w+)$/i, '$1').toLowerCase()

function attachRfwImages(rows: ResultRow[], raw: string[][]) {
  const paths = raw.map(rfwPaths)
  const notes = raw.map((r) => {
    const m = /(Image compare[^\r\n]*)/i.exec(r.join(' '))
    return m ? m[1].replace(/\s*[:]?\s*(?:name=)?\S+\.(?:bmp|png|jpe?g)/i, '').trim() : ''
  })
  rows.forEach((row, i) => {
    const own = paths[i] ?? []
    if (own.length === 0) return
    const keys = new Set(own.map(imageKey))
    let ref: string | null = null
    let result: string | null = null
    let diff: string | null = null
    let note = ''
    for (let k = Math.max(0, i - 3); k <= Math.min(rows.length - 1, i + 3); k++) {
      if (rows[k].cycle !== row.cycle) continue
      const near = (paths[k] ?? []).filter((p) => keys.has(imageKey(p)))
      if (near.length === 0) continue
      for (const p of near) {
        const name = fileName(p)
        if (!STAMP.test(name)) ref ??= p
        else if (/_result\.\w+$/i.test(name)) diff ??= p
        else result ??= p
      }
      if (!note && notes[k]) note = notes[k]
    }
    if (!ref && !result && !diff) return
    row.ats = {
      kind: result || diff ? 'y' : 'p',
      target: null,
      ref,
      result: result ?? diff,
      diff,
      note,
      label: result || diff ? '이미지 비교' : '이미지 일치 확인',
    }
  })
}
