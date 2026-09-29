import type { Agent, PcGroupFolder, PcGroups } from '../../api'

export const EMPTY_GROUPS: PcGroups = { folders: [], assignments: {} }

// 드래그앤드롭 식별용 MIME (dataTransfer)
export const AGENT_MIME = 'application/x-pcm-agent'
export const PANE_MIME = 'application/x-pcm-pane'

// crypto.randomUUID는 보안 컨텍스트(HTTPS/localhost)에서만 동작하므로,
// http로 접속하는 내부망에서도 되도록 폴백을 둔다. (폴더·창 ID는 암호학적 강도 불필요)
export function newId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(8)
      crypto.getRandomValues(bytes)
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    }
  } catch {
    // 아래 폴백 사용
  }
  return (Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)).slice(0, 16)
}

export interface ClipItem {
  path: string
  name: string
  isDir: boolean
}

/** 복사/잘라내기 클립보드 (패널 간 공유, 여러 항목) */
export interface FileClipboard {
  agentId: string
  items: ClipItem[]
  mode: 'copy' | 'cut'
}

/** 텍스트를 클립보드에 복사 (http 환경에서도 동작하도록 폴백 포함) */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

export interface FolderNode {
  folder: PcGroupFolder
  children: FolderNode[]
  agents: Agent[]
}

/** 폴더를 트리로 만들고 각 폴더에 배치된 PC를 담는다. 미분류 PC는 별도로 반환. */
export function buildTree(
  groups: PcGroups,
  agents: Agent[],
): { roots: FolderNode[]; ungrouped: Agent[] } {
  const byId = new Map<string, FolderNode>()
  for (const folder of groups.folders) {
    byId.set(folder.id, { folder, children: [], agents: [] })
  }

  for (const agent of agents) {
    const folderId = groups.assignments[agent.id]
    const node = folderId ? byId.get(folderId) : undefined
    if (node) node.agents.push(agent)
  }

  const roots: FolderNode[] = []
  for (const node of byId.values()) {
    const parent = node.folder.parentId ? byId.get(node.folder.parentId) : undefined
    if (parent) parent.children.push(node)
    else roots.push(node)
  }

  const sortNodes = (nodes: FolderNode[]) => {
    nodes.sort((a, b) => a.folder.order - b.folder.order || a.folder.name.localeCompare(b.folder.name))
    for (const n of nodes) {
      n.agents.sort((a, b) => a.machineName.localeCompare(b.machineName))
      sortNodes(n.children)
    }
  }
  sortNodes(roots)

  const ungrouped = agents
    .filter((a) => !groups.assignments[a.id] || !byId.has(groups.assignments[a.id]))
    .sort((a, b) => a.machineName.localeCompare(b.machineName))

  return { roots, ungrouped }
}

export function addFolder(groups: PcGroups, name: string, parentId: string | null): PcGroups {
  const siblings = groups.folders.filter((f) => f.parentId === parentId)
  const order = siblings.reduce((max, f) => Math.max(max, f.order), -1) + 1
  return {
    ...groups,
    folders: [...groups.folders, { id: newId(), name: name.trim() || '새 폴더', parentId, order }],
  }
}

export function renameFolder(groups: PcGroups, id: string, name: string): PcGroups {
  return {
    ...groups,
    folders: groups.folders.map((f) => (f.id === id ? { ...f, name: name.trim() || f.name } : f)),
  }
}

/** 폴더와 그 하위 폴더를 모두 지운다. 배치된 PC는 미분류가 된다. */
export function deleteFolder(groups: PcGroups, id: string): PcGroups {
  const toDelete = new Set<string>([id])
  let changed = true
  while (changed) {
    changed = false
    for (const f of groups.folders) {
      if (f.parentId && toDelete.has(f.parentId) && !toDelete.has(f.id)) {
        toDelete.add(f.id)
        changed = true
      }
    }
  }
  const assignments = Object.fromEntries(
    Object.entries(groups.assignments).filter(([, folderId]) => !toDelete.has(folderId)),
  )
  return { folders: groups.folders.filter((f) => !toDelete.has(f.id)), assignments }
}

export function assignAgent(groups: PcGroups, agentId: string, folderId: string | null): PcGroups {
  const assignments = { ...groups.assignments }
  if (folderId) assignments[agentId] = folderId
  else delete assignments[agentId]
  return { ...groups, assignments }
}
