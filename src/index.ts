/**
 * `dsh-llm-opencode-session` —— DSH 宿主插件：opencode 网关的逐会话会话头。
 *
 * **问题**：OpenCode Zen / Go（`https://opencode.ai/zen…`）要求客户端「为每段对话在
 * `x-opencode-session` 请求头中发送稳定的会话 ID」以便路由与提示缓存；缺失时上游直接
 * `400 {"type":"MissingSessionID"}`。
 *
 * DSH 侧只有官方 DeepSeek 适配器会发原生会话头（`x-deepseek-harness-session-id`）；
 * `@deepseek-ai/dsh-llm-pi-ai` 把 DSH 的逐会话 id 传到了 pi-ai（`options.sessionId`），
 * 却只把**静态**的 profile `headers` 发给请求 —— pi-ai 这一版不把会话 id 变成 opencode
 * 的头（上游在跟：earendil-works/pi#4847 / #4680 / #9290）。官方设置页也不暴露 `headers`
 * 字段，于是「网关要的请求头」在官方 UI 里无路可走。
 *
 * 本插件在**出口层**补上这一半，零上游改动：
 *   1. 只对 opencode 域（`opencode.ai` 及其子域）生效，其余请求原样透传；
 *   2. 请求**已带** `x-opencode-session`（用户在设置里静态配的，或上游将来自己发的）
 *      一律不覆盖 → 上游一旦修好，本插件自动退化为 no-op；
 *   3. **会话标签**（人类可读，便于在 opencode 控制台的「会话」列里认人）：默认
 *      `dsh-<中文2字><字母2>`（如 `dsh-青竹aB`，共 8 字符，短 id 截断显示也完整）；
 *      可配 `labelStyle: 'ascii'` 改成 `dsh-<4 字母>`。值由 `sha1(model + 该对话首条用户消息)`
 *      **确定性**派生 —— 同段对话内稳定、不同对话互不相同（官方明确该头 opaque：
 *      "any string works"，只要求稳定 + 唯一）；
 *   4. 无正文或非 JSON 的请求（例如模型列表探测）用本进程固定标签（只求稳定）；
 *   5. 每遇到一个**新标签**打印一行日志（便于把 DSH 会话与 opencode 控制台里的记录对上）。
 *
 * **为什么必须是出口层**：pi-ai 的三种 wire 协议都走 `options?.fetch ?? globalThis.fetch`，
 * 而 `dsh-llm-pi-ai` 不注入自定义 fetch（它给 pi-ai 的 options 里 headers 只有 profile 的
 * 静态头）；openai / @anthropic-ai 两 SDK 的 `getDefaultFetch()` 是**调用时**读全局
 * `fetch`，所以包装 `globalThis.fetch` 即可全覆盖，且无需触碰上游代码。
 *
 * **配置**（roster 行 `config` 段，均可选）：
 *   ```yaml
 *   - id: llm-opencode-session
 *     name: dsh-llm-opencode-session
 *     config:
 *       labelStyle: cjk   # cjk（默认）| ascii
 *   ```
 *   切换风格会改变标签 → 与历史记录的路由/缓存关联断开（会重新预热），非必要不切。
 *
 * **边界**：
 *   - 只读请求体的**克隆**（`request.clone()` / `init.body` 字符串），绝不消费原请求体；
 *   - 任何一步失败都回退「原样发送」（日志留痕），绝不因本插件让请求失败；
 *   - 首条用户消息若被压缩/摘要策略挤出上下文，该对话的标签会变化 → 提示缓存重新预热（可接受）；
 *   - 两段不同对话若首条用户消息完全相同（例如都只发「你好」），会共用一个标签。
 */

import { createHash, randomUUID } from 'node:crypto'

/** 插件名（roster 行的 id 应与之一致）。 */
export const name = 'llm-opencode-session'

/** 无服务依赖：本插件只在出口层工作，不消费任何 ctx 服务。 */
export const inject: string[] = []

/** 上游要求的会话头名。 */
const SESSION_HEADER = 'x-opencode-session'

