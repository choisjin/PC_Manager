import { useEffect, useState } from 'react'
import { api, type Agent, type FileFavorite, type FileFavoriteAccess, type PcGroups, type SharedFolder } from '../../api'
import { loadBackupSetting } from '../../fileTypes'
import { useCan } from '../../perms'
import { ensureUnlocked } from '../../pcLocks'
import { ContextMenu, type MenuItem } from './ContextMenu'
import { Icon } from './Icon'
import { displayName } from './pcGroups'

// 열 수 있는지 다시 확인하는 간격 (PC 연결 상태는 바로 반영, 파일이 있는지는 이 간격으로)
const CHECK_MS = 60_000

const fileName = (path: string) => path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path
const isNetworkPath = (path: string) => path.startsWith('\\\\')
const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

interface Props {
  items: FileFavorite[]
  onSave: (items: FileFavorite[]) => void
  agents: Agent[]
  shares: SharedFolder[]
  pcGroups: PcGroups
  /** 대시보드를 연 PC(내 PC)의 에이전트 (온라인일 때만). 없으면 열 수 없다 */
  selfAgentId: string | null
}

/**
 * 사이드바 PC 목록 위 '파일 즐겨찾기' 탭 (사용자별, 공유 서버 탭 옆).
 * 공유 폴더 파일은 내 PC에서 네트워크 경로로 바로 열고, 테스트 PC 파일은 내 PC 프로그램으로 열어 저장하면 원래 PC에 저장된다.
 * PC가 꺼졌거나 파일이 없어 열 수 없으면 흐리게 두고 누를 수 없다
 */
