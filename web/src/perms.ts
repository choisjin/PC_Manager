import { createContext, useContext } from 'react'

/** 사람별로 켜고 끄는 기능 (서버 Services/Features.cs 와 같게). 프로젝트 관리자는 전부 */
export const FEATURES = [
  { id: 'files', label: 'PC Manager', hint: 'PC Manager 탭 (파일 탐색)' },
  { id: 'state', label: 'State', hint: 'State 탭' },
  { id: 'history', label: 'History', hint: 'History 탭' },
  { id: 'fileWrite', label: '파일 변경', hint: '새 폴더·붙여넣기·이동·이름 바꾸기·삭제·올리기·압축·편집 저장' },
  { id: 'download', label: '가져오기', hint: '가져오기(다운로드)·다운로드 링크·내 PC 프로그램으로 열기' },
  { id: 'remote', label: '원격조작', hint: '원격조작' },
  { id: 'terminal', label: '터미널', hint: '터미널' },
  { id: 'results', label: '결과 확인', hint: '결과 확인' },
  { id: 'pcManage', label: 'PC 관리', hint: 'PC 상태·별칭·PIN·PC 목록 폴더·프로젝트 배정·목록에서 삭제' },
] as const

export type Feature = (typeof FEATURES)[number]['id']

/** 로그인한 사용자가 쓸 수 있는 기능 (화면에서만 숨긴다) */
export const PermsContext = createContext<ReadonlySet<string>>(new Set(FEATURES.map((f) => f.id)))

export function useCan() {
  const perms = useContext(PermsContext)
  return (feature: Feature) => perms.has(feature)
}
