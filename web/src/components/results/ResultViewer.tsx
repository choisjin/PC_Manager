import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api, type FileEntry, type ResultSet, type ResultSetSummary } from '../../api'
import { isImageFile, isVideoFile } from '../../fileTypes'
import { formatBytes } from '../../format'
import { type ClipItem, FILES_MIME, type FilesDragPayload } from '../explorer/pcGroups'
import {
  type ColumnRole, decodeText, formatSeconds, formatWall, type ParsedResult, parseResult, type ResultMapping,
  type ResultRow, statusTone, timeFromName,
} from './resultCsv'
import {
  type Anchor, baseSeconds, emptySync, resolveStart, rowAtTime, solveAnchors, START_SOURCE_LABEL, type SyncState,
  toRowTime, toVideoTime, type VideoInfo, videoForRow, wallFromIso,
} from './sync'
import { VideoTransport } from './VideoTransport'

/** 셋에 저장하는 화면 설정 */
interface ViewConfig {
  mapping: Partial<ResultMapping>
  sync: SyncState
}

interface Source {
  agentId: string
  machineName: string | null
  resultPath: string
  videoPaths: string[]
  imageDir: string | null
}

interface RawVideo {
  path: string
  name: string
  duration: number | null
  modified: number | null
  size: number | null
  metaStarted: string | null
}

interface Props {
  agentId: string
  machineName: string
  /** 미니 탐색기 시작 폴더 (지금 탐색기 경로) */
  startPath: string
  /** 탐색기에서 고른 항목 (확장자로 Result·영상·이미지 폴더에 자동 배치) */
  initialItems: ClipItem[]
  onClose: () => void
}

const RESULT_EXT = /\.(csv|tsv|txt|log|json)$/i
const ROW_HEIGHT = 26
const ROLE_LABEL: Record<ColumnRole, string> = {
  time: '시간', cycle: '회차', status: '결과', name: '스텝 이름', duration: '걸린 시간', message: '메시지',
}
const baseName = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
const dirName = (p: string) => p.replace(/[\\/][^\\/]*$/, '')
const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** 결과 확인: Result(CSV)·영상·이미지를 시각으로 맞춰 보는 전체 화면 (ReplayKit 시나리오 상세결과 방식) */
export function ResultViewer({ agentId, machineName, startPath, initialItems, onClose }: Props) {
  const [stage, setStage] = useState<'setup' | 'view'>('setup')
  const [source, setSource] = useState<Source>(() => autoAssign(agentId, machineName, initialItems))
  const [set, setSet] = useState<ResultSet | null>(null)
  const [dialog, setDialog] = useState<null | 'sync' | 'save' | 'sets' | 'trim'>(null)
  const [preview, setPreview] = useState<string | null>(null)
  // 보기 화면을 새로 시작할 때만 바꾼다 (경로로 열기·다른 셋 열기). 저장해서 셋이 생겨도 화면은 그대로
  const [viewKey, setViewKey] = useState(0)

  // 전체 화면이라 전송·알림 PiP가 표를 가리지 않게 (백업 진행은 저장 창에서 보여 준다)
  useEffect(() => {
    document.body.classList.add('rv-open')
    return () => document.body.classList.remove('rv-open')
  }, [])

  // Esc: 열린 창 먼저, 없으면 결과 확인 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (preview) setPreview(null)
      else if (dialog) setDialog(null)
      else onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [dialog, preview, onClose])

  const openSet = async (summary: ResultSetSummary) => {
    const full = await api.resultSet(summary.id)
    setSet(full)
    setSource({
      agentId: full.agentId, machineName: full.machineName, resultPath: full.resultPath,
      videoPaths: full.videoPaths, imageDir: full.imageDir,
    })
    setDialog(null)
    setViewKey((k) => k + 1)
    setStage('view')
  }

  return createPortal(
    <div className="rv-page" role="dialog" aria-label="결과 확인">
      {stage === 'setup' ? (
        <Setup
          source={source}
          setSource={setSource}
          startPath={startPath}
          onOpen={() => {
            setSet(null)
            setViewKey((k) => k + 1)
            setStage('view')
          }}
          onSets={() => setDialog('sets')}
          onClose={onClose}
        />
      ) : (
        <Viewer
          key={viewKey}
          source={source}
          set={set}
          setSet={setSet}
          dialog={dialog}
          setDialog={setDialog}
          setPreview={setPreview}
          onBack={() => setStage('setup')}
          onClose={onClose}
          addVideo={(path) => setSource((s) => ({ ...s, videoPaths: [...s.videoPaths, path] }))}
        />
      )}
      {dialog === 'sets' && <SetsDialog onOpen={(s) => void openSet(s)} onClose={() => setDialog(null)} />}
      {preview && (
        <div className="rv-preview" onClick={() => setPreview(null)}>
          <img src={preview} alt="" />
        </div>
      )}
    </div>,
    document.body,
  )
}

/** 탐색기에서 고른 항목을 확장자로 나눠 넣는다 */
function autoAssign(agentId: string, machineName: string, items: ClipItem[]): Source {
  const result = items.find((i) => !i.isDir && RESULT_EXT.test(i.name))
  return {
    agentId,
    machineName,
    resultPath: result?.path ?? '',
    videoPaths: items.filter((i) => !i.isDir && isVideoFile(i.name)).map((i) => i.path),
    imageDir: items.find((i) => i.isDir)?.path ?? null,
  }
}

// ─────────────────────────────── 설정: 미니 탐색기 + 세 칸