export function FileFavorites({ items, onSave, agents, shares, pcGroups, selfAgentId }: Props) {
  const can = useCan()
  const [access, setAccess] = useState<Record<string, FileFavoriteAccess>>({})
  const [checked, setChecked] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null)
  const [menu, setMenu] = useState<{ x: number; y: number; fav: FileFavorite } | null>(null)

  // 즐겨찾기가 바뀌거나 관련 PC가 켜지고 꺼지면 바로, 그 밖에는 주기적으로 확인한다
  const onlineKey = items.map((f) => `${f.id}:${f.isShare || agents.some((a) => a.id === f.sourceId && a.online)}`).join(',')
  useEffect(() => {
    if (items.length === 0) return
    let cancelled = false
    const check = () =>
      api.fileFavoriteAccess().then(
        (result) => {
          if (cancelled) return
          setAccess(result)
          setChecked(true)
        },
        () => {
          if (!cancelled) setChecked(true)
        },
      )
    void check()
    const timer = window.setInterval(check, CHECK_MS)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
    // onlineKey가 즐겨찾기 목록과 PC 연결 상태를 담는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onlineKey])

  useEffect(() => {
    if (!notice || notice.error) return
    const id = window.setTimeout(() => setNotice(null), 6000)
    return () => window.clearTimeout(id)
  }, [notice])

  /** 지금 열 수 없으면 그 이유 (열 수 있으면 null) */
  const blockedReason = (fav: FileFavorite): string | null => {
    if (!selfAgentId) return '내 PC 에이전트가 실행 중이 아니라 열 수 없습니다.'
    if (fav.isShare) {
      if (!shares.some((s) => s.id === fav.sourceId)) return '공유 폴더가 지워졌습니다.'
    } else {
      const agent = agents.find((a) => a.id === fav.sourceId)
      if (!agent) return 'PC가 목록에서 지워졌습니다.'
      if (!agent.online) return 'PC가 연결되어 있지 않습니다.'
      if (!can('download')) return '파일을 받을 권한이 없어 열 수 없습니다.'
    }
    const a = access[fav.id]
    if (a && !a.ok) return a.reason ?? '열 수 없습니다.'
    return null
  }

  // 지금 이름 (별칭·공유 이름이 바뀌었으면 그것으로, PC가 지워졌으면 저장할 때 이름)
  const sourceLabel = (fav: FileFavorite) => {
    if (fav.isShare) return shares.find((s) => s.id === fav.sourceId)?.name ?? fav.sourceName
    const agent = agents.find((a) => a.id === fav.sourceId)
    return agent ? displayName(agent, pcGroups) : fav.sourceName
  }

  const open = async (fav: FileFavorite) => {
    if (blockedReason(fav) || !selfAgentId) return
    const name = fileName(fav.path)
    const label = sourceLabel(fav)
    try {
      if (fav.isShare) {
        const share = shares.find((s) => s.id === fav.sourceId)
        if (share && isNetworkPath(share.path)) {
          // 네트워크 경로(\\서버\…)를 내 PC가 바로 연다: 사본 없이 저장하면 그 자리에
          setNotice({ text: `'${name}'을(를) 여는 중…`, error: false })
          await api.openShareDirect(fav.sourceId, fav.path, selfAgentId)
          setNotice({ text: `'${name}'을(를) 네트워크 경로에서 바로 열었습니다. 저장하면 ${label}에 그대로 저장됩니다.`, error: false })
          return
        }
        // 서버 PC의 로컬 폴더는 내 PC에서 경로로 닿지 않는다 → 내 PC 프로그램으로 열기
      } else if (!(await ensureUnlocked(fav.sourceId))) {
        return
      }
      const backup = loadBackupSetting()
      setNotice({ text: `'${name}'을(를) 여는 중…`, error: false })
      await api.openLocal(fav.sourceId, fav.path, selfAgentId, label, false, backup)
      setNotice({
        text: fav.sourceId === selfAgentId
          ? `'${name}'을(를) 열었습니다.`
          : `'${name}'을(를) 내 PC 프로그램으로 열었습니다. 저장하면 ${label}의 원래 위치에 저장됩니다${backup ? ' (원본은 .bak)' : ''}.`,
        error: false,
      })
    } catch (err) {
      setNotice({ text: `'${name}'을(를) 열지 못했습니다: ${toMessage(err)}`, error: true })
    }
  }

  const remove = (fav: FileFavorite) => onSave(items.filter((f) => f.id !== fav.id))

  const copyPath = (path: string) => {
    navigator.clipboard?.writeText(path).then(
      () => setNotice({ text: '경로를 복사했습니다.', error: false }),
      () => setNotice({ text: '경로를 복사하지 못했습니다.', error: true }),
    )
  }

  const menuItems = (fav: FileFavorite): MenuItem[] => [
    { label: '열기', disabled: !!blockedReason(fav), onClick: () => void open(fav) },
    { label: '경로 복사', onClick: () => copyPath(fav.path) },
    { separator: true },
    { label: '즐겨찾기 제거', danger: true, onClick: () => remove(fav) },
  ]

  return (
    <div className="file-fav-section">
      <ul className="tree-root file-fav-list">
        {items.map((fav) => {
          const reason = blockedReason(fav)
          // 처음 확인 전에는 PC 연결 상태만으로 판단한다
          const pending = !reason && !checked && !access[fav.id]
          const label = sourceLabel(fav)
          return (
            <li
              key={fav.id}
              className={`tree-agent file-fav-item${reason ? ' blocked' : ''}`}
              title={`${fav.path}\n${label}${fav.isShare ? ' (공유 폴더: 네트워크 경로로 바로 열기)' : ' (내 PC 프로그램으로 열기, 저장하면 원래 PC에)'}${reason ? `\n\n열 수 없음: ${reason}` : pending ? '\n\n확인 중…' : ''}`}
              aria-disabled={!!reason}
              onClick={() => void open(fav)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void open(fav)
              }}
              tabIndex={0}
              onContextMenu={(e) => {
                e.preventDefault()
                setMenu({ x: e.clientX, y: e.clientY, fav })
              }}
            >
              <Icon name={fav.isShare ? 'share' : 'file'} size={14} />
              <span className="file-fav-text">
                <span className="ellipsis" translate="no">{fileName(fav.path)}</span>
                <span className="file-fav-source small muted ellipsis" translate="no">{label}</span>
              </span>
              <button type="button" className="icon-mini" title="즐겨찾기 제거" aria-label="즐겨찾기 제거" onClick={(e) => { e.stopPropagation(); remove(fav) }}>
                ✕
              </button>
            </li>
          )
        })}
        {items.length === 0 && <li className="placeholder small">파일을 우클릭해 '파일 즐겨찾기에 추가'</li>}
      </ul>
      {notice && <div className={`file-fav-notice small${notice.error ? ' error' : ''}`} onClick={() => setNotice(null)}>{notice.text}</div>}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.fav)} onClose={() => setMenu(null)} />}
    </div>
  )
}
