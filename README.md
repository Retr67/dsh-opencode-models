# dsh-opencode-models

DeepSeek Harness（DSH）插件：在设置页新增一栏 **「OpenCode Go 模型同步」**，一键拉取 OpenCode Go 服务端的全部模型、逐个实测可用性与视觉能力，并把可用模型写回 `llm-pi-ai` 的模型列表。

## 为什么需要它

dsh 设置里内置的「获取可用模型」按钮对 catalog 里的 provider **不发网络请求**——它直接返回打包在 pi-ai npm 包里的静态快照（`opencode-go` 是 19 个模型）。OpenCode Go 服务端实际模型列表变动频繁（上新、下线、暂不可用），静态快照永远滞后。

本插件走真实路径：`GET /models` 拉全集 → 逐个实测 → 写回 `settings.yaml`。

## 安装

```bash
npx -y @deepseek-ai/dsh plugin --profile web add https://github.com/Retr67/dsh-opencode-models
```

安装后重启 dsh web 并刷新页面。

## 使用

1. 打开 dsh 设置 → **OpenCode Go 模型同步**；
2. 点击 **「更新最新 OpenCode Go 模型列表」**；
3. 等待进度完成（约 1 分钟：拉列表 + 全部模型两轮探测），页面会显示：
   - **新增**：服务端有、配置里没有的模型；
   - **保留**：继续可用的模型；
   - **移除**：配置里有、服务端已下线的模型；
   - **服务端拒绝**：在 `/models` 里但实测被拒的模型（400/401 明确拒绝、403 数据政策 opt-in）。

## 探测与安全策略

对每个模型发两类微型真实请求（`max_tokens: 1`，并发 6）：

| 探测 | 判定 |
|---|---|
| 文本 ping | 200 → 可用；400/401 → 明确拒绝（不进列表）；403 → 需数据政策 opt-in；5xx → 暂时故障（**保留**）；网络错误 → 无法判定（**保留**） |
| 图像 ping（1×1 PNG） | 200 → 标注 `input: [text, image]`；否则纯文本 |

写回保护：

- **无变化不写**：列表与当前配置一致时不触碰 `settings.yaml`（含「再同步一次同样内容」也完全不写；视觉标注 `input` 只在真正变化时才改，不会因为字段顺序变动而误判为有变化）；
- **大量失败中止**：超过一半模型"无法判定"（网络层异常）时放弃本次写回，绝不清空列表；
- **保留手工元数据**：已有条目的 `name` / `contextWindow` / `maxTokens` 原样保留——你手填过的规格永远不会被同步覆盖；
- **新条目不写死规格**：新模型只写 `id` / `name`（+ 实测的视觉、思考档位），`contextWindow` 与 `maxTokens` 交给 dsh 自己解析——dsh 会从内置的 pi-ai catalog 取该模型的**真实规格**（例如 kimi-k3 → 1048576 / 131072），只有 catalog 也不认识的模型才回落到路由默认值。写死一个猜测值反而会把错误数字永久冻结（因为同步保留已设置的字段）；
- 视觉能力以实测为准（覆盖手工标注）。

## 上下文窗口 / 最大输出从哪里来

模型条目没有声明 `contextWindow` / `maxTokens` 时，dsh 按这个顺序解析：

1. 内置 pi-ai catalog 里该模型的真实条目（例如 `kimi-k3` → 上下文 1048576、输出 131072）；
2. catalog 不认识这个模型时，回落到路由的 `defaultContextWindow` / `defaultMaxTokens`（dsh 默认 262144 / 32768）。

由此推论：

- **不要手填猜的值**——一旦条目里写了 `contextWindow`，它就永久覆盖 catalog 的真实规格，而同步又会一直保留你的写法（看起来"怎么都不是尽可能大"，就是这个原因）；
- 确实想调大/调小时才显式写，例如 `{ id: kimi-k2.6, contextWindow: 1048576 }`；
- 服务器 `/models` 只返回 `id`，**不提供任何规格元数据**，所以本插件不猜、也不写死规格，一律留给 dsh 的 catalog 解析。

## 工作原理

- **宿主端**（`dsh/index.js`，零依赖）：注册 `POST /opencode-models/refresh`（启动后台刷新）与 `GET /opencode-models/status`（进度/结果）两个路由；从 `llm-pi-ai` settings 读取路由配置（`baseURL` / `apiKeyEnv`），经 dsh 凭据服务解析 API Key，探测完成后用 `settings.mutate` 原子写回模型数组。
- **浏览器端**（`dsh/client.js`，零依赖手写懒加载 CJS bundle）：注册 `settings.section` slot，在设置面板新增独立一栏；按钮点击后轮询状态端点，实时渲染进度与结果。