function Setup({ source, setSource, startPath, onOpen, onSets, onClose }: {
  source: Source
  setSource: React.Dispatch<React.SetStateAction<Source>>
  startPath: string
  onOpen: () => void
  onSets: () => void
  onClose: () => void
}) {
  const [path, setPath] = useState(startPath)
  const [pathInput, setPathInput] = useState(startPath)
  const [listing, setListing] = useState<FileEntry[]>([])
  const [parent, setParent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setError(null)
    api.listFiles(source.agentId, path).then(
      (l) => {
        if (!alive) return
        setListing(l.entries)
        setParent(l.parentPath)
        setPathInput(l.path)
        if (l.error) setError(l.error)
      },
      (err) => alive && setError(toMessage(err)),
    )
    return () => {
      alive = false
    }
  }, [source.agentId, path])

  const put = (slot: 'result' | 'video' | 'image', item: ClipItem) =>
    setSource((s) =>
      slot === 'result' ? { ...s, resultPath: item.path }
        : slot === 'video' ? { ...s, videoPaths: s.videoPaths.includes(item.path) ? s.videoPaths : [...s.videoPaths, item.path] }
          : { ...s, imageDir: item.isDir ? item.path : dirName(item.path) },
    )

  const dropInto = (slot: 'result' | 'video' | 'image') => (e: React.DragEvent) => {
    e.preventDefault()
    const json = e.dataTransfer.getData(FILES_MIME)
    const items: ClipItem[] = json
      ? (JSON.parse(json) as FilesDragPayload).items
      : e.dataTransfer.getData('text/plain')
        ? [{ path: e.dataTransfer.getData('text/plain'), name: baseName(e.dataTransfer.getData('text/plain')), isDir: slot === 'image' }]
        : []
    for (const item of slot === 'video' ? items : items.slice(0, 1)) put(slot, item)
  }
  const allowDrop = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes(FILES_MIME) || e.dataTransfer.types.includes('text/plain')) e.preventDefault()
  }

  return (
    <>
      <header className="rv-head">
        <strong>결과 확인</strong>
        <span className="muted">{source.machineName} · Result·영상·이미지 폴더를 고르세요</span>
        <span className="rv-spacer" />
        <button type="button" onClick={onSets}>저장된 셋 열기</button>
        <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
      </header>
      <div className="rv-setup">
        <section className="rv-browser panel">
          <div className="rv-browser-bar">
            <button type="button" disabled={parent === null} onClick={() => parent !== null && setPath(parent)} title="위로">↑</button>
            <input
              className="mono"
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && setPath(pathInput.trim())}
            />
            <button type="button" onClick={() => setSource((s) => ({ ...s, imageDir: path }))} title="지금 폴더를 이미지 폴더로">이 폴더 = 이미지</button>
          </div>
          {error && <p className="error small">{error}</p>}
          <ul className="rv-browser-list">
            {listing.map((entry) => {
              const item: ClipItem = { path: entry.fullPath, name: entry.name, isDir: entry.isDirectory }
              return (
                <li
                  key={entry.fullPath}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(FILES_MIME, JSON.stringify({ agentId: source.agentId, items: [item] } satisfies FilesDragPayload))
                    e.dataTransfer.setData('text/plain', entry.fullPath)
                  }}
                  onDoubleClick={() => entry.isDirectory && setPath(entry.fullPath)}
                  title={entry.isDirectory ? '더블클릭으로 열기 · 오른쪽 칸으로 끌어다 놓기' : '오른쪽 칸으로 끌어다 놓기'}
                >
                  <span className="rv-browser-name">{entry.isDirectory ? '📁' : isVideoFile(entry.name) ? '🎬' : isImageFile(entry.name) ? '🖼' : '📄'} {entry.name}</span>
                  <span className="rv-browser-acts">
                    {!entry.isDirectory && RESULT_EXT.test(entry.name) && <button type="button" onClick={() => put('result', item)}>Result</button>}
                    {!entry.isDirectory && isVideoFile(entry.name) && <button type="button" onClick={() => put('video', item)}>영상</button>}
                    {entry.isDirectory && <button type="button" onClick={() => put('image', item)}>이미지</button>}
                  </span>
                </li>
              )
            })}
          </ul>
        </section>
        <section className="rv-slots">
          <Slot title="Result 파일 (CSV)" hint="CSV 파일을 끌어다 놓으세요" onDrop={dropInto('result')} onDragOver={allowDrop}
            items={source.resultPath ? [source.resultPath] : []} onRemove={() => setSource((s) => ({ ...s, resultPath: '' }))} />
          <Slot title="영상 (여러 개 가능)" hint="영상 파일을 끌어다 놓으세요 (회차별 녹화 등)" onDrop={dropInto('video')} onDragOver={allowDrop}
            items={source.videoPaths} onRemove={(p) => setSource((s) => ({ ...s, videoPaths: s.videoPaths.filter((v) => v !== p) }))} />
          <Slot title="이미지 폴더" hint="폴더를 끌어다 놓거나 '이 폴더 = 이미지'" onDrop={dropInto('image')} onDragOver={allowDrop}
            items={source.imageDir ? [source.imageDir] : []} onRemove={() => setSource((s) => ({ ...s, imageDir: null }))} />
          <p className="hint">Result에 적힌 이미지 경로는 자동으로 찾습니다. 이미지 폴더를 주면 폴더 안 같은 이름의 파일로도 찾고, 파일 이름의 시각으로 영상 위치에 맞춥니다.</p>
          <div className="rv-setup-actions">
            <button type="button" className="primary" disabled={!source.resultPath} onClick={onOpen}>열기</button>
          </div>
        </section>
      </div>
    </>
  )
}

