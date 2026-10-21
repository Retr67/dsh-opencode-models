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

### 前置条件（首次使用请先确认）

插件只做一件事：把某个 llm-pi-ai 路由的实际模型列表**如实同步**进配置。它不创建路由，所以先要有这个路由：

1. **路由存在**：`llm-pi-ai` 里有目标 provider 路由（默认 `opencode-go`），且带 `baseURL`；
2. **凭据可用**：该路由的 `apiKeyEnv` 指向的凭据已在 dsh 凭据里配好（否则报"凭据不可用"）；
3. **网关要求时**：若网关要求额外请求头（如 OpenCode Go 的 `x-opencode-session`），写进路由的 `headers`——插件的探测会带上它，否则会像真实聊天一样被网关拒绝。

缺哪一项，插件都会在页面上直接说明，不会静默失败。三种"起步失败"各有各的提示：

| 情况 | 提示 |
|---|---|
| 读不到 `llm-pi-ai` 配置节 | 提示适配器可能没加载 |
| 配置节在，但没有目标路由 | **列出当前实际存在的路由名**，并说明是新增路由还是改本插件的 `provider` 配置 |
| 路由在，但缺 `baseURL` | 直接指出缺哪个字段 |

### 操作

1. 打开 dsh 设置 → **OpenCode Go 模型同步**；
2. 点击 **「更新最新 OpenCode Go 模型列表」**；
3. 等待进度完成（约 1 分钟：拉列表 + 全部模型两轮探测），页面会显示：
   - **新增**：服务端有、配置里没有的模型；
   - **保留**：继续可用的模型；
   - **移除**：配置里有、服务端已下线的模型；
   - **服务端拒绝**：在 `/models` 里但实测不可用的模型（地区封锁 / 需 opt-in / 明确拒绝）；
   - **未纳入（catalog 未收录）**：可用但 dsh 内置 catalog 不认识、且路由未声明 `api` 的模型（见下文如何纳入）。

## 探测与安全策略

对每个模型发微型真实请求（`max_tokens: 1`，并发 6）。

### 三种协议都会尝试

网关上的模型分属三种 wire 协议。**dsh 按 catalog 给每个模型定的协议自动路由**，插件不干预也不该干预 —— 但插件必须"问得通"，才能判断模型是否真的可用：

| 协议 | 端点 | 鉴权 |
|---|---|---|
| `openai-completions` | `POST {baseURL}/chat/completions` | `Authorization: Bearer` |
| `openai-responses` | `POST {baseURL}/responses` | `Authorization: Bearer` |
| `anthropic-messages` | `POST {baseURL}/messages` | `x-api-key` + `anthropic-version`（Bearer 会被拒） |

插件先试 `openai-completions`；只有当失败信息表明「协议不对」（`ModelProtocolUnsupported` / 404 / 405）时，才换下一个协议重试。地区封锁、opt-in、5xx 等是关于**模型的结论**，不会白跑另外两个协议。

> **为什么必须这样做**：2026-10-22 在真实网关上实测，`grok-4.6` / `grok-4.7` 在 `/chat/completions` 返回 400 `ModelProtocolUnsupported`，但在 `/responses` 返回 **200**；`claude-haiku-5-5` / `minimax-m2.7` 在 completions 返回 400，在 `/messages`（配 `x-api-key`）返回 **200**。只探一种协议的旧版本会把这几只**完全可用**的模型判成「服务端拒绝」并从你自己的配置里删掉。

### 判定

| 探测结果 | 判定 |
|---|---|
| 任一协议 200 | **可用** |
| 403 `RegionError`「not available in your country」 | **地区不可用**（移除） |
| 400 含数据政策字样（如「trains on request data」） | **需 opt-in**（移除） |
| 三协议均 `ModelProtocolUnsupported` / 400 / 401 | **服务端明确拒绝**（移除） |
| 402「Endpoint is unavailable」 | **无法判定**（**保留**） |
| 5xx | 暂时故障（**保留**） |
| 网络错误 | 无法判定（**保留**） |
| 图像 ping（1×1 PNG，走该模型已答通的协议） | 200 → 标注 `input: [text, image]` |

> 旧版本把 403 一律当成「需要数据政策 opt-in」，但真实网关的 403 主要是**地区封锁**，而真正的 opt-in 反而返回 400。现在按响应体区分。

写回保护：

