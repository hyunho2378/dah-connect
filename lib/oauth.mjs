// DAH Connect: Sign in with ChatGPT (ChatGPT plan usage, 오픈소스 앱) 로그인·갱신·로그아웃.
// 따르는 문서:
//   sign-in            https://developers.openai.com/siwc/token-sharing-open-source/sign-in
//   profiles-and-sessions (갱신, 세션 종료)  https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
//   token-reference    https://developers.openai.com/siwc/token-sharing-open-source/token-reference
//   errors-and-recovery https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
// 문서에 없는 주소는 부르지 않는다: discovery 문서, 문서가 적은 authorize / token / JWKS / revocation 주소만 쓴다.
import crypto from 'node:crypto'
import http from 'node:http'
import { CALLBACK_PATH, DEFAULT_API_BASE, DEFAULT_ISSUER, DOC_CALLBACK_PORT, DOC_ENDPOINTS, DYNAMIC_CLIENT_ID, APP_NAME, PLAN_SCOPE, SCOPE, USER_AGENT } from './config.mjs'
import { ConnectError, readErrorBody, scrub } from './errors.mjs'
import { peekPayload, verifyIdToken } from './jwt.mjs'

const REFRESH_TERMINAL = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused'])
const REFRESH_MARGIN_MS = 5 * 60 * 1000 // 만료 5분 전부터 갱신한다
const rand = (n) => crypto.randomBytes(n).toString('base64url')
const sameOrigin = (a, b) => {
  try {
    return new URL(a).origin === new URL(b).origin
  } catch {
    return false
  }
}

/** earliest_refresh_at: 초 단위 숫자, 밀리초 숫자, ISO 문자열 모두 받는다(문서에 형식이 적혀 있지 않다) */
export function parseTime(v) {
  if (v === undefined || v === null || v === '') return null
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v))) {
    const n = Number(v)
    return n < 1e12 ? n * 1000 : n
  }
  const t = Date.parse(String(v))
  return Number.isFinite(t) ? t : null
}