function Slot({ title, hint, items, onDrop, onDragOver, onRemove }: {
  title: string
  hint: string
  items: string[]
  onDrop: (e: React.DragEvent) => void
  onDragOver: (e: React.DragEvent) => void
  onRemove: (path: string) => void
}) {
  const [over, setOver] = useState(false)
  return (
    <div
      className={`rv-slot${over ? ' over' : ''}`}
      onDragOver={(e) => {
        onDragOver(e)
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false)
        onDrop(e)
      }}
    >
      <div className="rv-slot-title">{title}</div>
      {items.length === 0 ? <div className="muted small">{hint}</div> : (
        <ul>
          {items.map((p) => (
            <li key={p} className="mono small">
              <span className="ellipsis" title={p}>{p}</span>
              <button type="button" className="icon" aria-label="빼기" onClick={() => onRemove(p)}>✕</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// ─────────────────────────────── 보기

function Viewer({ source, set, setSet, dialog, setDialog, setPreview, onBack, onClose, addVideo }: {
  source: Source
  set: ResultSet | null
  setSet: (s: ResultSet | null) => void
  dialog: null | 'sync' | 'save' | 'sets' | 'trim'
  setDialog: (d: null | 'sync' | 'save' | 'sets' | 'trim') => void
  setPreview: (url: string | null) => void
  onBack: () => void
  onClose: () => void
  addVideo: (path: string) => void
}) {
  const savedConfig = (set?.config ?? null) as ViewConfig | null
  const [rawText, setRawText] = useState<string | null>(null)
  const [mapping, setMapping] = useState<Partial<ResultMapping>>(savedConfig?.mapping ?? {})
  const [sync, setSync] = useState<SyncState>(savedConfig?.sync ?? emptySync())
  const [rawVideos, setRawVideos] = useState<RawVideo[]>(() =>
    source.videoPaths.map((p) => ({ path: p, name: baseName(p), duration: null, modified: null, size: null, metaStarted: null })))
  const [current, setCurrent] = useState<string | null>(source.videoPaths[0] ?? null)
  // 영상이 늘어나면(자른 영상 '목록에 추가') 목록에 넣는다
  useEffect(() => {
    setRawVideos((list) => source.videoPaths.map((p) =>
      list.find((v) => v.path === p) ?? { path: p, name: baseName(p), duration: null, modified: null, size: null, metaStarted: null }))
  }, [source.videoPaths])
  const [images, setImages] = useState<FileEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const [wallNow, setWallNow] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [onlyFail, setOnlyFail] = useState(false)
  const [cycle, setCycle] = useState('')
  const [follow, setFollow] = useState(true)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const pendingSeek = useRef<number | null>(null)

  // 셋에 백업된 파일이면 서버에서, 아니면 테스트 PC에서 바로
  const fileUrl = useCallback(
    (path: string) => (set && set.files[path] ? api.resultSetFileUrl(set.id, path) : api.mediaUrl(source.agentId, path)),
    [set, source.agentId],
  )

  // Result 읽기
  useEffect(() => {
    let alive = true
    fetch(fileUrl(source.resultPath))
      .then(async (res) => {
        if (!res.ok) throw new Error(`Result 파일을 읽지 못했습니다 (${res.status}): ${await res.text()}`)
        return decodeText(await res.arrayBuffer())
      })
      .then((text) => alive && setRawText(text), (err) => alive && setError(toMessage(err)))
    return () => {
      alive = false
    }
  }, [fileUrl, source.resultPath])

  const parsed: ParsedResult | null = useMemo(() => (rawText === null ? null : parseResult(rawText, mapping)), [rawText, mapping])
  const absolute = parsed?.timeKind === 'absolute'
  const rows = useMemo(() => parsed?.rows ?? [], [parsed])
  const sortedRows = useMemo(() => rows.filter((r) => r.time !== null).sort((a, b) => a.time! - b.time! || a.index - b.index), [rows])
  const firstTime = sortedRows[0]?.time ?? null

  // 영상: 수정 시각·크기(목록), 메타 파일(started_at), 길이(메타데이터)
  useEffect(() => {
    let alive = true
    for (const v of source.videoPaths) {
      const update = (patch: Partial<RawVideo>) => alive && setRawVideos((list) => list.map((x) => (x.path === v ? { ...x, ...patch } : x)))
      api.listFiles(source.agentId, dirName(v)).then(
        (l) => {
          const entry = l.entries.find((e) => e.fullPath === v || e.name === baseName(v))
          if (entry) update({ modified: wallFromIso(entry.modifiedAt), size: entry.size })
        },
        () => {},
      )
      fetch(api.mediaUrl(source.agentId, `${v}.meta.json`))
        .then((res) => (res.ok ? res.json() : null))
        .then((meta: { started_at?: string } | null) => meta?.started_at && update({ metaStarted: meta.started_at }), () => {})
      const probe = document.createElement('video')
      probe.preload = 'metadata'
      probe.muted = true
      probe.onloadedmetadata = () => {
        update({ duration: probe.duration })
        probe.removeAttribute('src')
        probe.load()
      }
      probe.src = fileUrl(v)
    }
    return () => {
      alive = false
    }
  }, [source.agentId, source.videoPaths, fileUrl])

  const videos: VideoInfo[] = useMemo(
    () => rawVideos.map((v) => {
      const { start, source: from } = resolveStart(v, v.metaStarted, sync.manualStarts[v.path], firstTime)
      return { path: v.path, name: v.name, start, startSource: from, duration: v.duration, modified: v.modified }
    }),
    [rawVideos, sync.manualStarts, firstTime],
  )
  const currentVideo = videos.find((v) => v.path === current) ?? null

  // 이미지 폴더
  useEffect(() => {
    if (!source.imageDir) return
    let alive = true
    api.listFiles(source.agentId, source.imageDir).then(
      (l) => alive && setImages(l.entries.filter((e) => !e.isDirectory && isImageFile(e.name))),
      () => {
        // 테스트 PC가 꺼져 있으면 셋에 백업된 이미지 목록으로
        if (alive && set) {
          const dir = source.imageDir!.toLowerCase()
          setImages(Object.keys(set.files).filter((p) => p.toLowerCase().startsWith(dir) && isImageFile(p))
            .map((p) => ({ name: baseName(p), fullPath: p, isDirectory: false, size: 0, modifiedAt: null })))
        }
      },
    )
    return () => {
      alive = false
    }
  }, [source.agentId, source.imageDir, set])

  const imagesByName = useMemo(() => new Map(images.map((i) => [i.name.toLowerCase(), i.fullPath])), [images])
  const resolveImage = useCallback((p: string) => imagesByName.get(baseName(p).toLowerCase()) ?? p, [imagesByName])
  const timedImages = useMemo(
    () => images.map((i) => ({ entry: i, time: timeFromName(i.name) })).filter((x) => x.time !== null).sort((a, b) => a.time! - b.time!),
    [images],
  )

  // 기준점이 바뀌면 보정·배율 다시 계산
  const baseOfAnchor = useCallback(
    (a: Anchor) => {
      const row = rows.find((r) => r.index === a.row)
      if (!row || row.time === null) return null
      return baseSeconds(row.time, videos.find((v) => v.path === a.video) ?? null, absolute)
    },
    [rows, videos, absolute],
  )

  const videoTimeOf = useCallback(
    (row: ResultRow, video: VideoInfo | null) => {
      if (row.time === null) return null
      const base = baseSeconds(row.time, video, absolute)
      return base === null ? null : toVideoTime(base, sync)
    },
    [absolute, sync],
  )

  const seekVideo = (t: number) => {
    const video = videoRef.current
    if (!video) return
    const max = Number.isFinite(video.duration) ? video.duration - 0.05 : t
    if (t < 0 || t > max) setNotice(t < 0 ? '이 스텝은 영상 시작 전입니다' : '이 스텝은 영상이 끝난 뒤입니다')
    video.currentTime = Math.max(0, Math.min(max, t))
  }

  const seekToRow = (row: ResultRow) => {
    setSelected(row.index)
    setNotice(null)
    const video = videoForRow(row, videos, currentVideo, absolute)
    if (!video) return setNotice('영상이 없습니다')
    const t = videoTimeOf(row, video)
    if (t === null) return setNotice('영상 시작 시각을 몰라 위치를 계산할 수 없습니다 → 동기화에서 지정하세요')
    if (video.path !== current) {
      pendingSeek.current = t
      setCurrent(video.path)
    } else seekVideo(t)
  }

  const seekToWall = (wall: number) => {
    const row: ResultRow = { index: -1, cells: [], time: wall, cycle: '', status: '', name: '', durationMs: null, message: '', images: [] }
    seekToRow(row)
  }

  const onTime = (t: number) => {
    const wall = toRowTime(t, currentVideo, absolute, sync)
    setWallNow(wall)
    if (wall === null) return
    // 스텝 시작 직전(0.5초)부터 그 스텝으로 본다 (ReplayKit과 같음)
    const row = rowAtTime(sortedRows, wall + 500)
    if (row && row.index !== playing) setPlaying(row.index)
  }

  const switchVideo = (step: 1 | -1) => {
    if (videos.length < 2) return
    const i = videos.findIndex((v) => v.path === current)
    setCurrent(videos[(i + step + videos.length) % videos.length].path)
  }

  // 목록 필터
  const cycles = useMemo(() => [...new Set(rows.map((r) => r.cycle).filter(Boolean))], [rows])
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((r) =>
      (!onlyFail || statusTone(r.status) === 'bad')
      && (!cycle || r.cycle === cycle)
      && (!q || r.cells.some((c) => c.toLowerCase().includes(q))))
  }, [rows, query, onlyFail, cycle])

  const focusRow = rows.find((r) => r.index === (playing ?? selected)) ?? null
  const detailRow = rows.find((r) => r.index === (selected ?? playing)) ?? null
  const nearImage = useMemo(() => {
    if (wallNow === null || timedImages.length === 0) return null
    let best = timedImages[0]
    for (const x of timedImages) if (Math.abs(x.time! - wallNow) < Math.abs(best.time! - wallNow)) best = x
    return best.entry.fullPath
  }, [wallNow, timedImages])

  const addAnchor = () => {
    const video = videoRef.current
    if (selected === null || !video || !current) return setNotice('표에서 스텝을 고르고, 영상을 그 장면에 맞춘 뒤 누르세요')
    setSync((s) => {
      const anchors = [...s.anchors.filter((a) => a.row !== selected), { row: selected, video: current, videoTime: video.currentTime }]
      return { ...s, anchors, ...solveAnchors(anchors, baseOfAnchor) }
    })
    setNotice('기준점을 넣었습니다. 두 곳 이상 맞추면 시계 속도 차이까지 보정합니다.')
  }

  if (error) {
    return (
      <>
        <ViewerHead source={source} set={set} onBack={onBack} onClose={onClose} setDialog={setDialog} />
        <p className="error rv-error">{error}</p>
      </>
    )
  }

  return (
    <>
      <ViewerHead source={source} set={set} onBack={onBack} onClose={onClose} setDialog={setDialog} />
      <div className="rv-main">
        <section className="rv-left">
          <VideoTransport
            src={current ? fileUrl(current) : null}
            videoRef={videoRef}
            keysEnabled={dialog === null}
            error={videoError}
            onTime={onTime}
            onLoaded={(duration) => {
              setVideoError(null)
              setRawVideos((list) => list.map((v) => (v.path === current ? { ...v, duration } : v)))
              if (pendingSeek.current !== null) {
                seekVideo(pendingSeek.current)
                pendingSeek.current = null
              }
            }}
            onSwitch={videos.length > 1 ? switchVideo : undefined}
            extra={
              <>
                {videos.length > 1 && (
                  <select value={current ?? ''} onChange={(e) => setCurrent(e.target.value)} title="영상 (F/R)">
                    {videos.map((v) => <option key={v.path} value={v.path}>{v.name}</option>)}
                  </select>
                )}
                <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={addAnchor} title="표에서 고른 스텝이 지금 장면이라고 알려 동기화를 맞춘다">
                  📍 이 장면 = 선택 스텝
                </button>
                <button type="button" onMouseDown={(e) => e.preventDefault()} disabled={!current} onClick={() => setDialog('trim')} title="영상 구간 자르기 (테스트 PC에서 ffmpeg, 원래 영상 폴더에 저장)">✂ 자르기</button>
              </>
            }
          />
          <div className="rv-sync-line small muted">
            {currentVideo
              ? <>영상 시작: {currentVideo.start !== null ? formatWall(currentVideo.start, true) : '모름'} ({START_SOURCE_LABEL[currentVideo.startSource]}) · 보정 {sync.offset >= 0 ? '+' : ''}{sync.offset.toFixed(2)}초{sync.rate !== 1 ? ` · 배율 ${sync.rate.toFixed(5)}` : ''}{sync.anchors.length ? ` · 기준점 ${sync.anchors.length}개` : ''}</>
              : 'Result만 보는 중 (영상 없음)'}
            {wallNow !== null && absolute && <> · 지금 {formatWall(wallNow)}</>}
            <button type="button" className="link" onClick={() => setDialog('sync')}>동기화·열 설정</button>
          </div>
          {notice && <div className="rv-notice small">{notice}</div>}
          <div className="rv-images">
            <div className="rv-images-title small muted">스텝 이미지 {focusRow ? `· #${focusRow.index + 1} ${focusRow.name}` : ''}</div>
            <div className="rv-thumbs">
              {(focusRow?.images ?? []).map((p) => (
                <figure key={p} onClick={() => setPreview(fileUrl(resolveImage(p)))} title={p}>
                  <img src={fileUrl(resolveImage(p))} alt="" loading="lazy" />
                  <figcaption className="ellipsis small">{baseName(p)}</figcaption>
                </figure>
              ))}
              {focusRow && focusRow.images.length === 0 && <span className="muted small">이 스텝에 적힌 이미지가 없습니다</span>}
            </div>
            {timedImages.length > 0 && (
              <>
                <div className="rv-images-title small muted">이미지 폴더 ({timedImages.length}) · 누르면 그 시각으로 이동</div>
                <div className="rv-strip">
                  {timedImages.map(({ entry, time }) => (
                    <figure
                      key={entry.fullPath}
                      className={entry.fullPath === nearImage ? 'near' : ''}
                      onClick={() => seekToWall(time!)}
                      onDoubleClick={() => setPreview(fileUrl(entry.fullPath))}
                      title={`${entry.name} · ${formatWall(time, true)} (더블클릭: 크게)`}
                    >
                      <img src={fileUrl(entry.fullPath)} alt="" loading="lazy" />
                      <figcaption className="small">{formatWall(time)}</figcaption>
                    </figure>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
        <section className="rv-right">
          <div className="rv-filters">
            <input placeholder="검색 (모든 열)" value={query} onChange={(e) => setQuery(e.target.value)} />
            <select value={cycle} onChange={(e) => setCycle(e.target.value)} title="회차">
              <option value="">전체 회차</option>
              {cycles.map((c) => <option key={c} value={c}>회차 {c}</option>)}
            </select>
            <label className="small"><input type="checkbox" checked={onlyFail} onChange={(e) => setOnlyFail(e.target.checked)} /> 실패만</label>
            <label className="small" title="재생 중인 스텝으로 표를 따라 움직임"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> 따라가기</label>
            <span className="muted small">{visible.length.toLocaleString()} / {rows.length.toLocaleString()}행</span>
          </div>
          {!parsed ? <p className="muted rv-loading">Result 읽는 중…</p> : (
            <RowTable
              rows={visible}
              selected={selected}
              playing={playing}
              follow={follow}
              anchors={sync.anchors}
              videoTime={(row) => {
                const t = videoTimeOf(row, videoForRow(row, videos, currentVideo, absolute))
                return t === null ? '' : formatSeconds(t)
              }}
              onPick={seekToRow}
            />
          )}
          {detailRow && parsed && (
            <details className="rv-detail" open>
              <summary className="small">#{detailRow.index + 1} 자세히</summary>
              <dl>
                {parsed.headers.map((h, i) => detailRow.cells[i] ? (
                  <div key={i}><dt>{h || `열 ${i + 1}`}</dt><dd>{detailRow.cells[i]}</dd></div>
                ) : null)}
              </dl>
            </details>
          )}
        </section>
      </div>

      {dialog === 'sync' && parsed && (
        <SyncDialog
          parsed={parsed}
          mapping={mapping}
          setMapping={setMapping}
          videos={videos}
          sync={sync}
          setSync={setSync}
          rows={rows}
          baseOfAnchor={baseOfAnchor}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'trim' && current && (
        <TrimDialog
          agentId={source.agentId}
          path={current}
          now={videoRef.current?.currentTime ?? 0}
          duration={currentVideo?.duration ?? null}
          readNow={() => videoRef.current?.currentTime ?? 0}
          onAdd={addVideo}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === 'save' && parsed && (
        <SaveDialog
          source={source}
          set={set}
          config={{ mapping, sync }}
          videos={rawVideos}
          backupFiles={[...new Set([...images.map((i) => i.fullPath), ...rows.flatMap((r) => r.images.map(resolveImage))])]}
          onSaved={setSet}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  )
}

function ViewerHead({ source, set, onBack, onClose, setDialog }: {
  source: Source
  set: ResultSet | null
  onBack: () => void
  onClose: () => void
  setDialog: (d: 'sync' | 'save' | 'sets') => void
}) {
  return (
    <header className="rv-head">
      <button type="button" onClick={onBack} title="Result·영상·이미지 다시 고르기">← 경로</button>
      <strong>결과 확인{set ? ` · ${set.name}` : ''}</strong>
      <span className="muted ellipsis" title={source.resultPath}>{source.machineName} · {baseName(source.resultPath)}</span>
      {set && set.backup.state !== 'done' && (
        <span className={`small ${set.backup.state === 'failed' ? 'error' : 'muted'}`}>
          백업 {set.backup.state === 'failed' ? '실패' : `중 ${set.backup.filesDone}/${set.backup.filesTotal}`}
        </span>
      )}
      <span className="rv-spacer" />
      <button type="button" onClick={() => setDialog('sync')}>동기화·열 설정</button>
      <button type="button" onClick={() => setDialog('sets')}>저장된 셋</button>
      <button type="button" className="primary" onClick={() => setDialog('save')}>셋 저장</button>
      <button type="button" className="icon" aria-label="닫기" title="닫기 (Esc)" onClick={onClose}>✕</button>
    </header>
  )
}

// ─────────────────────────────── 스텝 표 (행이 많아 보이는 부분만 그린다)

function RowTable({ rows, selected, playing, follow, anchors, videoTime, onPick }: {
  rows: ResultRow[]
  selected: number | null
  playing: number | null
  follow: boolean
  anchors: Anchor[]
  videoTime: (row: ResultRow) => string
  onPick: (row: ResultRow) => void
}) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState(0)
  const [height, setHeight] = useState(400)
  const lastUserScroll = useRef(0)

  useLayoutEffect(() => {
    const body = bodyRef.current
    if (!body) return
    const observer = new ResizeObserver(() => setHeight(body.clientHeight))
    observer.observe(body)
    return () => observer.disconnect()
  }, [])

  // 재생 중인 스텝을 따라 스크롤 (사용자가 막 스크롤했으면 잠시 두기)
  useEffect(() => {
    const body = bodyRef.current
    if (!follow || playing === null || !body || Date.now() - lastUserScroll.current < 2000) return
    const i = rows.findIndex((r) => r.index === playing)
    if (i < 0) return
    const top = i * ROW_HEIGHT
    if (top < body.scrollTop || top > body.scrollTop + body.clientHeight - ROW_HEIGHT * 2)
      body.scrollTop = Math.max(0, top - body.clientHeight / 3)
  }, [playing, follow, rows])

  const first = Math.max(0, Math.floor(scroll / ROW_HEIGHT) - 10)
  const last = Math.min(rows.length, Math.ceil((scroll + height) / ROW_HEIGHT) + 10)
  const anchorRows = new Set(anchors.map((a) => a.row))

  return (
    <div className="rv-table">
      <div className="rv-row rv-row-head small">
        <span>#</span><span>시간</span><span>회차</span><span>스텝</span><span>결과</span><span>걸린 시간</span><span>메시지</span><span>영상</span>
      </div>
      <div
        className="rv-table-body"
        ref={bodyRef}
        onScroll={(e) => setScroll(e.currentTarget.scrollTop)}
        onWheel={() => (lastUserScroll.current = Date.now())}
      >
        <div style={{ height: rows.length * ROW_HEIGHT, position: 'relative' }}>
          {rows.slice(first, last).map((row, i) => (
            <div
              key={row.index}
              className={`rv-row${row.index === selected ? ' selected' : ''}${row.index === playing ? ' playing' : ''} tone-${statusTone(row.status) || 'none'}`}
              style={{ position: 'absolute', top: (first + i) * ROW_HEIGHT, left: 0, right: 0, height: ROW_HEIGHT }}
              onClick={() => onPick(row)}
              title="누르면 영상의 이 시점으로"
            >
              <span className="muted">{anchorRows.has(row.index) ? '📍' : row.index + 1}</span>
              <span className="mono">{formatWall(row.time)}</span>
              <span>{row.cycle}</span>
              <span className="ellipsis" title={row.name}>{row.name}</span>
              <span className="rv-status">{row.status}</span>
              <span className="mono">{row.durationMs === null ? '' : `${(row.durationMs / 1000).toFixed(2)}s`}</span>
              <span className="ellipsis" title={row.message}>{row.message}</span>
              <span className="mono muted">{videoTime(row)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────── 동기화·열 설정

function SyncDialog({ parsed, mapping, setMapping, videos, sync, setSync, rows, baseOfAnchor, onClose }: {
  parsed: ParsedResult
  mapping: Partial<ResultMapping>
  setMapping: React.Dispatch<React.SetStateAction<Partial<ResultMapping>>>
  videos: VideoInfo[]
  sync: SyncState
  setSync: React.Dispatch<React.SetStateAction<SyncState>>
  rows: ResultRow[]
  baseOfAnchor: (a: Anchor) => number | null
  onClose: () => void
}) {
  const roles = Object.keys(ROLE_LABEL) as ColumnRole[]
  const [startText, setStartText] = useState<Record<string, string>>({})
  return (
    <div className="rv-drawer">
      <div className="rv-drawer-head">
        <strong>동기화 · 열 설정</strong>
        <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
      </div>
      <h4>Result 열</h4>
      <p className="hint">자동으로 고른 열입니다. 틀리면 바꾸세요. 시간 형식은 {parsed.timeKind === 'absolute' ? '날짜·시각' : parsed.timeKind === 'elapsed' ? '경과 시간' : '알 수 없음'}으로 읽었습니다.</p>
      <div className="rv-form">
        {roles.map((role) => (
          <label key={role}>
            {ROLE_LABEL[role]}
            <select
              value={parsed.mapping[role]}
              onChange={(e) => setMapping((m) => ({ ...m, [role]: Number(e.target.value) }))}
            >
              <option value={-1}>(없음)</option>
              {parsed.headers.map((h, i) => <option key={i} value={i}>{h || `열 ${i + 1}`}</option>)}
            </select>
          </label>
        ))}
        <label>
          시간 해석
          <select value={mapping.timeMode ?? 'auto'} onChange={(e) => setMapping((m) => ({ ...m, timeMode: e.target.value as ResultMapping['timeMode'] }))}>
            <option value="auto">자동</option>
            <option value="absolute">날짜·시각 (영상 시작 시각 기준)</option>
            <option value="elapsed">경과 시간 (영상 0초 = 시작)</option>
          </select>
        </label>
        <label>
          걸린 시간 단위
          <select value={parsed.mapping.durationUnit} onChange={(e) => setMapping((m) => ({ ...m, durationUnit: e.target.value as 's' | 'ms' }))}>
            <option value="s">초</option>
            <option value="ms">밀리초</option>
          </select>
        </label>
      </div>

      <h4>영상 시작 시각</h4>
      <p className="hint">메타 파일 → 파일 이름의 시각 → 파일 수정 시각−길이 → Result 첫 행 순서로 자동으로 찾습니다. 직접 입력하면 그 값을 씁니다.</p>
      {videos.map((v) => (
        <div key={v.path} className="rv-video-start">
          <div className="small ellipsis" title={v.path}>{v.name} {v.duration ? `(${formatSeconds(v.duration)})` : ''}</div>
          <div className="rv-inline">
            <input
              className="mono"
              placeholder="YYYY-MM-DD HH:mm:ss.fff"
              value={startText[v.path] ?? formatWall(v.start, true)}
              onChange={(e) => setStartText((s) => ({ ...s, [v.path]: e.target.value }))}
              onBlur={(e) => {
                if (e.target.value === formatWall(v.start, true)) return
                const ms = parseManual(e.target.value)
                if (ms !== null) setSync((s) => ({ ...s, manualStarts: { ...s.manualStarts, [v.path]: ms } }))
              }}
            />
            <span className="muted small">{START_SOURCE_LABEL[v.startSource]}</span>
            {sync.manualStarts[v.path] !== undefined && (
              <button type="button" className="link" onClick={() => {
                setStartText((s) => ({ ...s, [v.path]: '' }))
                setSync((s) => {
                  const manualStarts = { ...s.manualStarts }
                  delete manualStarts[v.path]
                  return { ...s, manualStarts }
                })
              }}>자동으로</button>
            )}
          </div>
        </div>
      ))}

      <h4>보정</h4>
      <p className="hint">영상에서 스텝이 시작되는 장면을 찾아 표에서 그 스텝을 고르고 '📍 이 장면 = 선택 스텝'을 누르면 자동 계산됩니다. 두 곳 이상이면 Result 기록과 녹화의 시계 속도 차이까지 맞춥니다.</p>
      <div className="rv-form">
        <label>
          보정 (초)
          <input type="number" step={0.1} value={Number(sync.offset.toFixed(3))} onChange={(e) => setSync((s) => ({ ...s, offset: Number(e.target.value) }))} />
        </label>
        <label>
          배율
          <input type="number" step={0.0001} value={Number(sync.rate.toFixed(6))} onChange={(e) => setSync((s) => ({ ...s, rate: Number(e.target.value) || 1 }))} />
        </label>
      </div>
      {sync.anchors.length > 0 && (
        <ul className="rv-anchors small">
          {sync.anchors.map((a) => {
            const row = rows.find((r) => r.index === a.row)
            return (
              <li key={a.row}>
                📍 #{a.row + 1} {row?.name} → {baseName(a.video)} {formatSeconds(a.videoTime)}
                <button type="button" className="icon" aria-label="빼기" onClick={() => setSync((s) => {
                  const anchors = s.anchors.filter((x) => x.row !== a.row)
                  return { ...s, anchors, ...solveAnchors(anchors, baseOfAnchor) }
                })}>✕</button>
              </li>
            )
          })}
        </ul>
      )}
      <button type="button" onClick={() => setSync((s) => ({ ...s, offset: 0, rate: 1, anchors: [] }))}>보정 초기화</button>
    </div>
  )
}

/** 직접 입력한 시각: 2026-10-06 14:12:30.5 등 */
function parseManual(text: string): number | null {
  const m = /^(\d{4})\D(\d{1,2})\D(\d{1,2})\D+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?$/.exec(text.trim())
  if (!m) return null
  const [, y, mo, d, h, mi, s, f] = m
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0) + (f ? Number(`0.${f}`) * 1000 : 0)
}

// ─────────────────────────────── 자르기

function TrimDialog({ agentId, path, now, duration, readNow, onAdd, onClose }: {
  agentId: string
  path: string
  now: number
  duration: number | null
  readNow: () => number
  onAdd: (path: string) => void
  onClose: () => void
}) {
  const [start, setStart] = useState(Math.max(0, Math.round((now - 5) * 10) / 10))
  const [end, setEnd] = useState(Math.round(Math.min(duration ?? now + 5, now + 5) * 10) / 10)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setError(null)
    api.trimVideo(agentId, path, start, end).then(
      (r) => setResult(r.outputPath),
      (err) => setError(toMessage(err)),
    ).finally(() => setBusy(false))
  }

  return (
    <div className="rv-modal">
      <div className="rv-modal-box panel">
        <div className="rv-drawer-head">
          <strong>영상 자르기</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        <p className="hint ellipsis" title={path}>{baseName(path)} · 테스트 PC에서 ffmpeg로 잘라 같은 폴더에 저장합니다 (프레임 단위로 정확하게 다시 인코딩)</p>
        <div className="rv-form">
          <label>
            시작 (초)
            <span className="rv-inline">
              <input type="number" min={0} step={0.1} value={start} onChange={(e) => setStart(Number(e.target.value))} />
              <button type="button" onClick={() => setStart(Math.round(readNow() * 10) / 10)}>지금 위치</button>
            </span>
          </label>
          <label>
            끝 (초)
            <span className="rv-inline">
              <input type="number" min={0} step={0.1} value={end} onChange={(e) => setEnd(Number(e.target.value))} />
              <button type="button" onClick={() => setEnd(Math.round(readNow() * 10) / 10)}>지금 위치</button>
            </span>
          </label>
        </div>
        <p className="small muted">길이 {formatSeconds(Math.max(0, end - start))}</p>
        {error && <p className="error small">{error}</p>}
        {result && (
          <p className="small">
            저장했습니다: <span className="mono">{result}</span>{' '}
            <button type="button" className="link" onClick={() => { onAdd(result); onClose() }}>영상 목록에 추가</button>
          </p>
        )}
        <div className="rv-setup-actions">
          <button type="button" className="primary" disabled={busy || end <= start} onClick={run}>{busy ? '자르는 중…' : '자르기'}</button>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────── 셋 저장·목록

function SaveDialog({ source, set, config, videos, backupFiles, onSaved, onClose }: {
  source: Source
  set: ResultSet | null
  config: ViewConfig
  videos: RawVideo[]
  backupFiles: string[]
  onSaved: (s: ResultSet) => void
  onClose: () => void
}) {
  const [name, setName] = useState(set?.name ?? baseName(source.resultPath).replace(/\.[^.]+$/, ''))
  const [copyVideo, setCopyVideo] = useState(false)
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState<ResultSet | null>(null)
  const [error, setError] = useState<string | null>(null)
  const videoBytes = videos.reduce((n, v) => n + (v.size ?? 0), 0)

  // 백업 진행 표시
  useEffect(() => {
    if (!saved || saved.backup.state !== 'running') return
    const id = window.setInterval(() => {
      api.resultSet(saved.id).then((s) => {
        setSaved(s)
        onSaved(s)
      }, () => {})
    }, 1000)
    return () => window.clearInterval(id)
  }, [saved, onSaved])

  const create = () => {
    setBusy(true)
    setError(null)
    api.createResultSet({
      name: name.trim(), agentId: source.agentId, machineName: source.machineName, resultPath: source.resultPath,
      videoPaths: source.videoPaths, imageDir: source.imageDir, copyVideo, config, files: backupFiles,
    }).then((s) => {
      setSaved(s)
      onSaved(s)
    }, (err) => setError(toMessage(err))).finally(() => setBusy(false))
  }

  const update = () => {
    if (!set) return
    setBusy(true)
    api.updateResultSet(set.id, { name: name.trim(), config }).then((s) => {
      onSaved(s)
      onClose()
    }, (err) => setError(toMessage(err))).finally(() => setBusy(false))
  }

  return (
    <div className="rv-modal">
      <div className="rv-modal-box panel">
        <div className="rv-drawer-head">
          <strong>셋 저장</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        {!saved ? (
          <>
            <label className="rv-block">
              이름
              <input autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            </label>
            <p className="hint">
              Result 파일과 이미지 {backupFiles.length.toLocaleString()}개를 서버에 백업해 테스트 PC가 꺼져 있어도 열 수 있게 합니다.
              열 지정·동기화 보정도 함께 저장합니다.
            </p>
            {source.videoPaths.length > 0 && (
              <label className="small">
                <input type="checkbox" checked={copyVideo} onChange={(e) => setCopyVideo(e.target.checked)} />{' '}
                영상도 백업 ({source.videoPaths.length}개{videoBytes ? `, ${formatBytes(videoBytes)}` : ''}) — 끄면 영상은 테스트 PC가 켜져 있을 때만 재생
              </label>
            )}
            {error && <p className="error small">{error}</p>}
            <div className="rv-setup-actions">
              {set && <button type="button" disabled={busy || !name.trim()} onClick={update}>'{set.name}'에 덮어쓰기 (설정·이름만)</button>}
              <button type="button" className="primary" disabled={busy || !name.trim()} onClick={create}>{set ? '새 셋으로 저장' : '저장'}</button>
            </div>
          </>
        ) : (
          <>
            <p>'{saved.name}' 저장 · 백업 {saved.backup.state === 'done' ? '완료' : saved.backup.state === 'failed' ? '일부 실패' : '중'}</p>
            <progress max={Math.max(1, saved.backup.filesTotal)} value={saved.backup.filesDone + saved.backup.skipped} />
            <p className="small muted">
              {saved.backup.filesDone}/{saved.backup.filesTotal}개 · {formatBytes(saved.backup.bytesDone)}
              {saved.backup.skipped > 0 && ` · 테스트 PC에 없는 파일 ${saved.backup.skipped}개 건너뜀`}
            </p>
            {saved.backup.error && <p className="error small">{saved.backup.error}</p>}
            <div className="rv-setup-actions">
              <button type="button" onClick={onClose}>닫기 (백업은 계속됩니다)</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function SetsDialog({ onOpen, onClose }: { onOpen: (s: ResultSetSummary) => void; onClose: () => void }) {
  const [sets, setSets] = useState<ResultSetSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = () => api.resultSets().then(setSets, (err) => setError(toMessage(err)))
  useEffect(() => {
    void load()
  }, [])

  const rename = (s: ResultSetSummary) => {
    const name = window.prompt('셋 이름', s.name)
    if (name?.trim()) api.updateResultSet(s.id, { name: name.trim() }).then(load, (err) => setError(toMessage(err)))
  }
  const remove = (s: ResultSetSummary) => {
    if (window.confirm(`'${s.name}' 셋과 서버에 백업한 파일을 지울까요? (테스트 PC의 원본은 그대로)`))
      api.deleteResultSet(s.id).then(load, (err) => setError(toMessage(err)))
  }

  return (
    <div className="rv-modal">
      <div className="rv-modal-box panel wide">
        <div className="rv-drawer-head">
          <strong>저장된 셋</strong>
          <button type="button" className="icon" aria-label="닫기" onClick={onClose}>✕</button>
        </div>
        {error && <p className="error small">{error}</p>}
        {!sets ? <p className="muted">불러오는 중…</p> : sets.length === 0 ? <p className="muted">저장된 셋이 없습니다</p> : (
          <ul className="rv-sets">
            {sets.map((s) => (
              <li key={s.id}>
                <div>
                  <strong>{s.name}</strong>
                  <div className="small muted">
                    {s.machineName} · {baseName(s.resultPath)} · 영상 {s.videoCount}개{s.copyVideo ? ' (백업)' : ''} · {new Date(s.updatedAt).toLocaleString()}
                  </div>
                  <div className={`small ${s.backup.state === 'failed' ? 'error' : 'muted'}`}>
                    백업 {s.backup.state === 'done' ? `완료 (${s.backup.filesDone}개${s.backup.skipped ? `, 없는 파일 ${s.backup.skipped}개 건너뜀` : ''})` : s.backup.state === 'failed' ? `실패: ${s.backup.error ?? ''}` : `중 ${s.backup.filesDone}/${s.backup.filesTotal}`}
                  </div>
                </div>
                <span className="rv-spacer" />
                {s.backup.state === 'failed' && <button type="button" onClick={() => api.retryResultSetBackup(s.id).then(load)}>다시 백업</button>}
                <button type="button" onClick={() => rename(s)}>이름</button>
                <button type="button" onClick={() => remove(s)}>삭제</button>
                <button type="button" className="primary" onClick={() => onOpen(s)}>열기</button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
