// dsh-opencode-models — browser half.
//
// Adds an "OpenCode Go 模型同步" page to the dsh settings panel by
// registering the `settings.section` slot, and drives the host's
// /opencode-models endpoints: one button starts the refresh run, a poller
// renders live progress, and the finished run prints what was added, kept,
// removed, or rejected by the server.
//
// Hand-written in the lazy-CJS bundle protocol (window.__ModuleLoader__.load
// with a factory returning cordis-plugin exports), so no build step and no
// imports from dsh client packages — the same zero-dependency stance as the
// host half. React comes from the client runtime's shared require table
// (same pattern as dsh-plugin-manager).
//
// ⚠️ Slot rules (all verified on real runs):
//  - `settings.section` component contract is a **React function component**:
//    ui-renderer scoped-slots does `entry.component as FC` then <Comp/>.
//    Passing a conversation.view-style `() => ({render(){...}})` renderer
//    object renders an EMPTY page (project-guard hit this 2026-08-23; we
//    repeated it 2026-09-05 — hence this comment).
//  - register must carry the `name` field equal to the slot name, and the
//    module must export `inject = ['slots']`.
//  - register({ must stay brace-adjacent: the injector's skeleton check
//    regexes `register\(\{[\s\S]*?name: '...'`.
window.__ModuleLoader__.load({
  id: 'dsh-opencode-models',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')
    var h = React.createElement

    var SECTION_ID = 'opencode-models'
    var BUTTON_LABEL = '更新最新 OpenCode Go 模型列表'
    var REFRESH_URL = '/opencode-models/refresh'
    var STATUS_URL = '/opencode-models/status'

    var CSS = [
      '.dsh-om-scope{display:flex;flex-direction:column;gap:12px;max-width:720px;}',
      '.dsh-om-intro{font-size:12px;line-height:1.7;opacity:.8;}',
      '.dsh-om-row{display:flex;align-items:center;gap:10px;}',
      '.dsh-om-btn{cursor:pointer;border:none;border-radius:8px;padding:7px 14px;font-size:12px;font-weight:600;color:#fff;background:#2563eb;}',
      '.dsh-om-btn:hover:not(:disabled){background:#1d4ed8;}',
      '.dsh-om-btn:disabled{opacity:.55;cursor:default;}',
      '.dsh-om-busy{display:inline-flex;align-items:center;gap:6px;font-size:12px;opacity:.85;}',
      '@keyframes dsh-om-spin{to{transform:rotate(360deg)}}',
      '.dsh-om-spinner{display:inline-block;width:10px;height:10px;border-radius:50%;border:2px solid rgba(148,163,184,.4);border-top-color:#3b82f6;animation:dsh-om-spin .9s linear infinite;}',
      '.dsh-om-err{font-size:12px;line-height:1.5;padding:8px 10px;border-radius:8px;background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35);color:#f16a6a;white-space:pre-wrap;}',
      '.dsh-om-head{font-size:12px;line-height:1.6;}',
      '.dsh-om-group-title{font-size:11px;font-weight:600;opacity:.75;margin-top:6px;}',
      '.dsh-om-list{display:flex;flex-direction:column;gap:2px;}',
      '.dsh-om-item{display:flex;gap:8px;align-items:baseline;padding:1px 0;}',
      '.dsh-om-chip{flex:none;font-size:10px;padding:0 6px;border-radius:999px;border:1px solid transparent;}',
      '.dsh-om-code{font-size:11px;opacity:.9;}',
      '.dsh-om-tips{font-size:11px;line-height:1.6;opacity:.6;}',
    ].join('\n')

    var TONES = {
      add: { border: 'rgba(37,99,235,.45)', color: '#3b82f6' },
      keep: { border: 'rgba(148,163,184,.45)', color: 'inherit' },
      remove: { border: 'rgba(239,68,68,.45)', color: '#ef4444' },
      skip: { border: 'rgba(148,163,184,.45)', color: '#94a3b8' },
    }

    function isRunning(phase) {
      return phase === 'listing' || phase === 'probing' || phase === 'writing'
    }

    function ResultRow(props) {
      var item = props.item
      var id = typeof item === 'string' ? item : item.id
      var reason = item && typeof item === 'object' && item.reason ? ' — ' + item.reason : ''
      return h('div', { className: 'dsh-om-item' },
        h('span', {
          className: 'dsh-om-chip',
          style: { borderColor: TONES[props.tone].border, color: TONES[props.tone].color },
        }, props.tag),
        h('code', { className: 'dsh-om-code' }, id + reason),
      )
    }

    function ResultGroup(props) {
      var rows = props.rows
      if (!rows || rows.length === 0) return null
      return [
        h('div', { className: 'dsh-om-group-title', key: 'title' },
          props.title + '（' + rows.length + '）'),
        h('div', { className: 'dsh-om-list', key: 'list' },
          rows.map(function (item, i) {
            return h(ResultRow, { item: item, tone: props.tone, tag: props.tag, key: i })
          })),
      ]
    }

    function ResultBox(props) {
      var result = props.result
      var error = props.error
      if (error) {
        return h('div', { className: 'dsh-om-err' }, '刷新失败：' + error)
      }
      if (!result) return null
      return [
        h('div', { className: 'dsh-om-head', key: 'head' },
          '服务端共 ' + result.serverCount + ' 个模型，本次配置 ' + result.configuredCount + ' 个。' +
            (result.written ? '已写入 settings.yaml。' : '列表无变化，未写入。')),
        h(ResultGroup, { title: '新增', rows: result.added, tone: 'add', tag: 'ADD', key: 'g-add' }),
        h(ResultGroup, { title: '保留', rows: result.kept, tone: 'keep', tag: 'KEEP', key: 'g-keep' }),
        h(ResultGroup, { title: '移除', rows: result.removed, tone: 'remove', tag: 'REMOVE', key: 'g-remove' }),
        h(ResultGroup, { title: '服务端拒绝', rows: result.unavailable, tone: 'skip', tag: 'SKIP', key: 'g-skip' }),
      ]
    }

    var PHASE_TEXT = {
      listing: '拉取服务端模型列表…',
      writing: '写入配置…',
    }

    function OmSection() {
      var st = React.useState(null)
      var snapshot = st[0]
      var setSnapshot = st[1]
      var eb = React.useState('')
      var error = eb[0]
      var setError = eb[1]

      var timerRef = React.useRef(null)

      var stopPolling = React.useCallback(function () {
        if (timerRef.current) {
          clearInterval(timerRef.current)
          timerRef.current = null
        }
      }, [])

      var fetchStatus = React.useCallback(async function () {
        try {
          var response = await fetch(STATUS_URL, { headers: { Accept: 'application/json' } })
          var next = await response.json()
          setSnapshot(next)
          if (!isRunning(next.phase)) stopPolling()
        } catch (e) {
          stopPolling()
          setError('状态查询失败：' + String(e && e.message ? e.message : e))
        }
      }, [stopPolling])

      // Mount: restore the live/last snapshot; unmount: always stop polling.
      React.useEffect(function () {
        fetchStatus()
        return stopPolling
      }, [fetchStatus, stopPolling])

      // Poll while a run is in flight.
      var running = snapshot ? isRunning(snapshot.phase) : false
      React.useEffect(function () {
        if (running && !timerRef.current) timerRef.current = setInterval(fetchStatus, 1200)
        if (!running) stopPolling()
      }, [running, fetchStatus, stopPolling])

      function startRefresh() {
        if (running || timerRef.current) return
        setError('')
        fetch(REFRESH_URL, { method: 'POST' })
          .then(function (response) {
            if (!response.ok) {
              return response.json().then(function (body) {
                throw new Error(body.error || String(response.status))
              })
            }
            return fetchStatus()
          })
          .catch(function (e) {
            setError(String(e && e.message ? e.message : e))
          })
      }

      var phase = snapshot ? snapshot.phase : null
      var busyText = phase === 'listing'
        ? PHASE_TEXT.listing
        : phase === 'probing'
          ? (snapshot.detail || '探测模型可用性…')
          : phase === 'writing'
            ? (snapshot.detail || PHASE_TEXT.writing)
            : ''

      return h('div', { className: 'dsh-om-scope' },
        h('style', null, CSS),
        h('div', { className: 'dsh-om-intro' },
          '从 OpenCode Go 服务端拉取当前全部模型（GET /models），逐个实测可用性与视觉能力后，' +
            '把可用模型写回 llm-pi-ai 的 opencode-go 模型列表。已有条目的名称与容量保留；' +
            '服务端明确拒绝（400/401）或需要数据政策 opt-in 的模型不会进入列表。' +
            'dsh 内置的「获取可用模型」按钮读取的是打包在 pi-ai 里的静态快照，不含服务端新增模型——本页用于补齐。'),
        h('div', { className: 'dsh-om-row' },
          h('button', {
            className: 'dsh-om-btn',
            disabled: running,
            onClick: startRefresh,
          }, BUTTON_LABEL),
          running
            ? h('span', { className: 'dsh-om-busy' },
                h('span', { className: 'dsh-om-spinner' }),
                busyText)
            : null,
        ),
        error ? h('div', { className: 'dsh-om-err' }, error) : null,
        snapshot && phase !== 'error'
          ? h(ResultBox, { result: snapshot.result, error: null })
          : null,
        snapshot && phase === 'error'
          ? h('div', { className: 'dsh-om-err' }, '刷新失败：' + (snapshot.error || '未知错误'))
          : null,
        !snapshot
          ? h('div', { className: 'dsh-om-tips' }, '正在读取同步状态…')
          : null,
      )
    }

    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register({
                name: 'settings.section',
                id: SECTION_ID,
                order: 15,
                label: () => 'OpenCode Go 模型同步',
              }, OmSection),
          ),
        'dsh-opencode-models: settings.section',
      )
    }

    module.exports = { inject: ['slots'], apply: apply }
    return module.exports
  },
})
