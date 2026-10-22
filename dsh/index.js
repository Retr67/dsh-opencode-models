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
// The namespace llm-pi-ai is registered under its ENTRY ID, which is
// `ctx.fiber.entry?.options.id ?? 'llm-pi-ai'` on the adapter's side
// (llm-pi-ai/src/index.ts) and `entry.options.id` on the settings side.
// dsh's bundle manifest normally pins it to `llm-pi-ai`, but the loader falls
// back to a generated id when a row omits one, so a hardcoded NS can silently
// miss the section (false "no route") and make discoverModels throw
// NO_DISCOVERY — which would put back the all-or-nothing failure of issue #1.
// Resolve it from the live entries instead, and only fall back to the constant.

// The wire protocol every probe in this file speaks (POST {baseURL}/chat/completions).
// Named only in the repair hint for a route that declares no `api` — the plugin
// never writes it into settings; see step 6 for why that is the user's call.
const PROBE_API = 'openai-completions'

/** 1x1 transparent PNG used for the vision probe. */
const PING_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/**
 * Route-name suffix per wire protocol, for the companion routes that carry
 * catalog-undescribed models.
 *
 * Why companion routes at all: a route that names no `api` can only serve
 * models the installed catalog describes (issue #1), and a route that DOES name
 * one forces that protocol onto EVERY model on it — measured, after declaring
 * api the catalog metadata survives but grok-4.6/grok-4.7 (responses-only) and
 * claude-haiku-5-5 (anthropic-only) start answering 400 on completions. So one
 * route cannot hold both kinds.
 *
 * The split is chosen to keep metadata loss at zero: the main route (a real
 * catalog provider name) keeps the catalog-described models with their full
 * specs, and only catalog-undescribed models — which have no catalog metadata
 * to lose — move to these companion routes.
 */
const PROTO_SUFFIX = {
  'openai-completions': 'completions',
  'openai-responses': 'responses',
  'anthropic-messages': 'anthropic',
}

/**
 * Shipped defaults for the providers this plugin knows, used for exactly two
 * jobs: creating a missing route, and resolving a baseURL the route omits.
 *
 * `api` and `headers` are deliberately absent. A catalog-backed route must NOT
 * name `api`: that switches provider construction from the catalog provider —
 * which injects the gateway's per-conversation `x-opencode-session` header — to
 * the raw protocol implementation, and every chat request then fails. The
 * gateway's own config proves the minimal shape: this profile's entire
 * llm-pi-ai config is one `apiKeyEnv` line and chat works, because baseURL,
 * protocol and the session header all come from the installed catalog.
 */
