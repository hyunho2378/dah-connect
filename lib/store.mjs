// DAH Connect: 로컬 저장소.
// - host.json          이 컴퓨터의 ext_agent_host_id 와 설치 id (비밀 아님). 첫 로그인 전에 만들어 둔다.
// - registration.json  발급받은 client_id 와 계정 식별(sub, 이메일). 로그아웃해도 남긴다(문서: 다음 로그인에 재사용).
// - credentials.*      토큰(access, refresh, id). macOS 에서 키체인을 쓸 수 있으면 키체인에 둔 무작위 키로 암호화한 파일(credentials.enc),
//                      아니면 소유자만 읽는 파일(0600, credentials.json). 토큰은 이 두 곳 밖으로 나가지 않는다.
// - pairs.json         화면과 짝지은 비밀값의 해시(원문은 브라우저에만 있다)
// 문서: https://developers.openai.com/siwc/token-sharing-open-source/sign-in#5-store-credentials-in-a-local-file
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile as execFileCb, spawn } from 'node:child_process'

const SERVICE = 'DAH Connect'
const ACCOUNT = 'credentials-key'

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  await fs.writeFile(tmp, text, { mode: 0o600 })
  await fs.chmod(tmp, 0o600).catch(() => {})
  await fs.rename(tmp, file)
}

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (e) {
    if (e?.code === 'ENOENT') return null
    if (e instanceof SyntaxError) return null
    throw e
  }
}

const execFile = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFileCb(cmd, args, { timeout: 10000, ...opts }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), code: err?.code }))
  })

