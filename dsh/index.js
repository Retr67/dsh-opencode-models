// dsh-opencode-models — host half.
//
// Serves the "update model list" flow for an OpenAI-compatible aggregator
// provider (default: the `opencode-go` route of the llm-pi-ai adapter):
//
//   POST /opencode-models/refresh  → start a background refresh run
//   GET  /opencode-models/status   → progress + last result (JSON)
//
// A refresh run:
//   1. reads the target route (baseURL, apiKeyEnv, current models) from the
//      `llm-pi-ai` settings document,
//   2. resolves the API key through the dsh credentials service,
//   3. lists the server's model ids (GET {baseURL}/models),
//   4. probes every id with tiny real requests (concurrency-limited): one
//      plain text ping for availability, one image ping for vision, — both
//      carrying the route's provider-level headers (e.g. an aggregator's
//      x-opencode-session),
//   5. writes the merged catalog back with settings.mutate, preserving the
//      name/contextWindow/maxTokens of surviving hand-maintained entries.
//
// Safety: dsh settings.yaml is the only thing that decides what a route
// serves, so a run never wipes the list on doubt. Individual 4xx probes drop
// that model (the server explicitly rejected it); 5xx keeps the model (a
// transient gateway fault should not delete a catalog entry); if MORE THAN
// HALF of the probes fail outright (network-level), the whole run aborts
// without touching settings at all.
//
// Zero dependencies (node builtins only). Loaded via cordis.patch.yml.
// The browser half is dsh/client.js (lazy-CJS ModuleLoader protocol).

export const name = 'dsh-opencode-models'
export const inject = ['settings', 'credentials']

// 0.2.0: harness SettingsForms 对 Config 做 'toJSON' in schema' 判断，
// null 会炸掉整个设置表单枚举（"加载提供商目录失败"）；undefined = 无 schema。
export const Config = undefined

const NS = 'llm-pi-ai'

// The wire protocol every probe in this file speaks (POST {baseURL}/chat/completions).
// Named only in the repair hint for a route that declares no `api` — the plugin
// never writes it into settings; see step 6 for why that is the user's call.
const PROBE_API = 'openai-completions'

/** 1x1 transparent PNG used for the vision probe. */
const PING_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

const FRIENDLY = {
  gpt: 'GPT',
  glm: 'GLM',
  minimax: 'MiniMax',
  mimo: 'MiMo',
  deepseek: 'DeepSeek',
  ai: 'AI',
}

/** `qwen3.8-flash` → `Qwen3.8 Flash`; known acronyms keep their shape. */
function displayName(id) {
  return id
    .split('-')
    .map((seg) => {
      const lower = seg.toLowerCase()
      if (FRIENDLY[lower]) return FRIENDLY[lower]
      if (/^[0-9]/.test(seg)) return seg
      return seg.charAt(0).toUpperCase() + seg.slice(1)
    })
    .join(' ')
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()))
  return results
}

async function fetchWithRetry(url, init, tries, timeoutMs) {
  let lastError
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
    } catch (error) {
      lastError = error
      if (attempt < tries) await new Promise((resolve) => setTimeout(resolve, 800 * attempt))
    }
  }
  throw lastError
}

