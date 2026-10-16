import type { FileFavorite } from '../../api'
import { newId } from './pcGroups'

/** 파일 즐겨찾기 하나를 목록에 넣을 값. 같은 PC의 같은 경로가 이미 있으면 null */
export function newFileFavorite(items: FileFavorite[], sourceId: string, sourceName: string, isShare: boolean, path: string): FileFavorite | null {
  if (items.some((f) => f.sourceId === sourceId && f.path.toLowerCase() === path.toLowerCase())) return null
  return { id: newId(), sourceId, sourceName, isShare, path, addedAt: new Date().toISOString() }
}
