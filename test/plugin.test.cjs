/**
 * `dsh-llm-opencode-session` 的行为断言（`node --test` 语义，零依赖，直接跑：
 * `npm test` 或 `node test/plugin.test.cjs`）。
 *
 * 与生产共用同一份 `lib/` 产物（不复制实现）。覆盖三层：
 *   1. 纯函数（域判定 / 对话种子 / 会话 ID 稳定性）；
 *   2. 出口注入（只对 opencode 域、不消费请求体、已带头不覆盖、无正文兜底、错误冒泡）；
 *   3. 插件契约（Loader 需要的 name/inject/apply + `ctx.effect` 生命周期 + 不冒泡）。
 */
'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ENTRY = path.join(__dirname, '..', 'lib', 'index.js')
const plugin = require(ENTRY)
const { isOpencodeRequestUrl, conversationSeed, conversationSessionId, sessionLabel, toHeaderValue, withOpencodeSessionHeader, installOpencodeSessionHeader, apply } = plugin

/** 记录调用并回 200 的假 fetch。 */
function recorder(response = { ok: true }) {
  const calls = []
  const inner = async (input, init) => {
    // 模拟真实 fetch 语义：init.headers 覆盖 Request 自带的头。
    const request = new Request(input, init)
    calls.push({ header: request.headers.get('x-opencode-session'), body: await request.clone().text() })
    return response
  }
  return { calls, inner }
}

const OPENCODE_URL = 'https://opencode.ai/zen/go/v1/chat/completions'
const OTHER_URL = 'https://api.deepseek.com/chat/completions'

/** 构造一个 openai-completions 形状的对话正文（首条 user 消息决定会话 id）。 */
function chatBody(firstUser, extra = []) {
  return JSON.stringify({
    model: 'kimi-k3',
    messages: [
      { role: 'system', content: 'you are a coding agent' },
      { role: 'user', content: firstUser },
      ...extra,
    ],
  })
}

test('isOpencodeRequestUrl：opencode.ai 与其子域命中，仿冒域与非法 URL 不命中', () => {
  assert.equal(isOpencodeRequestUrl('https://opencode.ai/zen/go'), true)
  assert.equal(isOpencodeRequestUrl('https://zen.opencode.ai/v1/messages'), true)
  assert.equal(isOpencodeRequestUrl('https://api.deepseek.com/v1'), false)
  assert.equal(isOpencodeRequestUrl('https://opencode.ai.evil.example/v1'), false)
  assert.equal(isOpencodeRequestUrl('not a url'), false)
})

test('conversationSeed：三种 wire 形状都取首条用户消息，取不到返回 undefined', () => {
  assert.equal(conversationSeed(JSON.parse(chatBody('第一个问题'))), 'kimi-k3\u0000第一个问题')
  assert.equal(conversationSeed({ model: 'gpt-5.6-luna', input: [{ role: 'user', content: [{ type: 'input_text', text: '你好' }] }] }), 'gpt-5.6-luna\u0000你好')
  assert.equal(conversationSeed({ model: 'minimax-m3', messages: [{ role: 'user', content: [{ type: 'text', text: '块文本' }] }] }), 'minimax-m3\u0000块文本')
  assert.equal(conversationSeed({ model: 'x', messages: [] }), undefined)
  assert.equal(conversationSeed(null), undefined)
})

test('conversationSessionId：标签为「dsh-中文2字+字母2」，同对话稳定、不同对话不同', () => {
  const first = conversationSessionId(JSON.parse(chatBody('第一个问题')))
  assert.match(first, /^dsh-[\u4e00-\u9fff]{2}[A-Za-z]{2}$/)
  assert.equal(first.length, 8, '控制在 8 字符内，短 id 截断显示时完整可见')
  const second = conversationSessionId(JSON.parse(chatBody('第一个问题', [{ role: 'assistant', content: '答' }, { role: 'user', content: '追问' }])))
  assert.equal(second, first)
  assert.notEqual(conversationSessionId(JSON.parse(chatBody('另一个问题'))), first)
  assert.equal(conversationSessionId({ model: 'x', messages: [] }), undefined)
  // ascii 风格：纯字母数字，同样稳定
  const ascii = conversationSessionId(JSON.parse(chatBody('第一个问题')), 'ascii')
  assert.match(ascii, /^dsh-[A-Za-z]{4}$/)
  assert.equal(conversationSessionId(JSON.parse(chatBody('第一个问题')), 'ascii'), ascii)
})

test('sessionLabel：确定性、人可读、风格可切', () => {
  assert.equal(sessionLabel('same-seed'), sessionLabel('same-seed'))
  assert.notEqual(sessionLabel('seed-a'), sessionLabel('seed-b'))
  assert.match(sessionLabel('seed-a'), /^dsh-[\u4e00-\u9fff]{2}[A-Za-z]{2}$/)
  assert.match(sessionLabel('seed-a', 'ascii'), /^dsh-[A-Za-z]{4}$/)
  // 字母表去掉了易混字符，便于口头/肉眼辨认
  assert.equal(/[lIO0]/.test(sessionLabel('seed-a', 'ascii').slice(4)), false)
})

/** 读回记录到的头值：wire 上是 UTF-8 字节按 latin-1 逐字节承载的串，解回可读标签。 */
function decodeHeader(value) {
  return Buffer.from(String(value), 'latin1').toString('utf8')
}

