// DAH Connect: ChatGPT 요금제로 부르는 Responses 어댑터.
// 논리는 server/src/lib/ai/openai.js (우리 서버의 OpenAI 어댑터)에서 순수 부분을 복사해 왔다. 이 폴더는 따로 배포되므로 서버 파일을 가져다 쓰지 않는다.
// 다른 점은 문서가 정한 요금제 사용 규칙이다:
//   모델 목록   GET  {api}/models      -> { models: [{ slug, display_name, visibility }] }, visibility == "list" 만, 서버가 준 순서 그대로
//   추론        POST {api}/responses   -> store:false, stream:true 필수, input 은 배열, system 역할 항목 금지(instructions 사용)
//   빼야 하는 필드: background, conversation, max_output_tokens, max_tool_calls, metadata, moderation, multi_agent, prompt,
//                   prompt_cache_retention, safety_identifier, temperature, top_logprobs, top_p, truncation, user, previous_response_id
//   지원하지 않는 도구: 이미지 생성, 파일 검색, Code Interpreter, 컴퓨터 사용, 호스팅 MCP/커넥터, tool_search
//   입력: 텍스트·이미지·파일(모델이 받을 때). 음성·영상, Files 업로드, 전사 API 는 안 된다.
//   종료: response.completed 를 받아야 성공. response.failed / response.incomplete / 끊김은 따로 처리한다.
// 문서: https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
//       https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
//       https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
import { USER_AGENT } from './config.mjs'
import { ConnectError, fromUpstream, readErrorBody } from './errors.mjs'

const MAX_STREAM_BYTES = 12 * 1024 * 1024
const DATA_URL_RE = /^data:(image\/(?:png|jpeg|webp));base64,[A-Za-z0-9+/=]+$/
export const cleanId = (id) => String(id || 'call').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'call'
const safeJson = (v) => {
  try {
    return JSON.stringify(v ?? {})
  } catch {
    return '{}'
  }
}
const parseJson = (s) => {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

/** 이 방식의 알려진 제한. /status 로 화면에 내려 보낸다 */
export const LIMITATIONS = Object.freeze({
  ignoredSettings: ['maxTokens', 'temperature'], // max_output_tokens, temperature 는 이 경로에서 거절되는 필드라 보내지 않는다
  unsupportedTools: ['image_generation', 'file_search', 'code_interpreter', 'computer_use', 'hosted_mcp', 'tool_search'],
  unsupportedInputs: ['audio', 'video'],
  notes: ['요청마다 이전 대화를 모두 다시 보냅니다(서버에 저장하지 않는 방식).', '사용할 수 있는 모델은 계정마다 다릅니다.'],
})

// ── 요청 본문 검사(웹 화면 -> 연결 프로그램) ─────────────────
const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/
export function parseChatBody(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) throw new ConnectError('BAD_REQUEST', '요청 형식이 올바르지 않습니다', { status: 400 })
  const model = typeof b.model === 'string' ? b.model.trim() : ''
  if (!model || model.length > 100 || !/^[\w.:/-]+$/.test(model)) throw new ConnectError('BAD_REQUEST', '모델을 고르세요', { status: 400 })
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 60) throw new ConnectError('BAD_REQUEST', '메시지가 없거나 너무 많습니다', { status: 400 })
  const messages = []
  for (const m of b.messages) {
    if (!m || typeof m !== 'object' || !['user', 'assistant', 'tool'].includes(m.role)) throw new ConnectError('BAD_REQUEST', '메시지 형식이 올바르지 않습니다', { status: 400 })
    const out = { role: m.role, content: typeof m.content === 'string' ? m.content : '' }
    if (m.role === 'user' && Array.isArray(m.images)) out.images = m.images.filter((u) => typeof u === 'string' && DATA_URL_RE.test(u)).slice(0, 4)
    if (m.role === 'assistant') {
      if (Array.isArray(m.toolCalls)) out.toolCalls = m.toolCalls.filter((t) => t && typeof t.name === 'string').slice(0, 24).map((t) => ({ id: String(t.id || ''), name: String(t.name), args: t.args && typeof t.args === 'object' ? t.args : {} }))
      if (m.meta && typeof m.meta === 'object') out.meta = m.meta
    }
    if (m.role === 'tool') out.toolCallId = String(m.toolCallId || '')
    messages.push(out)
  }
  let tools
  if (b.tools !== undefined) {
    if (!Array.isArray(b.tools) || b.tools.length > 24) throw new ConnectError('BAD_REQUEST', '도구 목록이 올바르지 않습니다', { status: 400 })
    tools = b.tools.map((t) => {
      if (!t || !NAME_RE.test(String(t.name))) throw new ConnectError('BAD_REQUEST', '도구 이름이 올바르지 않습니다', { status: 400 })
      return { name: t.name, description: String(t.description || '').slice(0, 2000), parameters: t.parameters && typeof t.parameters === 'object' ? t.parameters : { type: 'object', properties: {} } }
    })
  }
  const system = typeof b.system === 'string' ? b.system.slice(0, 60000) : ''
  return { model, messages, tools, system }
}

