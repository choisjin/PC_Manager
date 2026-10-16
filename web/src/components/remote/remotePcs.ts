// 원격조작 대상 PC 목록 계산 (대시보드 Remote 모드와 원격조작 탭이 같은 규칙을 쓴다)
import type { Agent, Org, PcGroups, PcStatus, RemoteUsage } from '../../api'
import { buildTree, displayName, type FolderNode } from '../explorer/pcGroups'
import type { RemoteSection } from '../RemoteGrid'
import type { RemotePc } from './RemoteContext'

/** 선택한 프로젝트의 에이전트 + 아직 미배정 에이전트 (다른 프로젝트 전용은 숨김). 프로젝트가 없으면 모두 */
export function projectAgents(agents: Agent[], org: Org, filterProjectId: string | null): Agent[] {
  if (!filterProjectId) return agents
  return agents.filter((a) => {
    const pid = org.agentProjects[a.id]
    return !pid || pid === filterProjectId
  })
}

/** 서버 PC와, 지금 대시보드를 보고 있는 이 PC는 뺀다 (자기 화면을 원격하면 화면이 무한히 겹친다) */
export function remoteCandidates(agents: Agent[], serverHostName: string | null, selfPc: string | null, clientIp: string | null): Agent[] {
  return agents.filter((a) => {
    if (serverHostName && a.machineName.toLowerCase() === serverHostName.toLowerCase()) return false
    if (selfPc && a.machineName.toLowerCase() === selfPc.toLowerCase()) return false
    if (clientIp && a.ipAddresses.includes(clientIp)) return false
    return true
  })
}

/**
 * 폴더(그룹)별 구역. allSections는 선택과 무관한 전체, targets는 선택한 폴더(하위 포함, 없으면 전체)
 */
export function remoteSections(
  pcGroups: PcGroups,
  agents: Agent[],
  org: Org,
  filterProjectId: string | null,
  selfUserId: string | null,
  selectedFolderId: string | null,
): { targets: { name: string | null; sections: RemoteSection[] }; allSections: RemoteSection[] } {
  // 트리와 같은 규칙: 다른 프로젝트에 배정된 폴더는 숨긴다
  const folderVisible = (folderId: string) => {
    const pid = org.folderProjects?.[folderId]
    if (!pid) return true
    if (filterProjectId) return pid === filterProjectId
    return selfUserId ? (org.projectUsers[pid] ?? []).includes(selfUserId) : true
  }
  const { roots, ungrouped } = buildTree(pcGroups, agents)
  const sections: RemoteSection[] = []
  const walk = (n: FolderNode, path: string) => {
    if (!folderVisible(n.folder.id)) return
    if (n.agents.length > 0) sections.push({ key: n.folder.id, name: path, agents: n.agents })
    for (const c of n.children) walk(c, `${path} / ${c.folder.name}`)
  }
  for (const r of roots) walk(r, r.folder.name)
  if (ungrouped.length > 0) sections.push({ key: 'ungrouped', name: '미분류', agents: ungrouped })
  const all = [...sections]
  const whole = { targets: { name: null as string | null, sections: all }, allSections: all }
  if (!selectedFolderId) return whole
  const find = (nodes: FolderNode[]): FolderNode | null => {
    for (const n of nodes) {
      if (n.folder.id === selectedFolderId) return n
      const c = find(n.children)
      if (c) return c
    }
    return null
  }
  const node = find(roots)
  if (!node) return whole
  sections.length = 0
  walk(node, node.folder.name)
  return { targets: { name: node.folder.name, sections: [...sections] }, allSections: all }
}

/** 원격조작 창의 PC 목록(빠른 전환): 그룹(폴더) 순서, 그룹 안은 별칭 순 */
export function remotePcList(
  allSections: RemoteSection[],
  pcGroups: PcGroups,
  pcStatuses: Record<string, PcStatus>,
  remoteUsage: RemoteUsage['inUseBy'],
): RemotePc[] {
  return allSections.flatMap((section) =>
    section.agents
      .map((a) => ({
        id: a.id,
        name: displayName(a, pcGroups),
        group: section.name,
        online: a.online,
        status: pcStatuses[a.id] ?? null,
        inUseBy: remoteUsage[a.id]?.userId ?? null,
      }))
      .sort((x, y) => x.name.localeCompare(y.name, 'ko', { numeric: true, sensitivity: 'base' })),
  )
}
