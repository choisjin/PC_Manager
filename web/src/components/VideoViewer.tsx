import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { isWebPlayable } from '../fileTypes'

interface Props {
  agentId: string
  path: string
  name: string
  /** 재생이 안 될 때 원본을 서버로 가져와 다운로드 */
  onFetch: () => void
  onClose: () => void
}

/** 원격 PC의 영상을 서버로 옮기지 않고 바로 재생하는 모달 */
export function VideoViewer({ agentId, path, name, onFetch, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const [failed, setFailed] = useState(false)
  const src = api.mediaUrl(agentId, path)

  useEffect(() => {
    dialogRef.current?.showModal()
  }, [])

  return (
    <dialog
      ref={dialogRef}
      className="dialog video-dialog"
      aria-label={`영상: ${name}`}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === dialogRef.current) dialogRef.current.close()
      }}
    >
      <div className="dialog-head">
        <h2 className="ellipsis" title={path}>
          {name}
        </h2>
        <button type="button" className="icon" aria-label="닫기" onClick={() => dialogRef.current?.close()}>
          ✕
        </button>
      </div>

      <div className="video-body">
        {failed ? (
          <div className="video-fallback">
            <p>이 형식은 브라우저에서 바로 재생되지 않을 수 있습니다{isWebPlayable(name) ? '' : ' (mkv·avi 등)'}.</p>
            <button
              type="button"
              className="primary"
              onClick={() => {
                onFetch()
                dialogRef.current?.close()
              }}
            >
              원본 가져와 다운로드
            </button>
          </div>
        ) : (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video
            className="video-player"
            src={src}
            controls
            autoPlay
            onError={() => setFailed(true)}
          />
        )}
      </div>
      <p className="hint video-hint">원격 PC에서 직접 스트리밍합니다 · 서버에 저장하지 않음</p>
    </dialog>
  )
}
