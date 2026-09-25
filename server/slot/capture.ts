/**
 * 槽位的抓包帧环形缓冲 + 落盘。
 *
 * 帧记录就是 `shared/protocol/states.ts` 的 `帧记录`：`bodyHex` 是完整包体十六进制
 * （不含 35 字节包头），前端的 hex 预览 / 导出都从这里切字节，所以服务端只给 hex。
 * 落盘部分移植自 `server/index.mjs:328-352`，文本格式对齐 `src/stores/packetLog.ts` 的 `exportText`。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { Frame } from '../net/frame.ts'
import { cmdName } from '../net/cmds.ts'
import { bytesToHex } from '../../shared/protocol/jsonSafe.ts'
import type { FrameDirection, FrameRecord } from '../../shared/protocol/states.ts'

export function makeFrameRecord(direction: FrameDirection, frame: Frame): FrameRecord {
  return {
    direction: direction,
    time: Date.now(),
    cmdId: frame.cmdId,
    name: cmdName(frame.cmdId),
    bodyLen: frame.body.length,
    // upsn/downsn 是 bigint，走 JSON 只能是字符串
    upsn: frame.upsn.toString(),
    downsn: frame.downsn.toString(),
    err: frame.err,
    bodyHex: bytesToHex(frame.body),
  }
}

export class frameRing {
  private readonly entries: FrameRecord[] = []
  /** 曾经进过环的帧总数，单调递增：连接侧的游标就是这个计数 */
  private accumulated = 0
  private readonly limit: number

  constructor(limit: number) {
    this.limit = Math.max(1, limit)
  }

  get total(): number {
    return this.accumulated
  }

  push(record: FrameRecord): void {
    this.entries.push(record)
    this.accumulated += 1
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit)
  }

  /** 取出「第 已发计数 条之后」的帧；环里已被挤掉的旧帧直接跳过 */
  takeFrom(sentCount: number): FrameRecord[] {
    const earliestCount = this.accumulated - this.entries.length
    const startNode = Math.max(sentCount, earliestCount) - earliestCount
    return this.entries.slice(Math.max(0, startNode))
  }

  pendingCount(sentCount: number): number {
    const earliestCount = this.accumulated - this.entries.length
    return this.accumulated - Math.max(sentCount, earliestCount)
  }

  all(): FrameRecord[] {
    return [...this.entries]
  }

  clear(): void {
    this.entries.length = 0
  }
}

/** 导出文本格式与前端 `packetLog.exportText` 保持一致，方便两边对照 */
export function captureText(entries: FrameRecord[]): string {
  const row: string[] = [
    '# xpatoolweb 抓包',
    `# 导出时间: ${new Date().toLocaleString()}`,
    `# 条目: ${entries.length}`,
    '# 格式: <方向> <时间> [账号] CMD=<命令号> <命令名> 包体=<长度> SN=<UPSN>/<DOWNSN> ERR=<错误码>',
    '#      下一行是完整包体十六进制（不含 35 字节包头）',
    '',
  ]
  for (const entry of entries) {
    row.push(
      `${entry.direction === 'send' ? '发->' : '收<-'} ${new Date(entry.time).toLocaleTimeString()}`
        + ` CMD=${entry.cmdId} ${entry.name} 包体=${entry.bodyLen} SN=${entry.upsn}/${entry.downsn} ERR=${entry.err}`,
    )
    row.push(entry.bodyHex)
  }
  return row.join('\n')
}

export function saveCaptureFile(dir: string, text: string): { ok: boolean; path?: string; message?: string } {
  if (text.length === 0) return { ok: false, message: '没有内容可保存' }
  try {
    fs.mkdirSync(dir, { recursive: true })
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const file = path.join(dir, `capture-${timestamp}.txt`)
    fs.writeFileSync(file, text, 'utf8')
    return { ok: true, path: file }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) }
  }
}