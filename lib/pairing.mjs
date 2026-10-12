// DAH Connect: 웹 화면과 짝짓기.
// 터미널에 6자리 연결 코드가 나온다 -> 화면이 코드를 보내면 무작위 비밀값을 돌려준다 -> 이후 모든 요청이 그 비밀값을 Bearer 로 보낸다.
// 연결 프로그램은 비밀값의 SHA-256 해시만 저장한다(원문은 그 브라우저의 localStorage 에만 있다).
// 코드를 다섯 번 틀리면 코드를 없애고 5분 동안 짝짓기를 막는다(6자리는 100만 가지라 무차별 대입을 이 제한으로 막는다).
import crypto from 'node:crypto'
import { PAIR_CODE_TTL_MS, PAIR_LOCK_MS, PAIR_MAX_FAILS } from './config.mjs'

const sha = (s) => crypto.createHash('sha256').update(s).digest()
const SECRET_RE = /^[A-Za-z0-9_-]{43}$/

export function createPairing({ store, now = () => Date.now(), randomInt = crypto.randomInt, maxFails = PAIR_MAX_FAILS, lockMs = PAIR_LOCK_MS, ttlMs = PAIR_CODE_TTL_MS } = {}) {
  let code = null
  let expires = 0
  let fails = 0
  let lockedUntil = 0

  const api = {
    /** 새 연결 코드를 만든다(잠겨 있으면 만들지 않는다). 터미널에 보이려고 돌려준다 */
    issue() {
      if (now() < lockedUntil) return null
      code = String(randomInt(0, 1000000)).padStart(6, '0')
      expires = now() + ttlMs
      fails = 0
      return { code, expiresAt: expires }
    },
    get activeCode() {
      return code && now() < expires ? code : null
    },
    get lockedMs() {
      return Math.max(0, lockedUntil - now())
    },

    /** @returns {Promise<{ok:true, secret:string} | {ok:false, reason:'LOCKED'|'BAD_CODE'|'NO_CODE', retryAfterMs?:number, attemptsLeft?:number}>} */
    async tryPair(input, { origin } = {}) {
      const t = now()
      if (t < lockedUntil) return { ok: false, reason: 'LOCKED', retryAfterMs: lockedUntil - t }
      const live = code && t < expires ? code : null
      const given = String(input ?? '').replace(/\s+/g, '')
      const same = live && /^\d{6}$/.test(given) && crypto.timingSafeEqual(sha(given), sha(live))
      if (!same) {
        fails++
        if (fails >= maxFails) {
          code = null
          lockedUntil = t + lockMs
          fails = 0
          return { ok: false, reason: 'LOCKED', retryAfterMs: lockMs }
        }
        return { ok: false, reason: live ? 'BAD_CODE' : 'NO_CODE', attemptsLeft: maxFails - fails }
      }
      code = null // 한 번 쓰면 끝
      fails = 0
      const secret = crypto.randomBytes(32).toString('base64url')
      const pairs = await store.readPairs()
      pairs.push({ hash: sha(secret).toString('hex'), created_at: new Date(t).toISOString(), origin: origin || null })
      await store.writePairs(pairs.slice(-20))
      return { ok: true, secret }
    },

    async verify(secret) {
      if (typeof secret !== 'string' || !SECRET_RE.test(secret)) return null
      const h = sha(secret)
      const pairs = await store.readPairs()
      let hit = null
      for (const p of pairs) {
        const ph = Buffer.from(String(p.hash || ''), 'hex')
        if (ph.length === h.length && crypto.timingSafeEqual(ph, h)) hit = p // 끝까지 훑어 시간 차이를 줄인다
      }
      return hit
    },

    async revoke(secret) {
      if (typeof secret !== 'string' || !SECRET_RE.test(secret)) return false
      const h = sha(secret).toString('hex')
      const pairs = await store.readPairs()
      const next = pairs.filter((p) => p.hash !== h)
      if (next.length === pairs.length) return false
      await store.writePairs(next)
      return true
    },
  }
  return api
}

/** "Authorization: Bearer xxx" 에서 비밀값만 */
export function bearerOf(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''))
  return m ? m[1] : null
}