export function createOAuth({ store, fetchImpl = globalThis.fetch, issuer = DEFAULT_ISSUER, apiBase = DEFAULT_API_BASE, now = () => Date.now() } = {}) {
  const isDev = issuer !== DEFAULT_ISSUER
  let discoveryCache = null
  let jwksCache = null
  let inflightRefresh = null

  async function http_(url, init = {}, { timeoutMs = 30000 } = {}) {
    const res = await fetchImpl(url, { ...init, headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers || {}) }, signal: init.signal || AbortSignal.timeout(timeoutMs), redirect: 'error' })
    return res
  }

  async function discover() {
    if (discoveryCache) return discoveryCache
    let d = null
    try {
      const res = await http_(`${issuer}/.well-known/openid-configuration`)
      if (res.ok) d = await res.json()
    } catch {
      /* 문서의 예시 주소로 대신한다 */
    }
    if (d && d.issuer !== issuer) throw new ConnectError('UPSTREAM', '로그인 서버 정보의 발급자가 맞지 않습니다', { status: 502 })
    if (!d) {
      if (isDev) throw new ConnectError('UPSTREAM', '로그인 서버 정보를 가져오지 못했습니다', { status: 502 })
      d = { ...DOC_ENDPOINTS }
    }
    // 모든 주소는 발급자와 같은 곳(origin)이어야 한다
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri', 'revocation_endpoint']) {
      if (d[k] && !sameOrigin(d[k], issuer)) throw new ConnectError('UPSTREAM', '로그인 서버 정보에 낯선 주소가 있어 중단했습니다', { status: 502 })
    }
    for (const k of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) if (!d[k]) d[k] = DOC_ENDPOINTS[k] && !isDev ? DOC_ENDPOINTS[k] : null
    discoveryCache = d
    return d
  }

  async function getJwks({ refresh } = {}) {
    if (jwksCache && !refresh && now() - jwksCache.at < 3600000) return jwksCache.set
    const d = await discover()
    const res = await http_(d.jwks_uri)
    if (!res.ok) throw new ConnectError('UPSTREAM', '서명 키를 가져오지 못했습니다', { status: 502 })
    jwksCache = { set: await res.json(), at: now() }
    return jwksCache.set
  }

  async function postForm(url, params) {
    const res = await http_(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      /* 본문이 JSON 이 아님 */
    }
    return { status: res.status, ok: res.ok, json, text, requestId: res.headers.get('openai-request-id') || res.headers.get('x-request-id') || undefined }
  }

  function readTokenResponse(j, savedAt) {
    const expiresIn = Number(j.expires_in) || 3600
    const earliest = parseTime(j.earliest_refresh_at)
    return {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      id_token: j.id_token,
      token_type: j.token_type || 'Bearer',
      expires_in: expiresIn,
      scope: typeof j.scope === 'string' ? j.scope : null,
      saved_at: new Date(savedAt).toISOString(),
      expires_at: savedAt + expiresIn * 1000,
      earliest_refresh_at: earliest ? new Date(earliest).toISOString() : null,
    }
  }

  const scopesOf = (...cands) => {
    for (const c of cands) if (typeof c === 'string' && c.trim()) return c.trim().split(/[\s+]+/).filter(Boolean).sort()
    return []
  }

  // ── 로그인 ────────────────────────────────────────────────
  /**
   * 브라우저 로그인. openBrowser(url) 은 시스템 브라우저를 여는 함수(시험에서는 가짜).
   * 반환: { status:'ok'|'declined'|'no_plan_scope', account, firstTime, clientId }
   */
  async function login({ openBrowser, onAuthUrl, reconsent = false, timeoutMs = 5 * 60 * 1000, preferredPort = DOC_CALLBACK_PORT } = {}) {
    const host = await store.hostInfo() // 첫 로그인 전에 호스트 id 를 만들어 저장한다
    const reg = await store.readRegistration()
    const oldCred = await store.readCredentials().catch(() => null)
    const d = await discover()
    const returning = Boolean(reg?.client_id)
    const clientIdForRequest = returning ? reg.client_id : DYNAMIC_CLIENT_ID

    const state = rand(32)
    const nonce = rand(32)
    const verifier = rand(64)
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url')

    // 콜백 서버를 브라우저를 열기 전에 먼저 띄운다(127.0.0.1 만)
    const cb = await startCallback({ state, timeoutMs, preferredPort })
    try {
      const q = {
        client_id: clientIdForRequest,
        ...(returning ? {} : { agent_name_hint: APP_NAME }), // 최초 등록 요청에만
        ext_agent_host_id: host.ext_agent_host_id,
        response_type: 'code',
        redirect_uri: cb.redirectUri,
        scope: SCOPE,
        resource: apiBase,
        state,
        nonce,
        code_challenge_method: 'S256',
        code_challenge: challenge,
      }
      if (returning && reg.email) q.login_hint = reg.email
      if (returning && oldCred?.id_token) q.id_token_hint = oldCred.id_token
      // 요금제 허용을 직접 다시 고르는 경우(문서: prompt=consent 는 계속 지원)
      if (reconsent || (returning && reg.planUsage === false)) q.prompt = 'consent'
      const url = new URL(d.authorization_endpoint)
      url.search = new URLSearchParams(q).toString()
      // 화면과 로그에는 id_token_hint 를 뺀 주소만 보인다(문서: 힌트가 든 주소는 로그에서 가린다)
      const shown = new URL(url)
      shown.searchParams.delete('id_token_hint')
      onAuthUrl?.(shown.toString())
      await openBrowser?.(url.toString(), shown.toString())

      const result = await cb.wait
      if (result.error) {
        if (result.error === 'access_denied') return { status: 'declined' }
        throw new ConnectError('LOGIN_FAILED', `로그인이 완료되지 않았습니다 (${scrub(result.error).slice(0, 60)})`, { status: 400 })
      }
      let clientId = clientIdForRequest
      if (returning) {
        if (result.client_id && result.client_id !== reg.client_id) throw new ConnectError('LOGIN_FAILED', '돌아온 client_id 가 저장된 것과 달라 중단했습니다', { status: 400 })
      } else {
        if (!result.client_id || result.client_id === DYNAMIC_CLIENT_ID) throw new ConnectError('LOGIN_FAILED', '등록이 끝나지 않았습니다(발급된 client_id 가 없습니다). 다시 시도하세요.', { status: 400 })
        clientId = result.client_id
      }

      const tr = await postForm(d.token_endpoint, { grant_type: 'authorization_code', client_id: clientId, code: result.code, code_verifier: verifier, redirect_uri: cb.redirectUri, resource: apiBase })
      if (!tr.ok || !tr.json?.access_token) {
        const eb = readErrorBody(tr.text)
        if (eb.code === 'invalid_grant') throw new ConnectError('LOGIN_FAILED', '인증 코드가 거절되었습니다. 처음부터 다시 로그인하세요.', { status: 400, requestId: tr.requestId })
        throw new ConnectError('LOGIN_FAILED', `토큰을 받지 못했습니다 (HTTP ${tr.status})`, { status: 502, requestId: tr.requestId })
      }
      const savedAt = now()
      const tok = readTokenResponse(tr.json, savedAt)
      if (typeof tok.id_token !== 'string') throw new ConnectError('LOGIN_FAILED', 'ID 토큰이 없어 로그인을 마치지 못했습니다', { status: 502 })

      let payload
      try {
        payload = await verifyIdToken(tok.id_token, { issuer: d.issuer || issuer, audience: clientId, nonce, getKeys: getJwks, now: savedAt })
      } catch (e) {
        throw new ConnectError('LOGIN_FAILED', `ID 토큰 검증에 실패했습니다 (${e.message})`, { status: 400 })
      }
      // 돌아온 계정이면 같은 사람인지 확인한 뒤에만 자격 증명을 바꾼다
      if (returning && reg.sub && reg.sub !== payload.sub) throw new ConnectError('LOGIN_FAILED', '이전에 연결한 ChatGPT 계정과 다른 계정입니다. 저장된 연결을 바꾸지 않았습니다. 같은 계정으로 로그인하거나 logout --forget 으로 지운 뒤 다시 하세요.', { status: 400 })

      const scopes = scopesOf(tok.scope, result.scope, peekPayload(tok.access_token)?.scope)
      const planUsage = scopes.includes(PLAN_SCOPE)
      if (planUsage && !tok.refresh_token) throw new ConnectError('LOGIN_FAILED', '갱신 토큰이 오지 않았습니다. 다시 로그인하세요.', { status: 502 })

      const firstTime = !reg?.welcomed_plan && planUsage
      await store.writeRegistration({
        client_id: clientId,
        issuer: d.issuer || issuer,
        sub: payload.sub,
        email: payload.email || reg?.email || null,
        ext_agent_host_id: host.ext_agent_host_id,
        planUsage,
        welcomed_plan: reg?.welcomed_plan || false,
        registered_at: reg?.registered_at || new Date(savedAt).toISOString(),
        last_login_at: new Date(savedAt).toISOString(),
      })
      await store.writeCredentials({
        email: payload.email || null,
        issuer: d.issuer || issuer,
        subject: payload.sub,
        client_id: clientId,
        ext_agent_host_id: host.ext_agent_host_id,
        id_token: tok.id_token,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        token_type: tok.token_type,
        expires_in: tok.expires_in,
        scopes,
        saved_at: tok.saved_at,
        expires_at: tok.expires_at,
        earliest_refresh_at: tok.earliest_refresh_at,
      })
      return { status: planUsage ? 'ok' : 'no_plan_scope', firstTime, clientId, account: { email: payload.email || null, sub: payload.sub } }
    } finally {
      cb.close()
    }
  }

  async function markWelcomed() {
    const reg = await store.readRegistration()
    if (reg && !reg.welcomed_plan) await store.writeRegistration({ ...reg, welcomed_plan: true })
  }

  // ── 토큰 갱신 ─────────────────────────────────────────────
  function needsRefresh(c, t = now()) {
    if (!c?.access_token) return true
    const exp = c.expires_at ?? parseTime(c.saved_at) + (c.expires_in || 3600) * 1000
    if (t >= exp) return true // 이미 만료
    const earliest = parseTime(c.earliest_refresh_at)
    if (earliest && t < earliest) return false // earliest_refresh_at 전에는 갱신하지 않는다
    return t >= exp - REFRESH_MARGIN_MS
  }

  async function doRefresh(staleAccess) {
    return store.withLock('refresh', async () => {
      const cred = await store.readCredentials()
      if (!cred?.refresh_token) throw new ConnectError('NOT_LOGGED_IN', 'ChatGPT 로그인이 필요합니다', { status: 409 })
      // 기다리는 동안 다른 프로그램이 이미 갱신했으면 그 결과를 쓴다
      if (staleAccess && cred.access_token !== staleAccess && !needsRefresh(cred)) return cred
      const d = await discover()
      let tr
      try {
        tr = await postForm(d.token_endpoint, { grant_type: 'refresh_token', client_id: cred.client_id, refresh_token: cred.refresh_token, resource: apiBase })
      } catch {
        throw new ConnectError('UPSTREAM', '로그인 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도하세요. (로그인 정보는 그대로 있습니다)', { status: 503 })
      }
      if (!tr.ok || !tr.json?.access_token) {
        const eb = readErrorBody(tr.text)
        if (tr.status >= 500 || tr.status === 429) throw new ConnectError('UPSTREAM', '로그인 서버가 잠시 응답하지 못했습니다. 잠시 뒤 다시 시도하세요. (로그인 정보는 그대로 있습니다)', { status: 503, requestId: tr.requestId })
        if (eb.code === 'invalid_client') throw new ConnectError('UPSTREAM', '이 연결의 클라이언트 설정이 거절되었습니다. logout --forget 후 다시 로그인하세요.', { status: 502, requestId: tr.requestId })
        if (REFRESH_TERMINAL.has(eb.code) || tr.status === 400 || tr.status === 401) {
          await store.clearCredentials() // 쓸 수 없는 토큰은 지운다. 등록 정보(client_id)는 남긴다
          throw new ConnectError('RECONNECT', 'ChatGPT 로그인이 끊겼습니다. 다시 로그인하세요.', { status: 401, requestId: tr.requestId })
        }
        throw new ConnectError('UPSTREAM', `토큰 갱신에 실패했습니다 (HTTP ${tr.status})`, { status: 502, requestId: tr.requestId })
      }
      const tok = readTokenResponse(tr.json, now())
      const scopes = scopesOf(tok.scope, peekPayload(tok.access_token)?.scope, cred.scopes?.join(' '))
      // 액세스 토큰·만료·권한·회전된 갱신 토큰을 함께 바꾼다
      const next = {
        ...cred,
        access_token: tok.access_token,
        refresh_token: tok.refresh_token || cred.refresh_token,
        id_token: tok.id_token || cred.id_token,
        token_type: tok.token_type,
        expires_in: tok.expires_in,
        scopes,
        saved_at: tok.saved_at,
        expires_at: tok.expires_at,
        earliest_refresh_at: tok.earliest_refresh_at,
      }
      await store.writeCredentials(next)
      return next
    })
  }

  /** 쓸 수 있는 액세스 토큰을 돌려준다. 필요하면 갱신한다(프로그램 안에서 한 번에 하나, 파일 잠금으로 프로그램 사이에서도 한 번에 하나) */
  async function getAccess({ force = false } = {}) {
    let cred
    try {
      cred = await store.readCredentials()
    } catch (e) {
      throw new ConnectError('NOT_LOGGED_IN', e.message, { status: 409 })
    }
    if (!cred?.access_token) throw new ConnectError('NOT_LOGGED_IN', 'ChatGPT 로그인이 필요합니다. 연결 프로그램에서 login 을 실행하세요.', { status: 409 })
    if (!cred.scopes?.includes(PLAN_SCOPE)) throw new ConnectError('PLAN_DISABLED', 'ChatGPT 요금제 사용이 허용되어 있지 않습니다. login 을 다시 실행해 허용하세요.', { status: 409 })
    if (force || needsRefresh(cred)) {
      inflightRefresh ||= doRefresh(cred.access_token).finally(() => {
        inflightRefresh = null
      })
      cred = await inflightRefresh
    }
    return { accessToken: cred.access_token, cred }
  }

  // ── 로그아웃 ──────────────────────────────────────────────
  /** 갱신 토큰을 철회(revocation_endpoint)한 뒤 로컬 토큰을 지운다. 철회를 확인하지 못해도 로컬은 지운다 */
  async function logout({ forget = false, sleepMs = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    let cred = null
    try {
      cred = await store.readCredentials()
    } catch {
      /* 읽을 수 없으면 지우기만 한다 */
    }
    let revoked = null // true 확인 | false 확인 못함 | null 철회할 토큰 없음
    if (cred?.refresh_token) {
      revoked = false
      try {
        const d = await discover()
        if (d.revocation_endpoint) {
          for (let i = 0; i < 3 && !revoked; i++) {
            try {
              const r = await postForm(d.revocation_endpoint, { token: cred.refresh_token, token_type_hint: 'refresh_token', client_id: cred.client_id })
              if (r.status === 200) revoked = true // 빈 200 이 성공(이미 무효인 토큰 포함)
              else if (r.status < 500 && r.status !== 429) break
            } catch {
              /* 네트워크 실패는 다시 시도 */
            }
            if (!revoked && i < 2) await sleepMs(500 * (i + 1) ** 2)
          }
        }
      } catch {
        /* 철회를 확인하지 못함 */
      }
    }
    await store.clearCredentials()
    if (forget) {
      await store.clearRegistration()
      await store.writePairs([])
      await store.deleteKeychainKey()
    }
    return { revoked }
  }

  return { discover, getJwks, login, logout, getAccess, needsRefresh, markWelcomed, apiBase }
}