- **无变化不写**：列表与当前配置一致时不触碰 `settings.yaml`（含「再同步一次同样内容」也完全不写；视觉标注 `input` 只在真正变化时才改，不会因为字段顺序变动而误判为有变化）；
- **大量失败中止**：超过一半模型"无法判定"（网络层异常）时放弃本次写回，绝不清空列表；
- **不写空列表**：若没有任何模型能写入（例如全部被拒、或全部未被 catalog 收录），拒绝写入并说明真实原因——空列表会把你已配置的模型丢回 catalog 默认值；
- **系统性误删保护**：如果**大部分"服务端仍在售卖"的已配置模型同时被拒**（≥3 个且占一半以上），这更像系统性故障（密钥失效、配额到期、网关新增了必需请求头）而不是真的下线，插件会**保留**这些条目并继续同步其余部分。服务端**不再列出**的模型才是真下线，照常移除。「下线模型自动移除」因此不受影响；
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

## 刷新失败 / 模型未被纳入：`model "xxx" needs an api`

服务端会先于 catalog 上新，所以同步时**可能有一部分模型写不进去**。这是设计使然，不是故障。

### 为什么

dsh 给一个模型定 wire 协议时按这个顺序解析：

```
路由的 api  →  catalog 里该模型的 api  →  该路由 catalog 唯一一致的协议
```

`opencode-go` 的 catalog 同时包含三种协议（`anthropic-messages` / `openai-completions` / `openai-responses`），所以**第三条永远没有值**。于是 catalog 不认识的模型无从定协议。

### 插件现在的行为（不再全盘失败）

| 情况 | 行为 |
|---|---|
| 路由**已声明** `api` | 全部模型照常同步（api 能解析不认识的模型） |
| 路由**未声明** `api`，但有 catalog 认识的模型 | **认识的照常写入**；不认识的列在「未纳入（catalog 未收录）」里，不写入 |
| 路由**未声明** `api`，且一个认识的都没有 | 拒绝写入并报错（写空列表会把你已配置的模型丢回 catalog 默认值） |

也就是说：**同步能推进多少就推进多少**，不会再因为一个新模型导致整份列表写不进去。未纳入的模型会明确列出来，而不是悄悄丢掉。

### 想让那部分模型也纳入

在路由下加一行 `api`：

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      api: openai-completions     # ← 加这一行
      baseURL: https://opencode.ai/zen/go/v1
      apiKeyEnv: OPENCODE_GO_API_KEY
```

加了之后刷新，未收录的模型也会被写入。

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

- dsh ≥ 0.1.0-rc.7（web profile；在 0.1.2-alpha.x 上开发验证，0.2.0-rc.2 上修复验证）
- 零构建、零运行时依赖（宿主与浏览器端均为 node/DOM 内置能力）
- 读配置走 `settings.describe()`：dsh 0.1.x 的 `settings.get(ns)` 在 **0.2.0 已被移除**（v0.2.1 起改用 `describe().find(ns).value`，新旧版本语义等价，双向兼容）
- 已验证的场景：模型上新自动补齐、下线模型自动移除、视觉模型自动标注、5xx 故障不误删
- **已知限制**：服务端出现 catalog 未收录的模型、且路由未声明 `api` 时，这部分模型不会被写入（会列在结果里）。本插件不会擅自替你声明 `api`（见上文「刷新失败 / 模型未被纳入」一节）
- 思考强度：同步的模型带 `reasoningEfforts` 声明，WebUI 出现思考强度选择器（关闭 / Minimal / Low / Medium / High / Max）。选择器停在"关闭"时完全不发送思考参数。少数模型的上游拒绝 Max（qwen3.7 系列、grok-4.5、gpt-5.6-luna、minimax-m2.7、mimo-v2.5-pro 已实测剔除，只到 High）；不想给某个模型开，把它的 `reasoningEfforts` 手动设为 `false`，同步会保留你的设置

## 升级到 dsh 0.2.0 后刷新报 `ctx.settings.get is not a function`

dsh 0.2.0 移除了 `settings` 服务的 `get(ns)` 方法（0.1.x 有，返回该命名空间的解析值），插件 v0.2.0 及更早版本因此在该版本上**完全无法读取配置**，点刷新立即失败：

```
刷新失败：ctx.settings.get is not a function
```

**v0.2.1 已修复**：改用 `settings.describe().find(ns).value`。这个方法在 0.1.2 起的每个版本都存在，返回的 `value` 与旧 `get()` 返回的解析值相同，所以同一个调用在新旧 dsh 上都能用。

修复后需要**重启 dsh**（宿主端模块在启动时加载，热重载不会重新执行已缓存的模块），再刷新页面。

## License

MIT
