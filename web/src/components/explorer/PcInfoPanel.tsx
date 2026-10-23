import { type ReactNode, useEffect, useRef, useState } from 'react'
import type { Agent, DeviceEntry, DriveDetail, PcSystemInfo, PerfSample, ProcessEntry } from '../../api'
import { formatBytes, formatTime } from '../../format'
import { formatRate, formatUptime, INFO_TABS, type InfoTab, PERF_POINTS, type PcInfoState, PROBLEM_TEXT, usePcInfo } from './pcInfo'

const OPEN_KEY = 'pcm.info.open'
const TAB_KEY = 'pcm.info.tab'
const HEIGHT_KEY = 'pcm.info.height'
const MIN_HEIGHT = 140

function load(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 저장 못 해도 패널은 동작한다
  }
}

type SortKey = 'name' | 'id' | 'cpu' | 'memory'
interface View {
  processQuery: string
  sort: { key: SortKey; desc: boolean }
  deviceQuery: string
  onlyProblems: boolean
  /** 사용자가 직접 펼치거나 접은 장치 종류 (없으면: 문제 있는 종류·검색 중이면 펼침) */
  groups: Record<string, boolean>
}

interface Props {
  /** 활성 탐색 창의 PC (창이 없거나 공유 서버면 null) */
  agent: Agent | null
  name: string | null
}

/** PC 목록 아래 PC 정보 패널: 시스템 · 디스크 · 프로세스 · 성능 · 장치. 접어 두거나 다른 탭을 보면 그 정보는 묻지 않는다 */
export function PcInfoPanel({ agent, name }: Props) {
  const [open, setOpen] = useState(() => load(OPEN_KEY) !== '0')
  const [tab, setTabState] = useState<InfoTab>(() => {
    const saved = load(TAB_KEY)
    return INFO_TABS.find((t) => t.id === saved)?.id ?? 'performance'
  })
  const [height, setHeight] = useState(() => Math.max(MIN_HEIGHT, Number(load(HEIGHT_KEY)) || 300))
  const [wide, setWide] = useState(false)
  const [view, setView] = useState<View>({ processQuery: '', sort: { key: 'cpu', desc: true }, deviceQuery: '', onlyProblems: false, groups: {} })
  const info = usePcInfo(agent?.id ?? null, tab, (open || wide) && !!agent?.online)

  const setTab = (next: InfoTab) => {
    setTabState(next)
    save(TAB_KEY, next)
  }
  const toggle = () => {
    setOpen(!open)
    save(OPEN_KEY, open ? '0' : '1')
  }

  // 위쪽 가장자리를 끌어 높이 조절 (PC 목록이 조금은 보이게)
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startHeight = height
    const tree = e.currentTarget.closest('.pc-tree')
    const max = Math.max(MIN_HEIGHT, (tree?.clientHeight ?? window.innerHeight) - 160)
    let latest = startHeight
    const move = (ev: PointerEvent) => {
      latest = Math.round(Math.min(max, Math.max(MIN_HEIGHT, startHeight + startY - ev.clientY)))
      setHeight(latest)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      save(HEIGHT_KEY, String(latest))
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const tabs = (
    <span className="side-tabs pc-info-tabs" role="tablist" aria-label="PC 정보">
      {INFO_TABS.map((t) => (
        <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
          {t.label}
        </button>
      ))}
    </span>
  )

  return (
    <section className={`pc-info${open ? '' : ' closed'}`} style={open ? { height } : undefined} aria-label="PC 정보">
      {open && <div className="pc-info-resizer" title="끌어서 높이 조절" onPointerDown={startResize} />}
      <div className="pc-info-head">
        <button type="button" className="pc-info-toggle" aria-expanded={open} onClick={toggle}>
          <span aria-hidden="true">{open ? '▾' : '▸'}</span> PC 정보
        </button>
        <span className="pc-info-name ellipsis" translate="no" title={name ?? ''}>{name ?? ''}</span>
        {agent?.online && open && (
          <button type="button" className="icon-mini" title="새로 고침" onClick={info.refresh}>↻</button>
        )}
        {agent && (
          <button type="button" className="icon-mini" title="크게 보기" onClick={() => setWide(true)}>⤢</button>
        )}
      </div>
      {open && (
        <>
          {tabs}
          <div className="pc-info-body">
            <InfoBody agent={agent} tab={tab} info={info} wide={false} view={view} setView={setView} />
          </div>
        </>
      )}
      {wide && agent && (
        <InfoWindow name={name ?? agent.machineName} tabs={tabs} onRefresh={info.refresh} onClose={() => setWide(false)}>
          <InfoBody agent={agent} tab={tab} info={info} wide view={view} setView={setView} />
        </InfoWindow>
      )}
    </section>
  )
}

function InfoWindow({ name, tabs, onRefresh, onClose, children }: {
  name: string
  tabs: ReactNode
  onRefresh: () => void
  onClose: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    ref.current?.showModal()
  }, [])
  return (
    <dialog
      ref={ref}
      className="dialog pc-info-dialog"
      aria-label={`${name} · PC 정보`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) ref.current.close()
      }}
    >
      <div className="dialog-head">
        <h2 className="ellipsis">
          <span translate="no">{name}</span>
          <span className="muted"> · PC 정보</span>
        </h2>
        {tabs}
        <span className="pc-info-dialog-actions">
          <button type="button" className="icon" title="새로 고침" onClick={onRefresh}>↻</button>
          <button type="button" className="icon" aria-label="닫기" onClick={() => ref.current?.close()}>✕</button>
        </span>
      </div>
      <div className="pc-info-dialog-body">{children}</div>
    </dialog>
  )
}

