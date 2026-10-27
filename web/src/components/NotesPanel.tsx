import { useCallback, useEffect, useRef, useState } from 'react'
import { api, type Note } from '../api'
import type { NoteEvent } from '../useDashboard'
import { openNotesTab, updateNotesTab } from './notesTab'

interface Props {
  selfUserId: string | null
  nameOf: (userId: string) => string
  subscribeNotes: (listener: (event: NoteEvent) => void) => () => void
  /** 메모 탭: 처음 열 메모 */
  initialNoteId?: string | null
  /** 메모 탭(새 브라우저 탭에 크게): 고른 메모를 주소·탭 제목에 적고, 새 탭으로 열기는 뺀다 */
  page?: boolean
}

type Scope = Note['scope']
type SaveState = 'saved' | 'dirty' | 'saving' | 'error'

const SCOPE_KEY = 'pcm.notes.scope'
const SAVE_DELAY = 800
// 올릴 때 이 크기(긴 변)보다 크면 줄인다
const MAX_IMAGE_SIDE = 1600
const KEEP_ORIGINAL_BYTES = 1.5 * 1024 * 1024
const IMAGE_PREFIX = '/api/notes/images/'

// 메모 HTML에 남길 태그. 나머지는 글자만 남기고 벗긴다 (다른 사람이 쓴 공유 메모를 그대로 넣으므로)
const ALLOWED = new Set(['DIV', 'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'UL', 'OL', 'LI', 'IMG', 'SPAN', 'H1', 'H2', 'H3', 'BLOCKQUOTE', 'PRE', 'CODE'])
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'LINK', 'META', 'TEMPLATE', 'SVG', 'MATH'])

function sanitizeNoteHtml(html: string): string {
  const doc = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html')
  const walk = (parent: Element) => {
    for (const el of Array.from(parent.children)) {
      if (DROP.has(el.tagName)) {
        el.remove()
        continue
      }
      walk(el)
      if (!ALLOWED.has(el.tagName)) {
        el.replaceWith(...Array.from(el.childNodes))
        continue
      }
      for (const attr of Array.from(el.attributes)) {
        if (!(el.tagName === 'IMG' && attr.name === 'src' && attr.value.startsWith(IMAGE_PREFIX))) el.removeAttribute(attr.name)
      }
      if (el.tagName === 'IMG' && !el.getAttribute('src')) el.remove()
    }
  }
  walk(doc.body)
  return doc.body.innerHTML
}

/** 목록 제목: 내용 첫 줄 */
const titleOf = (editor: HTMLElement) =>
  (editor.innerText.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '').slice(0, 80)

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

const timeText = (iso: string) => {
  const d = new Date(iso)
  const now = new Date()
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('ko-KR', { month: 'numeric', day: 'numeric' })
}

/** 큰 이미지는 긴 변 MAX_IMAGE_SIDE로 줄여 JPEG로 (투명 부분은 흰색). 작은 이미지·GIF는 그대로 */
async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file
  const bitmap = await createImageBitmap(file)
  try {
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height))
    if (scale === 1 && file.size <= KEEP_ORIGINAL_BYTES && ['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return file
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * scale)
    canvas.height = Math.round(bitmap.height * scale)
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('이미지를 변환하지 못했습니다.'))), 'image/jpeg', 0.85))
  } finally {
    bitmap.close()
  }
}

/** 편집기 커서 위치에 노드 넣기 (커서가 편집기 밖이면 끝에) */
function insertAtCaret(editor: HTMLElement, node: Node) {
  const selection = window.getSelection()
  let range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  if (!range || !editor.contains(range.commonAncestorContainer)) {
    range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(false)
  }
  range.deleteContents()
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection?.removeAllRanges()
  selection?.addRange(range)
}

// 사이드바·PiP에서 마지막으로 열어 둔 메모: 사이드바 탭을 바꾸거나 접어 패널이 다시 붙어도 그 메모를 다시 연다
let lastOpenNote: string | null = null

