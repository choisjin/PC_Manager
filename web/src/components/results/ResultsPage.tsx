import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type Agent, type FileEntry, type Org, type PcGroups, type ResultProfile } from '../../api'
import { formatBytes } from '../../format'
import { displayName } from '../explorer/pcGroups'
import { projectAgents, remoteSections } from '../remote/remotePcs'
import { RESULT_MODE_LABEL } from './resultCsv'
import { buildSource, cachedRuns, type FoundSource, type ResultRun, type RunScan, scanRuns, today } from './resultFinder'
import { baseName, dirName, openSetup, toMessage } from './resultSessions'
import { openResultTab, type ResultTabRequest } from './resultTab'

interface Props {
  agents: Agent[]
  pcGroups: PcGroups
  org: Org
  filterProjectId: string | null
  selfUserId: string | null
  profiles: Record<string, ResultProfile>
  saveProfile: (agentId: string, profile: ResultProfile | null) => Promise<void>
  userName: (id: string | null | undefined) => string | null
}

const PC_KEY = 'pcm.results.pc'
const ONLY_SET_KEY = 'pcm.results.onlySet'
// 이보다 오래된 실행 목록은 PC를 고를 때 다시 찾는다 (다음 날 열어도 최신이 보이게)
const STALE_MS = 5 * 60_000

const readKey = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
const writeKey = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 기억만 못 한다
  }
}

const pad = (n: number) => String(n).padStart(2, '0')
/** 벽시계 ms → HH:MM:SS */
const clock = (ms: number | null) => {
  if (ms === null) return ''
  const d = new Date(ms)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}
const WEEKDAY = ['일', '월', '화', '수', '목', '금', '토']
const dayLabel = (day: string) => {
  const [y, m, d] = day.split('-').map(Number)
  return `${m}/${d} (${WEEKDAY[new Date(y, m - 1, d).getDay()]})`
}

type ScanState = { agentId: string; loading: boolean; error: string | null; scan: RunScan | null }
type BuildState = { path: string; loading: boolean; error: string | null; found: FoundSource | null }

/**
 * 결과 확인 탭: PC별로 결과 폴더를 미리 정해 두면, 날짜를 고르면 그날 실행을 찾아 영상·이미지까지 채워 연다.
 * PC의 ▶는 가장 최신 결과를 바로 새 탭에서 연다
 */
