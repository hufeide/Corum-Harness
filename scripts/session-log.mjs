// corum 会话日志读取（共享模块）
//
// 关键事实：会话日志 `<home>/sessions/<slug>/<sid>/session.v2.jsonl.zstd` 是**多 frame
// 追加**写的 zstd 流（每次 flush 一个 frame）。Node 的 `zstdDecompressSync` 只解第一个
// frame —— 直接用它读会静默拿到「1 条事件」，把整轮监督结论带偏（本模块诞生的原因）。
// 因此这里按 zstd 帧结构逐帧切分并解压，不依赖外部 zstd 二进制；尾部若有半截 frame
// （应用正在写）则丢弃该帧，前面的照常返回。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

// 磁盘字节序为 28 B5 2F FD；按小端读成 u32 即 0xFD2FB528
const MAGIC = 0xfd2fb528

/** 一个 zstd frame 的总字节数（`0` = 结构非法/不完整）。 */
function frameSize(buf, off) {
  let p = off + 4
  if (p >= buf.length) return 0
  const fhd = buf[p++]
  const fcsFlag = fhd >> 6
  const singleSegment = (fhd >> 5) & 1
  const checksum = (fhd >> 2) & 1
  p += [0, 1, 2, 4][fhd & 3] // Dictionary_ID
  if (!singleSegment) p += 1 // Window_Descriptor
  p += fcsFlag === 0 ? (singleSegment ? 1 : 0) : fcsFlag === 1 ? 2 : fcsFlag === 2 ? 4 : 8
  for (;;) {
    if (p + 3 > buf.length) return 0
    const h = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = h & 1
    const type = (h >> 1) & 3
    const size = h >> 3
    if (type === 3) return 0 // Reserved
    p += type === 1 ? 1 : size // RLE = 1 字节；Raw/Compressed = size 字节
    if (last) break
    if (p > buf.length) return 0
  }
  if (checksum) p += 4
  return p - off
}

/** 解出整份日志文本（所有 frame 拼接）。返回 { text, frames, bytes, truncated }。 */
export function readSessionText(fp) {
  const buf = readFileSync(fp)
  const parts = []
  let off = 0
  let frames = 0
  let truncated = false
  while (off + 4 <= buf.length) {
    let i = off
    while (i + 4 <= buf.length && buf.readUInt32LE(i) !== MAGIC) i++
    if (i + 4 > buf.length) break
    const len = frameSize(buf, i)
    if (!len || i + len > buf.length) {
      // 尾部半截 frame：能解就收下，不能解就丢
      try {
        parts.push(zstdDecompressSync(buf.subarray(i)))
      } catch {
        truncated = true
      }
      break
    }
    parts.push(zstdDecompressSync(buf.subarray(i, i + len)))
    frames++
    off = i + len
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames, bytes: buf.length, truncated }
}

/** 会话日志行（已解析的 JSON 事件），解析失败的行被丢弃。 */
export function loadSessionLog(fp) {
  const { text, frames, bytes, truncated } = readSessionText(fp)
  const rows = text
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
  return { rows, frames, bytes, truncated }
}

/** 列出 <home>/sessions 下所有会话日志，按最后写入时间倒序。 */
export function collectSessions(home) {
  const root = join(home, 'sessions')
  const out = []
  let projects
  try {
    projects = readdirSync(root)
  } catch {
    const e = new Error(`读不到会话目录：${root}（用 --home 指向 dev-home / verify-home）`)
    e.code = 'ENOSESSIONS'
    throw e
  }
  for (const proj of projects) {
    const p = join(root, proj)
    if (!statSync(p).isDirectory()) continue
    for (const sid of readdirSync(p)) {
      const d = join(p, sid)
      let file
      try {
        file = readdirSync(d).find((n) => n.endsWith('.jsonl.zstd'))
      } catch {
        continue
      }
      if (!file) continue
      const fp = join(d, file)
      out.push({ fp, sid, proj: proj.slice(0, 46), mtime: statSync(fp).mtimeMs })
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime)
}