// ── 모델 목록 ────────────────────────────────────────────────
export function pickModels(json) {
  const list = Array.isArray(json?.models) ? json.models : []
  const models = list.filter((m) => m && m.visibility === 'list' && typeof m.slug === 'string' && m.slug).map((m) => ({ id: m.slug, name: m.display_name || m.slug }))
  return { models, suggested: models[0]?.id || null }
}

// ── 입력 변환(순수) ──────────────────────────────────────────
export function toInput(messages) {
  const input = []
  for (const m of messages) {
    if (m.role === 'user') {
      const content = []
      if (m.content) content.push({ type: 'input_text', text: m.content })
      for (const url of m.images || []) content.push({ type: 'input_image', image_url: url })
      if (content.length) input.push({ role: 'user', content })
    } else if (m.role === 'assistant') {
      if (Array.isArray(m.meta?.output) && m.meta.output.length) {
        input.push(...m.meta.output) // 이 경로가 만든 응답 항목은 그대로 되돌려 준다
      } else {
        if (m.content) input.push({ role: 'assistant', content: m.content })
        for (const t of m.toolCalls || []) input.push({ type: 'function_call', call_id: cleanId(t.id), name: t.name, arguments: safeJson(t.args) })
      }
    } else if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: cleanId(m.toolCallId), output: String(m.content ?? '') })
    }
  }
  return input
}

const fnTool = (t) => ({ type: 'function', name: t.name, description: t.description || '', parameters: t.parameters || { type: 'object', properties: {} }, strict: false })

/** 문서(preview-limitations)는 도구를 "네임스페이스로 묶거나 additional_tools 입력 항목으로" 주라고만 적었다(형식 예시 없음).
 *  먼저 일반 function 도구로 보내고, 이 경로가 도구 형식을 거절하면(unsupported_capability, param=tools) 네임스페이스로 묶어 한 번 더 보낸다. */
export function buildBody({ model, messages, system, tools, includeEncrypted = true, toolMode = 'flat' }) {
  const body = { model, input: toInput(messages), stream: true, store: false }
  if (system) body.instructions = system
  if (tools?.length) body.tools = toolMode === 'namespace' ? [{ type: 'namespace', name: 'dah_tools', description: '문서 편집 도구', tools: tools.map(fnTool) }] : tools.map(fnTool)
  if (includeEncrypted) body.include = ['reasoning.encrypted_content']
  return body
}

// ── SSE 읽기 ─────────────────────────────────────────────────
export async function* parseSse(res) {
  if (!res.body) return
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let total = 0
  const take = function* (final) {
    buf = buf.replace(/\r\n/g, '\n').replace(/\r(?!$)/g, '\n')
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0 || (final && buf.trim())) {
      const raw = idx >= 0 ? buf.slice(0, idx) : buf
      buf = idx >= 0 ? buf.slice(idx + 2) : ''
      let event = ''
      const data = []
      for (const line of raw.split('\n')) {
        if (!line || line.startsWith(':')) continue
        const c = line.indexOf(':')
        const field = c < 0 ? line : line.slice(0, c)
        const value = c < 0 ? '' : line.slice(c + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }
      if (data.length || event) yield { event, data: data.join('\n') }
    }
  }
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > MAX_STREAM_BYTES) throw new ConnectError('UPSTREAM', '응답이 너무 깁니다.', { status: 502 })
      buf += dec.decode(value, { stream: true })
      yield* take(false)
    }
    buf += dec.decode()
    yield* take(true)
  } finally {
    reader.cancel().catch(() => {})
  }
}

