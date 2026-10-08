import { useEffect, useMemo, useRef, useState } from 'react'
import { type Agent, type Org, PC_STATUS_LABEL, type PcGroups, type PcStatus, type RemoteUsage, type Transfer } from '../api'
import { buildTree, displayName, type FolderNode } from './explorer/pcGroups'
import { kindLabel } from './explorer/useTransfers'

interface Props {
  agents: Agent[]
  pcGroups: PcGroups
  pcStatuses: Record<string, PcStatus>
  remoteUsage: RemoteUsage['inUseBy']
  /** agentId → 그 PC 탐색 창을 보고 있는 사용자들 */
  presence: Record<string, string[]>
  transfers: Transfer[]
  org: Org
  serverHostName: string | null
  selfUserId: string | null
  connected: boolean
}

// ── 화면 모델 (Canvas가 매 프레임 읽는다)
interface PcNode {
  id: string
  name: string
  group: string
  online: boolean
  status: PcStatus['status'] | null
  inUseBy: string | null
  viewers: string[]
  x: number
  y: number
  angle: number
}
interface UserNode {
  id: string
  name: string
  self: boolean
  x: number
  y: number
}
interface Burst {
  x: number
  y: number
  color: string
  born: number
  big: boolean
}
interface LogEntry {
  id: number
  at: number
  text: string
  tone: 'ok' | 'bad' | 'info' | 'remote'
}

const COLORS = {
  online: '#35f0c9',
  offline: '#4a5468',
  remote: '#ff3fa4',
  testing: '#ffb547',
  forbidden: '#ff4d5e',
  maintenance: '#5aa8ff',
  server: '#7fd8ff',
  user: '#c49bff',
  self: '#ffd36b',
  fetch: '#4fe3ff',
  push: '#ffc95a',
  compress: '#b37dff',
  extract: '#7dffa8',
}
const HUD_WIDTH = 300

const pcColor = (n: PcNode) =>
  !n.online ? COLORS.offline
    : n.inUseBy ? COLORS.remote
      : n.status === 'forbidden' ? COLORS.forbidden
        : n.status === 'testing' ? COLORS.testing
          : n.status === 'maintenance' ? COLORS.maintenance : COLORS.online

const transferColor = (t: Transfer) =>
  t.kind === 'Compress' ? COLORS.compress : t.kind === 'Extract' ? COLORS.extract : t.kind === 'Push' ? COLORS.push : COLORS.fetch

const leaf = (p: string | null) => p?.split(/[\\/]/).filter(Boolean).pop() ?? ''