/** 适用域：`opencode.ai` 与其子域（`zen.opencode.ai` 等）。 */
const OPENCODE_HOST = /(^|\.)opencode\.ai$/i

/** JSON 正文的 content-type（含 `application/vnd.x+json` 一类）。 */
const JSON_CONTENT_TYPE = /application\/(?:[a-z0-9.+-]*\+)?json/i

/** fetch 的最小签名（只用到调用面，避免把 undici 类型拖进来）。 */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** 插件日志面（Cordis `ctx.logger` 的用到的两个方法；未提供时回落 console）。 */
export interface PluginLogger {
  info(message: string): void
  warn(message: string, ...rest: unknown[]): void
}

/** 插件上下文的最小面（只用 `effect` 与可选 `logger`，不拖 Cordis 类型进来）。 */
export interface PluginContext {
  effect(callback: () => (() => void) | void, label?: string): unknown
  logger?: PluginLogger
}

const TAG = '[dsh-opencode]'

/**
 * 会话标签风格：
 * - `cjk`（默认）：`dsh-青竹aB` —— 中文意象词 + 2 字母，共 8 字符（控制在 8 字符内，
 *   使控制台按短 id 截断显示时仍完整可见）；
 * - `ascii`：`dsh-Kx7Q` —— 纯字母数字（网关若对非 ASCII 头值不友好时可用）。
 */
export type LabelStyle = 'cjk' | 'ascii'

/** 插件配置（roster 行的 `config` 段；全部可选）。 */
export interface PluginConfig {
  /** 会话标签风格（默认 `cjk`）。切换会使历史记录的关联断开（路由/缓存需重新预热）。 */
  labelStyle?: LabelStyle
}

/** 中文意象词表（确定性取自会话哈希，够多以避免同用户内碰撞）。 */
const SESSION_WORDS: readonly string[] = [
  '青竹', '白鹿', '赤松', '云雀', '星河', '墨砚', '松风', '竹影', '山岚', '惊鸿',
  '落霞', '秋水', '长庚', '启明', '兰亭', '沧海', '春江', '明月', '疏影', '暗香',
  '惊蛰', '谷雨', '小满', '白露', '寒山', '牧云', '听涛', '折桂', '拾光', '砚池',
  '鹤鸣', '鹿鸣', '望舒', '扶摇', '蝉鸣', '青岚', '远山', '孤舟', '新雨', '晓风',
  '霁月', '寒潭', '古渡', '长亭', '烟波', '渔火', '轻舟', '清泉', '空谷', '朝露',
]

/** ascii 标签的字母表（去掉易混的 l/I/O/0）。 */
const ASCII_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ'

/**
 * 由任意种子串派生**稳定且人类可读**的会话标签。
 *
 * 值只需「同对话稳定、不同对话不同」——官方明确说明该头是 opaque 的（"any string works"）。
 * 所以这里不做真随机：真随机会让同一段对话每轮换值，直接破坏路由亲和与提示缓存。
 *
 * @param source 种子串（对话种子、或进程固定 id）。
 * @param style 标签风格（默认 `cjk`）。
 * @returns 形如 `dsh-青竹aB` / `dsh-Kx7Q` 的标签。
 */
export function sessionLabel(source: string, style: LabelStyle = 'cjk'): string {
  const digest = createHash('sha1').update(source).digest()
  const first = digest[0] ?? 0
  const second = digest[1] ?? 0
  if (style === 'ascii') {
    let out = ''
    for (let index = 0; index < 4; index += 1) {
      out += ASCII_ALPHABET[(digest[index] ?? 0) % ASCII_ALPHABET.length]
    }
    return `dsh-${out}`
  }
  const word = SESSION_WORDS[((first << 8) | second) % SESSION_WORDS.length] ?? SESSION_WORDS[0]
  const letters = [digest[2] ?? 0, digest[3] ?? 0].map((byte) => ASCII_ALPHABET[byte % ASCII_ALPHABET.length]).join('')
  return `dsh-${word}${letters}`
}