// ── 어댑터 ───────────────────────────────────────────────────
export function createResponses({ oauth, fetchImpl = globalThis.fetch, apiBase }) {
  let toolMode = 'flat'
  let modelCache = null

  const requestIdOf = (res) => res.headers.get('openai-request-id') || res.headers.get('x-request-id') || undefined

  async function authed(path, init, { signal } = {}) {
    // 401 이면 토큰을 한 번 강제로 갱신하고 다시 시도한다(문서: 확인된 철회·갱신 실패일 때만 다시 로그인)
    for (let attempt = 0; attempt < 2; attempt++) {
      const { accessToken } = await oauth.getAccess({ force: attempt === 1 })
      let res
      try {
        res = await fetchImpl(`${apiBase}${path}`, { ...init, headers: { ...(init.headers || {}), authorization: `Bearer ${accessToken}`, 'user-agent': USER_AGENT }, signal, redirect: 'error' })
      } catch (e) {
        if (e?.name === 'AbortError' || signal?.aborted) throw e
        throw new ConnectError('UPSTREAM', 'ChatGPT 서버에 연결하지 못했습니다. 네트워크를 확인하세요.', { status: 503 })
      }
      if (res.status === 401 && attempt === 0) {
        await res.body?.cancel?.().catch(() => {})
        continue
      }
      return res
    }
    throw new ConnectError('RECONNECT', '로그인 정보를 받아들이지 않았습니다. 다시 로그인하세요.', { status: 401 })
  }

  async function failFrom(res) {
    let raw = ''
    try {
      raw = (await res.text()).slice(0, 4000)
    } catch {
      /* 본문 없음 */
    }
    const eb = readErrorBody(raw)
    return { err: fromUpstream({ status: res.status, ...eb, requestId: requestIdOf(res) }), eb }
  }

  async function listModels({ signal } = {}) {
    if (modelCache && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.value
    const res = await authed('/models', { method: 'GET', headers: { accept: 'application/json' } }, { signal })
    if (!res.ok) throw (await failFrom(res)).err
    const value = pickModels(await res.json().catch(() => null))
    modelCache = { at: Date.now(), value }
    return value
  }
  const clearModelCache = () => {
    modelCache = null
  }

  async function open(args, signal, { includeEncrypted, mode }) {
    const body = buildBody({ ...args, includeEncrypted, toolMode: mode })
    return authed('/responses', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'text/event-stream' }, body: JSON.stringify(body) }, { signal })
  }

  async function* stream({ model, messages, system, tools, signal }) {
    const args = { model, messages, system, tools }
    let includeEncrypted = true
    let res = await open(args, signal, { includeEncrypted, mode: toolMode })
    for (let retry = 0; retry < 2 && res.status === 400; retry++) {
      const { err, eb } = await failFrom(res)
      const text = `${eb.message || ''} ${eb.detail || ''} ${eb.param || ''}`
      if (includeEncrypted && (/encrypted|include/i.test(text) || (err.code === 'UNSUPPORTED' && /include/.test(err.param || '')))) {
        includeEncrypted = false // 추론하지 않는 모델이나 이 경로가 받지 않는 필드
      } else if (tools?.length && toolMode === 'flat' && err.code === 'UNSUPPORTED' && /tool/.test(err.param || '')) {
        toolMode = 'namespace'
      } else {
        throw err
      }
      res = await open(args, signal, { includeEncrypted, mode: toolMode })
    }
    if (!res.ok) throw (await failFrom(res)).err

    const rid = requestIdOf(res)
    const output = []
    let sawTool = false
    for await (const ev of parseSse(res)) {
      const d = parseJson(ev.data)
      if (!d) continue
      switch (d.type) {
        case 'response.output_text.delta':
        case 'response.refusal.delta':
          if (d.delta) yield { type: 'text', delta: d.delta }
          break
        case 'response.output_item.done': {
          const it = d.item
          if (!it) break
          if (it.type === 'function_call') {
            sawTool = true
            output.push(it)
            yield { type: 'tool_call', id: it.call_id, name: it.name, args: parseJson(it.arguments || '{}') || {} }
          } else if (it.type === 'reasoning') {
            if (it.encrypted_content) output.push(it)
          } else if (it.type === 'message') {
            output.push(it)
          }
          break
        }
        case 'response.completed': {
          const r = d.response || {}
          const usage = r.usage ? { inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0 } : undefined
          yield { type: 'done', stopReason: sawTool ? 'tool_use' : 'end', ...(usage ? { usage } : {}), ...(sawTool && output.length ? { meta: { output } } : {}) }
          return
        }
        case 'response.incomplete': {
          const r = d.response || {}
          const reason = String(r.incomplete_details?.reason || '')
          if (/max_output_tokens|length/.test(reason)) {
            const usage = r.usage ? { inputTokens: r.usage.input_tokens ?? 0, outputTokens: r.usage.output_tokens ?? 0 } : undefined
            yield { type: 'done', stopReason: sawTool ? 'tool_use' : 'length', ...(usage ? { usage } : {}), ...(sawTool && output.length ? { meta: { output } } : {}) }
            return
          }
          throw new ConnectError('UPSTREAM', `응답이 끝까지 만들어지지 않았습니다${reason ? ` (${reason.slice(0, 60)})` : ''}. 다시 시도하세요.`, { status: 502, requestId: rid })
        }
        case 'response.failed': {
          const e = d.response?.error || {}
          throw fromUpstream({ status: 502, code: e.code, param: e.param, message: e.message, requestId: rid })
        }
        case 'error':
          throw fromUpstream({ status: 502, code: d.code || d.error?.code, param: d.param || d.error?.param, message: d.message || d.error?.message, requestId: rid })
        default:
          break
      }
    }
    throw new ConnectError('UPSTREAM', '응답이 중간에 끊겼습니다. 다시 시도하세요.', { status: 502, requestId: rid })
  }

  return { listModels, clearModelCache, stream, get toolMode() { return toolMode } }
}
