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

// 브라우저에서 바로 보고 편집할 텍스트 형식
const TEXT = new Set([
  'txt', 'log', 'csv', 'tsv', 'json', 'jsonl', 'xml', 'ini', 'cfg', 'conf', 'config', 'yaml', 'yml', 'toml', 'md',
  'bat', 'cmd', 'ps1', 'psm1', 'sh', 'py', 'js', 'ts', 'tsx', 'jsx', 'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'go', 'rs',
  'sql', 'html', 'htm', 'css', 'properties', 'reg', 'srt', 'vbs', 'inf', 'env', 'gitignore', 'csproj', 'props', 'targets', 'sln',
])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico'])

export function isTextFile(name: string): boolean {
  return TEXT.has(extensionOf(name))
}

export function isImageFile(name: string): boolean {
  return IMAGE.has(extensionOf(name))
}

export function isPdfFile(name: string): boolean {
  return extensionOf(name) === 'pdf'
}

/** 폴더처럼 열어볼 수 있는 압축 파일 (분할 압축은 첫 조각 .001) */
export function isArchiveFile(name: string): boolean {
  const lower = name.toLowerCase()
  return ['.zip', '.7z', '.rar', '.tar', '.tgz', '.tar.gz', '.zip.001', '.7z.001'].some((ext) => lower.endsWith(ext))
}

/** 압축 파일 이름에서 확장자를 뗀 이름 (압축 풀 폴더 이름) */
export function archiveBaseName(name: string): string {
  return name.replace(/(\.tar\.gz|\.zip\.001|\.7z\.001|\.zip|\.7z|\.rar|\.tar|\.tgz)$/i, '')
}

/** 저장할 때 원본을 .bak으로 남길지 (내 PC 프로그램 저장·브라우저 편집 공통, 브라우저에 저장). 기본 끔 */
export const BACKUP_SETTING_KEY = 'pcm.viewer.backup'
export const BACKUP_SETTING_EVENT = 'pcm-backup-setting'

export function loadBackupSetting(): boolean {
  try {
    return localStorage.getItem(BACKUP_SETTING_KEY) === '1'
  } catch {
    return false
  }
}

export function saveBackupSetting(value: boolean) {
  try {
    localStorage.setItem(BACKUP_SETTING_KEY, value ? '1' : '0')
  } catch {
    // 무시
  }
  window.dispatchEvent(new Event(BACKUP_SETTING_EVENT))
}

/** 탐색기 아이콘용 파일 종류 */
export type FileKind =
  | 'image' | 'video' | 'audio' | 'text' | 'code' | 'excel' | 'word' | 'powerpoint' | 'pdf' | 'archive' | 'program' | 'other'

const KIND_BY_EXT: Record<string, FileKind> = {}
const kinds: [FileKind, string[]][] = [
  ['image', ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'svg', 'ico', 'tif', 'tiff', 'heic', 'raw']],
  ['video', ['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'avi', 'wmv', 'flv', 'ts', 'mpg', 'mpeg', 'm2ts', '3gp']],
  ['audio', ['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'wma', 'opus']],
  ['excel', ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods']],
  ['word', ['doc', 'docx', 'docm', 'rtf', 'odt', 'hwp', 'hwpx']],
  ['powerpoint', ['ppt', 'pptx', 'pptm', 'odp']],
  ['pdf', ['pdf']],
  ['archive', ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab', 'iso', '001']],
  ['program', ['exe', 'msi', 'dll', 'sys', 'appx', 'msix', 'apk']],
  ['code', ['bat', 'cmd', 'ps1', 'psm1', 'sh', 'py', 'js', 'ts', 'tsx', 'jsx', 'c', 'h', 'cpp', 'hpp', 'cs', 'java', 'go', 'rs', 'sql', 'html', 'htm', 'css', 'vbs', 'json', 'jsonl', 'xml', 'yaml', 'yml', 'toml', 'csproj', 'sln', 'props', 'targets']],
  ['text', ['txt', 'log', 'ini', 'cfg', 'conf', 'config', 'md', 'properties', 'reg', 'srt', 'inf', 'env']],
]
for (const [kind, exts] of kinds) for (const ext of exts) KIND_BY_EXT[ext] = kind

export function fileKind(name: string): FileKind {
  // 분할 압축 a.zip.001 · a.tar.gz 같은 이중 확장자는 압축으로
  if (isArchiveFile(name)) return 'archive'
  return KIND_BY_EXT[extensionOf(name)] ?? 'other'
}