function InfoBody({ agent, tab, info, wide, view, setView }: {
  agent: Agent | null
  tab: InfoTab
  info: PcInfoState
  wide: boolean
  view: View
  setView: (update: (v: View) => View) => void
}) {
  if (!agent) return <p className="small muted">트리에서 PC를 누르면 그 PC 정보가 보입니다</p>
  if (!agent.online) return <p className="small muted">PC가 오프라인입니다.</p>
  return (
    <>
      {info.error && <p className="error small">{info.error}</p>}
      {tab === 'system' && <SystemView info={info.system} at={info.systemAt} agent={agent} />}
      {tab === 'disk' && <DiskView drives={info.system?.drives} />}
      {tab === 'processes' && <ProcessView items={info.processes} wide={wide} view={view} setView={setView} />}
      {tab === 'performance' && <PerfView samples={info.samples} wide={wide} />}
      {tab === 'devices' && <DeviceView items={info.devices} wide={wide} view={view} setView={setView} />}
    </>
  )
}

const Reading = () => <p className="small muted">읽는 중…</p>

/** at: 정보를 받은 시각 (가동 시간은 그때 기준, 30초마다 다시 받는다) */
function SystemView({ info, at, agent }: { info: PcSystemInfo | null; at: number; agent: Agent }) {
  if (!info) return <Reading />
  const model = [info.manufacturer, info.model].filter(Boolean).join(' ')
  return (
    <dl className="pc-info-kv">
      <dt>운영체제</dt>
      <dd>{`${info.os} · ${info.architecture}`}</dd>
      <dt>버전</dt>
      <dd>
        {info.platform === 'linux' ? `커널 ${info.osBuild}` : info.osVersion ? `${info.osVersion} (빌드 ${info.osBuild})` : `빌드 ${info.osBuild}`}
      </dd>
      {model && (
        <>
          <dt>모델</dt>
          <dd>{model}</dd>
        </>
      )}
      {info.bios && (
        <>
          <dt>BIOS</dt>
          <dd>{info.bios}</dd>
        </>
      )}
      <dt>CPU</dt>
      <dd>
        <div>{info.cpu || '-'}</div>
        <div className="muted">
          {info.cores > 0 ? `${info.cores}코어 · 논리 프로세서 ${info.logicalProcessors}개` : `논리 프로세서 ${info.logicalProcessors}개`}
        </div>
      </dd>
      <dt>메모리</dt>
      <dd>{formatBytes(info.memoryBytes)}</dd>
      {info.gpus.length > 0 && (
        <>
          <dt>그래픽</dt>
          <dd>
            {info.gpus.map((gpu, i) => (
              <div key={i}>{gpu}</div>
            ))}
          </dd>
        </>
      )}
      <dt>가동 시간</dt>
      <dd>
        <div>{formatUptime(at - new Date(info.bootTime).getTime())}</div>
        <div className="muted">{`${formatTime(info.bootTime)} 부팅`}</div>
      </dd>
      <dt>로그인</dt>
      <dd>{info.users.length > 0 ? info.users.join(', ') : '없음'}</dd>
      <dt>IP</dt>
      <dd className="mono">{agent.ipAddresses.join(', ') || '-'}</dd>
      <dt>에이전트</dt>
      <dd>{`v${agent.agentVersion}`}</dd>
    </dl>
  )
}

