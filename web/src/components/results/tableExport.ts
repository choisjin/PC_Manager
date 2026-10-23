// 결과 확인의 표 내보내기: 클립보드(엑셀에 붙이면 칸마다) · 엑셀 파일(.xlsx)

// 앞자리 0이 없는 숫자만 엑셀이 숫자로 받게 두고, 나머지는 글자 그대로 (1/2 → 날짜, 007 → 7 같은 변환 막기)
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/

/**
 * 표 칸을 클립보드로: 엑셀에 붙이면 칸마다 들어가게 TSV와 HTML 표를 함께 넣는다.
 * http 접속에서도 되게 navigator.clipboard 대신 copy 이벤트로
 */
export function copyTable(lines: string[][]) {
  const tsv = lines.map((line) => line.map((v) => (/[\t\r\n"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join('\t')).join('\r\n')
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const td = (v: string) => (PLAIN_NUMBER.test(v) ? `<td>${v}</td>`
    : `<td style="mso-number-format:'\\@'">${esc(v).replace(/\r?\n/g, '<br style="mso-data-placement:same-cell">')}</td>`)
  const html = `<html><head><meta charset="utf-8"></head><body><table>${lines.map((line) => `<tr>${line.map(td).join('')}</tr>`).join('')}</table></body></html>`
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault()
    e.clipboardData?.setData('text/plain', tsv)
    e.clipboardData?.setData('text/html', html)
  }
  document.addEventListener('copy', onCopy)
  try {
    document.execCommand('copy')
  } finally {
    document.removeEventListener('copy', onCopy)
  }
}

// ─────────────────────────────── 엑셀 파일 (.xlsx)
// CSV는 엑셀이 '2026-10-02 13:12:34.183'을 날짜로 바꿔 초·밀리초를 숨겨서, 글자 칸을 지정할 수 있는 xlsx로 쓴다.
// 라이브러리 없이: 압축 없는(STORE) zip에 시트 하나

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

/** XML에 못 넣는 제어 문자는 빼고 이스케이프 */
const xmlText = (v: string) => [...v]
  .filter((ch) => ch >= ' ' || ch === '\t' || ch === '\n' || ch === '\r')
  .join('')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** 열 번호 → A, B, … Z, AA */
const columnName = (i: number): string => (i >= 26 ? columnName(Math.floor(i / 26) - 1) : '') + String.fromCharCode(65 + (i % 26))

/** 열 폭(글자 수): 한글 등 넓은 글자는 2칸 */
const textWidth = (v: string) => [...v].reduce((n, ch) => n + (ch.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)

/**
 * 첫 줄은 머리글(굵게, 틀 고정). 숫자는 숫자 칸, 나머지는 글자 칸.
 * 숫자는 소수 자릿수를 그대로 보이게(2.00이 2로 안 보이게): 소수 1·2·3자리 → 스타일 2·3·4
 */
function sheetXml(lines: string[][]) {
  const count = Math.max(0, ...lines.map((line) => line.length))
  const widths = Array.from({ length: count }, (_, c) =>
    Math.min(60, Math.max(6, ...lines.map((line) => textWidth(line[c] ?? '') + 2))))
  const rows = lines.map((line, r) => {
    const head = r === 0
    const cells = line.map((v, c) => {
      if (v === '') return ''
      const ref = `${columnName(c)}${r + 1}`
      if (!head && PLAIN_NUMBER.test(v)) {
        const decimals = Math.min(3, v.split('.')[1]?.length ?? 0)
        return `<c r="${ref}"${decimals ? ` s="${decimals + 1}"` : ''}><v>${v}</v></c>`
      }
      return `<c r="${ref}" t="inlineStr"${head ? ' s="1"' : ''}><is><t xml:space="preserve">${xmlText(v)}</t></is></c>`
    })
    return `<row r="${r + 1}">${cells.join('')}</row>`
  })
  return `${XML_HEAD}<worksheet xmlns="${MAIN_NS}">`
    + '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
    + (count ? `<cols>${widths.map((w, c) => `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '')
    + `<sheetData>${rows.join('')}</sheetData></worksheet>`
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Uint8Array) {
  let c = 0xffffffff
  for (const b of data) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 압축 없는 zip (이름은 UTF-8, 날짜는 1980-01-01) */
function storeZip(files: { name: string; text: string }[], type: string) {
  const enc = new TextEncoder()
  const body: Uint8Array<ArrayBuffer>[] = []
  const directory: Uint8Array<ArrayBuffer>[] = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const data = enc.encode(f.text)
    const crc = crc32(data)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(12, 0x21, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, data.length, true)
    local.setUint32(22, data.length, true)
    local.setUint16(26, name.length, true)
    body.push(new Uint8Array(local.buffer), name, data)
    const entry = new DataView(new ArrayBuffer(46))
    entry.setUint32(0, 0x02014b50, true)
    entry.setUint16(4, 20, true)
    entry.setUint16(6, 20, true)
    entry.setUint16(8, 0x0800, true)
    entry.setUint16(14, 0x21, true)
    entry.setUint32(16, crc, true)
    entry.setUint32(20, data.length, true)
    entry.setUint32(24, data.length, true)
    entry.setUint16(28, name.length, true)
    entry.setUint32(42, offset, true)
    directory.push(new Uint8Array(entry.buffer), name)
    offset += 30 + name.length + data.length
  }
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, files.length, true)
  end.setUint16(10, files.length, true)
  end.setUint32(12, directory.reduce((n, b) => n + b.length, 0), true)
  end.setUint32(16, offset, true)
  return new Blob([...body, ...directory, new Uint8Array(end.buffer)], { type })
}

/** 엑셀 파일로 받기: 시트 하나, 첫 줄은 머리글 */
export function downloadXlsx(fileName: string, sheetName: string, lines: string[][]) {
  // 시트 이름: 31자까지, \ / ? * [ ] : 는 못 쓴다
  const sheet = xmlText(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1')
  const blob = storeZip([
    {
      name: '[Content_Types].xml',
      text: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        + '</Types>',
    },
    {
      name: '_rels/.rels',
      text: `${XML_HEAD}<Relationships xmlns="${REL_NS}">`
        + `<Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      text: `${XML_HEAD}<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_REL}">`
        + `<sheets><sheet name="${sheet}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: `${XML_HEAD}<Relationships xmlns="${REL_NS}">`
        + `<Relationship Id="rId1" Type="${DOC_REL}/worksheet" Target="worksheets/sheet1.xml"/>`
        + `<Relationship Id="rId2" Type="${DOC_REL}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      // 스타일 0 = 보통, 1 = 굵게(머리글), 2·3·4 = 소수 1·2·3자리 (2는 엑셀 기본 0.00)
      name: 'xl/styles.xml',
      text: `${XML_HEAD}<styleSheet xmlns="${MAIN_NS}">`
        + '<numFmts count="2"><numFmt numFmtId="164" formatCode="0.0"/><numFmt numFmtId="165" formatCode="0.000"/></numFmts>'
        + '<fonts count="2"><font><sz val="11"/><name val="맑은 고딕"/></font><font><b/><sz val="11"/><name val="맑은 고딕"/></font></fonts>'
        + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
        + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        + '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
        + '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
        + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
        + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        + '</styleSheet>',
    },
    { name: 'xl/worksheets/sheet1.xml', text: sheetXml(lines) },
  ], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
