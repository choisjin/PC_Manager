import { createContext } from 'react'
import type { PcStatus } from '../../api'

/** 원격조작 모달의 PC 목록(빠른 전환)에 쓰는 PC 정보 */
export interface RemotePc {
  id: string
  name: string
  /** 그룹(폴더) 이름. 하위 폴더는 "상위 / 하위", 그룹 없는 PC는 "미분류" */
  group: string
  online: boolean
  status: PcStatus | null
  /** 지금 원격조작 중인 userId */
  inUseBy: string | null
}

export interface RemoteContextValue {
  pcs: RemotePc[]
  userName: (userId: string) => string
}

export const RemoteContext = createContext<RemoteContextValue>({ pcs: [], userName: () => '다른 사용자' })
