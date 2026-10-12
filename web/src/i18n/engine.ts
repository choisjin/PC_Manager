/*
 * 화면 언어 (한국어 ↔ English) — APMS ui/apms-i18n.js 와 같은 방식.
 * - 언어: localStorage 'appLang' ('ko' | 'en'). 다른 탭에서 바꾸면 storage 이벤트로 따라가고,
 *   APMS 포털 안(iframe)에서는 postMessage { apmsLang } 도 받는다.
 * - 사전 키는 화면에 나오는 한국어 원문 그대로 (공백은 한 칸으로 줄여 비교). 숫자·이름이 끼는 글은 정규식.
 * - English 일 때 화면 글자 · 툴팁(title) · 입력 안내(placeholder) · aria-label · alt · optgroup label 과
 *   alert · confirm · prompt 문구를 사전대로 바꾸고, 한국어로 돌아오면 원문으로 되돌린다.
 * - 바꾸지 않는 곳: translate="no" 인 영역(파일 이름 · PC 이름 · 채팅 등 사용자 데이터), 입력 값, textarea, 편집 가능한 칸.
 * - 사전에 없는 글은 원문 그대로 (사용자 데이터가 우연히 바뀌지 않게 전체 일치만 쓴다).
 * - React 가 그린 글자 노드는 같은 노드의 값만 바꾸므로 React 의 다음 갱신과 충돌하지 않는다 (innerHTML 통째 교체는 쓰지 않음).
 */

export type Lang = 'ko' | 'en'
type Replacement = string | ((...args: string[]) => string)

const LANG_KEY = 'appLang'
const HANGUL = /[가-힣ㄱ-ㆎ]/
const ATTRS = ['title', 'placeholder', 'aria-label', 'alt', 'label']
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'TEMPLATE'])

const EXACT = new Map<string, string>()
const PATTERNS: [RegExp, Replacement][] = []
const textState = new WeakMap<Text, { src: string; out: string }>()
const attrState = new WeakMap<Element, Record<string, { src: string; out: string }>>()
const listeners: ((lang: Lang) => void)[] = []
let titleSrc: string | null = null

function readLang(): Lang {
  try {
    return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ko'
  } catch {
    return 'ko'
  }
}
let lang: Lang = readLang()

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const keepEdges = (s: string, v: string) => (s.match(/^\s*/)?.[0] ?? '') + v + (s.match(/\s*$/)?.[0] ?? '')

// 한 줄 옮기기: 앞뒤 공백은 그대로, 가운데 글자는 사전 → 정규식 순서.
// 정규식이 잡은 조각($1 …)도 사전에 있으면 옮긴다 ("저장 실패: <서버 메시지>" 의 서버 메시지 등)
let depth = 0
function trLine(s: string): string {
  if (!HANGUL.test(s)) return s
  const core = norm(s)
  let v = EXACT.get(core)
  if (v === undefined && depth < 3) {
    for (const [re, rep] of PATTERNS) {
      re.lastIndex = 0
      if (!re.test(core)) continue
      re.lastIndex = 0
      depth++
      try {
        v =
          typeof rep === 'function'
            ? core.replace(re, rep)
            : core.replace(re, (...args: unknown[]) => {
                const groups = args.slice(1, -2).filter((g) => typeof g !== 'object') as (string | undefined)[]
                return rep.replace(/\$(\d+)|\$\$/g, (m, n: string) => {
                  if (m === '$$') return '$'
                  const x = groups[Number(n) - 1]
                  return x === undefined ? '' : HANGUL.test(x) ? trLine(x) : x
                })
              })
      } finally {
        depth--
      }
      break
    }
  }
  return v === undefined ? s : keepEdges(s, v)
}

/** 글 옮기기 (English 일 때만). 여러 줄이면 통째로 사전 → 없으면 줄마다 */
export function tr(s: string): string
export function tr(s: string | null | undefined): string | null | undefined
export function tr(s: string | null | undefined) {
  if (lang !== 'en' || s === null || s === undefined) return s
  s = String(s)
  if (!HANGUL.test(s)) return s
  if (!s.includes('\n')) return trLine(s)
  const whole = EXACT.get(norm(s))
  if (whole !== undefined) return keepEdges(s, whole)
  return s.split('\n').map(trLine).join('\n')
}

