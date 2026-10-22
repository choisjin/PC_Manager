import { useCallback, useEffect, useState } from 'react'
import { api, type VideoStorageInfo } from '../../api'
import { formatBytes, formatTime } from '../../format'
import { baseName, dirName, toMessage } from './resultSessions'

/**
 * Result 탭: 테스트 PC 드라이브 남은 공간 · 재생용 사본 목록.
 * 사본은 바로 재생할 수 없는 영상을 사용자가 승인해 변환한 것이라 자동으로 지우지 않는다 → 여기서 직접 지운다 (원본은 그대로)
 */
export function VideoStorage({ agentId, online }: { agentId: string; online: boolean }) {
  const [info, setInfo] = useState<VideoStorageInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback(() => {
    if (!online) return
    api.videoStorage(agentId).then(
      (next) => {
        setInfo(next)
        setError(null)
        // 없어진 사본은 고른 목록에서 뺀다
        setPicked((cur) => new Set([...cur].filter((name) => next.cache.some((c) => c.name === name))))
      },
      (err) => setError(toMessage(err)),
    )
  }, [agentId, online])
  useEffect(load, [load])

  const remove = async (names: string[]) => {
    if (!info || names.length === 0) return
    const bytes = info.cache.filter((c) => names.includes(c.name)).reduce((n, c) => n + c.bytes, 0)
    if (!window.confirm(`재생용 사본 ${names.length}개(${formatBytes(bytes)})를 지울까요? 원본 영상은 그대로입니다.`)) return
    setBusy(true)
    try {
      const r = await api.deleteVideoCache(agentId, names)
      setNotice(`${r.deleted}개 지움 · ${formatBytes(r.freedBytes)} 비움${r.failed.length ? ` · ${r.failed.length}개는 만드는 중이거나 사용 중이라 못 지움` : ''}`)
      setPicked(new Set())
      load()
    } catch (err) {
      setNotice(`지우지 못했습니다: ${toMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  if (!online) return null
  const cacheBytes = info?.cache.reduce((n, c) => n + c.bytes, 0) ?? 0
  const removable = info?.cache.filter((c) => !c.converting) ?? []
  const toggle = (name: string, on: boolean) => setPicked((cur) => {
    const next = new Set(cur)
    if (on) next.add(name)
    else next.delete(name)
    return next
  })

  return (
    <div className="rp-storage">
      <div className="rp-storage-head small">
        <span className="muted">저장 공간</span>
        {error ? <span className="muted">{`읽지 못했습니다 (에이전트를 업데이트하세요): ${error}`}</span>
          : !info ? <span className="muted">읽는 중…</span>
            : info.drives.map((d) => (
              <span key={d.name} className="rp-drive" title={d.label ? `${d.name} (${d.label})` : d.name}>
                <span className="mono">{d.name.replace(/[\\/]$/, '') || '/'}</span>
                <meter min={0} max={d.totalBytes} value={d.totalBytes - d.freeBytes} low={d.totalBytes * 0.7} high={d.totalBytes * 0.9} optimum={0} />
                <span>{`${formatBytes(d.freeBytes)} 남음`}</span>
                <span className="muted">{`/ ${formatBytes(d.totalBytes)}`}</span>
              </span>
            ))}
        <span className="rv-spacer" />
        {info && (
          <button type="button" className={`small${open ? ' active' : ''}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {`재생용 사본 ${info.cache.length}개 · ${formatBytes(cacheBytes)}`} {open ? '▴' : '▾'}
          </button>
        )}
        <button type="button" className="small" title="다시 읽기" onClick={load}>↻</button>
      </div>
      {open && info && (
        <div className="rp-cache">
          <p className="small muted">
            {`바로 재생할 수 없어 승인받아 변환한 사본입니다 (${info.cacheDirectory}). 자동으로 지우지 않으니 필요 없으면 지우세요. 지워도 원본은 그대로이고, 다시 볼 때 다시 변환할 수 있습니다.`}
          </p>
          {info.cache.length === 0 ? <p className="small muted">재생용 사본이 없습니다</p> : (
            <ul className="rp-cache-list">
              {info.cache.map((c) => (
                <li key={c.name}>
                  <input
                    type="checkbox"
                    aria-label="고르기"
                    checked={picked.has(c.name)}
                    disabled={c.converting || busy}
                    onChange={(e) => toggle(c.name, e.target.checked)}
                  />
                  <span className="ellipsis" title={c.source ?? c.name}>{c.source ? baseName(c.source) : c.name}</span>
                  <span className="small muted ellipsis mono" title={c.source ?? ''}>
                    {c.converting ? '만드는 중' : c.source ? dirName(c.source) : '원본 모름 (이전 버전이 만든 사본)'}
                  </span>
                  <span className="small mono">{formatBytes(c.bytes)}</span>
                  <span className="small muted" title="마지막으로 쓴 시각">{formatTime(c.lastUsed)}</span>
                  <button type="button" className="small" disabled={c.converting || busy} onClick={() => void remove([c.name])}>삭제</button>
                </li>
              ))}
            </ul>
          )}
          <div className="rp-cache-actions">
            <button type="button" className="small" disabled={busy || picked.size === 0} onClick={() => void remove([...picked])}>
              {`선택 삭제 (${picked.size})`}
            </button>
            <button type="button" className="small danger" disabled={busy || removable.length === 0} onClick={() => void remove(removable.map((c) => c.name))}>
              모두 삭제
            </button>
            {notice && <span className="small muted">{notice}</span>}
          </div>
        </div>
      )}
    </div>
  )
}
