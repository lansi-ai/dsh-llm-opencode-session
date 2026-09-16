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
 *   3. 会话 ID = `dsh-` + `sha1(model + 该对话首条用户消息)` 前 32 位 —— **同段对话内稳定、
 *      不同对话互不相同**（对齐「per conversation, stable」的口径）；
 *   4. 无正文或非 JSON 的请求（例如模型列表探测）用本进程固定 id（只求稳定）。
 *
 * **为什么必须是出口层**：pi-ai 的三种 wire 协议都走 `options?.fetch ?? globalThis.fetch`，
 * 而 `dsh-llm-pi-ai` 不注入自定义 fetch（它给 pi-ai 的 options 里 headers 只有 profile 的
 * 静态头）；openai / @anthropic-ai 两 SDK 的 `getDefaultFetch()` 是**调用时**读全局
 * `fetch`，所以包装 `globalThis.fetch` 即可全覆盖，且无需触碰上游代码。
 *
 * **边界**：
 *   - 只读请求体的**克隆**（`request.clone()` / `init.body` 字符串），绝不消费原请求体；
 *   - 任何一步失败都回退「原样发送」（日志留痕），绝不因本插件让请求失败；
 *   - 首条用户消息若被压缩/摘要策略挤出上下文，该对话的 ID 会变化 → 提示缓存重新预热（可接受）；
 *   - 两段不同对话若首条用户消息完全相同（例如都只发「你好」），会共用一个会话 ID。
 */
import { createHash, randomUUID } from 'node:crypto';
/** 插件名（roster 行的 id 应与之一致）。 */
export const name = 'llm-opencode-session';
/** 无服务依赖：本插件只在出口层工作，不消费任何 ctx 服务。 */
export const inject = [];
/** 上游要求的会话头名。 */
const SESSION_HEADER = 'x-opencode-session';
/** 适用域：`opencode.ai` 与其子域（`zen.opencode.ai` 等）。 */
const OPENCODE_HOST = /(^|\.)opencode\.ai$/i;
/** JSON 正文的 content-type（含 `application/vnd.x+json` 一类）。 */
const JSON_CONTENT_TYPE = /application\/(?:[a-z0-9.+-]*\+)?json/i;
const TAG = '[dsh-opencode]';
/** 输出一行日志（plugin 自带 logger 优先，测试/裸跑回落到 console）。 */
function emit(logger, level, message, error) {
    const sink = logger ?? console;
    if (level === 'warn')
        sink.warn(message, ...(error === undefined ? [] : [error]));
    else
        sink.info(message);
}
/** 判定一个 URL 是否属 opencode 网关（导出供单测）。 */
export function isOpencodeRequestUrl(rawUrl) {
    try {
        return OPENCODE_HOST.test(new URL(rawUrl).hostname);
    }
    catch {
        return false;
    }
}
/** 从一段消息内容里取纯文本（兼容字符串 / 内容块数组 / `{text}` 对象）。 */
function contentText(value) {
    if (typeof value === 'string')
        return value;
    if (Array.isArray(value))
        return value.map((item) => contentText(item)).join('');
    if (typeof value !== 'object' || value === null)
        return '';
    const record = value;
    return contentText(record.text ?? record.content ?? '');
}
/**
 * 该请求正文的「对话种子」：模型 id + 首条用户消息文本。
 *
 * 三种 wire 形状都覆盖：openai-completions / anthropic-messages 用 `messages`，
 * openai-responses 用 `input`。首条用户消息在整段对话里保持不变，故种子稳定。
 *
 * @param body 已解析的请求正文。
 * @returns 种子字符串；取不到时 undefined（调用方回退进程固定 id）。
 */
export function conversationSeed(body) {
    if (typeof body !== 'object' || body === null)
        return undefined;
    const record = body;
    const model = typeof record.model === 'string' ? record.model : '';
    const list = Array.isArray(record.messages) ? record.messages : Array.isArray(record.input) ? record.input : [];
    const messages = list;
    const firstUser = messages.find((item) => typeof item === 'object' && item !== null && item.role === 'user') ?? messages[0];
    const text = contentText(firstUser);
    if (text.length === 0)
        return undefined;
    // 截断：正文前缀足以区分对话，避免把长上下文整段喂进哈希。
    return `${model}\u0000${text.slice(0, 4096)}`;
}
/**
 * 由请求正文派生会话 ID。
 * @param body 已解析的请求正文。
 * @returns `dsh-<32 hex>`；取不到种子时 undefined。
 */
