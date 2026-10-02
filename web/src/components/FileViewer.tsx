import { useEffect, useRef, useState } from 'react'
import { ARCHIVE_PASSWORD_PREFIX, api, type TextFile } from '../api'
import { loadBackupSetting, saveBackupSetting } from '../fileTypes'

export type ViewerKind = 'text' | 'image' | 'pdf'

interface Props {
  agentId: string
  path: string
  name: string
  kind: ViewerKind
  /** 압축 파일 안 등 저장할 수 없는 파일 */
  readOnly: boolean
  /** 원본을 내 PC로 내려받기 */
  onFetch: () => void
  /** 그 PC에 저장했을 때 (목록 새로고침) */
  onSaved: () => void
  /** 압축 암호가 필요할 때. 암호를 넣었으면 true */
  onPasswordNeeded: () => Promise<boolean>
  onClose: () => void
}

const WRAP_KEY = 'pcm.viewer.wrap'

const ENCODING_LABEL: Record<string, string> = {
  'utf-8': 'UTF-8',
  'utf-8-bom': 'UTF-8 (BOM)',
  'utf-16le': 'UTF-16 LE',
  'utf-16be': 'UTF-16 BE',
  cp949: 'ANSI (CP949)',
}

const loadFlag = (key: string, fallback: boolean) => {
  try {
    const v = localStorage.getItem(key)
    return v === null ? fallback : v === '1'
  } catch {
    return fallback
  }
}
const saveFlag = (key: string, value: boolean) => {
  try {
    localStorage.setItem(key, value ? '1' : '0')
  } catch {
    // 무시
  }
}

const toMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** 원격 PC의 텍스트·이미지·PDF를 내려받지 않고 바로 보는 모달. 텍스트는 편집해서 그 PC에 저장할 수 있다. */
export function FileViewer({ agentId, path, name, kind, readOnly, onFetch, onSaved, onPasswordNeeded, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [file, setFile] = useState<TextFile | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [backup, setBackup] = useState(loadBackupSetting)
  const [wrap, setWrap] = useState(() => loadFlag(WRAP_KEY, false))
  const [reloadKey, setReloadKey] = useState(0)
  const dirty = file !== null && text !== file.content
  const dirtyRef = useRef(false)
  dirtyRef.current = dirty
  const passwordRef = useRef(onPasswordNeeded)
  passwordRef.current = onPasswordNeeded

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  // 텍스트 불러오기
  useEffect(() => {
    if (kind !== 'text') return
    let cancelled = false
    setError(null)
    setNotice(null)
    setFile(null)
    api.readText(agentId, path).then(
      (result) => {
        if (cancelled) return
        setFile(result)
        setText(result.content)
      },
      async (err: unknown) => {
        if (cancelled) return
        const message = toMessage(err)
        if (message.includes(ARCHIVE_PASSWORD_PREFIX) && (await passwordRef.current())) {
          setReloadKey((k) => k + 1)
          return
        }
        setError(message)
      },
    )
    return () => {
      cancelled = true
    }
  }, [agentId, path, kind, reloadKey])

  const close = () => {
    if (dirtyRef.current && !window.confirm('저장하지 않은 변경 내용이 있습니다. 닫을까요?')) return
    dialogRef.current?.close()
  }

  const save = async (force = false): Promise<void> => {
    if (!file || readOnly) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const result = await api.saveText(agentId, {
        path,
        content: text,
        encoding: file.encoding,
        newline: file.newline,
        baseHash: force ? null : file.hash,
        backup,
      })
      if (result.conflict) {
        setBusy(false)
        if (window.confirm('편집하는 동안 다른 곳에서 이 파일이 바뀌었습니다.\n내 내용으로 덮어쓸까요? (취소하면 저장하지 않습니다)')) await save(true)
        return
      }
      if (!result.success) {
        setError(result.error ?? '저장하지 못했습니다.')
        return
      }
      setFile({ ...file, content: text, hash: result.hash ?? file.hash })
      setNotice(`저장했습니다${backup ? ' (원본은 .bak으로 남김)' : ''}`)
      onSaved()
    } catch (err) {
      setError(toMessage(err))
    } finally {
      setBusy(false)
    }
  }

  // 내 PC에 저장: 원래 인코딩 그대로. 저장 위치를 고를 수 있으면 고르게 한다 (HTTPS)
  const saveLocal = async () => {
    if (!file) return
    setError(null)
    try {
      const blob = await api.encodeText(text, file.encoding, file.newline)
      const picker = (window as unknown as { showSaveFilePicker?: (o: { suggestedName: string }) => Promise<FileSystemFileHandle> }).showSaveFilePicker
      if (picker) {
        try {
          const handle = await picker({ suggestedName: name })
          const writable = await handle.createWritable()
          await writable.write(blob)
          await writable.close()
          setNotice('내 PC에 저장했습니다')
          return
        } catch (err) {
          if (err instanceof DOMException && err.name === 'AbortError') return
          // 고르기가 안 되면 일반 다운로드로
        }
      }
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 5000)
    } catch (err) {
      setError(toMessage(err))
    }
  }

  const src = api.mediaUrl(agentId, path)

  return (
    <dialog
      ref={dialogRef}
      className={`dialog viewer-dialog viewer-kind-${kind}`}
      aria-label={`보기: ${name}`}
      onClose={onClose}
      onCancel={(e) => {
        // Esc: 저장 안 한 내용이 있으면 확인
        e.preventDefault()
        close()
      }}
      onKeyDown={(e) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && kind === 'text') {
          e.preventDefault()
          if (dirty && !busy) void save()
        }
      }}
    >
      <div className="dialog-head">
        <h2 className="ellipsis" title={path}>
          {dirty && <span className="viewer-dirty" title="저장하지 않은 변경">● </span>}
          {name}
        </h2>
        {kind === 'text' && file && (
          <span className="viewer-meta small">
            {ENCODING_LABEL[file.encoding] ?? file.encoding} · {file.newline === '\r\n' ? 'CRLF' : 'LF'}
            {readOnly && ' · 읽기 전용'}
          </span>
        )}
        <button type="button" className="icon" aria-label="닫기" onClick={close}>
          ✕
        </button>
      </div>

      {kind === 'text' && (
        <div className="viewer-toolbar">
          {!readOnly && (
            <button type="button" className="primary" disabled={!dirty || busy} onClick={() => void save()} title="Ctrl+S">
              {busy ? '저장 중…' : '저장'}
            </button>
          )}
          <button type="button" disabled={!file} onClick={() => void saveLocal()} title="편집한 내용을 원래 인코딩 그대로 내 PC에 저장">
            내 PC에 저장
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (dirty && !window.confirm('변경 내용을 버리고 다시 불러올까요?')) return
              setReloadKey((k) => k + 1)
            }}
          >
            다시 불러오기
          </button>
          <span className="win-spacer" />
          <label className="viewer-check">
            <input
              type="checkbox"
              checked={wrap}
              onChange={(e) => {
                setWrap(e.target.checked)
                saveFlag(WRAP_KEY, e.target.checked)
              }}
            />
            자동 줄바꿈
          </label>
          {!readOnly && (
            <label className="viewer-check" title="저장할 때 원래 파일을 '이름.bak'으로 남깁니다">
              <input
                type="checkbox"
                checked={backup}
                onChange={(e) => {
                  setBackup(e.target.checked)
                  saveBackupSetting(e.target.checked)
                }}
              />
              .bak 백업
            </label>
          )}
        </div>
      )}

      {error && (
        <div className="output-error viewer-error">
          {error}{' '}
          <button type="button" className="link" onClick={onFetch}>
            원본 내려받기
          </button>
        </div>
      )}
      {notice && <div className="viewer-notice small">{notice}</div>}

      <div className="viewer-body">
        {kind === 'text' &&
          (file ? (
            <textarea
              className={`viewer-text${wrap ? ' wrap' : ''}`}
              value={text}
              readOnly={readOnly}
              spellCheck={false}
              onChange={(e) => setText(e.target.value)}
              aria-label={`${name} 내용`}
            />
          ) : (
            !error && <p className="hint viewer-loading">불러오는 중…</p>
          ))}
        {kind === 'image' && <img className="viewer-image" src={src} alt={name} onError={() => setError('이미지를 불러오지 못했습니다.')} />}
        {kind === 'pdf' && <iframe className="viewer-pdf" src={src} title={name} />}
      </div>
      {kind !== 'text' && (
        <div className="viewer-toolbar">
          <span className="hint">원격 PC에서 바로 읽어 표시합니다 · 서버에 저장하지 않음</span>
          <span className="win-spacer" />
          <button type="button" onClick={onFetch}>
            내 PC로 가져오기
          </button>
        </div>
      )}
    </dialog>
  )
}
