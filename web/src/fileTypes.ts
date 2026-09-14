// 브라우저 <video>로 대체로 재생되는 형식
const WEB_VIDEO = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov'])
// 영상이지만 브라우저 기본 재생이 안 되는 경우가 많은 형식 (코덱에 따라 다름)
const OTHER_VIDEO = new Set(['mkv', 'avi', 'wmv', 'flv', 'ts', 'mpg', 'mpeg', 'm2ts'])

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export function isVideoFile(name: string): boolean {
  const ext = extensionOf(name)
  return WEB_VIDEO.has(ext) || OTHER_VIDEO.has(ext)
}

/** 브라우저에서 바로 재생될 가능성이 높은 형식인지 (아니면 다운로드를 안내) */
export function isWebPlayable(name: string): boolean {
  return WEB_VIDEO.has(extensionOf(name))
}