export function conversationSessionId(body) {
    const seed = conversationSeed(body);
    if (seed === undefined)
        return undefined;
    return `dsh-${createHash('sha1').update(seed).digest('hex').slice(0, 32)}`;
}
/** 读请求体的克隆文本（绝不消费原请求体）；读不到返回 undefined。 */
async function requestBodyText(input, init) {
    if (typeof init?.body === 'string')
        return init.body;
    if (input instanceof Request) {
        if (input.body === null)
            return undefined;
        const contentType = input.headers.get('content-type') ?? '';
        if (!JSON_CONTENT_TYPE.test(contentType))
            return undefined;
        try {
            return await input.clone().text();
        }
        catch {
            return undefined;
        }
    }
    return undefined;
}
/**
 * 包装 fetch：只对 opencode 域注入会话头，其余请求原样透传（导出供单测）。
 *
 * @param inner 被包装的 fetch（生产为 `globalThis.fetch`）。
 * @param fallbackId 取不到对话种子时的固定 id（默认本进程生成一次）。
 * @param logger 日志面（可缺省）。
 * @returns 包装后的 fetch。
 */
export function withOpencodeSessionHeader(inner, fallbackId = `dsh-${randomUUID()}`, logger) {
    return async (input, init) => {
        const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!isOpencodeRequestUrl(rawUrl))
            return inner(input, init);
        // 已有该头（用户静态配置 / 上游自己发的）→ 不覆盖。
        const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
        if (headers.has(SESSION_HEADER))
            return inner(input, init);
        let sessionId = fallbackId;
        try {
            const text = await requestBodyText(input, init);
            if (text !== undefined) {
                const derived = conversationSessionId(JSON.parse(text));
                if (derived !== undefined)
                    sessionId = derived;
            }
        }
        catch (error) {
            emit(logger, 'warn', `${TAG} 会话 ID 派生失败，改用进程固定 id:`, error);
        }
        headers.set(SESSION_HEADER, sessionId);
        return inner(input, { ...init, headers });
    };
}
/** 当前已安装补丁的还原器（幂等安装；重复安装返回同一还原器）。 */
let installed = null;
/**
 * 安装全局 fetch 补丁（幂等）。
 *
 * @param logger 日志面（可缺省）。
 * @returns 还原器（把 `globalThis.fetch` 换回原实现）。
 */
export function installOpencodeSessionHeader(logger) {
    if (installed !== null)
        return installed;
    const original = globalThis.fetch;
    if (typeof original !== 'function') {
        emit(logger, 'warn', `${TAG} 运行环境没有全局 fetch，opencode 会话头注入未安装`);
        return () => { };
    }
    const patched = withOpencodeSessionHeader(original, `dsh-${randomUUID()}`, logger);
    globalThis.fetch = patched;
    emit(logger, 'info', `${TAG} opencode 会话头注入已安装（仅 opencode.ai 域；已带该头的请求不覆盖）`);
    const restore = () => {
        if (globalThis.fetch === patched)
            globalThis.fetch = original;
        installed = null;
    };
    installed = restore;
    return restore;
}
/**
 * Cordis 插件入口：安装出口补丁，并把还原器交给 `ctx.effect`（卸载/热重载即还原）。
 *
 * 安装失败绝不抛出：宿主对任一未激活条目会回滚整棵插件树，「不缺头」这种小事不该让
 * 应用起不来。
 *
 * @param ctx 插件上下文。
 */
export function apply(ctx) {
    try {
        ctx.effect(() => installOpencodeSessionHeader(ctx.logger), 'llm-opencode-session: fetch header patch');
    }
    catch (error) {
        emit(ctx.logger, 'warn', `${TAG} 插件装载失败，opencode 会话头注入未启用:`, error);
    }
}
export default { name, inject, apply };