export function ResultsPage({ agents, pcGroups, org, filterProjectId, selfUserId, profiles, saveProfile, userName }: Props) {
  const sections = useMemo(
    () => remoteSections(pcGroups, projectAgents(agents, org, filterProjectId), org, filterProjectId, selfUserId, null).allSections,
    [pcGroups, agents, org, filterProjectId, selfUserId],
  )
  const [onlySet, setOnlySet] = useState(() => readKey(ONLY_SET_KEY) === '1')
  const [selectedId, setSelectedId] = useState<string | null>(() => readKey(PC_KEY))
  const [editing, setEditing] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const agent = agents.find((a) => a.id === selectedId) ?? null
  const profile = selectedId ? profiles[selectedId] ?? null : null
  const nameOf = (a: Agent) => displayName(a, pcGroups)

  const select = (id: string) => {
    setSelectedId(id)
    setEditing(false)
    setNotice(null)
    writeKey(PC_KEY, id)
  }

  const open = (request: ResultTabRequest) => {
    if (openResultTab(request)) setNotice(null)
    else setNotice('새 탭을 열지 못했습니다 (팝업 차단). 이 사이트의 팝업을 허용해 주세요.')
  }
  const openLatest = (a: Agent) => open({ find: { agentId: a.id, machineName: nameOf(a), day: null } })

  // ── 실행 목록
  const [scanState, setScanState] = useState<ScanState | null>(null)
  const [day, setDay] = useState<string>(today())
  const [runPath, setRunPath] = useState<string | null>(null)
  const [build, setBuild] = useState<BuildState | null>(null)
  const scanSeq = useRef(0)
  const buildSeq = useRef(0)

  const runScan = (refresh: boolean) => {
    if (!agent || !profile) return
    const seq = ++scanSeq.current
    const agentId = agent.id
    setScanState((s) => ({ agentId, loading: true, error: null, scan: s?.agentId === agentId ? s.scan : null }))
    void (async () => {
      try {
        const cached = refresh ? null : await cachedRuns(agentId, profile)
        const scan = cached && Date.now() - cached.scannedAt < STALE_MS ? cached : await scanRuns(agentId, profile, true)
        if (seq !== scanSeq.current) return
        setScanState({ agentId, loading: false, error: null, scan })
        // 처음 고르면 가장 최신 날짜의 최신 실행 (보던 날짜에 실행이 있으면 그대로)
        setDay((d) => (scan.runs.some((r) => r.day === d) ? d : scan.runs[0]?.day ?? today()))
        setRunPath((p) => (p && scan.runs.some((r) => r.path === p) ? p : null))
      } catch (err) {
        if (seq !== scanSeq.current) return
        setScanState({ agentId, loading: false, error: toMessage(err), scan: null })
      }
    })()
  }

  const profileKey = profile ? JSON.stringify(profile) : ''
  const online = agent?.online ?? false
  useEffect(() => {
    setRunPath(null)
    setBuild(null)
    if (!agent || !profile) {
      setScanState(null)
      return
    }
    if (!online) {
      setScanState({ agentId: agent.id, loading: false, error: 'PC가 연결되어 있지 않습니다.', scan: null })
      return
    }
    runScan(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, profileKey, online])

  const scan = scanState?.agentId === selectedId ? scanState.scan : null
  const days = useMemo(() => {
    const m = new Map<string, number>()
    for (const r of scan?.runs ?? []) m.set(r.day, (m.get(r.day) ?? 0) + 1)
    return [...m].slice(0, 14)
  }, [scan])
  const dayRuns = useMemo(() => (scan?.runs ?? []).filter((r) => r.day === day), [scan, day])
  const run = dayRuns.find((r) => r.path === runPath) ?? dayRuns[0] ?? null

  // ── 고른 실행의 영상·이미지 폴더 찾기
  useEffect(() => {
    if (!run || !agent || !profile || !scan) {
      setBuild(null)
      return
    }
    const seq = ++buildSeq.current
    setBuild({ path: run.path, loading: true, error: null, found: null })
    buildSource(agent.id, nameOf(agent), profile, run, scan.runs).then(
      (found) => seq === buildSeq.current && setBuild({ path: run.path, loading: false, error: null, found }),
      (err) => seq === buildSeq.current && setBuild({ path: run.path, loading: false, error: toMessage(err), found: null }),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.path, scan])
  const found = build?.path === run?.path ? build?.found ?? null : null

  const openRun = (r: ResultRun) => {
    if (!agent) return
    if (found && r.path === run?.path) open({ source: found.source })
    else open({ find: { agentId: agent.id, machineName: nameOf(agent), path: r.path } })
  }

  const relDir = (p: string) => {
    const dir = dirName(p)
    const root = profile?.resultDir.replace(/[\\/]+$/, '') ?? ''
    return dir.toLowerCase().startsWith(root.toLowerCase()) ? dir.slice(root.length).replace(/^[\\/]/, '') : dir
  }

  return (
    <div className="rp">
      <aside className="panel rp-pcs">
        <div className="panel-head">
          <h2>PC</h2>
          <label className="small muted rp-only">
            <input
              type="checkbox"
              checked={onlySet}
              onChange={(e) => {
                setOnlySet(e.target.checked)
                writeKey(ONLY_SET_KEY, e.target.checked ? '1' : '0')
              }}
            />
            결과 폴더를 정한 PC만
          </label>
        </div>
        <div className="rp-pc-list">
          {sections.map((section) => {
            const list = section.agents
              .filter((a) => !onlySet || profiles[a.id])
              .sort((x, y) => nameOf(x).localeCompare(nameOf(y), 'ko', { numeric: true, sensitivity: 'base' }))
            if (list.length === 0) return null
            return (
              <div key={section.key} className="rp-section">
                <div className="rp-section-name small muted">{section.name}</div>
                {list.map((a) => {
                  const p = profiles[a.id]
                  return (
                    <div
                      key={a.id}
                      className={`rp-pc${a.id === selectedId ? ' selected' : ''}${a.online ? '' : ' offline'}`}
                      onClick={() => select(a.id)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && select(a.id)}
                    >
                      <span className={`dot ${a.online ? 'on' : 'off'}`} />
                      <span className="rp-pc-name ellipsis" title={a.machineName}>{nameOf(a)}</span>
                      {p ? <span className="rp-chip">{RESULT_MODE_LABEL[p.mode]}</span> : <span className="small muted">미설정</span>}
                      <button
                        type="button"
                        className="small rp-latest"
                        disabled={!p || !a.online}
                        title={!p ? '결과 폴더를 먼저 정하세요' : !a.online ? 'PC가 연결되어 있지 않습니다' : '가장 최신 결과를 새 탭에서 엽니다'}
                        onClick={(e) => {
                          e.stopPropagation()
                          select(a.id)
                          openLatest(a)
                        }}
                      >
                        ▶ 최신
                      </button>
                    </div>
                  )
                })}
              </div>
            )
          })}
          {sections.every((s) => s.agents.every((a) => onlySet && !profiles[a.id])) && (
            <p className="muted small rp-empty">{onlySet ? '결과 폴더를 정한 PC가 없습니다' : 'PC가 없습니다'}</p>
          )}
        </div>
      </aside>

      <section className="panel rp-main">
        {!agent ? (
          <div className="rp-placeholder muted">왼쪽에서 PC를 고르세요</div>
        ) : editing || !profile ? (
          <ProfileForm
            key={agent.id}
            agent={agent}
            name={nameOf(agent)}
            initial={profile}
            onCancel={profile ? () => setEditing(false) : null}
            onSave={async (p) => {
              await saveProfile(agent.id, p)
              setEditing(false)
            }}
            onRemove={profile ? async () => {
              await saveProfile(agent.id, null)
              setEditing(false)
            } : null}
          />
        ) : (
          <>
            <div className="panel-head">
              <h2>
                {nameOf(agent)} <span className="rp-chip">{RESULT_MODE_LABEL[profile.mode]}</span>
              </h2>
              <span className="rp-head-actions">
                <button type="button" className="small" onClick={() => runScan(true)} disabled={!online || scanState?.loading}>
                  {scanState?.loading ? '찾는 중…' : '새로 고침'}
                </button>
                <button type="button" className="small" onClick={() => setEditing(true)}>결과 폴더 설정</button>
                <button type="button" className="small primary" disabled={!online} onClick={() => openLatest(agent)}>▶ 최신 결과 열기</button>
              </span>
            </div>
            <div className="rp-body">
              <dl className="rp-folders small">
                <dt>Result</dt><dd className="mono ellipsis" title={profile.resultDir}>{profile.resultDir} <span className="muted">({profile.pattern || '*.csv'})</span></dd>
                {profile.videoDir && <><dt>영상</dt><dd className="mono ellipsis" title={profile.videoDir}>{profile.videoDir}</dd></>}
                {profile.imageDir && <><dt>결과 이미지</dt><dd className="mono ellipsis" title={profile.imageDir}>{profile.imageDir}</dd></>}
                {profile.refDir && <><dt>원본 이미지</dt><dd className="mono ellipsis" title={profile.refDir}>{profile.refDir}</dd></>}
              </dl>
              {profile.updatedBy && <p className="small muted rp-updated">{`마지막 설정: ${userName(profile.updatedBy) ?? ''}`}</p>}

              <div className="rp-days">
                <input type="date" value={day} max={today()} onChange={(e) => e.target.value && setDay(e.target.value)} />
                <button type="button" className="small" onClick={() => setDay(today())}>오늘</button>
                {days.map(([d, n]) => (
                  <button key={d} type="button" className={`small rp-day${d === day ? ' active' : ''}`} onClick={() => setDay(d)}>
                    {dayLabel(d)} <span className="muted">{n}</span>
                  </button>
                ))}
              </div>
              {notice && <p className="error small">{notice}</p>}
              {scanState?.error && <p className="error small">결과 폴더를 읽지 못했습니다: {scanState.error}</p>}
              {scan?.truncated && <p className="small warning-box">Result 파일이 너무 많아 일부만 찾았습니다. 파일 이름 패턴이나 Result 폴더를 좁혀 주세요.</p>}

              <div className="rp-runs">
                {scanState?.loading && !scan ? <p className="muted small">결과 폴더에서 찾는 중…</p>
                  : scan && dayRuns.length === 0 ? <p className="muted small">{`${dayLabel(day)}에 실행한 결과가 없습니다.`}</p>
                    : dayRuns.map((r) => (
                      <div
                        key={r.path}
                        className={`rp-run${r === run ? ' selected' : ''}`}
                        onClick={() => setRunPath(r.path)}
                        onDoubleClick={() => openRun(r)}
                        title={r.path}
                      >
                        <span className="mono">{clock(r.time)}{r.timeFrom === 'mtime' && <span className="muted" title="이름에 시각이 없어 수정 시각으로 봤습니다">*</span>}</span>
                        <span className="ellipsis">{r.name}</span>
                        <span className="small muted ellipsis">{relDir(r.path)}</span>
                        <span className="small muted">{r.modified !== null && `~${clock(r.modified)}`}</span>
                        <span className="small muted">{formatBytes(r.size)}</span>
                      </div>
                    ))}
              </div>

              {run && (
                <div className="rp-found">
                  <div className="rp-found-head">
                    <strong className="ellipsis" title={run.path}>{baseName(run.path)}</strong>
                    <span className="rv-spacer" />
                    <button
                      type="button"
                      className="small"
                      disabled={!found}
                      title="찾은 경로를 경로 지정 창에서 고친 뒤 엽니다"
                      onClick={() => found && openSetup(found.source)}
                    >
                      경로 확인 후 열기
                    </button>
                    <button type="button" className="primary" disabled={!online} onClick={() => openRun(run)}>열기</button>
                  </div>
                  {build?.loading && <p className="muted small">영상·이미지 폴더 찾는 중…</p>}
                  {build?.error && build.path === run.path && <p className="error small">{build.error}</p>}
                  {found && (
                    <>
                      <p className="small muted">{found.notes.join(' · ')}</p>
                      <ul className="rp-files small mono">
                        {found.source.videoPaths.map((v) => <li key={v} className="ellipsis" title={v}>🎞 {v}</li>)}
                        {found.source.imageDir && <li className="ellipsis" title={found.source.imageDir}>🖼 {found.source.imageDir}</li>}
                        {found.source.refDir && <li className="ellipsis" title={found.source.refDir}>📁 원본 · {found.source.refDir}</li>}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </section>
    </div>
  )
}

// ─────────────────────────────── 결과 폴더 설정

type FolderField = 'resultDir' | 'videoDir' | 'imageDir' | 'refDir'

const FIELDS: { key: FolderField; label: string; hint: (ats: boolean) => string }[] = [
  { key: 'resultDir', label: 'Result 폴더 (필수)', hint: (ats) => (ats ? '예: D:\\excelrunner_report — 하위 폴더까지 Result 파일을 찾습니다' : '예: D:\\RF_TESTLOG — 하위 폴더까지 Result 파일을 찾습니다') },
  { key: 'videoDir', label: '영상 폴더', hint: () => '실행 시간에 걸친 영상을 고릅니다 (하위 폴더까지)' },
  { key: 'imageDir', label: '결과 이미지 폴더', hint: () => '캡처가 쌓이는 폴더, 또는 실행마다 날짜 폴더가 생기는 상위 폴더 (비우면 Result에 적힌 경로·Result 옆 폴더)' },
  { key: 'refDir', label: '원본 이미지 폴더', hint: (ats) => (ats ? '예: D:\\excelrunner_report\\captured_image' : '예: rnavn_project\\Image') },
]

function ProfileForm({ agent, name, initial, onSave, onCancel, onRemove }: {
  agent: Agent
  name: string
  initial: ResultProfile | null
  onSave: (p: ResultProfile) => Promise<void>
  onCancel: (() => void) | null
  onRemove: (() => Promise<void>) | null
}) {
  const [p, setP] = useState<ResultProfile>(
    initial ?? { mode: 'ats', resultDir: '', pattern: null, videoDir: null, imageDir: null, refDir: null },
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warn, setWarn] = useState<string | null>(null)
  const [picking, setPicking] = useState<FolderField | null>(null)
  const ats = p.mode === 'ats'

  const save = async () => {
    if (!p.resultDir.trim()) {
      setError('Result 폴더를 입력하세요.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      // 폴더가 실제로 있는지 (PC가 연결돼 있을 때만, 없어도 저장은 한다)
      if (agent.online && !warn) {
        const missing: string[] = []
        for (const f of FIELDS) {
          const dir = p[f.key]?.trim()
          if (!dir) continue
          const l = await api.listFiles(agent.id, dir).catch(() => null)
          if (!l || l.error) missing.push(f.label.replace(' (필수)', ''))
        }
        if (missing.length > 0) {
          setWarn(`${missing.join(', ')}를 이 PC에서 찾지 못했습니다. 그래도 저장하려면 다시 '저장'을 누르세요.`)
          return
        }
      }
      await onSave(p)
    } catch (err) {
      setError(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  const set = (patch: Partial<ResultProfile>) => {
    setP((cur) => ({ ...cur, ...patch }))
    setWarn(null)
  }

  return (
    <>
      <div className="panel-head">
        <h2>{`${name} · 결과 폴더 설정`}</h2>
        {!agent.online && <span className="small muted">PC가 연결되어 있지 않아 폴더를 확인할 수 없습니다</span>}
      </div>
      <form
        className="rp-form"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <p className="hint">PC마다 결과가 쌓이는 폴더를 정해 두면, 날짜만 고르면 그날 실행의 Result·영상·이미지를 알아서 찾아 엽니다. 모든 사용자가 같이 씁니다.</p>
        <div className="rp-field">
          <span className="rp-label">결과 형식</span>
          <span className="rv-mode" role="group" aria-label="결과 형식">
            {(['ats', 'rfw'] as const).map((m) => (
              <button key={m} type="button" className={p.mode === m ? 'active' : ''} onClick={() => set({ mode: m })}>
                {RESULT_MODE_LABEL[m]}
              </button>
            ))}
          </span>
        </div>
        {FIELDS.map((f) => (
          <div key={f.key} className="rp-field">
            <span className="rp-label">{f.label}</span>
            <span className="rp-input">
              <input
                className="mono"
                aria-label={f.label}
                value={p[f.key] ?? ''}
                onChange={(e) => set({ [f.key]: f.key === 'resultDir' ? e.target.value : e.target.value || null })}
                placeholder={f.hint(ats)}
              />
              <button type="button" className="small" disabled={!agent.online} onClick={() => setPicking(f.key)}>찾아보기</button>
            </span>
            {f.key === 'resultDir' && (
              <span className="rp-input">
                <span className="small muted">파일 이름</span>
                <input
                  className="mono rp-pattern"
                  aria-label="Result 파일 이름"
                  value={p.pattern ?? ''}
                  onChange={(e) => set({ pattern: e.target.value || null })}
                  placeholder={ats ? '*.csv' : 'result_*.csv'}
                />
                <span className="small muted">비우면 *.csv · 이름이나 폴더 이름에 날짜·시각이 있으면 그걸로 날짜를 정합니다 (없으면 수정 시각)</span>
              </span>
            )}
          </div>
        ))}
        {warn && <p className="small warning-box">{warn}</p>}
        {error && <p className="error small">{error}</p>}
        <div className="rp-form-actions">
          {onRemove && (
            <button
              type="button"
              className="small danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm(`${name}의 결과 폴더 설정을 지울까요?`)) void onRemove().catch((err) => setError(toMessage(err)))
              }}
            >
              설정 지우기
            </button>
          )}
          <span className="rv-spacer" />
          {onCancel && <button type="button" onClick={onCancel} disabled={busy}>취소</button>}
          <button type="submit" className="primary" disabled={busy}>{busy ? '확인 중…' : '저장'}</button>
        </div>
      </form>
      {picking && (
        <FolderPicker
          agentId={agent.id}
          title={FIELDS.find((f) => f.key === picking)!.label}
          start={p[picking] || p.resultDir || ''}
          onPick={(dir) => {
            set({ [picking]: dir })
            setPicking(null)
          }}
          onClose={() => setPicking(null)}
        />
      )}
    </>
  )
}

/** 테스트 PC 폴더 고르기 (폴더만 보여 준다) */
function FolderPicker({ agentId, title, start, onPick, onClose }: {
  agentId: string
  title: string
  start: string
  onPick: (dir: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const [path, setPath] = useState(start)
  const [listing, setListing] = useState<{ path: string; parent: string | null; dirs: FileEntry[] } | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (ref.current && !ref.current.open) ref.current.showModal()
  }, [])
  useEffect(() => {
    let cancelled = false
    setError(null)
    api.listFiles(agentId, path).then(
      (l) => {
        if (cancelled) return
        if (l.error) {
          // 없는 폴더면 드라이브 목록부터
          if (path) setPath('')
          else setError(l.error)
          return
        }
        setListing({ path: l.path, parent: l.parentPath, dirs: l.entries.filter((e) => e.isDirectory) })
      },
      (err) => !cancelled && setError(toMessage(err)),
    )
    return () => {
      cancelled = true
    }
  }, [agentId, path])

  return (
    <dialog
      ref={ref}
      className="dialog rp-picker"
      // PiP가 이 창 안으로 들어와 가리지 않게
      data-no-pip
      onCancel={(e) => {
        e.preventDefault()
        onClose()
      }}
    >
      <div className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
      </div>
      <div className="dialog-body">
        <div className="rp-input">
          <button type="button" className="small" disabled={!listing?.path} onClick={() => setPath(listing?.parent ?? '')}>↑ 위로</button>
          <span className="mono small ellipsis">{listing?.path || '내 PC'}</span>
        </div>
        {error && <p className="error small">{error}</p>}
        <ul className="rp-picker-list">
          {listing?.dirs.length === 0 && <li className="muted small">하위 폴더가 없습니다</li>}
          {listing?.dirs.map((d) => (
            <li key={d.fullPath} onClick={() => setPath(d.fullPath)}>📁 {d.name}</li>
          ))}
        </ul>
        <div className="dialog-actions">
          <span />
          <span className="rp-input">
            <button type="button" onClick={onClose}>취소</button>
            <button type="button" className="primary" disabled={!listing?.path} onClick={() => listing && onPick(listing.path)}>이 폴더 선택</button>
          </span>
        </div>
      </div>
    </dialog>
  )
}
