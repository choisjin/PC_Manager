import type { ChatRoom } from './api'

/** 여러 명이 있는 방 (그룹·전체): 구성원 수·@호출·안 읽은 사람 수를 보인다 */
export const isMultiRoom = (room: ChatRoom) => room.kind !== 'direct'

export const roomIcon = (room: ChatRoom) => (room.kind === 'all' ? '📢' : room.kind === 'group' ? '👥' : '👤')

/** 방 표시 이름: 그룹·전체는 방 이름, 1:1은 상대 이름 */
export function roomTitle(room: ChatRoom, selfUserId: string | null, nameOf: (id: string) => string) {
  if (room.kind === 'all') return room.name ?? '전체'
  if (room.kind === 'group') return room.name ?? '그룹'
  const other = room.members.find((m) => m.userId !== selfUserId)
  return other ? nameOf(other.userId) : '나'
}
