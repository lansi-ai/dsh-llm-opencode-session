# dsh-llm-opencode-session

让 DSH / DSH Forge 用 **OpenCode Zen / Go** 时不报 `400 MissingSessionID` 的宿主插件。

```text
OpenCode 要求「每段对话」带一个稳定的 x-opencode-session 头
        ↓  上游 pi-ai 这一版还没发它（官方设置页也不暴露请求头）
本插件在出口层补上：同一段对话稳定、不同对话不同
```

## 它解决什么

用 `https://opencode.ai/zen/go`（OpenCode Go）或 `https://opencode.ai/zen`（Zen）当模型路由时，
上游会拒绝没有会话头的请求：

```json
400: {"type":"MissingSessionID","message":"Error from provider (Console Go): Request is missing x-opencode-session and cannot be routed efficiently. ..."}
```

OpenCode 的文档（Go → *Where can I use it?*）要求客户端**为每段对话在 `x-opencode-session`
请求头中发送稳定的会话 ID**，以便其做路由与提示缓存；同一张表把 DeepSeek Harness 列为
「部分模型路径带会话信息、其余缺失」。

DSH 侧只有官方 DeepSeek 适配器会发原生会话头（`x-deepseek-harness-session-id`）；
`@deepseek-ai/dsh-llm-pi-ai` 虽然把 DSH 的逐会话 id 传给了 pi-ai，却只把**静态**的 profile
`headers` 发给请求 —— pi-ai 这一版没把会话 id 变成 opencode 的头（上游 issue：
[earendil-works/pi#4847](https://github.com/earendil-works/pi/issues/4847)、
[#4680](https://github.com/earendil-works/pi/issues/4680)、
[#9290](https://github.com/earendil-works/pi/issues/9290)）。

## 它怎么做

插件包装进程内的 `globalThis.fetch`，并且：

1. **只对 opencode 域生效**（`opencode.ai` 及其子域），其它请求原样透传；
2. **请求已带 `x-opencode-session` 就不覆盖** —— 你在设置里手配的静态值优先；上游哪天自己发了，
   本插件自动变成 no-op；
3. 会话 ID = **人可读短标签**：`dsh-青竹aB`（中文词 + 两个随机字母），
   **同一段对话稳定、不同对话互不相同**，且能直接在 opencode 控制台的「会话」列里认出是哪一段；
4. 无正文的请求（如拉模型列表）用本进程固定 ID；
5. 只**克隆**读请求体（绝不消费原请求体）；任何一步失败都回退「原样发送」。

为什么必须在出口层做：pi-ai 的三种 wire 协议都走 `options?.fetch ?? globalThis.fetch`，
而 `dsh-llm-pi-ai` 不注入自定义 fetch；openai / @anthropic-ai 两个 SDK 的 `getDefaultFetch()`
是**调用时**读全局 `fetch`。所以在全局 fetch 上包一层即可全覆盖，**无需改动任何上游代码**。

## 安装（DSH Forge）

先在**托盘里退出** DSH Forge（宿主插件只在进程启动时装配），然后：

```powershell
& "$env:LOCALAPPDATA\Programs\dsh-forge\DSH Forge.exe" --install-plugin github:lansi-ai/dsh-llm-opencode-session
```

```bat
"%LOCALAPPDATA%\Programs\dsh-forge\DSH Forge.exe" --install-plugin github:lansi-ai/dsh-llm-opencode-session
```

本地目录旁加载（离线/开发）：

```powershell
& "…\DSH Forge.exe" --install-plugin "E:\path\to\dsh-llm-opencode-session"
```

装完即生效（本次启动就装配）。**卸载**：删掉
`$DSH_HOME/profiles/dsh-forge/cordis.patch.yml` 里那条 `id: llm-opencode-session` 的行
（或删掉 `$DSH_HOME/profiles/node_modules/dsh-llm-opencode-session` 目录）。

## 安装（官方 dsh CLI）

```bash
dsh plugin --profile <name> add dsh-llm-opencode-session
```

## 使用

装完**什么都不用配**：正常选 opencode 路由下的模型聊天即可。想确认是否生效，看启动日志里有没有：

```text
[dsh-opencode] opencode 会话头注入已安装（仅 opencode.ai 域；标签风格 cjk；已带该头的请求不覆盖）
```

每为新对话生成一个标签，都会打一行 info，便于把控制台的「会话」列对回本地：

```text
[dsh-opencode] 新会话 dsh-云雀rz（opencode 控制台「会话」列对应此值）
```

## 会话标签长什么样

| 风格 | 样例 | 构成 | 何时用 |
| --- | --- | --- | --- |
| `cjk`（默认） | `dsh-青竹aB` | 两个汉字（50 词表）+ 两个字母 | 想一眼看出「这是哪段对话」 |
| `ascii` | `dsh-Kx7Q` | 四个字母（去掉了 l/I/O/0） | 控制台把中文显示成乱码时 |

字母表刻意去掉 `l`/`I`/`O`/`0`，避免和 `1`/`o` 看混。同一标签在一次进程内不会重复。

想改成纯 ASCII：

```yaml
# $DSH_HOME/profiles/dsh-forge/cordis.patch.yml 里那条 insert 行
- id: llm-opencode-session
  config:
    labelStyle: ascii
```

> **请求头编码注意**：HTTP 头按规范只能是 ByteString。中文标签会先按 UTF-8 编码、
> 再把每个字节映射回 latin-1 字符送出，**线上字节与 UTF-8 完全一致**；
> 若某个网关按 latin-1 解码而看到乱码，切 `labelStyle: ascii` 即可。

## 边界与已知取舍

- **首条用户消息变了，会话 ID 就变**：上下文被压缩/摘要挤掉第一条用户消息时，该对话会换一次 ID
  （提示缓存重新预热）。这是启发式的代价——DSH 没有把逐会话 id 暴露给这一层。
- **两段对话首条消息完全相同**（例如都只发「你好」）会共用一个 ID。
- 若你在设置里**手配过** `x-opencode-session`（静态值），它会优先，于是该路由所有对话共用一个
  会话；想让本插件逐会话工作，把那条静态头删掉。
- **中文标签是给「人看」的，不是协议要求**：opencode 只把该值当作不透明字符串做路由/缓存键，
  取值本身无格式约束；因此换标签风格不会影响命中率，但**换标签会换一次 ID**，
  该对话的提示缓存要重新预热。
- 本插件**不改任何上游代码**，也不依赖任何上游包（零 `peerDependencies`）。

## 开发

```bash
npm install          # 只为 typescript
npm run build        # src/index.ts → lib/index.js（产物需入库：--install-plugin 不跑构建）
npm test             # node --test 语义的行为断言
npm run typecheck
```

## 许可

MIT