/**
 * 把会话标签编成 `Headers.set` 可接受的 ByteString。
 *
 * Node/undici 的 `Headers.set` 只接受 ByteString（码元 ≤ 0xFF），直接写非 ASCII 会抛
 * `Cannot convert argument to a ByteString`。这里把标签的 **UTF-8 字节逐字节映射为 latin-1 码元**
 * —— undici 在线路上按字节写出，服务端收到的仍是原 UTF-8 字节（HTTP 头值规范允许 obs-text 0x80–0xFF）。
 * 纯 ASCII 标签原样返回。
 *
 * @param label 会话标签（如 `dsh-青竹aB`）。
 * @returns 可直接交给 `Headers.set` 的串。
 */
export function toHeaderValue(label: string): string {
  if (/^[\x20-\x7E]*$/.test(label)) return label
  return Buffer.from(label, 'utf8').toString('latin1')
}

/** 输出一行日志（plugin 自带 logger 优先，测试/裸跑回落到 console）。 */
function emit(logger: PluginLogger | undefined, level: 'info' | 'warn', message: string, error?: unknown): void {
  const sink = logger ?? console
  if (level === 'warn') sink.warn(message, ...(error === undefined ? [] : [error]))
  else sink.info(message)
}

/** 判定一个 URL 是否属 opencode 网关（导出供单测）。 */
export function isOpencodeRequestUrl(rawUrl: string): boolean {
  try {
    return OPENCODE_HOST.test(new URL(rawUrl).hostname)
  } catch {
    return false
  }
}

/** 从一段消息内容里取纯文本（兼容字符串 / 内容块数组 / `{text}` 对象）。 */
function contentText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map((item) => contentText(item)).join('')
  if (typeof value !== 'object' || value === null) return ''
  const record = value as Record<string, unknown>
  return contentText(record.text ?? record.content ?? '')
}

/**
 * 该请求正文的「对话种子」：模型 id + 首条用户消息文本。
 *
 * 三种 wire 形状都覆盖：openai-completions / anthropic-messages 用 `messages`，
 * openai-responses 用 `input`。首条用户消息在整段对话里保持不变，故种子稳定。
 *
 * @param body 已解析的请求正文。
 * @returns 种子字符串；取不到时 undefined（调用方回退进程固定标签）。
 */
export function conversationSeed(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined
  const record = body as Record<string, unknown>
  const model = typeof record.model === 'string' ? record.model : ''
  const list = Array.isArray(record.messages) ? record.messages : Array.isArray(record.input) ? record.input : []
  const messages = list as ReadonlyArray<Record<string, unknown> | string>
  const firstUser = messages.find((item) => typeof item === 'object' && item !== null && item.role === 'user') ?? messages[0]
  const text = contentText(firstUser)
  if (text.length === 0) return undefined
  // 截断：正文前缀足以区分对话，避免把长上下文整段喂进哈希。
  return `${model}\u0000${text.slice(0, 4096)}`
}

/**
 * 由请求正文派生会话标签。
 * @param body 已解析的请求正文。
 * @param style 标签风格（默认 `cjk`）。
 * @returns 形如 `dsh-青竹aB` 的标签；取不到种子时 undefined。
 */
export function conversationSessionId(body: unknown, style: LabelStyle = 'cjk'): string | undefined {
  const seed = conversationSeed(body)
  if (seed === undefined) return undefined
  return sessionLabel(seed, style)
}

