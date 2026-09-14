export function formatTime(iso: string) {
  const date = new Date(iso)
  const isToday = date.toDateString() === new Date().toDateString()
  return date.toLocaleString(
    'ko-KR',
    isToday
      ? { hour: '2-digit', minute: '2-digit', second: '2-digit' }
      : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' },
  )
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`
}

export function formatDuration(ms: number) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}초`
  const minutes = Math.floor(totalSeconds / 60)
  if (minutes < 60) return `${minutes}분 ${totalSeconds % 60}초`
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`
}
