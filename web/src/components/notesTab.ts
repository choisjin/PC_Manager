// 메모를 새 브라우저 탭(?notes=<메모 id>, 비우면 목록만)에서 크게 연다. 메모 탭에서 다른 메모를 고르면 주소도 바꾼다 (F5로 다시 열면 그 메모)

/** 이 탭이 메모 탭이면 처음 열 메모 id ('' = 목록만), 대시보드면 null */
export const NOTES_TAB: string | null = (() => {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  return params.has('notes') ? params.get('notes') ?? '' : null
})()

const notesUrl = (noteId: string | null) => `${window.location.pathname}?notes=${encodeURIComponent(noteId ?? '')}`

/**
 * 메모 탭을 연다. 누른 직후(동기)에 불러야 팝업 차단에 걸리지 않는다
 * @returns 새 탭을 열지 못했으면(팝업 차단) false
 */
export function openNotesTab(noteId: string | null): boolean {
  return window.open(notesUrl(noteId), '_blank') !== null
}

/** 메모 탭에서 고른 메모를 주소에 적는다 */
export function updateNotesTab(noteId: string | null) {
  window.history.replaceState(null, '', notesUrl(noteId) + window.location.hash)
}