/** 读请求体的克隆文本（绝不消费原请求体）；读不到返回 undefined。 */
async function requestBodyText(input: string | URL | Request, init?: RequestInit): Promise<string | undefined> {
  if (typeof init?.body === 'string') return init.body
  if (input instanceof Request) {
    if (input.body === null) return undefined
    const contentType = input.headers.get('content-type') ?? ''
    if (!JSON_CONTENT_TYPE.test(contentType)) return undefined
    try {
      return await input.clone().text()
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * 包装 fetch：只对 opencode 域注入会话头，其余请求原样透传（导出供单测）。
 *
 * @param inner 被包装的 fetch（生产为 `globalThis.fetch`）。
 * @param fallbackId 取不到对话种子时的固定标签（缺省按风格就地生成一次）。
 * @param logger 日志面（可缺省）。
 * @param style 标签风格（默认 `cjk`）。
 * @returns 包装后的 fetch。
 */
export function withOpencodeSessionHeader(
  inner: FetchLike,
  fallbackId?: string,
  logger?: PluginLogger,
  style: LabelStyle = 'cjk',
): FetchLike {
  const fallback = fallbackId ?? sessionLabel(randomUUID(), style)
  /** 已打印过的新会话标签（只报一次，避免每轮请求刷屏；上限防长跑进程无限增长）。 */
  const announced = new Set<string>()
  return async (input, init) => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (!isOpencodeRequestUrl(rawUrl)) return inner(input, init)
    // 已有该头（用户静态配置 / 上游自己发的）→ 不覆盖。
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
    if (headers.has(SESSION_HEADER)) return inner(input, init)
    let sessionId = fallback
    try {
      const text = await requestBodyText(input, init)
      if (text !== undefined) {
        const derived = conversationSessionId(JSON.parse(text), style)
        if (derived !== undefined) sessionId = derived
      }
    } catch (error) {
      emit(logger, 'warn', `${TAG} 会话标签派生失败，改用进程固定标签:`, error)
    }
    if (!announced.has(sessionId) && announced.size < 64) {
      announced.add(sessionId)
      emit(logger, 'info', `${TAG} 新会话 ${sessionId}（opencode 控制台「会话」列对应此值）`)
    }
    headers.set(SESSION_HEADER, toHeaderValue(sessionId))
    return inner(input, { ...init, headers })
  }
}

/** 当前已安装补丁的还原器（幂等安装；重复安装返回同一还原器）。 */
let installed: (() => void) | null = null

/**
 * 安装全局 fetch 补丁（幂等）。
 *
 * @param logger 日志面（可缺省）。
 * @param config 插件配置（可缺省；见 {@link PluginConfig}）。
 * @returns 还原器（把 `globalThis.fetch` 换回原实现）。
 */
export function installOpencodeSessionHeader(logger?: PluginLogger, config?: PluginConfig): () => void {
  if (installed !== null) return installed
  const original = globalThis.fetch
  if (typeof original !== 'function') {
    emit(logger, 'warn', `${TAG} 运行环境没有全局 fetch，opencode 会话头注入未安装`)
    return () => {}
  }
  const style: LabelStyle = config?.labelStyle === 'ascii' ? 'ascii' : 'cjk'
  const patched = withOpencodeSessionHeader(original as FetchLike, sessionLabel(randomUUID(), style), logger, style)
  globalThis.fetch = patched as typeof globalThis.fetch
  emit(
    logger,
    'info',
    `${TAG} opencode 会话头注入已安装（仅 opencode.ai 域；标签风格 ${style}；已带该头的请求不覆盖）`,
  )
  const restore = (): void => {
    if (globalThis.fetch === patched) globalThis.fetch = original
    installed = null
  }
  installed = restore
  return restore
}

/**
 * Cordis 插件入口：安装出口补丁，并把还原器交给 `ctx.effect`（卸载/热重载即还原）。
 *
 * 安装失败绝不抛出：宿主对任一未激活条目会回滚整棵插件树，「不缺头」这种小事不该让
 * 应用起不来。
 *
 * @param ctx 插件上下文。
 * @param config 插件配置（可缺省）。
 */
export function apply(ctx: PluginContext, config?: PluginConfig): void {
  try {
    ctx.effect(
      () => installOpencodeSessionHeader(ctx.logger, config),
      'llm-opencode-session: fetch header patch',
    )
  } catch (error) {
    emit(ctx.logger, 'warn', `${TAG} 插件装载失败，opencode 会话头注入未启用:`, error)
  }
}

export default { name, inject, apply }
