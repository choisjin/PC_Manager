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
  /** 대시보드를 열어 둔 사용자 */
  onlineUsers: string[]
  connected: boolean
}

// ── 화면 모델
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
}
interface GroupPanel {
  key: string
  name: string
  color: string
  x: number
  y: number
  w: number
  h: number
  total: number
  online: number
}
interface UserNode {
  id: string
  name: string
  self: boolean
  active: boolean
  x: number
  y: number
}
interface Burst {
  id: string
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
type Pos = Record<string, { x: number; y: number }>

const COLORS = {
  online: '#35e0b5',
  offline: '#556074',
  remote: '#ff4fa8',
  testing: '#ffb547',
  forbidden: '#ff5466',
  maintenance: '#5aa8ff',
  server: '#8fd3ff',
  user: '#b896ff',
  self: '#ffd36b',
  fetch: '#4fd8ff',
  push: '#ffc95a',
  compress: '#b37dff',
  extract: '#6ff0a0',
}
const GROUP_COLORS = ['#5aa8ff', '#35e0b5', '#ffb547', '#c49bff', '#ff7ab6', '#7dd3fc', '#a3e635', '#f97316']
const HUD_WIDTH = 300
const CELL_W = 104
const CELL_H = 52
const CARD_W = 94
const CARD_H = 40
const HEAD_H = 30
const PAD = 10
const SERVER_W = 124
const SERVER_H = 54
const POS_KEY = 'pcm.state.pos'

const pcColor = (n: PcNode) =>
  !n.online ? COLORS.offline
    : n.inUseBy ? COLORS.remote
      : n.status === 'forbidden' ? COLORS.forbidden
        : n.status === 'testing' ? COLORS.testing
          : n.status === 'maintenance' ? COLORS.maintenance : COLORS.online

const transferColor = (t: Transfer) =>
  t.kind === 'Compress' ? COLORS.compress : t.kind === 'Extract' ? COLORS.extract : t.kind === 'Push' ? COLORS.push : COLORS.fetch

const leaf = (p: string | null) => p?.split(/[\\/]/).filter(Boolean).pop() ?? ''

function loadPos(): Pos {
  try {
    return JSON.parse(localStorage.getItem(POS_KEY) ?? '{}') as Pos
  } catch {
    return {}
  }
}

/** State: 격자 위에 서버·그룹(PC)·사용자를 빛이 흐르는 선으로 잇고 상태·동작을 실시간으로. 노드는 끌어서 옮긴다 */
export function StatePage({ agents, pcGroups, pcStatuses, remoteUsage, presence, transfers, org, serverHostName, selfUserId, onlineUsers, connected }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 800, h: 600 })
  const [hover, setHover] = useState<{ x: number; y: number; lines: string[] } | null>(null)
  const [log, setLog] = useState<LogEntry[]>([])
  // 끌어서 옮긴 위치 (화면 영역 비율 0~1: 창 크기가 바뀌어도 같은 자리)
  const [pos, setPos] = useState<Pos>(loadPos)
  const [drag, setDrag] = useState<{ key: string; dx: number; dy: number } | null>(null)
  const burstsRef = useRef<Burst[]>([])
  const logId = useRef(0)

  const userName = (id: string) => org.users.find((u) => u.id === id)?.name ?? '사용자'
  const areaW = Math.max(320, size.w - HUD_WIDTH)

  // 그룹(폴더)별 PC (하위 폴더는 "상위 / 하위")
  const grouped = useMemo(() => {
    const { roots, ungrouped } = buildTree(pcGroups, agents)
    const out: { key: string; name: string; agents: Agent[] }[] = []
    const walk = (n: FolderNode, path: string) => {
      if (n.agents.length) out.push({ key: n.folder.id, name: path, agents: n.agents })
      for (const c of n.children) walk(c, `${path} / ${c.folder.name}`)
    }
    for (const r of roots) walk(r, r.folder.name)
    if (ungrouped.length) out.push({ key: 'ungrouped', name: '미분류', agents: ungrouped })
    return out
  }, [agents, pcGroups])

  const activeTransfers = useMemo(() => transfers.filter((t) => t.state === 'Pending' && t.kind !== 'Collect'), [transfers])

  // 사용자: 대시보드를 열어 둔 모든 사람 + 원격조작·탐색·전송 중인 사람 + 나
  const users = useMemo(() => {
    const active = new Set<string>()
    for (const u of Object.values(remoteUsage)) active.add(u.userId)
    for (const list of Object.values(presence)) for (const id of list) active.add(id)
    for (const t of activeTransfers) if (t.startedByUserId) active.add(t.startedByUserId)
    const ids = new Set<string>([...onlineUsers, ...active])
    if (selfUserId) ids.add(selfUserId)
    return [...ids].filter((id) => org.users.some((u) => u.id === id)).map((id) => ({ id, active: active.has(id) }))
  }, [onlineUsers, remoteUsage, presence, activeTransfers, selfUserId, org.users])

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // 배치: 저장한 위치가 있으면 그 자리, 없으면 서버 둘레에 그룹 패널, 왼쪽에 사용자
  const layout = useMemo(() => {
    const at = (key: string, fx: number, fy: number) => {
      const p = pos[key]
      return { x: (p?.x ?? fx) * areaW, y: (p?.y ?? fy) * size.h }
    }
    const server = at('server', 0.56, 0.5)
    const panels: GroupPanel[] = []
    const pcs: PcNode[] = []
    grouped.forEach((g, i) => {
      const n = g.agents.length
      const cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt(n * 1.4))))
      const rows = Math.ceil(n / cols)
      const w = cols * CELL_W + PAD * 2 - (CELL_W - CARD_W)
      const h = HEAD_H + rows * CELL_H + PAD - (CELL_H - CARD_H)
      // 기본 자리: 서버 둘레 타원 (위에서 시계 방향)
      const angle = -Math.PI / 2 + (i / Math.max(1, grouped.length)) * Math.PI * 2 + (grouped.length === 2 ? Math.PI / 2 : 0)
      const def = { x: 0.56 + Math.cos(angle) * 0.3, y: 0.5 + Math.sin(angle) * 0.32 }
      const c = at(`g:${g.key}`, def.x, def.y)
      const x = Math.max(4, Math.min(areaW - w - 4, c.x - w / 2))
      const y = Math.max(4, Math.min(size.h - h - 4, c.y - h / 2))
      panels.push({ key: g.key, name: g.name, color: GROUP_COLORS[i % GROUP_COLORS.length], x, y, w, h, total: n, online: g.agents.filter((a) => a.online).length })
      g.agents.forEach((agent, k) => {
        const col = k % cols
        const row = Math.floor(k / cols)
        pcs.push({
          id: agent.id,
          name: displayName(agent, pcGroups),
          group: g.name,
          online: agent.online,
          status: pcStatuses[agent.id]?.status ?? null,
          inUseBy: remoteUsage[agent.id]?.userId ?? null,
          viewers: presence[agent.id] ?? [],
          x: x + PAD + col * CELL_W + CARD_W / 2,
          y: y + HEAD_H + row * CELL_H + CARD_H / 2,
        })
      })
    })
    const userNodes: UserNode[] = users.map((u, i) => {
      const def = { x: Math.max(60, areaW * 0.07) / areaW, y: 0.5 + (i - (users.length - 1) / 2) * Math.min(0.11, 0.8 / Math.max(1, users.length)) }
      const p = at(`u:${u.id}`, def.x, def.y)
      return { id: u.id, name: userName(u.id), self: u.id === selfUserId, active: u.active, x: p.x, y: p.y }
    })
    return { server, panels, pcs, users: userNodes }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, areaW, pos, grouped, pcGroups, pcStatuses, remoteUsage, presence, users, selfUserId, org.users])

  const modelRef = useRef({ layout, activeTransfers })
  modelRef.current = { layout, activeTransfers }

  // 이벤트: 전송 완료·실패, 원격조작 시작·종료, PC 접속·끊김 → 섬광 + 기록
  const prevRef = useRef<{ transfers: Map<string, Transfer['state']>; remote: Record<string, string>; online: Map<string, boolean> } | null>(null)
  useEffect(() => {
    const now = performance.now()
    const pcName = (id: string) => layout.pcs.find((p) => p.id === id)?.name ?? id.slice(0, 8)
    const entries: LogEntry[] = []
    const add = (text: string, tone: LogEntry['tone']) => entries.push({ id: ++logId.current, at: Date.now(), text, tone })
    const burst = (id: string, color: string, big = false) => burstsRef.current.push({ id, color, born: now, big })
    const prev = prevRef.current
    const cur = {
      transfers: new Map(transfers.map((t) => [t.id, t.state])),
      remote: Object.fromEntries(Object.entries(remoteUsage).map(([k, v]) => [k, v.userId])),
      online: new Map(agents.map((a) => [a.id, a.online])),
    }
    if (prev) {
      for (const t of transfers) {
        if (t.kind === 'Collect') continue
        const before = prev.transfers.get(t.id)
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
    const speed = reduced ? 0.4 : 1

    // 격자는 한 번 그려 두고 매 프레임 복사
    const grid = document.createElement('canvas')
    grid.width = canvas.width
    grid.height = canvas.height
    const g = grid.getContext('2d')!
    g.scale(dpr, dpr)
    const bg = g.createRadialGradient(size.w * 0.45, size.h * 0.5, 0, size.w * 0.45, size.h * 0.5, Math.max(size.w, size.h) * 0.75)
    bg.addColorStop(0, '#0f1730')
    bg.addColorStop(1, '#070b16')
    g.fillStyle = bg
    g.fillRect(0, 0, size.w, size.h)
    for (const [step, color] of [[24, 'rgba(120, 160, 255, 0.06)'], [120, 'rgba(120, 160, 255, 0.14)']] as const) {
      g.strokeStyle = color
      g.lineWidth = 1
      g.beginPath()
      for (let x = 0.5; x < size.w; x += step) {
        g.moveTo(x, 0)
        g.lineTo(x, size.h)
      }
      for (let y = 0.5; y < size.h; y += step) {
        g.moveTo(0, y)
        g.lineTo(size.w, y)
      }
      g.stroke()
    }

    let raf = 0
    const start = performance.now()

    const curve = (ax: number, ay: number, bx: number, by: number, bend = 0.1) => {
      const dx = bx - ax
      const dy = by - ay
      return { ax, ay, bx, by, qx: (ax + bx) / 2 - dy * bend, qy: (ay + by) / 2 + dx * bend }
    }
    type Curve = ReturnType<typeof curve>
    const at = (c: Curve, t: number) => {
      const u = 1 - t
      return { x: u * u * c.ax + 2 * u * t * c.qx + t * t * c.bx, y: u * u * c.ay + 2 * u * t * c.qy + t * t * c.by }
    }
    const stroke = (c: Curve, color: string, width: number, alpha: number, dash?: number[], dashOffset = 0) => {
      ctx.save()
      ctx.globalAlpha = alpha
      ctx.strokeStyle = color
      ctx.lineWidth = width
      ctx.lineCap = 'round'
      if (dash) {
        ctx.setLineDash(dash)
        ctx.lineDashOffset = dashOffset
      }
      ctx.beginPath()
      ctx.moveTo(c.ax, c.ay)
      ctx.quadraticCurveTo(c.qx, c.qy, c.bx, c.by)
      ctx.stroke()
      ctx.restore()
    }
    const glowDot = (x: number, y: number, rad: number, color: string, alpha: number) => {
      const gr = ctx.createRadialGradient(x, y, 0, x, y, rad * 3)
      gr.addColorStop(0, color)
      gr.addColorStop(0.4, color + '99')
      gr.addColorStop(1, color + '00')
      ctx.globalAlpha = alpha
      ctx.fillStyle = gr
      ctx.beginPath()
      ctx.arc(x, y, rad * 3, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = 1
    }
    /** 선을 따라 흐르는 빛 (꼬리 포함). reverse면 b → a */
    const pulses = (c: Curve, now: number, color: string, count: number, period: number, sizePx: number, reverse = false, tail = 6) => {
      for (let k = 0; k < count; k++) {
        const phase = ((now / period + k / count) % 1 + 1) % 1
        for (let j = 0; j < tail; j++) {
          const t = phase - j * 0.014
          if (t < 0) continue
          const p = at(c, reverse ? 1 - t : t)
          glowDot(p.x, p.y, sizePx * (1 - j / (tail * 1.3)), color, (1 - j / tail) * 0.85)
        }
      }
    }
    /** 직사각형 가장자리에서 (tx, ty) 쪽으로 나가는 점 */
    const edge = (x: number, y: number, w: number, h: number, tx: number, ty: number) => {
      const cx = x + w / 2
      const cy = y + h / 2
      const dx = tx - cx
      const dy = ty - cy
      const s = Math.min(Math.abs(w / 2 / (dx || 1e-6)), Math.abs(h / 2 / (dy || 1e-6)))
      return { x: cx + dx * s, y: cy + dy * s }
    }

    const frame = (nowAbs: number) => {
      const now = (nowAbs - start) * speed
      const { layout: L, activeTransfers: T } = modelRef.current
      const { server } = L
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalCompositeOperation = 'source-over'
      ctx.drawImage(grid, 0, 0)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

      // 그룹 패널
      for (const p of L.panels) {
        ctx.save()
        ctx.fillStyle = 'rgba(14, 22, 44, 0.78)'
        ctx.strokeStyle = p.color
        ctx.globalAlpha = 1
        ctx.lineWidth = 1.2
        ctx.beginPath()
        ctx.roundRect(p.x, p.y, p.w, p.h, 8)
        ctx.fill()
        ctx.globalAlpha = 0.6
        ctx.stroke()
        ctx.globalAlpha = 0.16
        ctx.fillStyle = p.color
        ctx.beginPath()
        ctx.roundRect(p.x, p.y, p.w, HEAD_H - 6, [8, 8, 0, 0])
        ctx.fill()
        ctx.restore()
        ctx.font = '700 12px "Segoe UI", "Malgun Gothic", sans-serif'
        ctx.textAlign = 'left'
        ctx.textBaseline = 'middle'
        ctx.fillStyle = p.color
        ctx.fillText(p.name, p.x + 10, p.y + (HEAD_H - 6) / 2)
        ctx.textAlign = 'right'
        ctx.font = '600 10.5px "Segoe UI", sans-serif'
        ctx.fillStyle = '#9fb0d6'
        ctx.fillText(`${p.online} / ${p.total}`, p.x + p.w - 10, p.y + (HEAD_H - 6) / 2)
        ctx.textBaseline = 'alphabetic'
      }

      ctx.globalCompositeOperation = 'lighter'
      // 서버 ↔ 그룹 간선 (그룹 색, 천천히 흐르는 빛)
      for (const p of L.panels) {
        const a = edge(server.x - SERVER_W / 2, server.y - SERVER_H / 2, SERVER_W, SERVER_H, p.x + p.w / 2, p.y + p.h / 2)
        const b = edge(p.x, p.y, p.w, p.h, server.x, server.y)
        const c = curve(a.x, a.y, b.x, b.y, 0.06)
        stroke(c, p.color, 6, 0.08)
        stroke(c, p.color, 2, 0.55)
        if (p.online > 0) pulses(c, now + p.x * 3, p.color, 1, 3200, 2, false, 6)
      }
      // 사용자 ↔ 서버
      for (const u of L.users) {
        const c = curve(u.x, u.y, server.x - SERVER_W / 2, server.y, -0.06)
        const col = u.self ? COLORS.self : COLORS.user
        stroke(c, col, 1.5, u.active ? 0.5 : 0.25)
        if (u.active) pulses(c, now + u.y * 5, col, 1, 3600, 1.5, false, 5)
      }

      // PC 탐색(브라우저로 보는 중): 사용자 → PC, 흐르는 굵은 점선 + 느린 빛
      for (const p of L.pcs) {
        for (const vid of p.viewers) {
          if (vid === p.inUseBy) continue
          const u = L.users.find((x) => x.id === vid)
          if (!u) continue
          const col = u.self ? COLORS.self : COLORS.user
          const c = curve(u.x, u.y, p.x - CARD_W / 2, p.y, 0.14)
          stroke(c, col, 5, 0.1)
          stroke(c, col, 1.8, 0.75, [8, 6], -now * 0.025)
          pulses(c, now + p.y * 4, col, 1, 2800, 1.8, false, 6)
        }
      }

      // 원격조작: 사용자 → 서버 → PC (굵고 차분한 빔, 빛은 느리게)
      for (const p of L.pcs) {
        if (!p.inUseBy) continue
        const u = L.users.find((x) => x.id === p.inUseBy)
        const legs = [curve(server.x, server.y, p.x, p.y, 0.08)]
        if (u) legs.unshift(curve(u.x, u.y, server.x, server.y, -0.06))
        for (const c of legs) {
          stroke(c, COLORS.remote, 8, 0.1)
          stroke(c, COLORS.remote, 2.4, 0.85)
          pulses(c, now, COLORS.remote, 2, 3000, 2.2, false, 7)
        }
      }

      // 전송: 가져오기 PC → 서버, 올리기 서버 → PC (빛 입자), 압축·풀기는 카드 둘레 효과
      for (const t of T) {
        const p = L.pcs.find((x) => x.id === t.agentId)
        if (!p) continue
        const col = transferColor(t)
        if (t.kind === 'Fetch' || t.kind === 'Push') {
          const c = curve(server.x, server.y, p.x, p.y, 0.08)
          stroke(c, col, 6, 0.1)
          stroke(c, col, 1.6, 0.8)
          pulses(c, now, col, 3, 2000, 2.1, t.kind === 'Fetch', 7)
        } else {
          const inward = t.kind === 'Compress'
          for (let k = 0; k < 12; k++) {
            const ph = ((now / 1800 + k / 12) % 1 + 1) % 1
            const rr = inward ? 30 * (1 - ph) + 22 : 22 + 30 * ph
            const ang = k * 2.4 + now * 0.0012 + ph * (inward ? 3 : 1)
            glowDot(p.x + Math.cos(ang) * rr * 1.5, p.y + Math.sin(ang) * rr * 0.75, 1.5, col, inward ? 0.25 + ph * 0.6 : 0.9 - ph * 0.8)
          }
        }
      }

      // 섬광
      const bursts = burstsRef.current
      for (let i = bursts.length - 1; i >= 0; i--) {
        const b = bursts[i]
        const age = (nowAbs - b.born) / (b.big ? 1400 : 1000)
        const p = L.pcs.find((x) => x.id === b.id)
        if (age >= 1 || !p) {
          bursts.splice(i, 1)
          continue
        }
        const rad = (b.big ? 70 : 46) * age + 20
        ctx.save()
        ctx.globalAlpha = 1 - age
        ctx.strokeStyle = b.color
        ctx.lineWidth = 3 * (1 - age) + 0.5
        ctx.beginPath()
        ctx.ellipse(p.x, p.y, rad * 1.3, rad * 0.8, 0, 0, Math.PI * 2)
        ctx.stroke()
        ctx.restore()
      }

      // PC 카드
      ctx.globalCompositeOperation = 'source-over'
      for (const p of L.pcs) {
        const col = pcColor(p)
        const x = p.x - CARD_W / 2
        const y = p.y - CARD_H / 2
        if (p.inUseBy) {
          ctx.globalCompositeOperation = 'lighter'
          glowDot(p.x, p.y, 16 + 2 * Math.sin(now * 0.003), COLORS.remote, 0.35)
          ctx.globalCompositeOperation = 'source-over'
        }
        ctx.fillStyle = p.online ? '#111a33' : '#0d1222'
        ctx.strokeStyle = col
        ctx.globalAlpha = p.online ? 1 : 0.6
        ctx.lineWidth = p.inUseBy ? 1.8 : 1
        ctx.beginPath()
        ctx.roundRect(x, y, CARD_W, CARD_H, 6)
        ctx.fill()
        ctx.stroke()
        // 상태 표시등 (원격·테스트 중은 깜빡임)
        const blink = p.online && (p.inUseBy || p.status === 'testing') ? (Math.sin(now * 0.006) > 0 ? 1 : 0.3) : 1
        ctx.globalAlpha = blink * (p.online ? 1 : 0.6)
        if (p.online) {
          ctx.globalCompositeOperation = 'lighter'
          glowDot(x + 11, y + 12, 2.2, col, 0.8)
          ctx.globalCompositeOperation = 'source-over'
        }
        ctx.fillStyle = col
        ctx.beginPath()
        ctx.arc(x + 11, y + 12, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = p.online ? 1 : 0.6
        ctx.font = '600 11px "Segoe UI", "Malgun Gothic", sans-serif'
        ctx.textAlign = 'left'
        ctx.fillStyle = p.online ? '#e4ecff' : '#7a8499'
        const name = p.name.length > 11 ? p.name.slice(0, 10) + '…' : p.name
        ctx.fillText(name, x + 20, y + 16)
        // 둘째 줄: 상태
        const tr = T.find((t) => t.agentId === p.id)
        const sub = !p.online ? '오프라인'
          : tr ? `${kindLabel(tr.kind)}${typeof tr.percent === 'number' ? ` ${tr.percent}%` : ''}`
            : p.inUseBy ? `원격 · ${userName(p.inUseBy)}`
              : p.status && p.status !== 'available' ? PC_STATUS_LABEL[p.status] : '대기'
        ctx.font = '500 10px "Segoe UI", "Malgun Gothic", sans-serif'
        ctx.fillStyle = tr ? transferColor(tr) : p.inUseBy ? COLORS.remote : '#8d9ab8'
        ctx.fillText(sub.length > 13 ? sub.slice(0, 12) + '…' : sub, x + 9, y + 32)
        // 진행 막대
        if (tr) {
          ctx.fillStyle = 'rgba(255,255,255,0.08)'
          ctx.fillRect(x + 6, y + CARD_H - 4, CARD_W - 12, 2)
          ctx.fillStyle = transferColor(tr)
          const w = typeof tr.percent === 'number' ? ((CARD_W - 12) * tr.percent) / 100 : (CARD_W - 12) * 0.3
          const off = typeof tr.percent === 'number' ? 0 : (((now / 1400) % 1) * (CARD_W - 12 - w))
          ctx.fillRect(x + 6 + off, y + CARD_H - 4, w, 2)
        }
        ctx.globalAlpha = 1
      }

      // 서버 (단순한 카드)
      const sx = server.x - SERVER_W / 2
      const sy = server.y - SERVER_H / 2
      ctx.globalCompositeOperation = 'lighter'
      glowDot(server.x, server.y, 18 + 2 * Math.sin(now * 0.002), COLORS.server, 0.3)
      ctx.globalCompositeOperation = 'source-over'
      ctx.fillStyle = '#12224a'
      ctx.strokeStyle = COLORS.server
      ctx.lineWidth = 1.8
      ctx.beginPath()
      ctx.roundRect(sx, sy, SERVER_W, SERVER_H, 8)
      ctx.fill()
      ctx.stroke()
      for (let k = 0; k < 3; k++) {
        ctx.fillStyle = 'rgba(143, 211, 255, 0.25)'
        ctx.fillRect(sx + 10, sy + 9 + k * 9, 30, 5)
        ctx.fillStyle = k === Math.floor(now / 500) % 3 ? '#8fffd8' : '#3b6f8f'
        ctx.fillRect(sx + 44, sy + 9 + k * 9, 4, 5)
      }
      ctx.font = '800 12px "Segoe UI", sans-serif'
      ctx.textAlign = 'left'
      ctx.fillStyle = '#d8f1ff'
      ctx.fillText('SERVER', sx + 52, sy + 22)
      ctx.font = '500 9.5px "Segoe UI", sans-serif'
      ctx.fillStyle = '#8fb3d6'
      const host = serverHostName ?? ''
      ctx.fillText(host.length > 9 ? host.slice(0, 8) + '…' : host, sx + 52, sy + 36)

      // 사용자
      for (const u of L.users) {
        const col = u.self ? COLORS.self : COLORS.user
        ctx.globalAlpha = u.active ? 1 : 0.75
        ctx.fillStyle = '#151230'
        ctx.strokeStyle = col
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(u.x, u.y, 15, 0, Math.PI * 2)
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
        ctx.fillText(u.self ? `${u.name} (나)` : u.name, u.x, u.y + 29)
        // 접속 표시등
        ctx.fillStyle = u.active ? '#35e0b5' : '#6b7a99'
        ctx.beginPath()
        ctx.arc(u.x + 11, u.y - 11, 3.5, 0, Math.PI * 2)
        ctx.fill()
        ctx.globalAlpha = 1
      }

      raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
    // userName은 org에서 찾는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size, serverHostName, org.users])

  // ── 끌어서 옮기기: 서버 · 그룹 패널(PC 포함) · 사용자
  const hitTest = (x: number, y: number): string | null => {
    const { server, panels, users: us } = layout
    for (const u of us) if (Math.hypot(u.x - x, u.y - y) < 18) return `u:${u.id}`
    if (Math.abs(server.x - x) < SERVER_W / 2 && Math.abs(server.y - y) < SERVER_H / 2) return 'server'
    for (let i = panels.length - 1; i >= 0; i--) {
      const p = panels[i]
      if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return `g:${p.key}`
    }
    return null
  }
  const centerOf = (key: string) => {
    if (key === 'server') return layout.server
    if (key.startsWith('u:')) return layout.users.find((u) => `u:${u.id}` === key) ?? { x: 0, y: 0 }
    const p = layout.panels.find((g) => `g:${g.key}` === key)
    return p ? { x: p.x + p.w / 2, y: p.y + p.h / 2 } : { x: 0, y: 0 }
  }
  const local = (e: React.MouseEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }
  const onDown = (e: React.MouseEvent) => {
    const { x, y } = local(e)
    const key = hitTest(x, y)
    if (!key) return
    const c = centerOf(key)
    setDrag({ key, dx: x - c.x, dy: y - c.y })
    setHover(null)
  }
  const onUp = () => {
    if (!drag) return
    setDrag(null)
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(pos))
    } catch {
      // 무시
    }
  }

  const onMove = (e: React.MouseEvent) => {
    const { x, y } = local(e)
    if (drag) {
      const nx = Math.max(0.02, Math.min(0.98, (x - drag.dx) / areaW))
      const ny = Math.max(0.03, Math.min(0.97, (y - drag.dy) / size.h))
      setPos((p) => ({ ...p, [drag.key]: { x: nx, y: ny } }))
      return
    }
    const pc = layout.pcs.find((p) => Math.abs(p.x - x) < CARD_W / 2 && Math.abs(p.y - y) < CARD_H / 2)
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
    const u = layout.users.find((p) => Math.hypot(p.x - x, p.y - y) < 18)
    if (u) {
      const remote = layout.pcs.filter((p) => p.inUseBy === u.id).map((p) => p.name)
      const viewing = layout.pcs.filter((p) => p.viewers.includes(u.id)).map((p) => p.name)
      setHover({
        x, y,
        lines: [u.self ? `${u.name} (나)` : u.name, ...(remote.length ? [`원격조작: ${remote.join(', ')}`] : []),
          ...(viewing.length ? [`보는 중: ${viewing.join(', ')}`] : []), ...(!remote.length && !viewing.length ? ['대시보드 접속 중'] : [])],
      })
      return
    }
    if (Math.abs(layout.server.x - x) < SERVER_W / 2 && Math.abs(layout.server.y - y) < SERVER_H / 2) {
      setHover({ x, y, lines: ['관리 서버', serverHostName ?? '', connected ? '대시보드와 연결됨' : '연결 중…'] })
      return
    }
    setHover(null)
  }

  const resetLayout = () => {
    setPos({})
    try {
      localStorage.removeItem(POS_KEY)
    } catch {
      // 무시
    }
  }

  const online = agents.filter((a) => a.online).length
  const remoteCount = Object.keys(remoteUsage).length
  const cursor = drag ? 'grabbing' : hover ? 'grab' : 'default'

  return (
    <div className="state-page" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="state-canvas"
        style={{ cursor }}
        onMouseDown={onDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={() => {
          onUp()
          setHover(null)
        }}
      />
      {hover && !drag && (
        <div className="state-tip" style={{ left: Math.min(hover.x + 14, areaW - 240), top: hover.y + 14 }}>
          {hover.lines.filter(Boolean).map((l, i) => <div key={i} className={i === 0 ? 'state-tip-head' : ''}>{l}</div>)}
        </div>
      )}
      <aside className="state-hud" style={{ width: HUD_WIDTH }}>
        <div className="state-hud-title">SYSTEM STATE <span className={`state-live${connected ? ' on' : ''}`}>{connected ? 'LIVE' : 'OFFLINE'}</span></div>
        <div className="state-stats">
          <div><b style={{ color: COLORS.online }}>{online}</b><span>/ {agents.length}</span><label>PC 온라인</label></div>
          <div><b style={{ color: COLORS.user }}>{layout.users.length}</b><label>접속 사용자</label></div>
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
        <div className="state-foot">
          <span>서버 · 그룹 · 사용자를 끌어서 옮길 수 있습니다</span>
          <button type="button" className="link" onClick={resetLayout}>배치 초기화</button>
        </div>
      </aside>
    </div>
  )
}
