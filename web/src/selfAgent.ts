import type { Agent } from './api'

/**
 * 대시보드를 연 PC의 에이전트: 런처가 알려 준 PC 이름(?pc=) → 접속 IP → 서버 PC에서 localhost로 연 경우 서버 PC.
 * 못 찾으면 null
 */
export function findSelfAgentId(agents: Agent[], selfPc: string | null, clientIp: string | null, serverHostName: string | null): string | null {
  const byName = (name: string | null) => (name ? agents.find((a) => a.machineName.toLowerCase() === name.toLowerCase()) : undefined)
  const found = byName(selfPc) ?? (clientIp ? agents.find((a) => a.ipAddresses.includes(clientIp)) : byName(serverHostName))
  return found?.id ?? null
}
