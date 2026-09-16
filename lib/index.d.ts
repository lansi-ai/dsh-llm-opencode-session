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
/** 插件名（roster 行的 id 应与之一致）。 */
export declare const name = "llm-opencode-session";
/** 无服务依赖：本插件只在出口层工作，不消费任何 ctx 服务。 */
export declare const inject: string[];
/** fetch 的最小签名（只用到调用面，避免把 undici 类型拖进来）。 */
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
/** 插件日志面（Cordis `ctx.logger` 的用到的两个方法；未提供时回落 console）。 */
export interface PluginLogger {
    info(message: string): void;
    warn(message: string, ...rest: unknown[]): void;
}
/** 插件上下文的最小面（只用 `effect` 与可选 `logger`，不拖 Cordis 类型进来）。 */
export interface PluginContext {
    effect(callback: () => (() => void) | void, label?: string): unknown;
    logger?: PluginLogger;
}
/**
 * 会话标签风格：
 * - `cjk`（默认）：`dsh-青竹aB` —— 中文意象词 + 2 字母，共 8 字符（控制在 8 字符内，
 *   使控制台按短 id 截断显示时仍完整可见）；
 * - `ascii`：`dsh-Kx7Q` —— 纯字母数字（网关若对非 ASCII 头值不友好时可用）。
 */
export type LabelStyle = 'cjk' | 'ascii';
/** 插件配置（roster 行的 `config` 段；全部可选）。 */
export interface PluginConfig {
    /** 会话标签风格（默认 `cjk`）。切换会使历史记录的关联断开（路由/缓存需重新预热）。 */
    labelStyle?: LabelStyle;
}
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
export declare function sessionLabel(source: string, style?: LabelStyle): string;
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
export declare function toHeaderValue(label: string): string;
/** 判定一个 URL 是否属 opencode 网关（导出供单测）。 */
export declare function isOpencodeRequestUrl(rawUrl: string): boolean;
/**
 * 该请求正文的「对话种子」：模型 id + 首条用户消息文本。
 *
 * 三种 wire 形状都覆盖：openai-completions / anthropic-messages 用 `messages`，
 * openai-responses 用 `input`。首条用户消息在整段对话里保持不变，故种子稳定。
 *
 * @param body 已解析的请求正文。
 * @returns 种子字符串；取不到时 undefined（调用方回退进程固定标签）。
 */
export declare function conversationSeed(body: unknown): string | undefined;
/**
 * 由请求正文派生会话标签。
 * @param body 已解析的请求正文。
 * @param style 标签风格（默认 `cjk`）。
 * @returns 形如 `dsh-青竹aB` 的标签；取不到种子时 undefined。
 */
export declare function conversationSessionId(body: unknown, style?: LabelStyle): string | undefined;
/**
 * 包装 fetch：只对 opencode 域注入会话头，其余请求原样透传（导出供单测）。
 *
 * @param inner 被包装的 fetch（生产为 `globalThis.fetch`）。
 * @param fallbackId 取不到对话种子时的固定标签（缺省按风格就地生成一次）。
 * @param logger 日志面（可缺省）。
 * @param style 标签风格（默认 `cjk`）。
 * @returns 包装后的 fetch。
 */
export declare function withOpencodeSessionHeader(inner: FetchLike, fallbackId?: string, logger?: PluginLogger, style?: LabelStyle): FetchLike;
/**
 * 安装全局 fetch 补丁（幂等）。
 *
 * @param logger 日志面（可缺省）。
 * @param config 插件配置（可缺省；见 {@link PluginConfig}）。
 * @returns 还原器（把 `globalThis.fetch` 换回原实现）。
 */
export declare function installOpencodeSessionHeader(logger?: PluginLogger, config?: PluginConfig): () => void;
/**
 * Cordis 插件入口：安装出口补丁，并把还原器交给 `ctx.effect`（卸载/热重载即还原）。
 *
 * 安装失败绝不抛出：宿主对任一未激活条目会回滚整棵插件树，「不缺头」这种小事不该让
 * 应用起不来。
 *
 * @param ctx 插件上下文。
 * @param config 插件配置（可缺省）。
 */
export declare function apply(ctx: PluginContext, config?: PluginConfig): void;
declare const _default: {
    name: string;
    inject: string[];
    apply: typeof apply;
};
export default _default;
