import type { ChatRoom } from './api'

/** 방 표시 이름: 그룹은 방 이름, 1:1은 상대 이름 */
export function roomTitle(room: ChatRoom, selfUserId: string | null, nameOf: (id: string) => string) {
  if (room.kind === 'group') return room.name ?? '그룹'
  const other = room.members.find((m) => m.userId !== selfUserId)
  return other ? nameOf(other.userId) : '나'
}
