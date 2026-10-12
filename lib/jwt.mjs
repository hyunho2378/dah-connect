// ID 토큰 검증(외부 라이브러리 없이 node:crypto). 문서(sign-in 4단계, website 6단계)가 요구하는 검사:
// 서명(JWKS), iss, aud(발급받은 client_id), exp, nonce.
import crypto from 'node:crypto'

const b64u = (s) => Buffer.from(s, 'base64url')

export function decodeJwt(token) {
  const parts = String(token || '').split('.')
  if (parts.length !== 3) throw new Error('토큰 형식이 올바르지 않습니다')
  try {
    return { header: JSON.parse(b64u(parts[0]).toString('utf8')), payload: JSON.parse(b64u(parts[1]).toString('utf8')), signingInput: `${parts[0]}.${parts[1]}`, signature: b64u(parts[2]) }
  } catch {
    throw new Error('토큰을 읽지 못했습니다')
  }
}

/** 서명을 확인하지 않고 본문만 읽는다(권한 판단에 쓰지 않는다. 예: 만료 시각 참고) */
export function peekPayload(token) {
  try {
    return decodeJwt(token).payload
  } catch {
    return null
  }
}

const ALGS = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC', dsa: 'ieee-p1363' },
  ES384: { hash: 'sha384', kty: 'EC', dsa: 'ieee-p1363' },
}

export class JwtError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * @param {string} idToken
 * @param {{ issuer: string, audience: string, nonce: string, getKeys: (opts:{refresh:boolean}) => Promise<{keys:object[]}>, now?: number, skewSec?: number }} o
 * @returns payload
 */
export async function verifyIdToken(idToken, { issuer, audience, nonce, getKeys, now = Date.now(), skewSec = 5 }) {
  const t = decodeJwt(idToken)
  const alg = ALGS[t.header.alg]
  if (!alg) throw new JwtError('ALG', '지원하지 않는 서명 방식입니다') // none, HS* 는 받지 않는다
  const pick = (set) => (set.keys || []).find((k) => k.kty === alg.kty && (!t.header.kid || k.kid === t.header.kid) && (!k.use || k.use === 'sig'))
  let jwk = pick(await getKeys({ refresh: false }))
  if (!jwk) jwk = pick(await getKeys({ refresh: true })) // 처음 보는 kid 면 키를 다시 받는다
  if (!jwk) throw new JwtError('KEY', '서명 키를 찾지 못했습니다')
  const key = crypto.createPublicKey({ key: jwk, format: 'jwk' })
  const ok = crypto.verify(alg.hash, Buffer.from(t.signingInput), { key, ...(alg.pss ? { padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST } : {}), ...(alg.dsa ? { dsaEncoding: alg.dsa } : {}) }, t.signature)
  if (!ok) throw new JwtError('SIGNATURE', '서명이 맞지 않습니다')
  const p = t.payload
  if (p.iss !== issuer) throw new JwtError('ISS', '발급자가 맞지 않습니다')
  const auds = Array.isArray(p.aud) ? p.aud : [p.aud]
  if (!auds.includes(audience)) throw new JwtError('AUD', '대상(client_id)이 맞지 않습니다')
  const nowSec = Math.floor(now / 1000)
  if (typeof p.exp !== 'number' || p.exp + skewSec < nowSec) throw new JwtError('EXP', '토큰이 만료되었습니다')
  if (typeof p.iat === 'number' && p.iat - skewSec > nowSec + 60) throw new JwtError('IAT', '토큰 발급 시각이 올바르지 않습니다')
  if (!nonce || p.nonce !== nonce) throw new JwtError('NONCE', 'nonce 가 맞지 않습니다')
  if (typeof p.sub !== 'string' || !p.sub) throw new JwtError('SUB', '계정 식별자가 없습니다')
  return p
}