export function apply(ctx, config = {}) {
  const provider = String(config.provider || 'opencode-go')
  const concurrency = Math.max(1, Math.min(12, Number(config.concurrency) || 6))
  const timeoutMs = Math.max(5000, Math.min(60000, Number(config.timeoutMs) || 25000))

  // One refresh run at a time; survives plugin-fiber restarts of the module
  // scope as in-memory state only (the result is also visible from settings).
  const state = {
    phase: 'idle', // idle | listing | probing | writing | done | error
    detail: '',
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  }

  const setStatus = (phase, detail) => {
    state.phase = phase
    if (detail !== undefined) state.detail = detail
  }

  const chatUrl = (baseURL) => baseURL.replace(/\/+$/, '') + '/chat/completions'
  const modelsUrl = (baseURL) => baseURL.replace(/\/+$/, '') + '/models'

  /** List the server's model ids. Returns [{ id, raw }]. */
  async function listModels(baseURL, apiKey, extraHeaders) {
    const response = await fetchWithRetry(
      modelsUrl(baseURL),
      {
        headers: {
          ...(extraHeaders || {}),
          Authorization: 'Bearer ' + apiKey,
          Accept: 'application/json',
        },
      },
      3,
      timeoutMs,
    )
    if (!response.ok) {
      throw new Error('GET /models answered ' + response.status)
    }
    const body = await response.json()
    const rows = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : []
    const seen = new Set()
    const listed = []
    for (const row of rows) {
      const id = typeof row === 'string' ? row : row && row.id
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      listed.push({ id, raw: typeof row === 'object' && row ? row : {} })
    }
    return listed
  }

  /** One tiny ping. Returns { status, dataPolicy, kind }. */
  async function ping(model, apiKey, baseURL, vision, extraHeaders) {
    const content = vision
      ? [
          { type: 'text', text: 'hi' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PING_PNG } },
        ]
      : 'hi'
    const body = JSON.stringify({
      model,
      max_tokens: 1,
      messages: [{ role: 'user', content }],
    })
    try {
      const response = await fetchWithRetry(
        chatUrl(baseURL),
        {
          method: 'POST',
          headers: {
            ...(extraHeaders || {}),
            Authorization: 'Bearer ' + apiKey,
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          },
          body,
        },
        3,
        timeoutMs,
      )
      if (response.ok) return { status: response.status, kind: 'ok' }
      let snippet = ''
      try {
        snippet = (await response.text()).slice(0, 300)
      } catch {
        /* body unreadable; status is enough */
      }
      return { status: response.status, kind: 'http', snippet }
    } catch (error) {
      return {
        status: 0,
        kind: 'network',
        message: String(error && error.message ? error.message : error),
      }
    }
  }

  function classify(probe) {
    if (probe.kind === 'ok') return 'available'
    if (probe.kind === 'network') return 'unknown' // never a verdict by itself
    const text = String(probe.snippet || '')
    if (probe.status === 403 || /DataPolicy|data policy|opt in/i.test(text)) return 'opt-in'
    if (probe.status === 401) return 'rejected'
    if (probe.status === 404 || probe.status === 400) return 'rejected'
    if (probe.status >= 500) return 'flaky' // transient server fault: keep
    return 'unknown'
  }

  async function run() {
    state.startedAt = Date.now()
    state.finishedAt = null
    state.result = null
    state.error = null
    try {
      // 1. Route configuration.
      setStatus('listing', '读取 provider 配置…')
      // Read the llm-pi-ai route through describe(), NOT get().
      //
      // dsh 0.1.x exposed settings.get(ns) (returning the namespace's resolved
      // value); 0.2.0 removed it — SettingsForms now exposes only configure /
      // writable / documentPath / prepareDocument / describe / update / replace /
      // mutate. Calling get() on 0.2.0 throws "ctx.settings.get is not a
      // function" before a single probe runs.
      //
      // describe() exists on BOTH (0.1.2 onward) and its per-namespace `value`
      // is the same resolved section get() used to return, so this one call is
      // forward- and backward-compatible. It is also the path the settings
      // service itself uses internally, and what dsh's own session-controller
      // uses to read another plugin's config.
      const section = ctx.settings.describe?.().find((row) => row.ns === NS)?.value
      const route = section?.providers?.[provider]
      if (!route || typeof route.baseURL !== 'string') {
        throw new Error(`llm-pi-ai settings 里没有 ${provider} 路由（或缺少 baseURL）`)
      }
      const keyEnv = route.apiKeyEnv ? String(route.apiKeyEnv) : null
      let apiKey = null
      if (keyEnv) {
        const resolved = await ctx.credentials.resolve(keyEnv)
        apiKey = resolved?.value || null
      }
      if (!apiKey) {
        throw new Error(`凭据 ${keyEnv || '(未配置 apiKeyEnv)'} 不可用`)
      }
      const currentModels = Array.isArray(route.models) ? route.models : []
      const byId = new Map()
      for (const entry of currentModels) {
        if (entry && typeof entry.id === 'string') byId.set(entry.id, entry)
      }
      // Provider-level headers (e.g. an aggregator-gateway session id) apply
      // to every wire request the plugin makes, exactly as the llm adapter
      // applies them to chat calls.
      const routeHeaders =
        route.headers && typeof route.headers === 'object' ? route.headers : {}

      // 2. Server listing.
      setStatus('listing', '拉取 ' + route.baseURL + '/models…')
      const listed = await listModels(route.baseURL, apiKey, routeHeaders)
      if (listed.length === 0) {
        throw new Error('服务端 /models 返回空列表')
      }

      // 3. Probe availability, then vision for the available ones.
      const verdict = new Map() // id → { available, vision, note }
      setStatus('probing', `可用性探测 0/${listed.length}`)
      let doneCount = 0
      const availability = await mapLimit(listed, concurrency, async (row) => {
        const probe = await ping(row.id, apiKey, route.baseURL, false, routeHeaders)
        doneCount++
        setStatus('probing', `可用性探测 ${doneCount}/${listed.length}`)
        return [row.id, probe]
      })
      for (const [id, probe] of availability) {
        const note = classify(probe)
        verdict.set(id, {
          available: note === 'available',
          vision: false,
          note,
          message: note === 'unknown' && probe.message ? probe.message : probe.snippet,
        })
      }

      const availableIds = availability.filter(([, probe]) => classify(probe) === 'available').map(([id]) => id)
      if (availableIds.length > 0) {
        doneCount = 0
        setStatus('probing', `视觉探测 0/${availableIds.length}`)
        const visions = await mapLimit(availableIds, concurrency, async (id) => {
          const probe = await ping(id, apiKey, route.baseURL, true, routeHeaders)
          doneCount++
          setStatus('probing', `视觉探测 ${doneCount}/${availableIds.length}`)
          return [id, probe]
        })
        for (const [id, probe] of visions) {
          const entry = verdict.get(id)
          if (entry) entry.vision = classify(probe) === 'available'
        }
      }

      // 4. Abort on network-level mass failure — settings stay untouched.
      const unknownCount = [...verdict.values()].filter((v) => v.note === 'unknown').length
      if (unknownCount > listed.length / 2) {
        throw new Error(
          `网络层面失败过多（${unknownCount}/${listed.length} 无法判定），已放弃写回以保护现有列表`,
        )
      }

      // 5. Merge: server order, probe-filtered, hand metadata preserved.
      const nextModels = []
      const added = []
      const kept = []
      const removed = []
      const unavailable = []
      for (const row of listed) {
        const v = verdict.get(row.id) || { available: false, vision: false, note: 'unknown' }
        if (!v.available) {
          const reason =
            v.note === 'opt-in'
              ? '需要数据政策 opt-in（403）'
              : v.note === 'rejected'
                ? '服务端明确拒绝（400/401）'
                : v.note === 'flaky'
                  ? '5xx 暂时故障（保留）'
                  : '无法判定（保留）' + (v.message ? '：' + String(v.message).slice(0, 120) : '')
          const entry = byId.get(row.id)
          if (entry && (v.note === 'flaky' || v.note === 'unknown')) {
            // Keep previously configured entries on flaky/unknown — do not
            // delete a working model because one probe hiccuped.
            nextModels.push(entry)
            kept.push(row.id)
          } else {
            unavailable.push({ id: row.id, reason })
          }
          continue
        }
        const existing = byId.get(row.id)
        const model = existing
          ? { ...existing }
          : {
              id: row.id,
              name: displayName(row.id),
              // Deliberately no contextWindow/maxTokens: dsh materializes an
              // unspecified capacity from the installed pi-ai catalog — the
              // model's real spec — and falls back to the route defaults only
              // for a model the catalog does not describe. Writing a guess
              // here would freeze a wrong number forever, because a later sync
              // preserves every field the entry already sets.
            }
        // Vision comes from the probe (authoritative for this server).
        // Only touch the key when the value actually changes: `delete` followed
        // by an unconditional re-add moves `input` to the end of the object, and
        // the change check below compares JSON.stringify, which is key-order
        // sensitive. Re-adding an unchanged value would therefore report a
        // difference that is not one — a spurious settings write on a sync that
        // changed nothing, which is exactly what "无变化不写" promises not to do.
        const desiredInput = v.vision ? ['text', 'image'] : undefined
        if (JSON.stringify(model.input) !== JSON.stringify(desiredInput)) {
          if (model.input) delete model.input
          if (desiredInput) model.input = desiredInput
        }
        // Reasoning: the gateway accepts reasoning_effort on every model probed
        // (2026-09, OpenAI-completions wire), and dsh omits the parameter
        // entirely while the selector sits on 'off'. The ladder offers
        // off/minimal/low/medium/high/max — every rung named exactly what it
        // does. A handful
        // of upstreams reject effort=max (qwen3.7 series, grok-4.5, ...) —
        // drop the `max` key by hand for those; sync preserves manual edits.
        // An explicit `false` (or any hand-set value) is the user's opt-out
        // and is preserved by the spread above.
        if (model.reasoningEfforts === undefined) {
          model.reasoningEfforts = { minimal: 'minimal', low: 'low', medium: 'medium', high: 'high', max: 'max' }
        }
        nextModels.push(model)
        if (existing) kept.push(row.id)
        else added.push(row.id)
      }
      for (const [id] of byId) {
        if (!listed.some((row) => row.id === id)) removed.push(id)
      }

      // 6. Write back — whenever merged content differs from what is on disk
      // (additions, removals, or newly declared fields like reasoningEfforts),
      // not only when the id set changed.
      // Which of these can this route actually serve? A route that names no
      // `api` can only serve models the installed catalog describes: the
      // harness resolves `api ?? catalog entry's api ?? the one protocol every
      // catalog model agrees on`, and a catalog spanning several protocols
      // (opencode-go ships anthropic-messages, openai-completions and
      // openai-responses) has no such shared answer. One server-side addition
      // the catalog has not caught up with therefore used to sink the ENTIRE
      // list — issue #1. Catalog-known models are now written as usual and the
      // rest are reported, so a sync is no longer all-or-nothing.
      let catalogIds = null
      try {
        const llm = ctx.get?.('llm')
        // A catalog route answers this from the installed catalog: no network.
        if (llm && typeof llm.discoverModels === 'function') {
          const rows = await llm.discoverModels(NS, { provider })
          catalogIds = new Set((rows || []).map((row) => row && row.id).filter((id) => typeof id === 'string'))
        }
      } catch { catalogIds = null } // unknown: fall back to writing everything

      const undescribed = catalogIds !== null && route.api === undefined
        ? nextModels.filter((model) => !catalogIds.has(model.id))
        : []
      const writable = undescribed.length > 0
        ? nextModels.filter((model) => catalogIds.has(model.id))
        : nextModels

      const changed = JSON.stringify(currentModels) !== JSON.stringify(writable)
      if (changed && writable.length === 0) {
        // Nothing here is servable; writing an empty list would hand the route
        // back to the catalog defaults and drop the user's configured models.
        throw new Error(
          `服务端 ${listed.length} 个模型里没有一个被 dsh 内置 catalog 收录，而路由 ${provider} 没有声明 wire 协议；` +
            `写入空列表会把你已配置的模型丢回 catalog 默认值，因此本次未写入。\n` +
            `修法：在该路由下加一行 api（本插件的探测走 POST {baseURL}/chat/completions，所以通常是 openai-completions）：\n\n` +
            `  llm-pi-ai:\n    providers:\n      ${provider}:\n        api: ${PROBE_API}\n\n` +
            `注意：catalog 路由一旦显式声明 api，dsh 会改用协议实现而非 catalog provider 构造该路由，` +
            `随之不再自动注入 x-opencode-session 请求头。若你的网关要求该头（如 OpenCode Go），请同时在路由里显式配置 headers。`,
        )
      }
      if (changed) {
        setStatus('writing', `写入 settings（${writable.length} 个模型）…`)
        try {
          await ctx.settings.mutate(NS, [
            { op: 'set', path: ['providers', provider, 'models'], value: writable },
          ])
        } catch (error) {
          const message = String(error && error.message ? error.message : error)
          // A route that names no `api` can only serve models the installed
          // catalog describes: the harness resolves `api ?? catalog entry's api
          // ?? the one protocol every catalog model agrees on`, and a catalog
          // spanning several protocols (opencode-go ships anthropic-messages,
          // openai-completions and openai-responses) has no such shared answer.
          // So the first time the server serves a model the catalog has not
          // caught up with, the entire write is refused — issue #1.
          //
          // The plugin does not declare that protocol for you. On a catalog
          // route an explicit `api` switches provider construction away from
          // the catalog provider, which is what wraps requests in this
          // gateway's per-conversation `x-opencode-session` header — declaring
          // it here would fix the sync and silently break every chat request
          // for a route that relies on that wrapper. It is the user's call, so
          // this reports the refusal with the exact repair instead.
          if (!/needs an api/i.test(message)) throw error
          throw new Error(
            `${message}\n\n` +
              `原因：服务端提供了 dsh 内置 catalog 尚未收录的模型，而路由 ${provider} 没有声明 wire 协议，` +
              `dsh 拒绝写入整份列表。\n` +
              `修法：在该路由下加一行 api（本插件的探测走 POST {baseURL}/chat/completions，所以通常是 openai-completions）：\n\n` +
              `  llm-pi-ai:\n    providers:\n      ${provider}:\n        api: ${PROBE_API}\n\n` +
              `注意：catalog 路由一旦显式声明 api，dsh 会改用协议实现而非 catalog provider 构造该路由，` +
              `随之不再自动注入 x-opencode-session 请求头。若你的网关要求该头（如 OpenCode Go），` +
              `请同时在路由里显式配置：\n\n` +
              `        headers:\n          x-opencode-session: <你的会话标识>\n`,
          )
        }
      } else {
        setStatus('writing', '无需写入（列表无变化）')
      }

      state.phase = 'done'
      state.detail = `完成：共 ${listed.length}，可用 ${nextModels.length}`
      state.finishedAt = Date.now()
      state.result = {
        serverCount: listed.length,
        configuredCount: nextModels.length,
        added,
        kept,
        removed,
        unavailable,
        // Models the server offers but this route cannot serve, because the
        // installed catalog does not describe them and the route names no
        // protocol. Surfaced rather than dropped silently: the sync still
        // lands everything else, and the user can admit these by adding `api`.
        skipped: undescribed.map((model) => ({
          id: model.id,
          reason: 'catalog 未收录，且路由未声明 api',
        })),
        written: changed,
      }
    } catch (error) {
      state.phase = 'error'
      state.error = String(error && error.message ? error.message : error)
      state.finishedAt = Date.now()
    }
  }

  let running = false

  // The routes only make sense under the web profile; ride a scoped inject so
  // a headless profile never waits on webServer.
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => {
      const json = (res, code, payload) => {
        const body = JSON.stringify(payload)
        res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(body)
      }
      scope.webServer.register({
        kind: 'exact',
        path: '/opencode-models/status',
        handler: (req, res) => {
          json(res, 200, {
            provider,
            ...state,
          })
        },
      })
      scope.webServer.register({
        kind: 'exact',
        path: '/opencode-models/refresh',
        handler: (req, res) => {
          if (running || (state.phase !== 'idle' && state.phase !== 'done' && state.phase !== 'error')) {
            json(res, 409, { started: false, error: '已有一次刷新在进行中' })
            return
          }
          running = true
          json(res, 200, { started: true })
          void run().finally(() => {
            running = false
          })
        },
      })
    })
  }

  ctx.logger?.info?.(`[dsh-opencode-models] ready: provider=${provider} routes=/opencode-models/{refresh,status}`)
}