test('toHeaderValue：非 ASCII 标签编成 ByteString（wire 仍是 UTF-8 字节），ASCII 原样', () => {
  const label = 'dsh-青竹aB'
  const wire = toHeaderValue(label)
  assert.equal(wire.split('').every((ch) => ch.charCodeAt(0) <= 255), true, '不得含 >255 的码元')
  assert.equal(Buffer.from(wire, 'latin1').toString('utf8'), label, 'latin1 解回应还原标签')
  assert.equal(toHeaderValue('dsh-Kx7Q'), 'dsh-Kx7Q', '纯 ASCII 原样返回')
})

test('注入：非 opencode 域原样透传，opencode 域按对话注入且不消费请求体', async () => {
  const { calls, inner } = recorder()
  const fetchImpl = withOpencodeSessionHeader(inner, 'dsh-fallback')

  await fetchImpl(OTHER_URL, { method: 'POST', body: chatBody('无关请求') })
  assert.equal(calls[0].header, null, '非 opencode 域不应注入')

  await fetchImpl(OPENCODE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('第一个问题') })
  const injected = calls[1]
  assert.match(decodeHeader(injected.header), /^dsh-[\u4e00-\u9fff]{2}[A-Za-z]{2}$/)
  assert.equal(injected.body, chatBody('第一个问题'), '下游仍应读到完整请求体')

  await fetchImpl(OPENCODE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('第一个问题', [{ role: 'assistant', content: '答' }, { role: 'user', content: '追问' }]) })
  assert.equal(calls[2].header, injected.header, '同对话下一轮应同 ID')
  await fetchImpl(OPENCODE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('另一个问题') })
  assert.notEqual(calls[3].header, injected.header, '另一对话应不同 ID')
})

test('注入：Request 形态同样生效（克隆读体，不消费原请求）', async () => {
  const { calls, inner } = recorder()
  const fetchImpl = withOpencodeSessionHeader(inner, 'dsh-fallback')
  const request = new Request(OPENCODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: chatBody('Request 形态'),
  })
  await fetchImpl(request)
  assert.match(decodeHeader(calls[0].header), /^dsh-[\u4e00-\u9fff]{2}[A-Za-z]{2}$/)
  assert.equal(calls[0].body, chatBody('Request 形态'))
})

test('注入：已带该头不覆盖（自退役）、无正文用进程固定 id、非 JSON 正文也兜底', async () => {
  const { calls, inner } = recorder()
  const fetchImpl = withOpencodeSessionHeader(inner, 'dsh-fallback')

  await fetchImpl(OPENCODE_URL, { method: 'POST', headers: { 'x-opencode-session': 'user-set', 'content-type': 'application/json' }, body: chatBody('用户已配') })
  assert.equal(calls[0].header, 'user-set', '用户静态配置应优先')

  await fetchImpl('https://opencode.ai/zen/go/v1/models', { method: 'GET' })
  assert.equal(calls[1].header, 'dsh-fallback', '无正文请求用进程固定 id')

  await fetchImpl(OPENCODE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"x","messages":[{"role":"user","content":"ok"}]}' })
  assert.notEqual(calls[2].header, 'dsh-fallback', '可派生时不应使用兜底 id')
})

test('注入：下游抛错原样冒泡（本插件不改写失败语义）', async () => {
  const inner = async () => {
    throw new Error('upstream boom')
  }
  const fetchImpl = withOpencodeSessionHeader(inner)
  await assert.rejects(() => fetchImpl(OPENCODE_URL, { method: 'POST', body: chatBody('x') }), /upstream boom/)
})

test('install：装到 globalThis.fetch 上、幂等、可还原', async () => {
  const original = globalThis.fetch
  const { calls, inner } = recorder()
  globalThis.fetch = inner
  try {
    const restore = installOpencodeSessionHeader()
    assert.notEqual(globalThis.fetch, inner, '应已替换 globalThis.fetch')
    assert.equal(installOpencodeSessionHeader(), restore, '重复安装应返回同一还原器')
    await globalThis.fetch(OPENCODE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('装到全局') })
    assert.match(decodeHeader(calls[0].header), /^dsh-[\u4e00-\u9fff]{2}[A-Za-z]{2}$/)
    restore()
    assert.equal(globalThis.fetch, inner, '还原后应回到原实现')
  } finally {
    globalThis.fetch = original
  }
})

test('装载契约：dynamic import 能拿到 name / inject / apply（Loader 激活判据）', async () => {
  const mod = await import(pathToFileURL(ENTRY).href)
  assert.equal(mod.name, 'llm-opencode-session', '入口应导出 name，且与 roster 行 id 一致')
  assert.ok(Array.isArray(mod.inject), '入口应导出 inject 数组')
  assert.equal(typeof mod.apply, 'function', '入口应导出 apply')
  assert.equal(typeof mod.default, 'object', '应有 default 导出兜底其它装载路径')
})

test('apply：经 ctx.effect 安装补丁，卸载即还原；effect 抛错不冒泡', async () => {
  const original = globalThis.fetch
  const { calls, inner } = recorder()
  globalThis.fetch = inner
  let cleanup = null
  try {
    apply({ effect: (callback) => { cleanup = callback() }, logger: { info: () => {}, warn: () => {} } })
    assert.notEqual(globalThis.fetch, inner, 'apply 应已安装补丁')
    await globalThis.fetch(OPENCODE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: chatBody('插件装载') })
    assert.match(decodeHeader(calls[0].header), /^dsh-[\u4e00-\u9fff]{2}[A-Za-z]{2}$/)
    cleanup()
    assert.equal(globalThis.fetch, inner, '卸载后应还原')
  } finally {
    globalThis.fetch = original
  }
  assert.doesNotThrow(() => apply({
    effect: () => {
      throw new Error('boom')
    },
    logger: { info: () => {}, warn: () => {} },
  }))
})
