// H.264 프레임을 조각 MP4(fMP4)로 감싸는 최소 muxer. MSE(Media Source Extensions) 재생용.
// WebCodecs는 보안 컨텍스트(HTTPS/localhost)에서만 쓸 수 있어서, http://서버IP 로 접속할 때 이 경로를 쓴다.

import { NAL_AUD, NAL_PPS, NAL_SPS, nalType, type ParameterSets } from './h264'

export const TIMESCALE = 90000

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const body = concat(payload)
  const out = new Uint8Array(8 + body.length)
  new DataView(out.buffer).setUint32(0, out.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(body, 8)
  return out
}

const bytes = (...values: number[]) => Uint8Array.from(values)
const zeros = (n: number) => new Uint8Array(n)

function u16(v: number) {
  return bytes((v >>> 8) & 0xff, v & 0xff)
}

function u32(v: number) {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, v >>> 0)
  return b
}

function u64(v: number) {
  const b = new Uint8Array(8)
  const view = new DataView(b.buffer)
  view.setUint32(0, Math.floor(v / 2 ** 32))
  view.setUint32(4, v >>> 0)
  return b
}

const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)])

/** 초기화 세그먼트 (ftyp + moov) */
export function initSegment(width: number, height: number, ps: ParameterSets): Uint8Array {
  const ftyp = box('ftyp', new TextEncoder().encode('isom'), u32(0x200), new TextEncoder().encode('isomiso2avc1mp41'))

  const mvhd = box('mvhd', u32(0), u32(0), u32(0), u32(1000), u32(0), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(2))
  const tkhd = box('tkhd', u32(0x00000003), u32(0), u32(0), u32(1), u32(0), u32(0), zeros(8), u16(0), u16(0), u16(0), u16(0), MATRIX, u32(width << 16), u32(height << 16))
  const mdhd = box('mdhd', u32(0), u32(0), u32(0), u32(TIMESCALE), u32(0), u16(0x55c4), u16(0))
  const hdlr = box('hdlr', u32(0), u32(0), new TextEncoder().encode('vide'), zeros(12), new TextEncoder().encode('VideoHandler\0'))

  const avcC = box(
    'avcC',
    bytes(1, ps.sps[1], ps.sps[2], ps.sps[3], 0xff, 0xe1),
    u16(ps.sps.length),
    ps.sps,
    bytes(1),
    u16(ps.pps.length),
    ps.pps,
  )
  const avc1 = box(
    'avc1',
    zeros(6), u16(1), // reserved, data_reference_index
    u16(0), u16(0), zeros(12),
    u16(width), u16(height),
    u32(0x00480000), u32(0x00480000), u32(0),
    u16(1), zeros(32), u16(0x0018), u16(0xffff),
    avcC,
  )
  const stsd = box('stsd', u32(0), u32(1), avc1)
  const stbl = box('stbl', stsd, box('stts', u32(0), u32(0)), box('stsc', u32(0), u32(0)), box('stsz', u32(0), u32(0), u32(0)), box('stco', u32(0), u32(0)))
  const dinf = box('dinf', box('dref', u32(0), u32(1), box('url ', u32(1))))
  const minf = box('minf', box('vmhd', u32(1), zeros(8)), dinf, stbl)
  const mdia = box('mdia', mdhd, hdlr, minf)
  const trak = box('trak', tkhd, mdia)
  const mvex = box('mvex', box('trex', u32(0), u32(1), u32(1), u32(0), u32(0), u32(0)))
  const moov = box('moov', mvhd, trak, mvex)
  return concat([ftyp, moov])
}

/** 프레임 하나를 미디어 세그먼트(moof + mdat)로 만든다. SPS/PPS/AUD는 avcC에 있으므로 뺀다 */
export function mediaSegment(sequence: number, decodeTime: number, duration: number, units: Uint8Array[], isKey: boolean): Uint8Array {
  const samples = units.filter((u) => {
    const t = nalType(u)
    return t !== NAL_SPS && t !== NAL_PPS && t !== NAL_AUD
  })
  const mdatBody = concat(samples.flatMap((u) => [u32(u.length), u]))

  // 키 프레임: 다른 프레임에 의존하지 않음 / 그 외: 의존함 + 동기 샘플 아님
  const flags = isKey ? 0x02000000 : 0x01010000
  const build = (dataOffset: number) =>
    box(
      'moof',
      box('mfhd', u32(0), u32(sequence)),
      box(
        'traf',
        box('tfhd', u32(0x00020000), u32(1)), // default-base-is-moof
        box('tfdt', u32(0x01000000), u64(decodeTime)),
        box('trun', u32(0x00000701), u32(1), u32(dataOffset), u32(duration), u32(mdatBody.length), u32(flags)),
      ),
    )
  const size = build(0).length
  const moof = build(size + 8)
  return concat([moof, box('mdat', mdatBody)])
}