// 화면 글자: 줄바꿈은 보통 들여쓰기라 공백과 같다 → 통째로 → 없으면 줄마다
function trText(s: string) {
  if (lang !== 'en' || !HANGUL.test(s)) return s
  const whole = trLine(s)
  if (whole !== s || !s.includes('\n')) return whole
  return s.split('\n').map(trLine).join('\n')
}

const skipped = (el: Element | null) =>
  !el || SKIP_TAGS.has(el.tagName) || (el as HTMLElement).translate === false || (el as HTMLElement).isContentEditable

function doText(node: Text) {
  const cur = node.nodeValue ?? ''
  const st = textState.get(node)
  if (st && cur === st.out) return
  if (!HANGUL.test(cur)) return
  if (skipped(node.parentElement)) return
  const out = trText(cur)
  if (out === cur) return
  textState.set(node, { src: cur, out })
  node.nodeValue = out
}

function doAttrs(el: Element) {
  let m = attrState.get(el)
  for (const a of ATTRS) {
    const v = el.getAttribute(a)
    if (!v || !HANGUL.test(v)) continue
    if (m?.[a]?.out === v) continue
    const out = tr(v)
    if (out === v) continue
    if (!m) attrState.set(el, (m = {}))
    m[a] = { src: v, out }
    el.setAttribute(a, out)
  }
  if (el instanceof HTMLInputElement && /^(button|submit|reset)$/i.test(el.type)) {
    const val = el.value
    if (val && HANGUL.test(val) && m?.value?.out !== val) {
      const out = tr(val)
      if (out !== val) {
        if (!m) attrState.set(el, (m = {}))
        m.value = { src: val, out }
        el.value = out
      }
    }
  }
}

function translateTree(root: Node | null) {
  if (lang !== 'en' || !root) return
  if (root.nodeType === Node.TEXT_NODE) {
    doText(root as Text)
    return
  }
  if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
  if (root.nodeType === Node.ELEMENT_NODE) {
    if (skipped(root as Element)) return
    doAttrs(root as Element)
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
      if (skipped(n as Element)) return NodeFilter.FILTER_REJECT // 아래도 건너뜀
      doAttrs(n as Element)
      return NodeFilter.FILTER_ACCEPT
    },
  })
  let t: Node | null
  while ((t = walker.nextNode())) if (t.nodeType === Node.TEXT_NODE) doText(t as Text)
}

function restoreTree(root: Node | null) {
  if (!root) return
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT)
  const list: Node[] = [root]
  let n: Node | null
  while ((n = walker.nextNode())) list.push(n)
  for (const x of list) {
    if (x.nodeType === Node.TEXT_NODE) {
      const st = textState.get(x as Text)
      if (st && x.nodeValue === st.out) x.nodeValue = st.src
      textState.delete(x as Text)
      continue
    }
    if (x.nodeType !== Node.ELEMENT_NODE) continue
    const el = x as Element
    const m = attrState.get(el)
    if (!m) continue
    for (const a of Object.keys(m)) {
      if (a === 'value') {
        if (el instanceof HTMLInputElement && el.value === m.value.out) el.value = m.value.src
      } else if (el.getAttribute(a) === m[a].out) el.setAttribute(a, m[a].src)
    }
    attrState.delete(el)
  }
}

const inNoTranslate = (n: Node) => !!n.parentElement?.closest('[translate="no"]')

const observer = new MutationObserver((records) => {
  if (lang !== 'en') return
  for (const m of records) {
    if (m.type === 'childList') {
      m.addedNodes.forEach((n) => {
        if (n.isConnected && !inNoTranslate(n)) translateTree(n)
      })
    } else if (m.type === 'characterData') {
      if (!inNoTranslate(m.target)) doText(m.target as Text)
    } else if (m.type === 'attributes') {
      const el = m.target as Element
      if (!el.closest('[translate="no"]')) doAttrs(el)
    }
  }
})
let watching = false
function watch(on: boolean) {
  if (on && !watching) {
    observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS })
    watching = true
  } else if (!on && watching) {
    observer.disconnect()
    watching = false
  }
}