// ── 로컬 콜백 서버 ───────────────────────────────────────────
// 127.0.0.1 에서만 듣는다. 경로·Host·state 가 맞는 요청 하나만 받고 닫힌다.
function startCallback({ state, timeoutMs, preferredPort }) {
  return new Promise((resolveStart, rejectStart) => {
    let finish
    const wait = new Promise((resolve, reject) => {
      finish = { resolve, reject }
    })
    let done = false
    let timer = null
    let port = 0
    const page = (title, body) =>
      `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${title}</title><body style="font-family:-apple-system,'Pretendard',sans-serif;background:#fff;color:#1f1f1f;display:grid;place-items:center;min-height:100vh;margin:0"><main style="max-width:420px;padding:32px"><h1 style="font-size:22px;margin:0 0 12px">${title}</h1><p style="color:#5f6368;line-height:1.6;margin:0">${body}</p></main></body></html>`
    const server = http.createServer((req, res) => {
      const send = (code, html) => {
        res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' })
        res.end(html)
      }
      if (req.headers.host !== `127.0.0.1:${port}`) return send(403, page('허용되지 않은 요청', '이 주소로는 열 수 없습니다.'))
      let u
      try {
        u = new URL(req.url, `http://127.0.0.1:${port}`)
      } catch {
        return send(400, page('잘못된 요청', ''))
      }
      if (req.method !== 'GET' || u.pathname !== CALLBACK_PATH) return send(404, page('찾을 수 없음', ''))
      if (done) return send(409, page('이미 처리됨', '이 로그인 시도는 이미 끝났습니다. 터미널을 확인하세요.'))
      const got = u.searchParams.get('state') || ''
      const a = Buffer.from(got)
      const b = Buffer.from(state)
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return send(400, page('확인할 수 없는 로그인', '이 로그인 시도와 맞지 않는 요청입니다. 터미널에서 login 을 다시 실행하세요.'))
      done = true
      clearTimeout(timer)
      const error = u.searchParams.get('error')
      if (error) {
        finish.resolve({ error })
        send(200, page('연결하지 않았습니다', '요금제 사용을 허용하지 않았거나 로그인이 취소되었습니다. 이 창을 닫아도 됩니다.'))
      } else if (!u.searchParams.get('code')) {
        finish.resolve({ error: 'missing_code' })
        send(400, page('인증 코드가 없습니다', '터미널에서 login 을 다시 실행하세요.'))
      } else {
        finish.resolve({ code: u.searchParams.get('code'), client_id: u.searchParams.get('client_id') || null, scope: u.searchParams.get('scope') || null })
        send(200, page('연결 요청을 받았습니다', '터미널로 돌아가 결과를 확인하세요. 이 창은 닫아도 됩니다.'))
      }
      setTimeout(() => server.close(), 200).unref()
    })
    const listen = (p, fallback) => {
      server.once('error', (e) => {
        if (fallback && e?.code === 'EADDRINUSE') return listen(0, false) // 문서: 이후 로그인은 다른 빈 포트도 가능
        rejectStart(e)
      })
      server.listen(p, '127.0.0.1', () => {
        port = server.address().port
        timer = setTimeout(() => {
          if (!done) {
            done = true
            finish.reject(new ConnectError('LOGIN_TIMEOUT', '시간 안에 로그인이 끝나지 않았습니다. 다시 시도하세요.', { status: 408 }))
            server.close()
          }
        }, timeoutMs)
        timer.unref?.()
        resolveStart({ redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`, port, wait, close: () => { clearTimeout(timer); server.close() } })
      })
    }
    listen(preferredPort, preferredPort !== 0)
  })
}