/** macOS `security` 명령. 비밀은 인자로 넘기지 않고 `security -i` 의 표준입력으로 넘긴다(ps 에 보이지 않게). */
export function macKeychain({ run = execFile, spawnImpl = spawn } = {}) {
  return {
    name: 'keychain',
    async get() {
      const r = await run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w'])
      return r.ok ? r.stdout.trim() || null : null
    },
    async set(value) {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('키체인에 넣을 수 없는 값입니다')
      return new Promise((resolve) => {
        const p = spawnImpl('security', ['-i'], { stdio: ['pipe', 'ignore', 'ignore'] })
        p.on('error', () => resolve(false))
        p.on('close', (code) => resolve(code === 0))
        p.stdin.end(`add-generic-password -U -s "${SERVICE}" -a "${ACCOUNT}" -w ${value}\n`)
      })
    },
    async del() {
      await run('security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT])
    },
  }
}

export function createStore({ dir, backend = 'auto', platform = process.platform, keychain } = {}) {
  if (!dir) throw new Error('저장 폴더가 필요합니다')
  const f = (n) => path.join(dir, n)
  let mode = null // 'keychain' | 'file'
  let kc = keychain || (platform === 'darwin' && backend !== 'file' ? macKeychain() : null)

  async function ensureDir() {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await fs.chmod(dir, 0o700).catch(() => {})
  }

  async function getMasterKey(create) {
    if (!kc) return null
    let k = await kc.get().catch(() => null)
    if (k) return Buffer.from(k, 'base64url')
    if (!create) return null
    const fresh = crypto.randomBytes(32).toString('base64url')
    if (!(await kc.set(fresh).catch(() => false))) return null
    // 저장이 실제로 됐는지 다시 읽어 확인한다
    k = await kc.get().catch(() => null)
    return k === fresh ? Buffer.from(fresh, 'base64url') : null
  }

  const seal = (key, obj) => {
    const iv = crypto.randomBytes(12)
    const c = crypto.createCipheriv('aes-256-gcm', key, iv)
    const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()])
    return JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') })
  }
  const open = (key, text) => {
    const j = JSON.parse(text)
    const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(j.iv, 'base64'))
    d.setAuthTag(Buffer.from(j.tag, 'base64'))
    return JSON.parse(Buffer.concat([d.update(Buffer.from(j.data, 'base64')), d.final()]).toString('utf8'))
  }

  const api = {
    dir,
    get mode() {
      return mode
    },

    async init() {
      await ensureDir()
      return api
    },

    /** 이 컴퓨터를 가리키는 변하지 않는 값. 문서: urn:uuid: + UUIDv4 를 호스트 생애 동안 한 번만 만든다. 첫 로그인 전에 만든다. */
    async hostInfo() {
      await ensureDir()
      let h = await readJson(f('host.json'))
      if (!h?.ext_agent_host_id || !/^urn:uuid:[0-9a-f-]{36}$/.test(h.ext_agent_host_id)) {
        h = { ext_agent_host_id: `urn:uuid:${crypto.randomUUID()}`, install_id: crypto.randomBytes(12).toString('base64url'), created_at: new Date().toISOString() }
        await writeAtomic(f('host.json'), JSON.stringify(h, null, 2))
      } else if (!h.install_id) {
        h.install_id = crypto.randomBytes(12).toString('base64url')
        await writeAtomic(f('host.json'), JSON.stringify(h, null, 2))
      }
      return h
    },

    async readRegistration() {
      return readJson(f('registration.json'))
    },
    async writeRegistration(reg) {
      await ensureDir()
      await writeAtomic(f('registration.json'), JSON.stringify(reg, null, 2))
    },

    async clearRegistration() {
      await fs.rm(f('registration.json'), { force: true })
    },

    async readCredentials() {
      const enc = await fs.readFile(f('credentials.enc'), 'utf8').catch(() => null)
      if (enc) {
        const key = await getMasterKey(false)
        if (!key) {
          const e = new Error('키체인에서 암호 키를 읽지 못했습니다. 다시 로그인하세요.')
          e.code = 'KEYCHAIN_LOST'
          throw e
        }
        try {
          mode = 'keychain'
          return open(key, enc)
        } catch {
          const e = new Error('저장된 로그인 정보를 읽지 못했습니다. 다시 로그인하세요.')
          e.code = 'KEYCHAIN_LOST'
          throw e
        }
      }
      const plain = await readJson(f('credentials.json'))
      if (plain) mode = 'file'
      return plain
    },

    async writeCredentials(cred) {
      await ensureDir()
      const key = await getMasterKey(true)
      if (key) {
        await writeAtomic(f('credentials.enc'), seal(key, cred))
        await fs.rm(f('credentials.json'), { force: true })
        mode = 'keychain'
      } else {
        await writeAtomic(f('credentials.json'), JSON.stringify(cred, null, 2))
        await fs.rm(f('credentials.enc'), { force: true })
        mode = 'file'
      }
    },

    async clearCredentials() {
      await fs.rm(f('credentials.enc'), { force: true })
      await fs.rm(f('credentials.json'), { force: true })
      mode = null
    },

    // ── 화면과의 짝짓기 ──
    async readPairs() {
      const j = await readJson(f('pairs.json'))
      return Array.isArray(j?.pairs) ? j.pairs : []
    },
    async writePairs(pairs) {
      await ensureDir()
      await writeAtomic(f('pairs.json'), JSON.stringify({ pairs }, null, 2))
    },

    /** 토큰 갱신처럼 두 프로그램이 동시에 하면 안 되는 일을 잠금 파일로 한 번에 하나만 하게 한다 */
    async withLock(name, fn, { timeoutMs = 20000, staleMs = 60000 } = {}) {
      await ensureDir()
      const lock = f(`${name}.lock`)
      const start = Date.now()
      for (;;) {
        try {
          const h = await fs.open(lock, 'wx', 0o600)
          await h.writeFile(String(process.pid))
          await h.close()
          break
        } catch (e) {
          if (e?.code !== 'EEXIST') throw e
          const st = await fs.stat(lock).catch(() => null)
          if (st && Date.now() - st.mtimeMs > staleMs) {
            await fs.rm(lock, { force: true })
            continue
          }
          if (Date.now() - start > timeoutMs) throw new Error('다른 DAH Connect 가 로그인 정보를 갱신하는 중입니다. 잠시 뒤 다시 시도하세요.')
          await new Promise((r) => setTimeout(r, 120))
        }
      }
      try {
        return await fn()
      } finally {
        await fs.rm(lock, { force: true })
      }
    },

    async deleteKeychainKey() {
      if (kc) await kc.del().catch(() => {})
    },
  }
  return api
}