function applyTitle() {
  if (lang === 'en') {
    if (titleSrc === null && HANGUL.test(document.title)) titleSrc = document.title
    if (titleSrc !== null) document.title = tr(titleSrc)
  } else if (titleSrc !== null) {
    document.title = titleSrc
    titleSrc = null
  }
}

function apply() {
  document.documentElement.lang = lang
  if (lang === 'en') {
    translateTree(document.body)
    watch(true)
  } else {
    watch(false)
    restoreTree(document.body)
  }
  applyTitle()
}

export function getLang(): Lang {
  return lang
}

export function setLang(next: Lang) {
  const l: Lang = next === 'en' ? 'en' : 'ko'
  try {
    localStorage.setItem(LANG_KEY, l)
  } catch {
    // 무시
  }
  if (l === lang) return
  lang = l
  if (document.body) apply()
  for (const fn of listeners) {
    try {
      fn(lang)
    } catch {
      // 무시
    }
  }
}

export function onLangChange(fn: (lang: Lang) => void) {
  listeners.push(fn)
  return () => {
    const i = listeners.indexOf(fn)
    if (i >= 0) listeners.splice(i, 1)
  }
}

// 사전을 등록하면 화면을 다시 옮긴다 — 등록이 끝난 뒤 한 번에
let pending = false
function retranslateSoon() {
  if (pending || lang !== 'en' || !document.body) return
  pending = true
  setTimeout(() => {
    pending = false
    if (lang === 'en') translateTree(document.body)
  }, 0)
}

/** 글자 그대로 사전 (같은 키는 먼저 등록한 것이 이긴다) */
export function addExact(map: Record<string, string>) {
  for (const [k, v] of Object.entries(map)) {
    const n = norm(k)
    if (!EXACT.has(n)) EXACT.set(n, v)
  }
  retranslateSoon()
}

/** 숫자 · 이름이 끼는 글 (정규식, ^…$ 로 전체 일치). 등록 순서대로 */
export function addPatterns(list: [RegExp, Replacement][]) {
  PATTERNS.push(...list)
  retranslateSoon()
}

/** 검사용: 화면에 남은 한국어 (translate="no" · 입력 값 제외) — 콘솔에서 window.pcmI18nLeftovers() */
export function leftovers(root: Node = document.body) {
  const out: string[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT
      return skipped(n as Element) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    },
  })
  let n: Node | null
  while ((n = walker.nextNode())) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (HANGUL.test(n.nodeValue ?? '')) out.push(norm(n.nodeValue ?? ''))
    } else {
      for (const a of ATTRS) {
        const v = (n as Element).getAttribute(a)
        if (v && HANGUL.test(v)) out.push(`[${a}] ${norm(v)}`)
      }
    }
  }
  return [...new Set(out)]
}

// 대화상자 문구
const nativeAlert = window.alert.bind(window)
const nativeConfirm = window.confirm.bind(window)
const nativePrompt = window.prompt.bind(window)
window.alert = (m?: unknown) => nativeAlert(tr(m === undefined ? '' : String(m)))
window.confirm = (m?: string) => nativeConfirm(tr(m ?? ''))
window.prompt = (m?: string, d?: string) => (d === undefined ? nativePrompt(tr(m ?? '')) : nativePrompt(tr(m ?? ''), d))

window.addEventListener('storage', (e) => {
  if (e.key === LANG_KEY) setLang(e.newValue === 'en' ? 'en' : 'ko')
})
window.addEventListener('message', (e) => {
  const v = (e.data as { apmsLang?: string } | null)?.apmsLang
  if (v === 'en' || v === 'ko') setLang(v)
})
;(window as unknown as { pcmI18nLeftovers: typeof leftovers }).pcmI18nLeftovers = leftovers

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', apply)
else setTimeout(apply, 0)