/** State: 우주 배경 위에 서버·PC·사용자를 광케이블로 잇고 상태·동작을 실시간으로 보여 준다 */
export function StatePage({ agents, pcGroups, pcStatuses, remoteUsage, presence, transfers, org, serverHostName, selfUserId, connected }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [hover, setHover] = useState<{ x: number; y: number; lines: string[] } | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  const burstsRef = useRef<Burst[]>([])
  const logId = useRef(0)

  const userName = (id: string) => org.users.find((u) => u.id === id)?.name ?? '사용자'

  // 그룹(폴더) 순서대로 PC를 늘어놓는다 (하위 폴더는 "상위 / 하위")
  const ordered = useMemo(() => {
    const { roots, ungrouped } = buildTree(pcGroups, agents)
    const out: { agent: Agent; group: string }[] = []
    const walk = (n: FolderNode, path: string) => {
      for (const a of n.agents) out.push({ agent: a, group: path })
      for (const c of n.children) walk(c, `${path} / ${c.folder.name}`)
    }
    for (const r of roots) walk(r, r.folder.name)
    for (const a of ungrouped) out.push({ agent: a, group: '미분류' })
    return out
  }, [agents, pcGroups])

  // 지금 활동 중인 사용자: 원격조작 · PC 탐색 · 전송을 실행한 사람 + 나
  const activeTransfers = useMemo(() => transfers.filter((t) => t.state === 'Pending' && t.kind !== 'Collect'), [transfers])
  const userIds = useMemo(() => {
    const ids = new Set<string>()
    if (selfUserId) ids.add(selfUserId)
    for (const u of Object.values(remoteUsage)) ids.add(u.userId)
    for (const list of Object.values(presence)) for (const id of list) ids.add(id)
    for (const t of activeTransfers) if (t.startedByUserId) ids.add(t.startedByUserId)
    return [...ids].filter((id) => org.users.some((u) => u.id === id))
  }, [selfUserId, remoteUsage, presence, activeTransfers, org.users])

  // 크기
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 배치: 서버는 가운데(HUD 왼쪽 영역), PC는 서버 둘레 궤도, 사용자는 왼쪽 세로줄
  const layout = useMemo(() => {
    const areaW = Math.max(320, size.w - HUD_WIDTH)
    const cx = areaW * 0.56
    const cy = size.h * 0.5
    const base = Math.min(areaW * 0.62, size.h) * 0.36
    const n = ordered.length
    const rings = n > 28 ? 2 : 1
    // 그룹 사이에 빈칸을 두어 구역이 보이게
    const groups: string[] = []
    for (const o of ordered) if (groups[groups.length - 1] !== o.group) groups.push(o.group)
    const slots = n + groups.length
    const pcs: PcNode[] = []
    const groupArcs: { name: string; angle: number; r: number }[] = []
    let slot = 0
    let lastGroup = ''
    let groupStart = 0
    ordered.forEach(({ agent, group }, i) => {
      if (group !== lastGroup) {
        if (lastGroup) groupArcs.push({ name: lastGroup, angle: (groupStart + slot - 1) / 2, r: 0 })
        slot += 1
        groupStart = slot
        lastGroup = group
      }
      const angle = -Math.PI / 2 + (slot / Math.max(1, slots)) * Math.PI * 2
      const r = rings === 2 ? base * (i % 2 === 0 ? 0.92 : 1.22) : base
      pcs.push({
        id: agent.id,
        name: displayName(agent, pcGroups),
        group,
        online: agent.online,
        status: pcStatuses[agent.id]?.status ?? null,
        inUseBy: remoteUsage[agent.id]?.userId ?? null,
        viewers: presence[agent.id] ?? [],
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r * 0.86,
        angle,
      })
      slot += 1
    })
    if (lastGroup) groupArcs.push({ name: lastGroup, angle: (groupStart + slot - 1) / 2, r: 0 })
    const labels = groupArcs.map((g) => {
      const angle = -Math.PI / 2 + (g.angle / Math.max(1, slots)) * Math.PI * 2
      const r = base * (rings === 2 ? 1.5 : 1.32)
      return { name: g.name, x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r * 0.86 }
    })
    const users: UserNode[] = userIds.map((id, i) => ({
      id,
      name: userName(id),
      self: id === selfUserId,
      x: Math.max(70, areaW * 0.08),
      y: size.h / 2 + (i - (userIds.length - 1) / 2) * Math.min(70, (size.h - 120) / Math.max(1, userIds.length)),
    }))
    return { cx, cy, base, pcs, users, labels }
    // userName은 org에서 매번 찾는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, ordered, pcGroups, pcStatuses, remoteUsage, presence, userIds, selfUserId, org.users])

  // 화면 모델은 ref로 넘겨 애니메이션이 다시 시작되지 않게
  const modelRef = useRef({ layout, activeTransfers })
  modelRef.current = { layout, activeTransfers }

  // 이벤트: 전송 완료·실패, 원격조작 시작·종료, PC 접속·끊김 → 섬광 + 기록
  const prevRef = useRef<{ transfers: Map<string, Transfer['state']>; remote: Record<string, string>; online: Map<string, boolean> } | null>(null)
  useEffect(() => {
    const now = performance.now()
    const pcAt = (id: string) => layout.pcs.find((p) => p.id === id)
    const pcName = (id: string) => pcAt(id)?.name ?? id.slice(0, 8)
    const entries: LogEntry[] = []
    const add = (text: string, tone: LogEntry['tone']) => entries.push({ id: ++logId.current, at: Date.now(), text, tone })
    const burst = (id: string, color: string, big = false) => {
      const p = pcAt(id)
      if (p) burstsRef.current.push({ x: p.x, y: p.y, color, born: now, big })
    }
    const prev = prevRef.current
    const cur = {
      transfers: new Map(transfers.map((t) => [t.id, t.state])),
      remote: Object.fromEntries(Object.entries(remoteUsage).map(([k, v]) => [k, v.userId])),
      online: new Map(agents.map((a) => [a.id, a.online])),
    }
    if (prev) {
      for (const t of transfers) {
        const before = prev.transfers.get(t.id)
        if (t.kind === 'Collect') continue
        if (before === undefined && t.state === 'Pending') add(`${pcName(t.agentId)} · ${kindLabel(t.kind)} 시작 ${leaf(t.path)}`, 'info')
        if (before === 'Pending' && t.state === 'Succeeded') {
          add(`${pcName(t.agentId)} · ${kindLabel(t.kind)} 완료 ${leaf(t.path)}`, 'ok')
          burst(t.agentId, transferColor(t), true)
        }
        if (before === 'Pending' && t.state === 'Failed') {
          add(`${pcName(t.agentId)} · ${kindLabel(t.kind)} 실패 ${t.error ?? ''}`, 'bad')
          burst(t.agentId, COLORS.forbidden, true)
        }
      }
      for (const [id, uid] of Object.entries(cur.remote))
        if (prev.remote[id] !== uid) {
          add(`${userName(uid)} → ${pcName(id)} 원격조작 시작`, 'remote')
          burst(id, COLORS.remote)
        }
      for (const id of Object.keys(prev.remote)) if (!cur.remote[id]) add(`${pcName(id)} 원격조작 종료`, 'info')
      for (const [id, on] of cur.online) {
        const was = prev.online.get(id)
        if (was === undefined) continue
        if (!was && on) {
          add(`${pcName(id)} 접속`, 'ok')
          burst(id, COLORS.online)
        }
        if (was && !on) add(`${pcName(id)} 연결 끊김`, 'bad')
      }
    }
    prevRef.current = cur
    if (entries.length) setLog((l) => [...entries.reverse(), ...l].slice(0, 30))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transfers, remoteUsage, agents])

  // ── 그리기
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size.w * dpr)
    canvas.height = Math.round(size.h * dpr)
    canvas.style.width = `${size.w}px`
    canvas.style.height = `${size.h}px`
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const speed = reduced ? 0.3 : 1

    // 별 3겹 (먼 것은 느리게)
    const rand = (seed: number) => {
      let s = seed
      return () => ((s = (s * 16807) % 2147483647) / 2147483647)
    }
    const r = rand(12345)
    const stars = [0.15, 0.35, 0.7].flatMap((depth, layer) =>
      Array.from({ length: Math.round((size.w * size.h) / (layer === 0 ? 2600 : layer === 1 ? 6500 : 16000)) }, () => ({
        x: r() * size.w,
        y: r() * size.h,
        size: (layer + 1) * 0.45 + r() * 0.6,
        depth,
        tw: r() * Math.PI * 2,
      })),
    )
    const nebulae = Array.from({ length: 4 }, (_, i) => ({
      x: r() * size.w,
      y: r() * size.h,
      rad: Math.max(size.w, size.h) * (0.25 + r() * 0.25),
      hue: [265, 200, 320, 185][i],
    }))

    let raf = 0
    const start = performance.now()

    const curve = (ax: number, ay: number, bx: number, by: number, bend = 0.12) => {
      const mx = (ax + bx) / 2
      const my = (ay + by) / 2
      const dx = bx - ax
      const dy = by - ay
      return { ax, ay, bx, by, qx: mx - dy * bend, qy: my + dx * bend }
    }
    type Curve = ReturnType<typeof curve>
    const at = (c: Curve, t: number) => {
      const u = 1 - t
      return { x: u * u * c.ax + 2 * u * t * c.qx + t * t * c.bx, y: u * u * c.ay + 2 * u * t * c.qy + t * t * c.by }
    }
    const stroke = (c: Curve, color: string, width: number, alpha: number, dash?: number[]) => {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = color
      ctx.lineWidth = width
      if (dash) ctx.setLineDash(dash)
      ctx.beginPath()
      ctx.moveTo(c.ax, c.ay)
      ctx.quadraticCurveTo(c.qx, c.qy, c.bx, c.by)
      ctx.stroke()
      ctx.restore()
    }
    /** 선을 따라 흐르는 빛 (꼬리 포함). reverse면 b → a */
    const pulses = (c: Curve, now: number, color: string, count: number, period: number, sizePx: number, reverse = false, tail = 6) => {
      for (let k = 0; k < count; k++) {
        const phase = ((now / period + k / count) % 1 + 1) % 1
        for (let j = 0; j < tail; j++) {
          const t = phase - j * 0.012
          if (t < 0) continue
          const p = at(c, reverse ? 1 - t : t)
          const a = (1 - j / tail) * 0.9
          glowDot(p.x, p.y, sizePx * (1 - j / (tail * 1.4)), color, a)
        }
      }
    }
    const glowDot = (x: number, y: number, rad: number, color: string, alpha: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, rad * 3)
      g.addColorStop(0, color)
      g.addColorStop(0.35, color + 'aa')
      g.addColorStop(1, color + '00')
      ctx.globalAlpha = alpha
      ctx.fillStyle = g
      ctx.beginPath()
      ctx.arc(x, y, rad * 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }

    const frame = (nowAbs: number) => {
      const now = (nowAbs - start) * speed
      const { layout: L, activeTransfers: T } = modelRef.current
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // 배경: 깊은 우주 + 성운 + 별
      const bg = ctx.createLinearGradient(0, 0, 0, size.h)
      bg.addColorStop(0, '#04050d')
      bg.addColorStop(1, '#0a0b1f')
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, size.w, size.h)
      ctx.globalCompositeOperation = 'lighter'
      for (const nb of nebulae) {
        const g = ctx.createRadialGradient(nb.x, nb.y, 0, nb.x, nb.y, nb.rad)
        g.addColorStop(0, `hsla(${nb.hue}, 80%, 45%, 0.10)`)
        g.addColorStop(1, `hsla(${nb.hue}, 80%, 30%, 0)`)
        ctx.fillStyle = g
        ctx.fillRect(nb.x - nb.rad, nb.y - nb.rad, nb.rad * 2, nb.rad * 2)
      }
      for (const s of stars) {
        const x = (((s.x - now * 0.004 * s.depth) % size.w) + size.w) % size.w
        const tw = 0.55 + 0.45 * Math.sin(now * 0.002 + s.tw)
        ctx.globalAlpha = tw * (0.35 + s.depth)
        ctx.fillStyle = '#dfe8ff'
        ctx.fillRect(x, s.y, s.size, s.size)
      }
      ctx.globalAlpha = 1

      const { cx, cy } = L
      // 궤도 고리
      ctx.save()
      ctx.globalAlpha = 0.18
      ctx.strokeStyle = '#6fa8ff'
      ctx.setLineDash([2, 6])
      ctx.lineDashOffset = -now * 0.01
      ctx.beginPath()
      ctx.ellipse(cx, cy, L.base, L.base * 0.86, 0, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()

      // 서버 ↔ PC 광케이블
      for (const p of L.pcs) {
        const c = curve(cx, cy, p.x, p.y, 0.1)
        const col = pcColor(p)
        if (!p.online) {
          stroke(c, COLORS.offline, 1, 0.35, [3, 5])
          continue
        }
        stroke(c, col, 3, 0.08)
        stroke(c, col, 1, 0.45)
        // 평소: 느린 심장 박동 빛
        pulses(c, now + p.angle * 900, col, 1, 2600, 1.6, false, 5)
      }
      // 사용자 ↔ 서버
      for (const u of L.users) {
        const c = curve(u.x, u.y, cx, cy, -0.08)
        const col = u.self ? COLORS.self : COLORS.user
        stroke(c, col, 3, 0.07)
        stroke(c, col, 1, 0.4)
        pulses(c, now + u.y * 7, col, 1, 3200, 1.4, false, 5)
      }

      // 원격조작: 사용자 → 서버 → PC 굵은 빔 (화면은 PC → 사용자로 촘촘히, 입력은 반대로)
      for (const p of L.pcs) {
        if (!p.inUseBy) continue
        const u = L.users.find((x) => x.id === p.inUseBy)
        const legs = [curve(cx, cy, p.x, p.y, 0.1), ...(u ? [curve(u.x, u.y, cx, cy, -0.08)] : [])]
        for (const c of legs) {
          stroke(c, COLORS.remote, 6, 0.12)
          stroke(c, COLORS.remote, 1.6, 0.8)
        }
        pulses(legs[0], now, COLORS.remote, 5, 900, 2.1, true, 7)
        pulses(legs[0], now, '#ffffff', 2, 1400, 1.2, false, 4)
        if (legs[1]) {
          pulses(legs[1], now, COLORS.remote, 5, 900, 2.1, true, 7)
          pulses(legs[1], now, '#ffffff', 2, 1400, 1.2, false, 4)
        }
      }
      // PC 탐색(보기): 사용자 → PC 가는 점선
      for (const p of L.pcs) {
        for (const vid of p.viewers) {
          if (vid === p.inUseBy) continue
          const u = L.users.find((x) => x.id === vid)
          if (!u) continue
          const c = curve(u.x, u.y, p.x, p.y, 0.18)
          ctx.save()
          ctx.lineDashOffset = -now * 0.03
          stroke(c, u.self ? COLORS.self : COLORS.user, 1, 0.22, [2, 7])
          ctx.restore()
        }
      }

      // 전송: 가져오기는 PC → 서버, 올리기는 서버 → PC, 압축은 소용돌이, 풀기는 퍼짐
      for (const t of T) {
        const p = L.pcs.find((x) => x.id === t.agentId)
        if (!p) continue
        const col = transferColor(t)
        if (t.kind === 'Fetch' || t.kind === 'Push') {
          const c = curve(cx, cy, p.x, p.y, 0.1)
          stroke(c, col, 5, 0.15)
          stroke(c, col, 1.4, 0.85)
          pulses(c, now, col, 6, 1100, 2.3, t.kind === 'Fetch', 8)
          const u = t.startedByUserId ? L.users.find((x) => x.id === t.startedByUserId) : null
          if (u) pulses(curve(u.x, u.y, cx, cy, -0.08), now, col, 3, 1500, 1.6, t.kind === 'Fetch', 5)
        } else {
          // 압축: 안으로 빨려 드는 소용돌이 / 풀기: 밖으로 퍼지는 입자
          const inward = t.kind === 'Compress'
          for (let k = 0; k < 14; k++) {
            const ph = ((now / 1600 + k / 14) % 1 + 1) % 1
            const rr = inward ? 34 * (1 - ph) + 6 : 6 + 34 * ph
            const ang = k * 2.4 + now * (inward ? 0.004 : 0.0015) + ph * (inward ? 5 : 1.5)
            glowDot(p.x + Math.cos(ang) * rr, p.y + Math.sin(ang) * rr * 0.8, 1.6, col, inward ? 0.25 + ph * 0.7 : 0.95 - ph * 0.8)
          }
          ctx.save()
          ctx.globalAlpha = 0.55
          ctx.strokeStyle = col
          ctx.lineWidth = 1.2
          ctx.beginPath()
          ctx.arc(p.x, p.y, 24, now * 0.004, now * 0.004 + Math.PI * 1.3)
          ctx.stroke()
          ctx.restore()
        }
        // 진행률 고리
        if (typeof t.percent === 'number') {
          ctx.save()
          ctx.globalCompositeOperation = 'source-over'
          ctx.strokeStyle = col
          ctx.lineWidth = 2.5
          ctx.beginPath()
          ctx.arc(p.x, p.y, 17, -Math.PI / 2, -Math.PI / 2 + (Math.PI * 2 * t.percent) / 100)
          ctx.stroke()
          ctx.fillStyle = col
          ctx.font = '600 10px "Segoe UI", sans-serif'
          ctx.textAlign = 'left'
          ctx.fillText(`${t.percent}%`, p.x + 22, p.y + 4)
          ctx.restore()
        }
      }

      // 섬광 (완료·실패·접속·원격 시작)
      const bursts = burstsRef.current
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i]
        const age = (nowAbs - b.born) / (b.big ? 1400 : 1000)
        if (age >= 1) {
          bursts.splice(i, 1)
          continue
        }
        const rad = (b.big ? 70 : 45) * age
        ctx.save()
        ctx.globalAlpha = 1 - age
        ctx.strokeStyle = b.color
        ctx.lineWidth = 3 * (1 - age) + 0.5
        ctx.beginPath()
        ctx.arc(b.x, b.y, rad, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
        for (let k = 0; k < 10; k++) {
          const a = (k / 10) * Math.PI * 2
          glowDot(b.x + Math.cos(a) * rad * 0.9, b.y + Math.sin(a) * rad * 0.9, 1.4, b.color, 1 - age)
        }
      }

      // 서버 코어
      const pulse = 1 + 0.06 * Math.sin(now * 0.004)
      glowDot(cx, cy, 16 * pulse, COLORS.server, 0.55)
      ctx.globalCompositeOperation = 'source-over'
      const core = ctx.createRadialGradient(cx - 6, cy - 6, 2, cx, cy, 26)
      core.addColorStop(0, '#ffffff')
      core.addColorStop(0.35, '#9be7ff')
      core.addColorStop(1, '#1b4a8f')
      ctx.fillStyle = core
      ctx.beginPath()
      ctx.arc(cx, cy, 24, 0, Math.PI * 2)
      ctx.fill()
      for (const [rad, sp, len] of [[36, 0.0016, 1.4], [46, -0.0011, 0.9], [56, 0.0007, 0.5]] as const) {
        ctx.save()
        ctx.strokeStyle = COLORS.server
        ctx.globalAlpha = 0.6
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(cx, cy, rad, now * sp, now * sp + Math.PI * len)
        ctx.stroke()
        ctx.beginPath()
        ctx.arc(cx, cy, rad, now * sp + Math.PI, now * sp + Math.PI + Math.PI * len * 0.5)
        ctx.stroke()
        ctx.restore()
      }

      // PC 노드
      ctx.globalCompositeOperation = 'source-over'
      for (const p of L.pcs) {
        const col = pcColor(p)
        ctx.globalCompositeOperation = 'lighter'
        if (p.online) glowDot(p.x, p.y, p.inUseBy ? 9 + 2 * Math.sin(now * 0.008) : 6, col, p.inUseBy ? 0.75 : 0.45)
        ctx.globalCompositeOperation = 'source-over'
        // 모니터 모양
        ctx.fillStyle = '#0c1222'
        ctx.strokeStyle = col
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.roundRect(p.x - 10, p.y - 8, 20, 13, 2)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = col
        ctx.globalAlpha = p.online ? 0.35 + 0.15 * Math.sin(now * 0.003 + p.angle * 3) : 0.12
        ctx.fillRect(p.x - 7.5, p.y - 5.5, 15, 8)
        ctx.globalAlpha = 1
        ctx.fillRect(p.x - 4, p.y + 6, 8, 1.5)
        // 상태 표시등 (깜빡임)
        const blink = p.online ? (p.inUseBy || p.status === 'testing' ? (Math.sin(now * 0.012) > 0 ? 1 : 0.25) : 1) : 0.4
        ctx.globalAlpha = blink
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.arc(p.x + 12, p.y - 8, 2.6, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
        // 이름
        ctx.font = '600 10.5px "Segoe UI", "Malgun Gothic", sans-serif'
        ctx.textAlign = 'center'
        ctx.fillStyle = p.online ? '#dce6ff' : '#6b7488'
        const below = Math.sin(p.angle) > -0.2
        ctx.fillText(p.name.length > 14 ? p.name.slice(0, 13) + '…' : p.name, p.x, below ? p.y + 22 : p.y - 16)
      }
      // 그룹 이름
      ctx.font = '700 11px "Segoe UI", "Malgun Gothic", sans-serif'
      ctx.textAlign = 'center'
      for (const g of L.labels) {
        ctx.fillStyle = 'rgba(140, 170, 255, 0.55)'
        ctx.fillText(g.name, g.x, g.y)
      }

      // 사용자
      for (const u of L.users) {
        const col = u.self ? COLORS.self : COLORS.user
        ctx.globalCompositeOperation = 'lighter'
        glowDot(u.x, u.y, 9, col, 0.4)
        ctx.globalCompositeOperation = 'source-over'
        ctx.fillStyle = '#120d24'
        ctx.strokeStyle = col
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(u.x, u.y, 14, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = col
        ctx.font = '700 12px "Malgun Gothic", sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(u.name.slice(0, 1), u.x, u.y + 0.5)
        ctx.textBaseline = 'alphabetic'
        ctx.font = '600 10.5px "Segoe UI", "Malgun Gothic", sans-serif'
        ctx.fillStyle = '#e6dcff'
        ctx.fillText(u.self ? `${u.name} (나)` : u.name, u.x, u.y + 28)
      }

      // 서버 이름
      ctx.font = '700 11px "Segoe UI", sans-serif'
      ctx.textAlign = 'center'
      ctx.fillStyle = '#bfefff'
      ctx.fillText('SERVER', cx, cy + 74)

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [size])

  // 마우스 올리면 자세히
  const onMove = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const near = (px: number, py: number, d: number) => Math.hypot(px - x, py - y) < d
    const pc = layout.pcs.find((p) => near(p.x, p.y, 16))
    if (pc) {
      const ts = activeTransfers.filter((t) => t.agentId === pc.id)
      setHover({
        x, y,
        lines: [
          pc.name,
          `${pc.group} · ${pc.online ? '온라인' : '오프라인'}${pc.status && pc.status !== 'available' ? ` · ${PC_STATUS_LABEL[pc.status]}` : ''}`,
          ...(pc.inUseBy ? [`원격조작: ${userName(pc.inUseBy)}`] : []),
          ...(pc.viewers.length ? [`보는 중: ${pc.viewers.map(userName).join(', ')}`] : []),
          ...ts.map((t) => `${kindLabel(t.kind)} ${typeof t.percent === 'number' ? `${t.percent}% ` : ''}${leaf(t.path)}`),
        ],
      })
      return
    }
    const u = layout.users.find((p) => near(p.x, p.y, 18))
    if (u) {
      const remote = layout.pcs.filter((p) => p.inUseBy === u.id).map((p) => p.name)
      setHover({ x, y, lines: [u.self ? `${u.name} (나)` : u.name, ...(remote.length ? [`원격조작: ${remote.join(', ')}`] : ['활동 중'])] })
      return
    }
    if (near(layout.cx, layout.cy, 30)) {
      setHover({ x, y, lines: ['관리 서버', serverHostName ?? '', connected ? '대시보드와 연결됨' : '연결 중…'] })
      return
    }
    setHover(null)
  }

  const online = agents.filter((a) => a.online).length
  const remoteCount = Object.keys(remoteUsage).length
  const byKind = (k: Transfer['kind']) => activeTransfers.filter((t) => t.kind === k).length

  return (
    <div className="state-page" ref={wrapRef}>
      <canvas ref={canvasRef} className="state-canvas" onMouseMove={onMove} onMouseLeave={() => setHover(null)} />
      {hover && (
        <div className="state-tip" style={{ left: Math.min(hover.x + 14, size.w - HUD_WIDTH - 230), top: hover.y + 14 }}>
          {hover.lines.filter(Boolean).map((l, i) => <div key={i} className={i === 0 ? 'state-tip-head' : ''}>{l}</div>)}
        </div>
      )}
      <aside className="state-hud" style={{ width: HUD_WIDTH }}>
        <div className="state-hud-title">SYSTEM STATE <span className={`state-live${connected ? ' on' : ''}`}>{connected ? 'LIVE' : 'OFFLINE'}</span></div>
        <div className="state-stats">
          <div><b style={{ color: COLORS.online }}>{online}</b><span>/ {agents.length}</span><label>PC 온라인</label></div>
          <div><b style={{ color: COLORS.user }}>{userIds.length}</b><label>활동 사용자</label></div>
          <div><b style={{ color: COLORS.remote }}>{remoteCount}</b><label>원격조작</label></div>
          <div><b style={{ color: COLORS.push }}>{activeTransfers.length}</b><label>진행 중 작업</label></div>
        </div>
        <div className="state-sec">진행 중</div>
        <ul className="state-ops">
          {Object.entries(remoteUsage).map(([id, u]) => (
            <li key={`r-${id}`}>
              <span className="state-op-dot" style={{ background: COLORS.remote }} />
              <span className="ellipsis">{userName(u.userId)} → {layout.pcs.find((p) => p.id === id)?.name ?? id.slice(0, 8)}</span>
              <em>원격</em>
            </li>
          ))}
          {activeTransfers.map((t) => (
            <li key={t.id}>
              <span className="state-op-dot" style={{ background: transferColor(t) }} />
              <span className="ellipsis" title={t.path ?? ''}>{layout.pcs.find((p) => p.id === t.agentId)?.name ?? '?'} · {leaf(t.path)}</span>
              <em>{kindLabel(t.kind)}</em>
              <span className="state-bar"><span style={{ width: `${typeof t.percent === 'number' ? t.percent : 100}%`, background: transferColor(t) }} className={typeof t.percent === 'number' ? '' : 'indet'} /></span>
            </li>
          ))}
          {remoteCount === 0 && activeTransfers.length === 0 && <li className="state-empty">조용합니다 · 진행 중인 작업 없음</li>}
        </ul>
        <div className="state-sec">이벤트</div>
        <ul className="state-log">
          {log.map((e) => (
            <li key={e.id} className={`tone-${e.tone}`}>
              <time>{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>
              <span className="ellipsis" title={e.text}>{e.text}</span>
            </li>
          ))}
          {log.length === 0 && <li className="state-empty">이 화면을 연 뒤의 접속·전송·원격조작이 여기에 쌓입니다</li>}
        </ul>
        <div className="state-sec">범례</div>
        <div className="state-legend">
          {([
            ['온라인', COLORS.online], ['원격조작 중', COLORS.remote], ['테스트 중', COLORS.testing], ['사용 금지', COLORS.forbidden],
            ['점검 중', COLORS.maintenance], ['오프라인', COLORS.offline], ['가져오기', COLORS.fetch], ['올리기·복사', COLORS.push],
            ['압축', COLORS.compress], ['압축 풀기', COLORS.extract],
          ] as const).map(([label, color]) => (
            <span key={label}><i style={{ background: color, boxShadow: `0 0 6px ${color}` }} />{label}</span>
          ))}
        </div>
        <p className="state-note">{byKind('Compress') + byKind('Extract') > 0 ? '보라 소용돌이 = 압축, 초록 퍼짐 = 압축 풀기' : 'PC에 마우스를 올리면 자세한 상태'}</p>
      </aside>
    </div>
  )
}
