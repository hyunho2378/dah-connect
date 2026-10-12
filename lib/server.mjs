// DAH Connect: 로컬 HTTP 서버(127.0.0.1 전용). 웹 화면이 이 서버를 AI 제공업체처럼 쓴다.
//   GET  /status   (비밀값 없이: 실행 중인지·짝짓기가 필요한지만. 비밀값이 있으면: 로그인 상태·제한·계정)
//   POST /pair     { code } -> { secret, installId }   연결 코드 6자리를 비밀값으로 바꾼다
//   POST /unpair   (Bearer)  이 브라우저의 비밀값을 지운다
//   GET  /models   (Bearer)  { models:[{id,name}], suggested }
//   POST /chat     (Bearer)  우리 AI 창 계약의 SSE (client/src/components/ai/README.md)
// 보안: 127.0.0.1 에만 묶는다 / Host 검사(DNS 리바인딩 방어) / Origin 허용 목록(그 밖은 403) / 모든 요청에 Bearer /
//       Private Network Access 사전 요청에 Access-Control-Allow-Private-Network 응답 / 본문 크기 한도 / 프롬프트·토큰은 기록하지 않는다.
import http from 'node:http'
import { DEFAULT_ORIGINS, HELP_URL, MAX_BODY_BYTES, MAX_CONCURRENT_CHATS, MAX_PAIR_BODY_BYTES, SERVE_PORTS, USAGE_URL, VERSION, APP_NAME } from './config.mjs'
import { ConnectError, scrub } from './errors.mjs'
import { bearerOf } from './pairing.mjs'
import { LIMITATIONS, parseChatBody } from './responses.mjs'

export function maskEmail(e) {
  const m = /^([^@]{1,})@(.+)$/.exec(String(e || ''))
  if (!m) return null
  return `${m[1].slice(0, 2)}${m[1].length > 2 ? '***' : '*'}@${m[2]}`
}

/** 허용 목록 항목: "https://a.b" 또는 "http://localhost:*"(포트 아무거나) */
export function originAllowed(origin, list) {
  if (typeof origin !== 'string' || origin === 'null') return false
  let o
  try {
    o = new URL(origin)
  } catch {
    return false
  }
  if (o.origin !== origin) return false // 경로·끝 슬래시가 붙은 이상한 값은 받지 않는다
  for (const entry of list) {
    if (entry.endsWith(':*')) {
      const base = entry.slice(0, -2)
      try {
        const b = new URL(base)
        if (b.protocol === o.protocol && b.hostname === o.hostname && o.port) return true
      } catch {
        /* 무시 */
      }
    } else if (entry === origin) return true
  }
  return false
}

