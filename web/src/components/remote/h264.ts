// H.264 Annex B 바이트 스트림 도우미 (에이전트가 보내는 형식)

export const NAL_IDR = 5
export const NAL_SPS = 7
export const NAL_PPS = 8
export const NAL_AUD = 9

/** 시작 코드(00 00 01 / 00 00 00 01)로 NAL 단위를 나눈다 (시작 코드 제외) */
export function splitNalUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = []
  let start = -1
  let i = 0
  while (i + 2 < data.length) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      if (start >= 0) {
        // 4바이트 시작 코드의 앞 0은 이전 NAL에 붙지 않게 잘라낸다
        let end = i
        if (end > start && data[end - 1] === 0) end--
        units.push(data.subarray(start, end))
      }
      i += 3
      start = i
    } else {
      i++
    }
  }
  if (start >= 0 && start < data.length) units.push(data.subarray(start))
  return units
}

export const nalType = (nal: Uint8Array) => nal[0] & 0x1f

const hex2 = (n: number) => n.toString(16).padStart(2, '0')

/** SPS에서 코덱 문자열(avc1.PPCCLL)을 만든다 */
export function codecString(sps: Uint8Array): string {
  return `avc1.${hex2(sps[1])}${hex2(sps[2])}${hex2(sps[3])}`
}

export interface ParameterSets {
  sps: Uint8Array
  pps: Uint8Array
}

/** 키 프레임에서 SPS/PPS를 꺼낸다 */
export function findParameterSets(units: Uint8Array[]): ParameterSets | null {
  const sps = units.find((u) => nalType(u) === NAL_SPS)
  const pps = units.find((u) => nalType(u) === NAL_PPS)
  return sps && pps ? { sps, pps } : null
}
