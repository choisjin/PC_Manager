// 인원 권한 › PC 폴더: 이 프로젝트에서 고를 수 있는 PC 목록 폴더 트리와 표에 보일 글
import type { Agent, Org, PcGroups } from '../api'
import { UNGROUPED_FOLDER } from '../perms'
import { buildTree, type FolderNode } from './explorer/pcGroups'
import { projectAgents } from './remote/remotePcs'

/** 이 프로젝트에서 보이는 PC 목록 폴더 (다른 프로젝트에 배정된 폴더는 아래 폴더까지 뺀다) · 폴더마다 이 프로젝트 PC */
export interface FolderTree {
  roots: FolderNode[]
  ungrouped: Agent[]
}

export function projectFolderTree(org: Org, agents: Agent[], pcGroups: PcGroups, projectId: string): FolderTree {
  const { roots, ungrouped } = buildTree(pcGroups, projectAgents(agents, org, projectId))
  const prune = (nodes: FolderNode[]): FolderNode[] =>
    nodes
      .filter((n) => {
        const pid = org.folderProjects?.[n.folder.id]
        return !pid || pid === projectId
      })
      .map((n) => ({ ...n, children: prune(n.children) }))
  return { roots: prune(roots), ungrouped }
}

/** 아래 폴더까지 모든 폴더 id */
export const subtreeIds = (nodes: FolderNode[]): string[] => nodes.flatMap((n) => [n.folder.id, ...subtreeIds(n.children)])

/** 인원 권한 표의 'PC 폴더' 칸 글: 모든 폴더면 '전체', 아니면 고른 폴더 수 (마우스를 올리면 이름) */
export function folderPermLabel(current: readonly string[] | null | undefined, tree: FolderTree): { text: string; title: string } {
  if (!current) return { text: '전체', title: '모든 폴더 (새로 만드는 폴더 포함)' }
  const picked = new Set(current)
  const names: string[] = []
  const walk = (nodes: FolderNode[], path: string) => {
    for (const n of nodes) {
      const name = path ? `${path} / ${n.folder.name}` : n.folder.name
      if (picked.has(n.folder.id)) names.push(name)
      walk(n.children, name)
    }
  }
  walk(tree.roots, '')
  const ungrouped = picked.has(UNGROUPED_FOLDER)
  const title = [...names, ...(ungrouped ? ['미분류 PC'] : [])].join('\n')
  if (names.length === 0) return ungrouped ? { text: '미분류만', title } : { text: '없음', title: '볼 수 있는 PC 목록 폴더가 없습니다' }
  return { text: ungrouped ? `${names.length}개 폴더 + 미분류` : `${names.length}개 폴더`, title }
}