const PROVIDER_DEFAULTS = {
  'opencode-go': {
    baseURL: 'https://opencode.ai/zen/go/v1',
    apiKeyEnv: 'OPENCODE_GO_API_KEY',
    // This gateway wants a session id on EVERY wire request: /models and all
    // three protocol endpoints answer 400 MissingSessionID without one
    // (measured 2026-10-22). dsh's catalog provider injects the per-conversation
    // id for chat, but the plugin issues its own requests, so it supplies a
    // stable one when the route does not. Used for probes only — never written
    // into the config, where a fixed value would replace the per-conversation
    // id that chat relies on.
    probedHeaders: { 'x-opencode-session': 'dsh-opencode-models' },
  },
}

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

  const modelsUrl = (baseURL) => baseURL.replace(/\/+$/, '') + '/models'

  /** List the server's model ids. Returns [{ id, raw }]. */
  async function listModels(baseURL, apiKey, extraHeaders) {
    const url = modelsUrl(baseURL)
    const response = await fetchWithRetry(
      url,
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
    // Read the body once, as text: a refusal body carries the reason, and a
    // gateway that answers 200 with an HTML error page would otherwise surface
    // as an opaque JSON parse error.
    const text = await response.text().catch(() => '')
    if (!response.ok) {
      const snippet = text.trim().slice(0, 200)
      throw new Error(
        `GET ${url} 返回 ${response.status}${snippet ? '：' + snippet : ''}\n` +
          `请检查该路由的 baseURL 是否正确、apiKeyEnv 指向的凭据是否有效。`,
      )
    }
    let body
    try {
      body = JSON.parse(text)
    } catch {
      throw new Error(
        `GET ${url} 返回的不是 JSON（前 200 字符）：${text.trim().slice(0, 200)}`,
      )
    }
    // OpenAI-compatible servers answer { data: [...] }; some aggregators use
    // { models: [...] } instead. Accept both, plus a bare array.
    const container = Array.isArray(body)
      ? body
      : Array.isArray(body?.data)
        ? body.data
        : Array.isArray(body?.models)
          ? body.models
          : undefined
    if (container === undefined) {
      const shape = body && typeof body === 'object' ? Object.keys(body).slice(0, 8).join(', ') : typeof body
      throw new Error(
        `GET ${url} 的响应里找不到模型数组（期望 data / models / 顶层数组，实际字段：${shape}）`,
      )
    }
    const seen = new Set()
    const listed = []
    for (const row of container) {
      const id = typeof row === 'string' ? row : row && row.id
      if (typeof id !== 'string' || id.length === 0 || seen.has(id)) continue
      seen.add(id)
      listed.push({ id, raw: typeof row === 'object' && row ? row : {} })
    }
    return listed
  }

  /**
   * The three wire protocols this gateway can expose a model on.
   *
   * dsh routes each model to the protocol named by the installed catalog (or,
   * for a catalog-undescribed id, by the route's `api`) — the plugin cannot
   * choose that and must not try to. It only needs to know whether a model
   * answers AT ALL, which means it has to speak all three.
   *
   * Probing just `openai-completions` misreads every model the catalog routes
   * elsewhere. Measured against the live gateway: chat/completions answers 400
   * `ModelProtocolUnsupported` for grok-4.6 and grok-4.7 (catalog:
   * openai-responses), claude-haiku-5-5 and minimax-m2.7 (anthropic-messages) —
   * and every one of them answers 200 on its own protocol. The old single-
   * protocol probe classified those working models as "served refused them" and
   * deleted them from the user's config.
   *
   * `anthropic-messages` also authenticates differently: it wants `x-api-key`
   * (Bearer answers 401 "Go requires a credential").
   */
  const PROTOCOLS = [
    {
      id: 'openai-completions',
      path: '/chat/completions',
      auth: (apiKey) => ({ Authorization: 'Bearer ' + apiKey }),
      body: (model, content) => ({ model, max_tokens: 1, messages: [{ role: 'user', content }] }),
      vision: (png) => [
        { type: 'text', text: 'hi' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } },
      ],
    },
    {
      id: 'openai-responses',
      path: '/responses',
      auth: (apiKey) => ({ Authorization: 'Bearer ' + apiKey }),
      body: (model, content) => ({ model, max_output_tokens: 16, input: content }),
      vision: (png) => [{
        role: 'user',
        content: [
          { type: 'input_text', text: 'hi' },
          { type: 'input_image', image_url: 'data:image/png;base64,' + png },
        ],
      }],
    },
    {
      id: 'anthropic-messages',
      path: '/messages',
      auth: (apiKey) => ({ 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }),
      body: (model, content) => ({ model, max_tokens: 1, messages: [{ role: 'user', content }] }),
      vision: (png) => [{
        role: 'user',
        content: [
          { type: 'text', text: 'hi' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } },
        ],
      }],
    },
  ]

  /** Whether a failure means "this endpoint isn't this model's protocol" rather than a verdict about the model. */
  function isWrongProtocol(probe) {
    if (probe.status === 404 || probe.status === 405) return true
    return /ModelProtocolUnsupported|does not support this protocol/i.test(String(probe.snippet || ''))
  }

  /** One tiny request on ONE protocol. */
  async function sendOnce(protocol, model, apiKey, baseURL, vision, extraHeaders) {
    const payload = protocol.body(model, vision ? protocol.vision(PING_PNG) : 'hi')
    const body = JSON.stringify(payload)
    try {
      const response = await fetchWithRetry(
        baseURL.replace(/\/+$/, '') + protocol.path,
        {
          method: 'POST',
          headers: {
            ...(extraHeaders || {}),
            ...protocol.auth(apiKey),
            'Content-Type': 'application/json',
          },
          body,
        },
        3,
        timeoutMs,
      )
      if (response.ok) return { status: response.status, kind: 'ok', protocol: protocol.id }
      let snippet = ''
      try {
        snippet = (await response.text()).slice(0, 300)
      } catch {
        /* body unreadable; status is enough */
      }
      return { status: response.status, kind: 'http', snippet, protocol: protocol.id }
    } catch (error) {
      return {
        status: 0,
        kind: 'network',
        message: String(error && error.message ? error.message : error),
        protocol: protocol.id,
      }
    }
  }

  /**
   * Probe one model, trying each protocol until one answers.
   * @param preferred - the protocol that already answered for this model.
   * @returns the first real verdict, carrying the protocol that produced it.
   */
  async function ping(model, apiKey, baseURL, vision, extraHeaders, preferred) {
    const ordered = preferred === undefined
      ? PROTOCOLS
      : [PROTOCOLS.find((p) => p.id === preferred), ...PROTOCOLS.filter((p) => p.id !== preferred)].filter(Boolean)
    let last
    for (const protocol of ordered) {
      const probe = await sendOnce(protocol, model, apiKey, baseURL, vision, extraHeaders)
      if (probe.kind === 'ok') return probe
      last = probe
      // A region block, an opt-in demand or a 5xx is a verdict about the model,
      // not a hint to try another endpoint.
      if (!isWrongProtocol(probe)) return probe
    }
    return last ?? { status: 0, kind: 'network', message: 'no protocol attempted' }
  }

  /**
   * Turn one probe into a verdict. The wording here matches what the live
   * gateway actually returns, which differs from the obvious guess:
   *   - a region block is 403 `RegionError` "not available in your country"
   *     (not a data-policy opt-in, which the old 403 => 'opt-in' rule claimed);
   *   - a data-policy opt-in is 400 "trains on request data" (not 403);
   *   - "ModelProtocolUnsupported" arrives as 400 and means only that THIS
   *     endpoint isn't the model's protocol — ping() already tried the others,
   *     so if it survives to here the model really is unavailable.
   */
  function classify(probe) {
    if (probe.kind === 'ok') return 'available'
    if (probe.kind === 'network') return 'unknown' // never a verdict by itself
    const text = String(probe.snippet || '')
    if (/RegionError|not available in your country|unsupported_country_region/i.test(text)) return 'region'
    if (/DataPolicy|trains on request data|Allow paid endpoints|opt[- ]?in/i.test(text)) return 'opt-in'
    if (probe.status === 402) return 'unknown' // "Endpoint is unavailable": not a verdict
    if (probe.status === 401) return 'rejected'
    if (probe.status === 403) return 'unknown' // forbidden for an unstated reason: keep
    if (probe.status === 404 || probe.status === 400) return 'rejected'
    if (probe.status >= 500) return 'flaky' // transient server fault: keep
    return 'unknown'
  }

  /**
   * The settings namespace llm-pi-ai is registered under its ENTRY ID, which is
   * `ctx.fiber.entry?.options.id ?? 'llm-pi-ai'` on the adapter's side and
   * `entry.options.id` on the settings side. dsh's bundle manifest normally pins
   * it to `llm-pi-ai`, but the loader falls back to a generated id when a row
   * omits one. A hardcoded NS would then miss the section (false "no route") and
   * make discoverModels throw NO_DISCOVERY, silently putting back the
   * all-or-nothing failure of issue #1. So find the live namespace, and only
   * fall back to the constant when nothing is visible.
   * @param rows - namespaces reported by settings.describe().
   * @returns the namespace to read and to pass to discoverModels.
   */
  function settingsNamespace(rows) {
    if (!Array.isArray(rows)) return NS
    const exact = rows.find((row) => row && row.ns === NS)
    if (exact) return NS
    // Otherwise recognise the adapter's section by what this plugin actually
    // needs from it: a providers dict that carries the target route. That is
    // precise enough that another plugin declaring an unrelated `providers`
    // field cannot be mistaken for it.
    const carriesRoute = rows.find((row) => {
      const providers = row && row.value && row.value.providers
      return providers && typeof providers === 'object' && provider in providers
    })
    if (carriesRoute) return carriesRoute.ns
    const shaped = rows.find((row) => {
      const value = row && row.value
      return value && typeof value === 'object' && 'providers' in value
    })
    return shaped ? shaped.ns : NS
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
      const described = ctx.settings.describe?.()
      const ns = settingsNamespace(described)
      const section = described?.find((row) => row.ns === ns)?.value
      // Three distinct faults used to share one sentence ("没有 X 路由（或缺少
      // baseURL）"), so the message could not tell you which one you had — and
      // it never told you which routes DO exist, which is the first thing you
      // need. Keep them apart.
      if (section === undefined) {
        throw new Error(
          `读不到 llm-pi-ai 的配置节（settings.describe() 里没有它的命名空间）。\n` +
            `这通常意味着 llm-pi-ai 适配器没有加载：检查它是否在当前 profile 里启用。`,
        )
      }
      const routes = Object.keys(section.providers ?? {})
      let route = section.providers?.[provider]
      let createdRoute = false
      if (route === undefined) {
        // The route does not exist. dsh can serve a catalog-backed provider from
        // just a credential reference, so a new user has nothing to copy from —
        // and being told "go write baseURL + apiKeyEnv yourself" is exactly the
        // friction this plugin exists to remove. Create it from the shipped
        // defaults, and only for a provider we actually know.
        const template = PROVIDER_DEFAULTS[provider]
        if (template === undefined) {
          throw new Error(
            `llm-pi-ai 里没有 "${provider}" 这个路由，插件也不认识这个 provider，无法自动创建。\n` +
              `现有路由：${routes.length > 0 ? routes.join('、') : '（一个都没有）'}\n` +
              `修法：在 llm-pi-ai.providers 下新增 "${provider}"（至少要有 baseURL 与 apiKeyEnv），` +
              `或把本插件的 provider 配置改成上面已有的路由名。`,
          )
        }
        // Write ONLY the two config fields. `probedHeaders` is a plugin-internal
        // default for its own requests; writing it would pin a fixed session id
        // into the user's config, replacing the per-conversation id chat uses.
        const written = { baseURL: template.baseURL, apiKeyEnv: template.apiKeyEnv }
        setStatus('listing', `自动创建路由 ${provider}…`)
        await ctx.settings.mutate(ns, [
          { op: 'set', path: ['providers', provider], value: written },
        ])
        route = { ...written }
        createdRoute = true
      }
      // A route may omit baseURL: a catalog-backed provider takes its baseUrl
      // from the installed catalog, so dsh chats fine without it — measured on
      // this profile, whose whole llm-pi-ai config is one `apiKeyEnv` line while
      // chat works. The plugin builds its own URLs, so it resolves the same
      // value locally instead of demanding config that dsh does not.
      const defaults = PROVIDER_DEFAULTS[provider] ?? {}
      const baseURL = (typeof route.baseURL === 'string' && route.baseURL.length > 0)
        ? route.baseURL
        : defaults.baseURL
      if (typeof baseURL !== 'string' || baseURL.length === 0) {
        throw new Error(
          `路由 "${provider}" 缺少 baseURL，插件也不知道这个 provider 的默认端点。\n` +
            `修法：在 llm-pi-ai.providers.${provider}.baseURL 配置它。`,
        )
      }
      const keyEnv = route.apiKeyEnv ? String(route.apiKeyEnv) : (defaults.apiKeyEnv ?? null)
      let apiKey = null
      if (keyEnv) {
        const resolved = await ctx.credentials.resolve(keyEnv)
        apiKey = resolved?.value || null
      }
      if (!apiKey) {
        throw new Error(
          `凭据 ${keyEnv || '(未配置 apiKeyEnv)'} 不可用。\n` +
            `修法：在 dsh 的设置里为该凭据填入 API key，或在路由里把 apiKeyEnv 指向已有的凭据名。`,
        )
      }
      const currentModels = Array.isArray(route.models) ? route.models : []
      const byId = new Map()
      for (const entry of currentModels) {
        if (entry && typeof entry.id === 'string') byId.set(entry.id, entry)
      }
      // Provider-level headers (e.g. an aggregator-gateway session id) apply
      // to every wire request the plugin makes, exactly as the llm adapter
      // applies them to chat calls. Gaps are filled from the shipped defaults,
      // so a minimal route (the `apiKeyEnv`-only shape dsh itself accepts) is
      // still probeable.
      const routeHeaders = {
        ...(route.headers && typeof route.headers === 'object' ? route.headers : {}),
      }
      for (const [name, value] of Object.entries(PROVIDER_DEFAULTS[provider]?.probedHeaders ?? {})) {
        const present = Object.keys(routeHeaders).some((key) => key.toLowerCase() === name.toLowerCase())
        if (!present) routeHeaders[name] = value
      }

      // 2. Server listing.
      setStatus('listing', '拉取 ' + baseURL + '/models…')
      const listed = await listModels(baseURL, apiKey, routeHeaders)
      if (listed.length === 0) {
        throw new Error('服务端 /models 返回空列表')
      }

      // 3. Probe availability, then vision for the available ones.
      const verdict = new Map() // id → { available, vision, note }
      setStatus('probing', `可用性探测 0/${listed.length}`)
      let doneCount = 0
      const availability = await mapLimit(listed, concurrency, async (row) => {
        const probe = await ping(row.id, apiKey, baseURL, false, routeHeaders)
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
          // The protocol that answered, so the vision probe asks the same
          // endpoint instead of re-discovering it.
          protocol: probe.protocol,
          message: note === 'unknown' && probe.message ? probe.message : probe.snippet,
        })
      }

      const availableIds = availability.filter(([, probe]) => classify(probe) === 'available').map(([id]) => id)
      if (availableIds.length > 0) {
        doneCount = 0
        setStatus('probing', `视觉探测 0/${availableIds.length}`)
        const visions = await mapLimit(availableIds, concurrency, async (id) => {
          const known = verdict.get(id)
          const probe = await ping(id, apiKey, baseURL, true, routeHeaders, known?.protocol)
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

      // 4b. Guard against a systemic cull. Losing most of the CONFIGURED models
      // that the server still advertises — and losing them all to HTTP
      // rejections — looks like a systemic fault (expired key, quota, or a
      // header the gateway newly requires) rather than a real cull. On
      // 2026-09-08 a missing header made the gateway 400 a subset and the sync
      // deleted 8 working models. Models the server stopped listing are a
      // genuine removal and are deliberately not counted here, so "下线模型自动
      // 移除" keeps working. Rescue by KEEPING them rather than aborting: the
      // rest of the sync still lands, and nothing is destroyed.
      const advertised = new Set(listed.map((row) => row.id))
      const configuredAdvertised = currentModels.filter((model) => model && advertised.has(model.id))
      const droppedByProbe = configuredAdvertised.filter((model) => {
        const v = verdict.get(model.id)
        return v !== undefined && !v.available && v.note !== 'flaky' && v.note !== 'unknown'
      })
      const systemicCull = droppedByProbe.length >= 3
        && droppedByProbe.length * 2 >= configuredAdvertised.length
      const rescued = new Set(systemicCull ? droppedByProbe.map((model) => model.id) : [])

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
            v.note === 'region'
              ? '地区不可用（403 RegionError）'
              : v.note === 'opt-in'
                ? '需要数据政策 opt-in（上游要求同意用请求数据训练）'
                : v.note === 'rejected'
                  ? '服务端明确拒绝（三个协议都尝试过）'
                  : v.note === 'flaky'
                    ? '5xx 暂时故障（保留）'
                    : '无法判定（保留）' + (v.message ? '：' + String(v.message).slice(0, 120) : '')
          const entry = byId.get(row.id)
          if (entry && (v.note === 'flaky' || v.note === 'unknown' || rescued.has(row.id))) {
            // Keep previously configured entries on flaky/unknown — do not
            // delete a working model because one probe hiccuped. Entries in
            // `rescued` are kept because the rejection pattern looked systemic
            // (see 4b) rather than like a real cull.
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
        // and is preserved by the spread above. The ladder itself is filled in
        // after the repair pass below, so a cleaned-up entry converges in ONE
        // run instead of gaining its ladder on the next sync.
        nextModels.push(model)
        if (existing) kept.push(row.id)
        else added.push(row.id)
      }
      for (const [id] of byId) {
        if (!listed.some((row) => row.id === id)) removed.push(id)
      }

      // Repair carried-over reasoningEfforts in place. A config synced by an
      // older version still holds `minimal: null`, and entries are preserved
      // field-by-field, so without this the SAME invalid value would be written
      // back and dsh would refuse every future sync — the user would be stuck
      // until they hand-edited YAML.
      for (const model of nextModels) {
        const efforts = model.reasoningEfforts
        if (efforts === null || typeof efforts !== 'object' || Array.isArray(efforts)) continue
        for (const level of Object.keys(efforts)) {
          if (level === 'off') continue
          if (efforts[level] === null || efforts[level] === '') delete efforts[level]
        }
        // Only "off" left is just as invalid ("offers no level beyond off"):
        // drop the field so the installed catalog's capability applies.
        if (!Object.keys(efforts).some((level) => level !== 'off')) delete model.reasoningEfforts
      }

      // Now declare the ladder for anything still unset — new models AND entries
      // whose illegal value the repair just removed. Doing it here (rather than
      // inside the merge loop) keeps one sync sufficient: a repair that erased an
      // empty/illegal map would otherwise read as "never declared" on the next
      // run and gain its ladder then, so config churned twice for one outcome.
      // Hide a rung by OMITTING it; only "off" may hold a null wire value.
      for (const model of nextModels) {
        if (model.reasoningEfforts === undefined) {
          model.reasoningEfforts = { low: 'low', medium: 'medium', high: 'high', max: 'max' }
        }
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
          const rows = await llm.discoverModels(ns, { provider })
          catalogIds = new Set((rows || []).map((row) => row && row.id).filter((id) => typeof id === 'string'))
        }
      } catch { catalogIds = null } // unknown: fall back to writing everything

      const undescribed = catalogIds !== null && route.api === undefined
        ? nextModels.filter((model) => !catalogIds.has(model.id))
        : []
      const writable = undescribed.length > 0
        ? nextModels.filter((model) => catalogIds.has(model.id))
        : nextModels

      // Companion routes: one per protocol, carrying only catalog-undescribed
      // models. They declare an `api` (so dsh can resolve a protocol for an id it
      // does not know) and therefore cannot be the catalog route — which is why
      // the described models stay behind on `provider`, where the catalog still
      // supplies their real specs, vision support and reasoning capability.
      // `verdict.protocol` is the endpoint that actually answered during probing,
      // so a model lands on the route that can serve it.
      const extraGroups = new Map() // routeName → { protocol, models, headers }
      if (undescribed.length > 0) {
        // The companion route has no catalog provider behind it, so nothing
        // injects this gateway's session header for chat — it has to be written
        // into the route. `routeHeaders` is the merged set (the user's own
        // headers plus the shipped probe default), which is exactly what chat
        // needs; the earlier `route.headers` here produced an empty object
        // whenever the main route omitted headers, and those 8 models would then
        // answer 400 on every chat.
        const baseHeaders = { ...routeHeaders }
        for (const model of undescribed) {
          const protocol = verdict.get(model.id)?.protocol
          const suffix = PROTO_SUFFIX[protocol]
          if (suffix === undefined) continue // unknown protocol: leave it skipped
          const name = `${provider}-${suffix}`
          if (!extraGroups.has(name)) extraGroups.set(name, { protocol, models: [], headers: baseHeaders })
          extraGroups.get(name).models.push(model)
        }
      }
      // A companion route that is no longer needed is emptied rather than
      // deleted: removing a provider entry is a bigger, harder-to-undo action
      // than leaving it serving nothing.
      for (const suffix of Object.values(PROTO_SUFFIX)) {
        const name = `${provider}-${suffix}`
        if (extraGroups.has(name)) continue
        if (section.providers?.[name] === undefined) continue
        const stale = section.providers[name]
        if (Array.isArray(stale.models) && stale.models.length === 0) continue
        extraGroups.set(name, { protocol: stale.api, models: [], headers: {}, retire: true })
      }

      const changed = JSON.stringify(currentModels) !== JSON.stringify(writable)
      if (changed && writable.length === 0) {
        // Nothing survived; writing an empty list would hand the route back to
        // the catalog defaults and drop the user's configured models. Refuse —
        // and name the ACTUAL cause. "every model is catalog-unknown" and
        // "every probe failed" need opposite fixes, so blaming the wrong one
        // sends the reader down the wrong path.
        const nothingProbed = nextModels.length === 0
        throw new Error(
          `服务端 ${listed.length} 个模型，没有一个能写入${nothingProbed ? '：全部未通过探测' : ''}。\n` +
            `写入空列表会把你已配置的模型丢回 catalog 默认值，因此本次未写入。\n` +
            (nothingProbed
              ? `常见原因：API key 无效或已过期（401）、订阅/配额失效（403）、baseURL 写错、` +
                `或网关要求额外请求头（如 x-opencode-session，需在路由的 headers 里配置）。\n` +
                `结果里的「服务端拒绝」分组列出了每个模型被拒的原因。`
              : `${undescribed.length} 个可用模型未被 dsh 内置 catalog 收录，而路由 ${provider} 没有声明 wire 协议，` +
                `dsh 无法为它们定协议。\n` +
                `修法：在该路由下加一行 api（本插件的探测走 POST {baseURL}/chat/completions，所以通常是 openai-completions）：\n\n` +
                `  llm-pi-ai:\n    providers:\n      ${provider}:\n        api: ${PROBE_API}\n\n` +
                `注意：catalog 路由一旦显式声明 api，dsh 会改用协议实现而非 catalog provider 构造该路由，` +
                `随之不再自动注入 x-opencode-session 请求头。若你的网关要求该头（如 OpenCode Go），请同时在路由里显式配置 headers。`),
        )
      }
      // Everything lands in ONE mutate so a refused companion route cannot leave
      // the main route half-written.
      const ops = []
      if (changed) {
        // A route that declares `api` but omits baseURL is refused by dsh for any
        // undescribed model ("needs a baseURL"). The plugin knows the endpoint,
        // so it completes the route in the same write rather than failing.
        ops.push({ op: 'set', path: ['providers', provider, 'models'], value: writable })
        if ((typeof route.baseURL !== 'string' || route.baseURL.length === 0) && defaults.baseURL) {
          ops.push({ op: 'set', path: ['providers', provider, 'baseURL'], value: defaults.baseURL })
        }
      }
      const extraReport = []
      for (const [name, group] of extraGroups) {
        // Preserve hand-edited entries by id, exactly like the main route does.
        const before = Array.isArray(section.providers?.[name]?.models) ? section.providers[name].models : []
        const beforeById = new Map(before.filter((m) => m && typeof m.id === 'string').map((m) => [m.id, m]))
        const merged = group.models.map((model) => ({ ...(beforeById.get(model.id) ?? {}), ...model }))
        const same = JSON.stringify(before) === JSON.stringify(merged)
        const routeValue = {
          api: group.protocol,
          baseURL,
          apiKeyEnv: keyEnv,
          ...(Object.keys(group.headers).length > 0 ? { headers: group.headers } : {}),
          models: merged,
        }
        if (!same || section.providers?.[name] === undefined) {
          ops.push({ op: 'set', path: ['providers', name], value: routeValue })
        }
        if (group.models.length > 0) {
          extraReport.push({
            provider: name,
            protocol: group.protocol,
            models: group.models.map((model) => model.id),
          })
        }
      }
      if (ops.length > 0) {
        setStatus('writing', `写入 settings（主路由 ${writable.length} 个模型${extraReport.length > 0 ? `，另有 ${extraReport.length} 条扩展路由` : ''}）…`)
        try {
          await ctx.settings.mutate(ns, ops)
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
      // Report what actually reached the file, not what was merely available.
      // `added`/`kept` are built while merging, BEFORE the catalog-undescribed
      // filter narrows `writable`, so an undescribed model was listed as BOTH
      // 新增 and 未纳入 — the same 8 models in two groups, under a
      // "本次配置 28 个" that was really 20. Counts must match the write.
      const extraIds = new Set(extraReport.flatMap((group) => group.models))
      const writtenIds = new Set([...writable.map((model) => model.id), ...extraIds])
      state.detail = `完成：共 ${listed.length}，写入 ${writable.length}${extraIds.size > 0 ? ` + 扩展路由 ${extraIds.size}` : ''} 个`
      state.finishedAt = Date.now()
      state.result = {
        serverCount: listed.length,
        configuredCount: writable.length,
        extraCount: extraIds.size,
        extraRoutes: extraReport,
        createdRoute,
        added: added.filter((id) => writtenIds.has(id)),
        kept: kept.filter((id) => writtenIds.has(id)),
        removed,
        unavailable,
        // Catalog-undescribed models that STILL could not be placed: only a
        // protocol this build has no companion route for. Normally empty, since
        // they now go to their own per-protocol route instead of being dropped.
        skipped: undescribed
          .filter((model) => !extraIds.has(model.id))
          .map((model) => ({
            id: model.id,
            reason: 'catalog 未收录，且无法为它确定可用的 wire 协议',
          })),
        written: ops.length > 0,
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
