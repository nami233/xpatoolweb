import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type { FrameDirection, FrameRecord } from '@shared/protocol/messages'

const HEX_PREVIEW_BYTES = 128
const MAX_ENTRIES = 500

export interface PacketEntry {
  id: number
  account: string
  direction: FrameDirection
  time: number
  cmdId: number
  name: string
  bodyLen: number
  upsn: string
  downsn: string
  err: number
  hex: string
  hexPreview: string
  text: string
}

const DEFAULT_FILTERS = ['CMD=5003', 'CMD=5004']

/** 包体前半段的十六进制（每字节两字符），用来做预览 / 文本探测的切片 */
function previewSegment(bodyHex: string): string {
  return bodyHex.slice(0, HEX_PREVIEW_BYTES * 2)
}

function toHexPreview(bodyHex: string): string {
  const segment = previewSegment(bodyHex)
  const group: string[] = []
  for (let i = 0; i < segment.length; i += 2) group.push(segment.slice(i, i + 2))
  return group.join(' ') + (bodyHex.length > segment.length ? ' ...' : '')
}

function toTextPreview(bodyHex: string): string {
  const segment = previewSegment(bodyHex)
  let text = ''
  for (let i = 0; i + 2 <= segment.length; i += 2) {
    const value = parseInt(segment.slice(i, i + 2), 16)
    text += value >= 0x20 && value <= 0x7e ? String.fromCharCode(value) : '.'
  }
  return text
}

export const usePacketLogStore = defineStore('packetLog', () => {
  const entries = ref<PacketEntry[]>([])
  const paused = ref(false)
  const filterEnabled = ref(true)
  const filters = ref<string[]>([...DEFAULT_FILTERS])
  const counters = ref({ send: 0, recv: 0, filtered: 0 })

  let nextId = 1

  function searchTextOf(entry: PacketEntry): string {
    return `CMD=${entry.cmdId} ${entry.name} ${entry.account} ${entry.hexPreview} ${entry.text}`
  }

  /**
   * 收一批帧。
   *
   * 帧在服务端已经解码过（命令名、SN、错误码都算好了），前端只做展示层的切片，
   * 所以不再需要本地的 `cmdName` / 35 字节包头。
   */
  function recordBatch(account: string, records: FrameRecord[]): void {
    for (const frame of records) {
      if (frame.direction === 'send') counters.value.send += 1
      else counters.value.recv += 1

      if (paused.value) continue

      const entry: PacketEntry = {
        id: nextId++,
        account,
        direction: frame.direction,
        time: frame.time,
        cmdId: frame.cmdId,
        name: frame.name,
        bodyLen: frame.bodyLen,
        upsn: frame.upsn,
        downsn: frame.downsn,
        err: frame.err,
        hex: frame.bodyHex,
        hexPreview: toHexPreview(frame.bodyHex),
        text: toTextPreview(frame.bodyHex),
      }

      if (filterEnabled.value) {
        const haystack = searchTextOf(entry)
        if (filters.value.some((rule) => rule.length > 0 && haystack.includes(rule))) {
          counters.value.filtered += 1
          continue
        }
      }

      entries.value.push(entry)
      if (entries.value.length > MAX_ENTRIES)
        entries.value.splice(0, entries.value.length - MAX_ENTRIES)
    }
  }

  function clear(): void {
    entries.value = []
    counters.value = { send: 0, recv: 0, filtered: 0 }
  }

  function addFilter(rule: string): void {
    const trimmed = rule.trim()
    if (trimmed.length === 0 || filters.value.includes(trimmed)) return
    filters.value.push(trimmed)
  }

  function removeFilter(index: number): void {
    filters.value.splice(index, 1)
  }

  function exportText(): string {
    const row: string[] = [
      `# xpatoolweb 抓包`,
      `# 导出时间: ${new Date().toLocaleString()}`,
      `# 条目: ${entries.value.length}  发送: ${counters.value.send}  接收: ${counters.value.recv}  已过滤: ${counters.value.filtered}`,
      `# 格式: <方向> <时间> [账号] CMD=<命令号> <命令名> 包体=<长度> SN=<UPSN>/<DOWNSN> ERR=<错误码>`,
      `#      下一行是完整包体十六进制（不含 35 字节包头）`,
      '',
    ]
    for (const entry of entries.value) {
      const time = new Date(entry.time).toLocaleTimeString()
      row.push(
        `${entry.direction === 'send' ? '发->' : '收<-'} ${time} [${entry.account}] CMD=${entry.cmdId} ${entry.name} 包体=${entry.bodyLen} SN=${entry.upsn}/${entry.downsn} ERR=${entry.err}`,
      )
      row.push(entry.hex)
    }
    return row.join('\n')
  }

  const total = computed(() => counters.value.send + counters.value.recv)

  return {
    entries,
    paused,
    filterEnabled,
    filters,
    counters,
    total,
    recordBatch,
    clear,
    addFilter,
    removeFilter,
    exportText,
  }
})