const DRIVE_TYPE: Record<DriveDetail['type'], string> = {
  fixed: '로컬 디스크',
  removable: '이동식 디스크',
  network: '네트워크 드라이브',
  cdrom: 'CD/DVD',
  other: '기타',
}

function DiskView({ drives }: { drives: DriveDetail[] | undefined }) {
  if (!drives) return <Reading />
  if (drives.length === 0) return <p className="small muted">드라이브가 없습니다</p>
  return (
    <ul className="pc-drives">
      {drives.map((d) => {
        const used = d.totalBytes - d.freeBytes
        return (
          <li key={d.name}>
            <div className="pc-drive-head">
              <b className="mono" translate="no">{d.name.replace(/\\$/, '')}</b>
              {d.label && <span className="ellipsis" translate="no">{d.label}</span>}
              <span className="muted">{DRIVE_TYPE[d.type]}</span>
              {d.format && <span className="muted">{d.format}</span>}
            </div>
            <meter min={0} max={d.totalBytes} value={used} low={d.totalBytes * 0.8} high={d.totalBytes * 0.9} optimum={0} />
            <div className="pc-drive-foot">
              <span>{`${formatBytes(d.freeBytes)} 남음`}</span>
              <span className="muted">{`/ ${formatBytes(d.totalBytes)}`}</span>
              <span className="muted">{`${Math.round((used / d.totalBytes) * 100)}% 사용`}</span>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function ProcessView({ items, wide, view, setView }: {
  items: ProcessEntry[] | null
  wide: boolean
  view: View
  setView: (update: (v: View) => View) => void
}) {
  if (!items) return <Reading />
  const query = view.processQuery.trim().toLowerCase()
  const { key, desc } = view.sort
  const shown = (query ? items.filter((p) => p.name.toLowerCase().includes(query) || String(p.id) === query) : items)
    .slice()
    .sort((a, b) => {
      const order = key === 'name' ? a.name.localeCompare(b.name) : a[key] - b[key]
      return (desc ? -order : order) || a.id - b.id
    })
  const sortBy = (next: SortKey) =>
    setView((v) => ({ ...v, sort: { key: next, desc: v.sort.key === next ? !v.sort.desc : next !== 'name' && next !== 'id' } }))
  const mark = (k: SortKey) => (key === k ? (desc ? ' ▾' : ' ▴') : '')
  const totalCpu = items.reduce((n, p) => n + p.cpu, 0)

  return (
    <div className="pc-procs">
      <div className="pc-info-tools">
        <input
          type="search"
          placeholder="프로세스 검색"
          value={view.processQuery}
          onChange={(e) => setView((v) => ({ ...v, processQuery: e.target.value }))}
        />
        {!wide && (
          <span className="segmented">
            <button type="button" className={key === 'cpu' ? 'active' : ''} onClick={() => setView((v) => ({ ...v, sort: { key: 'cpu', desc: true } }))}>CPU</button>
            <button type="button" className={key === 'memory' ? 'active' : ''} onClick={() => setView((v) => ({ ...v, sort: { key: 'memory', desc: true } }))}>메모리</button>
          </span>
        )}
      </div>
      <p className="pc-info-summary small muted">
        <span>{`프로세스 ${items.length}개`}</span>
        <span title="PC 전체 대비 CPU 사용률">{`CPU ${totalCpu.toFixed(0)}%`}</span>
      </p>
      {wide ? (
        <table className="pc-table">
          <thead>
            <tr>
              <th><button type="button" onClick={() => sortBy('name')}>이름{mark('name')}</button></th>
              <th className="num"><button type="button" onClick={() => sortBy('id')}>PID{mark('id')}</button></th>
              <th className="num"><button type="button" onClick={() => sortBy('cpu')}>CPU{mark('cpu')}</button></th>
              <th className="num"><button type="button" onClick={() => sortBy('memory')}>메모리{mark('memory')}</button></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => (
              <tr key={p.id}>
                <td translate="no">{p.name}</td>
                <td className="num mono">{p.id}</td>
                <td className="num mono">{`${p.cpu.toFixed(1)}%`}</td>
                <td className="num mono">{formatBytes(p.memory)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="pc-proc-list">
          {shown.map((p) => (
            <li key={p.id} title={`${p.name} (PID ${p.id})`}>
              <span className="ellipsis" translate="no">{p.name}</span>
              <span className="mono">{`${p.cpu.toFixed(1)}%`}</span>
              <span className="mono">{formatBytes(p.memory)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function PerfView({ samples, wide }: { samples: PerfSample[]; wide: boolean }) {
  const last = samples[samples.length - 1]
  if (!last) return <p className="small muted">재는 중…</p>
  const percent = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0)
  // 속도 그래프: 최근 값 중 가장 큰 값 기준 (작은 흔들림이 꽉 차 보이지 않게 64KB/s 이상)
  const rateMax = (...series: number[][]) => Math.max(64 * 1024, ...series.flat())
  const receive = samples.map((s) => s.netReceive)
  const send = samples.map((s) => s.netSend)
  const hasGpu = samples.some((s) => s.gpu !== null)
  return (
    <div className={`pc-perf${wide ? ' wide' : ''}`}>
      <PerfRow label="CPU" value={`${last.cpu.toFixed(0)}%`} series={[samples.map((s) => s.cpu)]} max={100} />
      <PerfRow
        label="메모리"
        value={`${formatBytes(last.memoryUsed)} / ${formatBytes(last.memoryTotal)}`}
        sub={`${percent(last.memoryUsed, last.memoryTotal).toFixed(0)}%`}
        series={[samples.map((s) => percent(s.memoryUsed, s.memoryTotal))]}
        max={100}
      />
      <PerfRow
        label="디스크"
        value={`활성 ${last.diskActive.toFixed(0)}%`}
        sub={`읽기 ${formatRate(last.diskRead)} · 쓰기 ${formatRate(last.diskWrite)}`}
        series={[samples.map((s) => s.diskActive)]}
        max={100}
      />
      <PerfRow
        label="네트워크"
        value={`받기 ${formatRate(last.netReceive)}`}
        sub={`보내기 ${formatRate(last.netSend)}`}
        series={[receive, send]}
        max={rateMax(receive, send)}
      />
      {hasGpu && <PerfRow label="GPU" value={`${(last.gpu ?? 0).toFixed(0)}%`} series={[samples.map((s) => s.gpu ?? 0)]} max={100} />}
      <p className="small muted">최근 60초 · 1초마다</p>
    </div>
  )
}

function PerfRow({ label, value, sub, series, max }: { label: string; value: string; sub?: string; series: number[][]; max: number }) {
  return (
    <div className="pc-perf-row">
      <div className="pc-perf-text">
        <span className="pc-perf-label">{label}</span>
        <span className="pc-perf-value">{value}</span>
        {sub && <span className="pc-perf-sub muted">{sub}</span>}
      </div>
      <Spark series={series} max={max} />
    </div>
  )
}

/** 최근 60초 그래프 (오른쪽 끝이 지금) */
function Spark({ series, max }: { series: number[][]; max: number }) {
  const right = PERF_POINTS - 1
  return (
    <svg className="pc-spark" viewBox={`0 0 ${right} 100`} preserveAspectRatio="none" aria-hidden="true">
      {series.map((values, i) => {
        if (values.length < 2) return null
        const start = right - (values.length - 1)
        const points = values.map((v, j) => `${start + j},${(100 - Math.min(100, (Math.max(0, v) / max) * 100)).toFixed(1)}`).join(' ')
        return (
          <g key={i} className={`s${i}`}>
            <polygon points={`${start},100 ${points} ${right},100`} />
            <polyline points={points} vectorEffect="non-scaling-stroke" />
          </g>
        )
      })}
    </svg>
  )
}

function ProblemBadge({ code }: { code: number }) {
  return (
    <span className={`pc-problem${code === 22 ? ' disabled' : ''}`} title={`문제 코드 ${code}`}>
      {PROBLEM_TEXT[code] ?? `문제 코드 ${code}`}
    </span>
  )
}

function DeviceView({ items, wide, view, setView }: {
  items: DeviceEntry[] | null
  wide: boolean
  view: View
  setView: (update: (v: View) => View) => void
}) {
  if (!items) return <Reading />
  const query = view.deviceQuery.trim().toLowerCase()
  const shown = items.filter((d) =>
    (!view.onlyProblems || d.problem !== 0)
    && (!query || d.name.toLowerCase().includes(query) || d.class.toLowerCase().includes(query) || (d.id ?? '').toLowerCase().includes(query)))
  const groups = new Map<string, DeviceEntry[]>()
  for (const d of shown) groups.set(d.class, [...(groups.get(d.class) ?? []), d])
  const sorted = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b, 'ko'))
  const problems = items.filter((d) => d.problem !== 0).length

  return (
    <div className="pc-devices">
      <div className="pc-info-tools">
        <input type="search" placeholder="장치 검색" value={view.deviceQuery} onChange={(e) => setView((v) => ({ ...v, deviceQuery: e.target.value }))} />
        <label className="check small">
          <input type="checkbox" checked={view.onlyProblems} onChange={(e) => setView((v) => ({ ...v, onlyProblems: e.target.checked }))} />
          문제 있는 장치만
        </label>
      </div>
      <p className="pc-info-summary small muted">
        <span>{`장치 ${items.length}개`}</span>
        {problems > 0 && <span className="pc-problem-count">{`문제 ${problems}개`}</span>}
      </p>
      {sorted.length === 0 && <p className="small muted">{view.onlyProblems ? '문제 있는 장치가 없습니다' : '장치가 없습니다'}</p>}
      <ul className="pc-device-groups">
        {sorted.map(([cls, list]) => {
          const hasProblem = list.some((d) => d.problem !== 0)
          const isOpen = view.groups[cls] ?? (hasProblem || query.length > 0 || view.onlyProblems)
          return (
            <li key={cls}>
              <button
                type="button"
                className="pc-device-group"
                aria-expanded={isOpen}
                onClick={() => setView((v) => ({ ...v, groups: { ...v.groups, [cls]: !isOpen } }))}
              >
                <span aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                <span className="ellipsis">{cls}</span>
                <span className="muted">{list.length}</span>
                {hasProblem && <span className="pc-problem-dot" aria-hidden="true">⚠</span>}
              </button>
              {isOpen && (wide ? (
                <table className="pc-table pc-device-table">
                  <tbody>
                    {list.map((d, i) => (
                      <tr key={`${d.id ?? d.name}-${i}`} className={d.problem ? 'problem' : ''}>
                        <td translate="no">{d.name}</td>
                        <td className="muted" translate="no">{d.manufacturer ?? ''}</td>
                        <td>{d.problem ? <ProblemBadge code={d.problem} /> : <span className="muted">정상</span>}</td>
                        <td className="mono small muted" translate="no">{d.id ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <ul className="pc-device-list">
                  {list.map((d, i) => (
                    <li key={`${d.id ?? d.name}-${i}`} className={d.problem ? 'problem' : ''} title={d.id ?? ''}>
                      <span className="ellipsis" translate="no">{d.name}</span>
                      {d.problem !== 0 && <ProblemBadge code={d.problem} />}
                    </li>
                  ))}
                </ul>
              ))}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