/** 사이드바·PiP '메모' 탭과 메모 탭: 왼쪽 목록(공유·개인), 오른쪽 내용. 고치면 잠시 뒤 자동 저장 */
export function NotesPanel({ selfUserId, nameOf, subscribeNotes, initialNoteId = null, page = false }: Props) {
  const [notes, setNotes] = useState<Note[]>([])
  const [scope, setScope] = useState<Scope>(() => {
    try {
      return localStorage.getItem(SCOPE_KEY) === 'personal' ? 'personal' : 'shared'
    } catch {
      return 'shared'
    }
  })
  const [activeId, setActiveId] = useState<string | null>(null)
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [error, setError] = useState<string | null>(null)
  // 고치는 중에 다른 곳에서 바뀐 최신 메모 (덮어쓸지 불러올지 고른다)
  const [conflict, setConflict] = useState<Note | null>(null)
  const [uploading, setUploading] = useState(0)
  const [viewer, setViewer] = useState<{ src: string; actual: boolean } | null>(null)

  const editorRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 편집 중인 메모의 기준 버전(수정 시각)과 저장 대기
  const baseRef = useRef<{ id: string; updatedAt: string } | null>(null)
  const dirtyRef = useRef(false)
  // 마지막으로 고친 내용 (창을 닫아 편집기가 사라진 뒤에도 저장할 수 있게)
  const draftRef = useRef<{ html: string; title: string } | null>(null)
  const timerRef = useRef(0)
  const savingRef = useRef<Promise<void> | null>(null)
  const notesRef = useRef<Note[]>([])
  useEffect(() => {
    notesRef.current = notes
  }, [notes])

  const active = notes.find((n) => n.id === activeId) ?? null
  const visibleNotes = notes.filter((n) => n.scope === scope)

  // 처음 열 메모: 메모 탭은 주소의 메모, 사이드바·PiP는 마지막으로 열어 둔 메모(못 찾아도 알리지 않음). 서버에서 목록을 받은 뒤 한 번
  // (목록이 처음 바뀔 때 보면, 그 전에 변경 알림으로 메모 하나만 들어온 목록에서 찾다 못 찾는다)
  const pendingRef = useRef<{ id: string; quiet: boolean } | null>(
    initialNoteId ? { id: initialNoteId, quiet: false } : !page && lastOpenNote ? { id: lastOpenNote, quiet: true } : null,
  )
  const openPendingRef = useRef<(list: Note[]) => void>(() => {})
  const load = useCallback(() => {
    if (!selfUserId) return
    api.notes(selfUserId).then((list) => {
      setNotes(list)
      openPendingRef.current(list)
    }).catch((err) => setError(toMessage(err)))
  }, [selfUserId])
  useEffect(() => {
    setNotes([])
    setActiveId(null)
    load()
  }, [load])

  /** 편집기에 메모 내용 넣기 (기준 버전도 바꾼다) */
  const showNote = (note: Note | null) => {
    baseRef.current = note ? { id: note.id, updatedAt: note.updatedAt } : null
    dirtyRef.current = false
    draftRef.current = null
    setConflict(null)
    setSaveState('saved')
    if (editorRef.current) editorRef.current.innerHTML = note ? sanitizeNoteHtml(note.content) : ''
  }

  const save = useCallback(async (force = false): Promise<void> => {
    clearTimeout(timerRef.current)
    const editor = editorRef.current
    const base = baseRef.current
    if (editor) draftRef.current = { html: editor.innerHTML, title: titleOf(editor) }
    const draft = draftRef.current
    if (!draft || !base || (!dirtyRef.current && !force)) return
    if (savingRef.current) {
      await savingRef.current
      return save(force)
    }
    dirtyRef.current = false
    setSaveState('saving')
    const html = sanitizeNoteHtml(draft.html)
    const work = (async () => {
      try {
        const result = await api.updateNote(base.id, draft.title, html, base.updatedAt)
        if (result.conflict) {
          dirtyRef.current = true
          setConflict(result.conflict)
          setSaveState('dirty')
          return
        }
        if (baseRef.current?.id === base.id) baseRef.current = { id: base.id, updatedAt: result.note.updatedAt }
        setNotes((prev) => prev.map((n) => (n.id === result.note.id ? result.note : n)))
        setSaveState(dirtyRef.current ? 'dirty' : 'saved')
      } catch (err) {
        dirtyRef.current = true
        setSaveState('error')
        setError(toMessage(err))
      }
    })()
    savingRef.current = work
    await work
    savingRef.current = null
  }, [])

  const scheduleSave = () => {
    const editor = editorRef.current
    if (editor) draftRef.current = { html: editor.innerHTML, title: titleOf(editor) }
    dirtyRef.current = true
    setSaveState('dirty')
    clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => void save(), SAVE_DELAY)
  }

  // 다른 곳(다른 사람·다른 창)의 변경 반영
  useEffect(
    () =>
      subscribeNotes((event) => {
        if (event.reconnected) {
          load()
          return
        }
        if (event.removedId) {
          setNotes((prev) => prev.filter((n) => n.id !== event.removedId))
          if (baseRef.current?.id === event.removedId) {
            setActiveId(null)
            showNote(null)
            setError('보고 있던 메모가 다른 곳에서 삭제됐습니다.')
          }
          return
        }
        const note = event.note
        if (!note) return
        setNotes((prev) => [note, ...prev.filter((n) => n.id !== note.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)))
        const base = baseRef.current
        if (base?.id !== note.id || note.updatedAt <= base.updatedAt) return
        // 지금 저장 중인 내 변경이 먼저 알림으로 돌아온 것 → 저장 응답이 기준 버전을 맞춘다
        if (savingRef.current && note.updatedBy === selfUserId) return
        // 다른 곳에서 고친 것
        if (dirtyRef.current || savingRef.current) setConflict(note)
        else showNote(note)
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [subscribeNotes, load],
  )

  // 창을 닫거나 다른 메모로 갈 때 저장
  useEffect(() => () => void save(), [save])

  const open = async (note: Note) => {
    if (note.id === activeId) return
    await save()
    setActiveId(note.id)
    showNote(note)
  }

  const changeScope = (next: Scope) => {
    setScope(next)
    try {
      localStorage.setItem(SCOPE_KEY, next)
    } catch {
      // 무시
    }
  }

  openPendingRef.current = (list: Note[]) => {
    const p = pendingRef.current
    if (!p) return
    pendingRef.current = null
    const note = list.find((n) => n.id === p.id)
    if (!note) {
      if (!p.quiet) setError('열 메모를 찾지 못했습니다 (지워졌거나 볼 수 없는 메모입니다).')
      if (page) updateNotesTab(null)
      return
    }
    if (note.scope !== scope) changeScope(note.scope)
    setActiveId(note.id)
    showNote(note)
  }
  // 메모 탭: 고른 메모를 주소(F5로 다시 열면 그 메모)·탭 제목에. 사이드바·PiP: 마지막으로 연 메모를 기억 (처음 열 메모를 열기 전에는 그대로)
  useEffect(() => {
    if (pendingRef.current) return
    if (page) updateNotesTab(activeId)
    else lastOpenNote = activeId
  }, [page, activeId])
  // 탭을 닫거나 새로 고칠 때 저장 대기 중이면: 바로 저장을 시작하고 떠날지 묻게 한다 (저장 전에 닫히면 마지막에 고친 내용이 사라진다)
  useEffect(() => {
    const onLeave = (e: BeforeUnloadEvent) => {
      if (!dirtyRef.current && !savingRef.current) return
      void save()
      e.preventDefault()
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [save])
  const activeTitle = active ? active.title || '빈 메모' : null
  useEffect(() => {
    if (page) document.title = `📝 ${activeTitle ?? 'RemoteKit'}`
  }, [page, activeTitle])

  /** 새 브라우저 탭에서 크게 (고치던 내용은 먼저 저장 — 새 탭은 서버에서 읽는다) */
  const openInTab = (noteId: string | null) => {
    void save()
    if (!openNotesTab(noteId)) setError('새 탭을 열지 못했습니다 (팝업 차단). 이 사이트의 팝업을 허용해 주세요.')
  }

  const create = async () => {
    setError(null)
    try {
      await save()
      const note = await api.createNote(scope)
      setNotes((prev) => [note, ...prev.filter((n) => n.id !== note.id)])
      setActiveId(note.id)
      showNote(note)
      editorRef.current?.focus()
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const remove = async () => {
    if (!active) return
    const label = active.title || '빈 메모'
    if (!window.confirm(`'${label}' 메모를 삭제할까요?${active.scope === 'shared' ? '\n공유 메모라 모두에게서 사라집니다.' : ''}`)) return
    clearTimeout(timerRef.current)
    dirtyRef.current = false
    try {
      await api.deleteNote(active.id)
      setNotes((prev) => prev.filter((n) => n.id !== active.id))
      setActiveId(null)
      showNote(null)
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const resolveConflict = (keepMine: boolean) => {
    if (!conflict) return
    if (keepMine) {
      // 최신 버전을 기준으로 내 내용을 덮어쓴다
      baseRef.current = { id: conflict.id, updatedAt: conflict.updatedAt }
      setConflict(null)
      void save(true)
    } else {
      showNote(conflict)
    }
  }

  const addImages = async (files: File[]) => {
    const editor = editorRef.current
    if (!editor || files.length === 0) return
    setError(null)
    for (const file of files) {
      setUploading((n) => n + 1)
      try {
        const { url } = await api.uploadNoteImage(await shrinkImage(file))
        const img = document.createElement('img')
        img.src = url
        img.alt = ''
        insertAtCaret(editor, img)
        scheduleSave()
      } catch (err) {
        setError(`이미지를 넣지 못했습니다: ${toMessage(err)}`)
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  const imageFiles = (data: DataTransfer | null) => Array.from(data?.files ?? []).filter((f) => f.type.startsWith('image/'))

  const onPaste = (e: React.ClipboardEvent) => {
    const images = imageFiles(e.clipboardData)
    e.preventDefault()
    if (images.length > 0) {
      void addImages(images)
      return
    }
    // 다른 곳의 서식(HTML)은 가져오지 않고 글자만
    const text = e.clipboardData.getData('text/plain')
    if (text) document.execCommand('insertText', false, text)
  }

  const onDrop = (e: React.DragEvent) => {
    const images = imageFiles(e.dataTransfer)
    if (images.length === 0) return
    e.preventDefault()
    // 놓은 자리에 넣는다
    const range = document.caretRangeFromPoint?.(e.clientX, e.clientY)
    if (range) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(range)
    }
    void addImages(images)
  }

  const onEditorClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.tagName === 'IMG') setViewer({ src: (target as HTMLImageElement).src, actual: false })
  }

  useEffect(() => {
    if (!viewer) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setViewer(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [viewer])

  if (!selfUserId) return <div className="pip-empty muted small">사용자를 선택(로그인)하면 메모를 쓸 수 있습니다</div>

  const statusText =
    uploading > 0 ? '이미지 올리는 중…' : saveState === 'saving' ? '저장 중…' : saveState === 'dirty' ? '고치는 중' : saveState === 'error' ? '저장 실패' : active ? `${timeText(active.updatedAt)} · ${nameOf(active.updatedBy)}` : ''

  return (
    <div className={`chat-panel notes-panel${page ? ' notes-page-panel' : ''}`}>
      <aside className="chat-rooms">
        <span className="segmented notes-scope" role="radiogroup" aria-label="메모 종류">
          <button type="button" role="radio" aria-checked={scope === 'shared'} className={scope === 'shared' ? 'active' : ''} onClick={() => changeScope('shared')}>
            공유 {notes.filter((n) => n.scope === 'shared').length}
          </button>
          <button type="button" role="radio" aria-checked={scope === 'personal'} className={scope === 'personal' ? 'active' : ''} onClick={() => changeScope('personal')}>
            개인 {notes.filter((n) => n.scope === 'personal').length}
          </button>
        </span>
        <button type="button" className="chat-new" onClick={() => void create()}>
          ＋ 새 {scope === 'shared' ? '공유' : '개인'} 메모
        </button>
        {visibleNotes.length === 0 && <div className="pip-empty muted small">{scope === 'shared' ? '모두가 보고 고치는 메모가 없습니다' : '나만 보는 메모가 없습니다'}</div>}
        {visibleNotes.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`chat-room-item${n.id === activeId ? ' active' : ''}`}
            onClick={() => void open(n)}
            title={n.title || '빈 메모'}
          >
            <span className="chat-room-icon" aria-hidden="true">{n.scope === 'shared' ? '📝' : '🔒'}</span>
            <span className="chat-room-text">
              <span className="chat-room-name ellipsis">{n.title || <span className="muted">빈 메모</span>}</span>
              <span className="chat-room-last ellipsis muted">
                {timeText(n.updatedAt)}
                {n.scope === 'shared' ? ` · ${nameOf(n.updatedBy)}` : ''}
              </span>
            </span>
          </button>
        ))}
      </aside>

      <section className="chat-main">
        {!active ? (
          <div className="pip-empty muted small">
            왼쪽에서 메모를 고르거나 ＋ 새 메모를 만드세요
            {!page && (
              <>
                {' · '}
                <button type="button" className="link small" onClick={() => openInTab(null)}>새 탭에서 크게 보기</button>
              </>
            )}
          </div>
        ) : (
          <div className="chat-main-head">
            <span className="chat-main-title ellipsis">
              {active.scope === 'shared' ? '📝 ' : '🔒 '}
              {active.title || '빈 메모'}
            </span>
            <span className="small muted notes-status">{statusText}</span>
            <button type="button" className="chat-head-btn" title="이미지 넣기 (붙여넣기·끌어다 놓기도 됩니다)" onClick={() => fileRef.current?.click()}>
              🖼
            </button>
            {!page && (
              <button type="button" className="chat-head-btn" title="새 탭으로 열기" aria-label="새 탭으로 열기" onClick={() => openInTab(active.id)}>
                ↗
              </button>
            )}
            <button type="button" className="chat-head-btn danger" title="삭제" onClick={() => void remove()}>
              삭제
            </button>
          </div>
        )}
        {conflict && (
          <div className="notes-conflict small">
            {nameOf(conflict.updatedBy)}님이 이 메모를 먼저 고쳤습니다.
            <button type="button" className="chat-head-btn" onClick={() => resolveConflict(false)}>
              그 내용 불러오기
            </button>
            <button type="button" className="chat-head-btn danger" onClick={() => resolveConflict(true)}>
              내 내용으로 덮어쓰기
            </button>
          </div>
        )}
        {error && (
          <div className="chat-error small" onClick={() => setError(null)} title="클릭해서 닫기">
            {error}
          </div>
        )}
        {/* 편집기는 항상 두고 숨긴다 (내용은 showNote가 직접 넣는다) */}
        <div
          ref={editorRef}
          className="note-editor"
          hidden={!active}
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          data-placeholder="내용을 입력하세요. 이미지는 붙여넣기(Ctrl+V)·끌어다 놓기로 넣고, 클릭하면 크게 봅니다."
          onInput={scheduleSave}
          onBlur={() => void save()}
          onPaste={onPaste}
          onDrop={onDrop}
          onClick={onEditorClick}
        />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            void addImages(Array.from(e.target.files ?? []))
            e.target.value = ''
          }}
        />
      </section>

      {viewer && (
        <div className="note-viewer" onClick={() => setViewer(null)} title="클릭하거나 Esc로 닫기">
          <img
            src={viewer.src}
            alt=""
            className={viewer.actual ? 'actual' : ''}
            title={viewer.actual ? '클릭: 화면에 맞추기' : '클릭: 원래 크기'}
            onClick={(e) => {
              e.stopPropagation()
              setViewer({ ...viewer, actual: !viewer.actual })
            }}
          />
        </div>
      )}
    </div>
  )
}