默认目标 provider 是 `opencode-go`（llm-pi-ai 路由里的 `opencode-go` 条目）；任何 OpenAI 兼容聚合站只要按同样方式配置了路由，改一个配置项即可复用（见下）。

> 探测请求与列表请求会携带该 provider 路由配置里的 `headers`（llm-pi-ai 路由可配 `headers: { ... }`）。部分聚合网关（如 OpenCode Go）要求 `x-opencode-session` 请求头——确保它在你的路由 headers 里，否则探测会被网关判为拒绝。

## 刷新失败：`model "xxx" needs an api`

如果刷新报出这样的错：

```
刷新失败：llm-pi-ai: provider "opencode-go" model "minimax-m2.5" needs an api;
the installed catalog does not describe it, so set the route's api to the wire protocol its endpoint speaks
```

**这不是探测失败，而是写回被 dsh 拒绝了。** 原因是：

1. 服务端上线了 dsh 内置 catalog（pi-ai 静态快照）**还没收录**的模型；
2. 你的路由**没有声明 `api`**；
3. dsh 解析一个模型的协议时走 `路由 api → catalog 里该模型的协议 → 该路由 catalog 的唯一协议`。`opencode-go` 的 catalog 同时含 `anthropic-messages` / `openai-completions` / `openai-responses` 三种协议，**没有唯一协议可用**，于是 catalog 不认识的模型无从定协议，dsh 拒绝写入整份列表（宁可不写，也不写一份无法服务的配置）。

修法：在路由下加一行 `api`。本插件的探测走 `POST {baseURL}/chat/completions`，所以通常是 `openai-completions`：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      api: openai-completions     # ← 加这一行
      baseURL: https://opencode.ai/zen/go/v1
      apiKeyEnv: OPENCODE_GO_API_KEY
```

> **注意（重要）**：catalog 路由一旦**显式**声明 `api`，dsh 会改用协议实现（`createProvider`）而不是复用 catalog provider 来构造该路由。catalog provider 会按会话自动注入 `x-opencode-session`，改走协议实现后**这个自动注入就没了**。所以如果你的网关要求该头（OpenCode Go 就是），请把 header 一并显式写上：
>
> ```yaml
>       headers:
>         x-opencode-session: <你的会话标识>
> ```
>
> 否则可能出现「同步成功了，但聊天全部被网关拒绝」。
>
> 本插件**不会**替你自动写这行 `api`：自动写会修好同步、却可能悄悄弄坏你原本正常的聊天请求（丢掉上面那个自动注入的 header）。这个取舍交给你决定。

已显式声明 `api` 的路由不受影响，刷新照常工作。

## 配置

无需配置即可使用（默认目标 `opencode-go` 路由）。如需调整，在 profile 的 `cordis.patch.yml` 里按 entry id 覆盖：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: opencode-models    # 本插件在 patch 层的 entry id
  config:
    provider: opencode-go   # 目标 llm-pi-ai provider 路由名
    concurrency: 6          # 探测并发数（1-12）
    timeoutMs: 25000        # 单请求超时（5s-60s）
```

## 兼容性

- dsh ≥ 0.1.0-rc.7（web profile；在 0.1.2-alpha.x 上开发验证）
- 零构建、零运行时依赖（宿主与浏览器端均为 node/DOM 内置能力）
- 已验证的场景：模型上新自动补齐、下线模型自动移除、视觉模型自动标注、5xx 故障不误删
- **已知限制**：服务端出现 catalog 未收录的模型、且路由未声明 `api` 时，dsh 会拒绝整份写入——本插件会给出可操作的报错（见上文「刷新失败」一节），不会擅自替你改路由配置
- 思考强度：同步的模型带 `reasoningEfforts` 声明，WebUI 出现思考强度选择器（关闭 / Minimal / Low / Medium / High / Max）。选择器停在"关闭"时完全不发送思考参数。少数模型的上游拒绝 Max（qwen3.7 系列、grok-4.5、gpt-5.6-luna、minimax-m2.7、mimo-v2.5-pro 已实测剔除，只到 High）；不想给某个模型开，把它的 `reasoningEfforts` 手动设为 `false`，同步会保留你的设置

## License

MIT
