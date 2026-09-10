#!/usr/bin/env node
/**
 * 把 PNG 打印成 ASCII 灰度图（给「看不到图片」的会话用的眼睛）。
 *
 * 用途：判断品牌图里「图标本体」落在哪个区域（行/列范围），以便裁出托盘
 * template 图标。支持 8bit 灰度/RGB/RGBA、非隔行 PNG（本仓库 assets 全是这类）。
 *
 * 用法：node .dbg/png-ascii.mjs <file.png> [cols] [rows]
 *
 * @module .dbg/png-ascii
 */
import { readFileSync } from 'node:fs'
import { inflateSync } from 'node:zlib'

/** 读 PNG 的 IHDR（宽高/位深/颜色类型/隔行）。 */
function readHeader(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  const depth = buf[24]
  const colorType = buf[25]
  const interlace = buf[28]
  return { width, height, depth, colorType, interlace }
}

/** 收集所有 IDAT 并解压。 */
function readData(buf) {
  const chunks = []
  let offset = 8
  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const data = buf.subarray(offset + 8, offset + 8 + length)
    if (type === 'IDAT') chunks.push(data)
    offset += 12 + length
    if (type === 'IEND') break
  }
  return { raw: inflateSync(Buffer.concat(chunks)) }
}

/** 每通道字节数（按颜色类型推）。 */
function channels(colorType) {
  switch (colorType) {
    case 0: return 1
    case 2: return 3
    case 4: return 2
    case 6: return 4
    default: throw new Error(`unsupported colorType ${colorType}`)
  }
}

/** 反 filter（逐行，标准 PNG 五种 filter）。 */
function unfilter(raw, width, height, ch) {
  const stride = width * ch
  const out = Buffer.alloc(stride * height)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const cur = out.subarray(y * stride, (y + 1) * stride)
    const prev = y === 0 ? Buffer.alloc(stride) : out.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const a = x >= ch ? cur[x - ch] : 0
      const b = prev[x]
      const c = x >= ch ? prev[x - ch] : 0
      let value = line[x]
      if (filter === 1) value += a
      else if (filter === 2) value += b
      else if (filter === 3) value += (a + b) >> 1
      else if (filter === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a)
        const pb = Math.abs(p - b)
        const pc = Math.abs(p - c)
        value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      }
      cur[x] = value & 0xff
    }
  }
  return out
}

/** 解码为 {width,height,get(x,y)->{r,g,b,a}}。 */
export function decodePng(path) {
  const buf = readFileSync(path)
  const { width, height, depth, colorType, interlace } = readHeader(buf)
  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`)
  if (interlace !== 0) throw new Error('interlaced PNG unsupported')
  const ch = channels(colorType)
  const pixels = unfilter(readData(buf).raw, width, height, ch)
  const get = (x, y) => {
    const i = (y * width + x) * ch
    if (ch === 1) return { r: pixels[i], g: pixels[i], b: pixels[i], a: 255 }
    if (ch === 2) return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: 255 }
    if (ch === 4) return { r: pixels[i], g: pixels[i], b: pixels[i], a: pixels[i + 1] }
    return { r: pixels[i], g: pixels[i + 1], b: pixels[i + 2], a: pixels[i + 3] }
  }
  return { width, height, colorType, get }
}

/** 主入口：打印 ASCII 灰度图 + 每列/行的「非背景」占用统计。 */
function main() {
  const [path, colsArg, rowsArg, modeArg] = process.argv.slice(2)
  if (path === undefined) {
    process.stderr.write('usage: node .dbg/png-ascii.mjs <file.png> [cols] [rows]\n')
    process.exit(2)
  }
  const img = decodePng(path)
  const cols = Number(colsArg ?? 96)
  const rows = Number(rowsArg ?? 32)
  // 背景色 = 四角平均（品牌图多为纯色底或透明）。
  const corners = [img.get(0, 0), img.get(img.width - 1, 0), img.get(0, img.height - 1), img.get(img.width - 1, img.height - 1)]
  const bg = corners.reduce((acc, p) => ({ r: acc.r + p.r / 4, g: acc.g + p.g / 4, b: acc.b + p.b / 4, a: acc.a + p.a / 4 }), { r: 0, g: 0, b: 0, a: 0 })
  // 有 alpha 通道时：**不透明度就是「墨」**（透明底图，颜色常是白的或半透的）；
  // 无 alpha 时：与四角平均背景的色差才是墨。
  // `lum` 模式：直接打亮度 —— 截图（整幅半透明/带底色的画面）用这个，
  // 因为「相对背景的色差」在渐变色底上会把整幅都判成墨。
  const hasAlpha = img.colorType === 4 || img.colorType === 6
  const lumMode = modeArg === 'lum'
  const ramp = '@%#*+=-:. '
  const colUsed = new Array(cols).fill(0)
  const rowUsed = new Array(rows).fill(0)
  const lines = []
  for (let ry = 0; ry < rows; ry += 1) {
    let line = ''
    for (let rx = 0; rx < cols; rx += 1) {
      const x0 = Math.floor((rx * img.width) / cols)
      const x1 = Math.max(x0 + 1, Math.floor(((rx + 1) * img.width) / cols))
      const y0 = Math.floor((ry * img.height) / rows)
      const y1 = Math.max(y0 + 1, Math.floor(((ry + 1) * img.height) / rows))
      let diff = 0
      let n = 0
      for (let y = y0; y < y1; y += 1) {
        for (let x = x0; x < x1; x += 1) {
          const p = img.get(x, y)
          if (lumMode) diff += 0.299 * p.r + 0.587 * p.g + 0.114 * p.b
          else if (hasAlpha) diff += p.a
          else diff += Math.min(255, Math.abs(p.r - bg.r) + Math.abs(p.g - bg.g) + Math.abs(p.b - bg.b))
          n += 1
        }
      }
      const v = n === 0 ? 0 : diff / n
      if (v > 40) { colUsed[rx] += 1; rowUsed[ry] += 1 }
      line += ramp[Math.min(ramp.length - 1, Math.floor((v / 255) * ramp.length))]
    }
    lines.push(line)
  }
  process.stdout.write(`${path}  ${img.width}x${img.height} colorType=${img.colorType} hasAlpha=${hasAlpha} bg=rgba(${bg.r | 0},${bg.g | 0},${bg.b | 0},${bg.a | 0})\n`)
  process.stdout.write(`cols[0..${cols - 1}]  colScale=${(img.width / cols).toFixed(1)}px\n`)
  process.stdout.write(lines.join('\n') + '\n')
  const firstCol = colUsed.findIndex(v => v > 0)
  const lastCol = colUsed.length - 1 - [...colUsed].reverse().findIndex(v => v > 0)
  const firstRow = rowUsed.findIndex(v => v > 0)
  const lastRow = rowUsed.length - 1 - [...rowUsed].reverse().findIndex(v => v > 0)
  process.stdout.write(`ink cols ${firstCol}..${lastCol} → x ${(firstCol * img.width / cols) | 0}..${((lastCol + 1) * img.width / cols) | 0}px\n`)
  process.stdout.write(`ink rows ${firstRow}..${lastRow} → y ${(firstRow * img.height / rows) | 0}..${((lastRow + 1) * img.height / rows) | 0}px\n`)
  process.stdout.write(`emptyCols=${colUsed.filter(v => v === 0).length} emptyRows=${rowUsed.filter(v => v === 0).length}\n`)
}

if (import.meta.url === `file://${process.argv[1]}`) main()
