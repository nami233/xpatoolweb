/**
 * 用户脚本的落盘（单文件 `scripts.json`，见 `配置.数据目录`）。
 *
 * ```
 * { version: 1, script: { [username]: { [slotId]: '源码字符串' } } }
 * ```
 *
 * 按「用户名 → 槽位号」两层挂着 —— 槽位号就是游戏账号在用户记录里的 id，
 * 删账号时顺着它一起删（`服务器.办删游戏账号`），不会留下孤儿脚本。
 *
 * 与 `user/store.ts` 的两点不同：
 *  - **坏文件不当致命**：用户数据读不动会 `process.exit(1)`（洗掉就没了），
 *    脚本读不动只警告当空库 —— 大不了让用户重写一遍，不该拖垮整个后端。
 *  - 落盘结构更简单，没有会话那种独立顶级字段的需求。
 *
 * 两条硬规矩照抄用户存储：**原子写**（`.tmp` + rename）、**串行化**（一条 Promise 队列）。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { config, log } from '../config.ts'

interface PersistedData {
  version: number
  script: Record<string, Record<string, string>>
}

const structVersion = 1

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** 只留「用户名 → 槽位 → 字符串源码」这三层都对的项，别的一律丢 */
function collectScriptTable(value: unknown): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  if (!isObject(value)) return out
  for (const [username, bucket] of Object.entries(value)) {
    if (!isObject(bucket)) continue
    const SlotTable: Record<string, string> = {}
    for (const [slotId, source] of Object.entries(bucket)) {
      if (typeof source !== 'string') continue
      SlotTable[slotId] = source
    }
    if (Object.keys(SlotTable).length > 0) out[username] = SlotTable
  }
  return out
}

export class ScriptStore {
  readonly file: string
  private data: PersistedData = { version: structVersion, script: {} }
  private writeQueue: Promise<void> = Promise.resolve()

  constructor() {
    this.file = path.join(config.dataDir, 'scripts.json')
  }

  /** 启动时读一次。文件不在 / 读不动 / 不是 JSON，都只警告当空库 */
  async load(): Promise<void> {
    let rawText: string
    try {
      rawText = await fsp.readFile(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      log(`读不了脚本文件 ${this.file}，当空库继续跑:`, error instanceof Error ? error.message : error)
      return
    }
    try {
      const parse: unknown = JSON.parse(rawText)
      this.data = { version: structVersion, script: isObject(parse) ? collectScriptTable(parse.script) : {} }
    } catch (error) {
      log(`脚本文件 ${this.file} 不是合法 JSON，当空库继续跑:`, error instanceof Error ? error.message : error)
      return
    }
    let count = 0
    for (const bucket of Object.values(this.data.script)) count += Object.keys(bucket).length
    log(`已载入脚本 ${this.file}：${count} 份`)
  }

  /** 没存过回 undefined（与「存过但存的是空串」区分得开） */
  get(username: string, slot: number): string | undefined {
    return this.data.script[username]?.[String(slot)]
  }

  save(username: string, slot: number, source: string): void {
    const bucket = (this.data.script[username] ??= {})
    bucket[String(slot)] = source
    this.queuePersist()
  }

  remove(username: string, slot: number): void {
    const bucket = this.data.script[username]
    if (bucket === undefined) return
    if (bucket[String(slot)] === undefined) return
    delete bucket[String(slot)]
    if (Object.keys(bucket).length === 0) delete this.data.script[username]
    this.queuePersist()
  }

  // ---------------------------------------------------------------- 落盘

  /** 排队落盘。返回的 Promise 只用来串联队列，调用方不用等 */
  queuePersist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(() => this.persistOnce()).catch((error: unknown) => {
      log('脚本落盘失败:', error instanceof Error ? error.message : String(error))
    })
    return this.writeQueue
  }

  private async persistOnce(): Promise<void> {
    await fsp.mkdir(config.dataDir, { recursive: true })
    const tmp = `${this.file}.tmp`
    await fsp.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    // rename 是原子的：读者要么看到旧文件，要么看到新文件，不会看到半个
    await fsp.rename(tmp, this.file)
  }
}