import { createContext, useContext } from 'react'
import type { PcGroups } from './api'

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

/** 폴더 권한에서 미분류 PC(폴더에 넣지 않은 PC)를 가리키는 id (서버 OrgStore.UngroupedFolder 와 같게) */
export const UNGROUPED_FOLDER = 'ungrouped'

/**
 * PC 목록 폴더 권한 (관리자가 Setting › 인원 권한에서 사람마다 고름, 기본 모든 폴더).
 * 고른 폴더의 PC만 보이고, 고른 폴더의 상위 폴더는 길(이름)로만 보인다. 화면에서만 숨긴다
 */
export interface FolderAccess {
  /** 고른 폴더만 보는 사람 */
  limited: boolean
  /** 그 폴더 안의 PC를 볼 수 있는지 (UNGROUPED_FOLDER = 미분류 PC) */
  opens: (folderId: string) => boolean
  /** 폴더 줄을 그릴지: 볼 수 있는 폴더와, 그 아래에 볼 수 있는 폴더가 있는 상위 폴더 */
  shows: (folderId: string) => boolean
  /** 그 PC가 보이는지: 들어 있는 폴더(없으면 미분류)를 볼 수 있는지 */
  showsAgent: (agentId: string) => boolean
}

export const ALL_FOLDERS: FolderAccess = { limited: false, opens: () => true, shows: () => true, showsAgent: () => true }

/** allowed: 볼 수 있는 폴더 id (null·undefined = 모든 폴더) */
export function folderAccess(groups: PcGroups, allowed: readonly string[] | null | undefined): FolderAccess {
  if (!allowed) return ALL_FOLDERS
  const open = new Set(allowed)
  const byId = new Map(groups.folders.map((f) => [f.id, f]))
  const shown = new Set<string>()
  for (const id of open) {
    for (let f = byId.get(id); f && !shown.has(f.id); f = f.parentId ? byId.get(f.parentId) : undefined) shown.add(f.id)
  }
  const folderOf = (agentId: string) => {
    const id = groups.assignments[agentId]
    return id && byId.has(id) ? id : UNGROUPED_FOLDER
  }
  return {
    limited: true,
    opens: (id) => open.has(id),
    shows: (id) => shown.has(id),
    showsAgent: (agentId) => open.has(folderOf(agentId)),
  }
}

export const FolderAccessContext = createContext<FolderAccess>(ALL_FOLDERS)

export const useFolderAccess = () => useContext(FolderAccessContext)
