// 시험용 가짜 OpenAI(로컬 http). 문서에 적힌 주소와 규칙만 흉내 낸다:
//   /.well-known/openid-configuration, /.well-known/jwks.json, /api/accounts/authorize, /api/accounts/oauth/token,
//   revocation_endpoint, GET /v1/models, POST /v1/responses (store:false, stream:true 강제, 금지 필드 거절)
// 실제 OpenAI 가 아니다. 여기서 통과해도 실서버 동작은 사람이 직접 로그인해 확인해야 한다(README 의 시험 순서 참고).
import crypto from 'node:crypto'
import http from 'node:http'

const b64u = (b) => Buffer.from(b).toString('base64url')
const FORBIDDEN = ['background', 'conversation', 'max_output_tokens', 'max_tool_calls', 'metadata', 'moderation', 'multi_agent', 'prompt', 'prompt_cache_retention', 'safety_identifier', 'temperature', 'top_logprobs', 'top_p', 'truncation', 'user', 'previous_response_id']

export async function createFake() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fake-key-1', alg: 'RS256', use: 'sig' }
  const state = {
    mode: 'ok', // 'ok' | 'decline' | 'no_plan' | 'bad_nonce' | 'other_account'
    clients: new Map(), // client_id -> { sub, email }
    codes: new Map(), // code -> { client_id, challenge, redirect_uri, nonce, scope, resource }
    access: new Map(), // token -> { client_id, exp, sub }
    refresh: new Map(), // token -> { client_id, sub, used, revoked }
    requests: [], // { method, path, headers, body }
    authorizeQueries: [],
    revoked: [],
    tokenLifetime: 3600,
    refreshFails: null, // { status, body }
    subSeq: 1,
    nextSub: 'sub_alice',
    email: 'alice@example.com',
    responsesMode: {}, // model -> mode
    includeScopeInTokenResponse: true,
  }
  let base = ''

  const sign = (payload) => {
    const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'fake-key-1' }))
    const body = b64u(JSON.stringify(payload))
    const sig = crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey)
    return `${head}.${body}.${b64u(sig)}`
  }

  function issueTokens({ client_id, sub, email, nonce, scope }) {
    const now = Math.floor(Date.now() / 1000)
    const at = `at_${crypto.randomBytes(24).toString('hex')}`
    const rt = `rt_${crypto.randomBytes(24).toString('hex')}`
    state.access.set(at, { client_id, sub, exp: Date.now() + state.tokenLifetime * 1000 })
    state.refresh.set(rt, { client_id, sub, used: false, revoked: false })
    const res = {
      access_token: at,
      refresh_token: rt,
      token_type: 'Bearer',
      expires_in: state.tokenLifetime,
      earliest_refresh_at: new Date(Date.now() + (state.tokenLifetime - 600) * 1000).toISOString(),
    }
    if (state.includeScopeInTokenResponse) res.scope = scope
    if (nonce !== undefined) res.id_token = sign({ iss: base, aud: client_id, sub, email, nonce: state.mode === 'bad_nonce' ? 'WRONG' : nonce, iat: now, exp: now + 3600 })
    return res
  }

  const json = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'x-request-id': 'req_fake_1', ...headers })
    res.end(JSON.stringify(obj))
  }
  const readBody = async (req) => {
    const c = []
    for await (const x of req) c.push(x)
    return Buffer.concat(c).toString('utf8')
  }
  const bearerOk = (req) => {
    const m = /^Bearer (\S+)$/.exec(req.headers.authorization || '')
    const t = m && state.access.get(m[1])
    return t && t.exp > Date.now() ? t : null
  }

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x')
    const raw = req.method === 'POST' ? await readBody(req) : ''
    state.requests.push({ method: req.method, path: u.pathname, headers: { ...req.headers }, body: raw })

    if (u.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, { issuer: base, authorization_endpoint: `${base}/api/accounts/authorize`, token_endpoint: `${base}/api/accounts/oauth/token`, jwks_uri: `${base}/.well-known/jwks.json`, revocation_endpoint: `${base}/api/accounts/oauth/revoke` })
    }
    if (u.pathname === '/.well-known/jwks.json') return json(res, 200, { keys: [jwk] })

    if (u.pathname === '/api/accounts/authorize') {
      const q = Object.fromEntries(u.searchParams)
      state.authorizeQueries.push(q)
      const bad = (m) => json(res, 400, { error: 'invalid_request', error_description: m })
      if (q.response_type !== 'code') return bad('response_type')
      if (q.code_challenge_method !== 'S256' || !q.code_challenge) return bad('pkce')
      if (!/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/.test(q.redirect_uri || '')) return bad('redirect_uri')
      if (!q.state || !q.nonce) return bad('state/nonce')
      if (!/^urn:uuid:[0-9a-f-]{36}$/.test(q.ext_agent_host_id || '')) return bad('ext_agent_host_id')
      const dynamic = q.client_id === 'dynamic_agent_client'
      if (dynamic && !q.agent_name_hint) return bad('agent_name_hint')
      if (!dynamic && q.agent_name_hint) return bad('agent_name_hint on reauth')
      if (!dynamic && !state.clients.has(q.client_id)) return bad('unknown client')
      const want = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', 'chatgpt.tokens.use.direct']
      if ([...want].sort().join(' ') !== q.scope.split(' ').sort().join(' ')) return bad('scope')
      if (q.resource !== `${base}/v1`) return bad('resource')
      const redirect = new URL(q.redirect_uri)
      redirect.searchParams.set('state', q.state)
      if (state.mode === 'decline') {
        redirect.searchParams.set('error', 'access_denied')
        res.writeHead(302, { location: redirect.toString() })
        return res.end()
      }
      let client_id = q.client_id
      let sub = state.nextSub
      if (dynamic) {
        client_id = `oaiapp_${crypto.randomBytes(6).toString('hex')}`
        state.clients.set(client_id, { sub, email: state.email })
        redirect.searchParams.set('client_id', client_id)
      } else {
        sub = state.mode === 'other_account' ? 'sub_mallory' : state.clients.get(client_id).sub
      }
      const scope = state.mode === 'no_plan' ? 'email offline_access openid profile' : 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke'
      const code = `code_${crypto.randomBytes(12).toString('hex')}`
      state.codes.set(code, { client_id, sub, challenge: q.code_challenge, redirect_uri: q.redirect_uri, nonce: q.nonce, scope, resource: q.resource })
      redirect.searchParams.set('code', code)
      redirect.searchParams.set('scope', scope.split(' ').join('+'))
      res.writeHead(302, { location: redirect.toString().replace(/%2B/g, '+') })
      return res.end()
    }

    if (u.pathname === '/api/accounts/oauth/token' && req.method === 'POST') {
      const p = new URLSearchParams(raw)
      if (p.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(p.get('code'))
        state.codes.delete(p.get('code'))
        if (!c) return json(res, 400, { error: 'invalid_grant' })
        if (p.get('client_id') !== c.client_id || p.get('redirect_uri') !== c.redirect_uri || p.get('resource') !== c.resource) return json(res, 400, { error: 'invalid_grant', error_description: 'mismatch' })
        const challenge = crypto.createHash('sha256').update(p.get('code_verifier') || '').digest('base64url')
        if (challenge !== c.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'pkce' })
        const client = state.clients.get(c.client_id)
        return json(res, 200, issueTokens({ client_id: c.client_id, sub: c.sub, email: client.email, nonce: c.nonce, scope: c.scope }))
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (state.refreshFails) return json(res, state.refreshFails.status, state.refreshFails.body)
        if (p.get('resource') !== `${base}/v1`) return json(res, 400, { error: 'invalid_target' })
        if (p.has('scope')) return json(res, 400, { error: 'invalid_request', error_description: 'scope must be omitted' })
        const r = state.refresh.get(p.get('refresh_token'))
        if (!r || r.revoked || p.get('client_id') !== r.client_id) return json(res, 400, { error: 'invalid_grant' })
        if (r.used) return json(res, 400, { error: 'refresh_token_reused' })
        r.used = true
        const client = state.clients.get(r.client_id)
        return json(res, 200, issueTokens({ client_id: r.client_id, sub: r.sub, email: client.email, scope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke' }))
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }

    if (u.pathname === '/api/accounts/oauth/revoke' && req.method === 'POST') {
      const p = new URLSearchParams(raw)
      state.revoked.push({ token: p.get('token'), hint: p.get('token_type_hint'), client_id: p.get('client_id') })
      const r = state.refresh.get(p.get('token'))
      if (r) r.revoked = true
      res.writeHead(200)
      return res.end()
    }

    if (u.pathname === '/v1/models' && req.method === 'GET') {
      if (!bearerOk(req)) return json(res, 401, { detail: 'invalid token' })
      return json(res, 200, { models: [{ slug: 'gpt-fake-1', display_name: 'GPT Fake 1', visibility: 'list' }, { slug: 'gpt-hidden', display_name: 'Hidden', visibility: 'hide' }, { slug: 'gpt-fake-mini', display_name: 'GPT Fake Mini', visibility: 'list' }] })
    }

    if (u.pathname === '/v1/responses' && req.method === 'POST') {
      const tok = bearerOk(req)
      if (!tok) return json(res, 401, { detail: 'invalid or expired token' })
      let b
      try {
        b = JSON.parse(raw)
      } catch {
        return json(res, 400, { error: { code: 'invalid_json', message: 'bad json' } })
      }
      if (b.store !== false || b.stream !== true) return json(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param: b.store !== false ? 'store' : 'stream', message: 'store=false and stream=true required' } })
      for (const k of FORBIDDEN) if (k in b) return json(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param: k, message: `${k} not supported` } })
      if (!Array.isArray(b.input)) return json(res, 400, { error: { code: 'invalid_input', param: 'input', message: 'input must be array' } })
      if (b.input.some((i) => i.role === 'system' && (i.type === 'message' || i.type === undefined))) return json(res, 400, { error: { code: 'invalid_input', param: 'input', message: 'system role rejected' } })
      if (state.responsesMode.rejectFlatTools && Array.isArray(b.tools) && b.tools.some((t) => t.type === 'function')) return json(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'tools', message: 'group tools in namespaces' } })
      if (state.responsesMode.rejectInclude && 'include' in b) return json(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'include', message: 'include not supported' } })
      const mode = state.responsesMode[b.model] || 'ok'
      if (mode === 'limit') return json(res, 429, { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } })
      if (mode === 'ineligible') return json(res, 403, { error: { code: 'subscription_sharing_user_not_eligible', message: 'no' } })
      if (mode === 'detail503') return json(res, 503, { detail: 'direct route unavailable' })
      if (mode === 'unsupported') return json(res, 400, { error: { code: 'subscription_sharing_unsupported_capability', param: 'model', message: 'model not supported' } })
      res.writeHead(200, { 'content-type': 'text/event-stream', 'x-request-id': 'req_fake_2' })
      const ev = (o) => res.write(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)
      if (mode === 'limit-stream') {
        ev({ type: 'response.created', response: {} })
        ev({ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } })
        return res.end()
      }
      if (mode === 'cut') {
        ev({ type: 'response.output_text.delta', delta: '반쯤' })
        return res.end()
      }
      if (mode === 'incomplete') {
        ev({ type: 'response.output_text.delta', delta: '길어서 ' })
        ev({ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } })
        return res.end()
      }
      const gotToolResult = b.input.some((i) => i.type === 'function_call_output')
      if (b.tools?.length && !gotToolResult) {
        ev({ type: 'response.output_text.delta', delta: '고칩니다. ' })
        ev({ type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC' } })
        ev({ type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call_1', name: (b.tools[0].tools?.[0] || b.tools[0]).name, arguments: '{"find":"잇","replace":"있"}' } })
        ev({ type: 'response.completed', response: { usage: { input_tokens: 10, output_tokens: 5 } } })
        return res.end()
      }
      const last = b.input[b.input.length - 1]
      const text = gotToolResult ? `도구 결과를 받았습니다: ${String(last.output).slice(0, 40)}` : `에코: ${JSON.stringify(last.content).slice(0, 80)}`
      for (const part of text.match(/.{1,6}/gs)) ev({ type: 'response.output_text.delta', delta: part })
      ev({ type: 'response.completed', response: { usage: { input_tokens: 7, output_tokens: 3 } } })
      return res.end()
    }

    json(res, 404, { error: 'not found' })
  })

  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`

  return {
    url: base,
    apiBase: `${base}/v1`,
    state,
    expireAllAccess: () => state.access.forEach((v) => (v.exp = Date.now() - 1000)),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }),
    /** 브라우저 대신 인가 주소를 따라가서 콜백까지 호출한다 */
    async fakeBrowser(url) {
      const r1 = await fetch(url, { redirect: 'manual' })
      const loc = r1.headers.get('location')
      if (!loc) throw new Error(`authorize failed ${r1.status}`)
      const r2 = await fetch(loc, { redirect: 'manual' })
      await r2.text()
    },
  }
}