export function hostAllowed(host, port) {
  const h = String(host || '').toLowerCase()
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`
}

class TooLarge extends Error {}

async function readBody(req, limit) {
  const len = Number(req.headers['content-length'])
  if (Number.isFinite(len) && len > limit) throw new TooLarge()
  const chunks = []
  let total = 0
  for await (const c of req) {
    total += c.length
    if (total > limit) throw new TooLarge()
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}

export function createLocalServer({ oauth, responses, store, pairing, host, origins = DEFAULT_ORIGINS, log = () => {}, ports = SERVE_PORTS, now = () => Date.now() } = {}) {
  let port = 0
  let activeChats = 0
  const allowList = [...origins]

  const corsHeaders = (req, origin) => {
    const h = {
      'access-control-allow-origin': origin,
      vary: 'Origin',
      'access-control-allow-headers': 'authorization, content-type, accept',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-max-age': '600',
      'access-control-expose-headers': 'x-dah-connect-version',
    }
    // Chrome 의 Private Network Access(사전 요청): 공개 사이트가 내 컴퓨터(loopback)를 부를 때 허락 신호를 돌려준다
    if (req.headers['access-control-request-private-network'] === 'true') h['access-control-allow-private-network'] = 'true'
    return h
  }

  const baseHeaders = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-dah-connect-version': VERSION, 'referrer-policy': 'no-referrer' }

  function sendJson(res, status, obj, extra = {}) {
    if (res.headersSent) return
    res.writeHead(status, { ...baseHeaders, 'content-type': 'application/json; charset=utf-8', ...extra })
    res.end(JSON.stringify(obj))
  }

  const errBody = (e) => ({
    error: e.message,
    code: e.code || 'UPSTREAM',
    ...(e.link ? { link: e.link } : {}),
    ...(e.param ? { param: e.param } : {}),
    ...(e.requestId ? { requestId: e.requestId } : {}),
    ...(e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {}),
  })

  async function authState() {
    const reg = await store.readRegistration().catch(() => null)
    let cred = null
    let lost = false
    try {
      cred = await store.readCredentials()
    } catch {
      lost = true
    }
    if (!reg?.client_id && !cred) return { state: 'not_logged_in', message: '아직 ChatGPT 로그인이 안 되어 있습니다. 연결 프로그램 창에서 로그인하세요.' }
    if (lost || !cred) return { state: 'reconnect', message: 'ChatGPT 로그인이 끊겼습니다. 연결 프로그램에서 다시 로그인하세요.', account: reg?.email }
    if (!cred.scopes?.includes('chatgpt.tokens.use.direct')) return { state: 'plan_disabled', message: '로그인은 되어 있지만 ChatGPT 요금제 사용을 허용하지 않았습니다. 다시 로그인해 허용하세요.', account: cred.email || reg?.email }
    return { state: 'ready', message: '', account: cred.email || reg?.email }
  }

  async function statusFull(pair) {
    const a = await authState()
    return {
      ok: true,
      app: APP_NAME,
      version: VERSION,
      installId: host.install_id,
      paired: true,
      pairedAt: pair?.created_at || null,
      state: a.state,
      loggedIn: a.state === 'ready' || a.state === 'plan_disabled',
      planUsage: a.state === 'ready',
      message: a.message,
      account: a.account ? { email: maskEmail(a.account) } : null,
      limitations: LIMITATIONS,
      usageUrl: USAGE_URL,
      helpUrl: HELP_URL,
    }
  }

  async function handle(req, res) {
    const started = now()
    const done = (status) => log(`${req.method} ${(req.url || '').split('?')[0]} -> ${status} (${now() - started}ms)`)
    res.on('finish', () => done(res.statusCode))

    // 1) Host 검사: IP 나 localhost 로 직접 부르는 요청만. 바깥 도메인이 내 컴퓨터를 가리키게 만드는 공격(DNS 리바인딩)을 막는다.
    if (!hostAllowed(req.headers.host, port)) return sendJson(res, 403, { error: '허용되지 않은 주소입니다', code: 'BAD_HOST' })

    // 2) Origin 검사: 브라우저가 붙인 Origin 이 허용 목록에 없으면 거절한다(CORS 헤더도 주지 않는다)
    const origin = req.headers.origin
    if (origin !== undefined && !originAllowed(origin, allowList)) return sendJson(res, 403, { error: '허용되지 않은 사이트입니다', code: 'ORIGIN_NOT_ALLOWED' })
    const cors = origin ? corsHeaders(req, origin) : {}

    if (req.method === 'OPTIONS') {
      if (!origin) return sendJson(res, 403, { error: '허용되지 않은 요청입니다', code: 'ORIGIN_NOT_ALLOWED' })
      res.writeHead(204, { ...baseHeaders, ...cors })
      return res.end()
    }

    let u
    try {
      u = new URL(req.url, `http://127.0.0.1:${port}`)
    } catch {
      return sendJson(res, 400, { error: '잘못된 주소입니다', code: 'BAD_REQUEST' }, cors)
    }
    const route = `${req.method} ${u.pathname}`

    try {
      if (route === 'GET /') {
        res.writeHead(200, { ...baseHeaders, ...cors, 'content-type': 'text/plain; charset=utf-8' })
        return res.end(`${APP_NAME} ${VERSION} 실행 중\n`)
      }

      // 짝짓기 전에도 부르는 두 경로
      if (route === 'POST /pair') {
        if (!/^application\/json/i.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'JSON 으로 보내세요', code: 'BAD_REQUEST' }, cors)
        let body
        try {
          body = JSON.parse((await readBody(req, MAX_PAIR_BODY_BYTES)).toString('utf8'))
        } catch (e) {
          return sendJson(res, e instanceof TooLarge ? 413 : 400, { error: e instanceof TooLarge ? '요청이 너무 큽니다' : '요청 형식이 올바르지 않습니다', code: e instanceof TooLarge ? 'TOO_LARGE' : 'BAD_REQUEST' }, cors)
        }
        const r = await pairing.tryPair(body?.code, { origin })
        if (r.ok) return sendJson(res, 200, { secret: r.secret, installId: host.install_id }, cors)
        if (r.reason === 'LOCKED') return sendJson(res, 429, { error: `코드를 여러 번 틀려 ${Math.ceil(r.retryAfterMs / 60000)}분 동안 잠겼습니다. 터미널에서 새 코드를 확인하세요.`, code: 'PAIR_LOCKED', retryAfterMs: r.retryAfterMs }, { ...cors, 'retry-after': String(Math.ceil(r.retryAfterMs / 1000)) })
        const msg = r.reason === 'NO_CODE' ? '유효한 연결 코드가 없습니다. 터미널에서 Enter 를 눌러 새 코드를 받으세요.' : `코드가 맞지 않습니다. ${r.attemptsLeft}번 더 틀리면 잠깁니다.`
        return sendJson(res, 401, { error: msg, code: 'BAD_CODE', attemptsLeft: r.attemptsLeft }, cors)
      }

      const secret = bearerOf(req)
      const pair = secret ? await pairing.verify(secret) : null

      if (route === 'GET /status') {
        if (!secret) return sendJson(res, 200, { ok: true, app: APP_NAME, version: VERSION, installId: host.install_id, paired: false }, cors)
        if (!pair) return sendJson(res, 401, { error: '연결 정보가 맞지 않습니다. 연결 코드를 다시 입력하세요.', code: 'UNAUTHORIZED', installId: host.install_id }, cors)
        return sendJson(res, 200, await statusFull(pair), cors)
      }

      // 이 아래는 모두 Bearer 필수
      if (!pair) return sendJson(res, 401, { error: '연결되어 있지 않습니다. 연결 코드를 입력하세요.', code: 'UNAUTHORIZED' }, cors)

      if (route === 'POST /unpair') {
        await pairing.revoke(secret)
        return sendJson(res, 200, { ok: true }, cors)
      }

      if (route === 'GET /models') {
        const r = await responses.listModels()
        return sendJson(res, 200, r, cors)
      }

      if (route === 'POST /chat') return await handleChat(req, res, cors)

      return sendJson(res, 404, { error: '없는 주소입니다', code: 'NOT_FOUND' }, cors)
    } catch (e) {
      if (e?.name === 'AbortError') return
      const ce = e instanceof ConnectError ? e : new ConnectError('UPSTREAM', '처리하지 못했습니다. 잠시 뒤 다시 시도하세요.', { status: 500 })
      return sendJson(res, ce.status || 502, errBody(ce), cors)
    }
  }

  async function handleChat(req, res, cors) {
    if (!/^application\/json/i.test(req.headers['content-type'] || '')) throw new ConnectError('BAD_REQUEST', 'JSON 으로 보내세요', { status: 415 })
    let parsed
    try {
      const raw = await readBody(req, MAX_BODY_BYTES)
      parsed = parseChatBody(JSON.parse(raw.toString('utf8')))
    } catch (e) {
      if (e instanceof TooLarge) throw new ConnectError('TOO_LARGE', '보낼 내용이 너무 큽니다. 문서 범위를 줄여 다시 시도하세요.', { status: 413 })
      if (e instanceof ConnectError) throw e
      throw new ConnectError('BAD_REQUEST', '요청 형식이 올바르지 않습니다', { status: 400 })
    }
    if (activeChats >= MAX_CONCURRENT_CHATS) throw new ConnectError('BUSY', '동시에 처리할 수 있는 요청 수를 넘었습니다. 잠시 뒤 다시 시도하세요.', { status: 429 })
    activeChats++
    const ac = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) ac.abort()
    }
    res.on('close', onClose)
    let ping = null
    try {
      const it = responses.stream({ ...parsed, signal: ac.signal })[Symbol.asyncIterator]()
      // 첫 이벤트를 받을 때까지는 아직 일반 JSON 오류로 답할 수 있다(계약: 연결이 열리기 전 실패는 JSON)
      let first
      first = await it.next()
      res.writeHead(200, { ...baseHeaders, ...cors, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive', 'x-accel-buffering': 'no' })
      res.flushHeaders?.()
      ping = setInterval(() => !res.writableEnded && res.write(': ping\n\n'), 15000)
      ping.unref?.()
      const write = (ev) => res.write(`data: ${JSON.stringify(ev)}\n\n`)
      try {
        let cur = first
        while (!cur.done) {
          write(cur.value)
          cur = await it.next()
        }
      } catch (e) {
        if (e?.name !== 'AbortError' && !ac.signal.aborted) {
          const ce = e instanceof ConnectError ? e : new ConnectError('UPSTREAM', '응답을 받는 중 오류가 났습니다. 다시 시도하세요.')
          write({ type: 'error', code: ce.code, message: ce.message, ...(ce.link ? { link: ce.link } : {}), ...(ce.param ? { param: ce.param } : {}), ...(ce.requestId ? { requestId: ce.requestId } : {}) })
        }
      }
      res.end()
    } finally {
      clearInterval(ping)
      res.off('close', onClose)
      activeChats--
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      log(`내부 오류 ${scrub(e?.message || '')}`)
      sendJson(res, 500, { error: '내부 오류가 났습니다', code: 'UPSTREAM' })
    })
  })
  server.headersTimeout = 20000
  server.requestTimeout = 0

  return {
    server,
    allowList,
    get port() {
      return port
    },
    /** 127.0.0.1 에만 묶는다. 포트가 사용 중이면 다음 포트로 */
    listen(candidates = ports) {
      return new Promise((resolve, reject) => {
        let i = 0
        const tryNext = () => {
          if (i >= candidates.length) return reject(new Error('사용할 수 있는 포트가 없습니다(47684~47688). 이미 DAH Connect 가 켜져 있는지 확인하세요.'))
          const p = candidates[i++]
          const onErr = (e) => {
            if (e?.code === 'EADDRINUSE') return tryNext()
            reject(e)
          }
          server.once('error', onErr)
          server.listen(p, '127.0.0.1', () => {
            server.off('error', onErr)
            port = server.address().port
            resolve(port)
          })
        }
        tryNext()
      })
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()) }),
  }
}
