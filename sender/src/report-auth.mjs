// 콘솔 로그인 — HTTP 로그인만. LOCO 세션 안 만든다
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const LIB = '../../../node_modules/agent-messenger/dist/src/platforms/kakaotalk/auth/kakao-login.js'
const DATA = join(process.cwd(), 'data', 'report')
const FILE = join(DATA, 'console-auth.json')
const DEVICE = 'SM-X710'

let cred = null
let pending = null

function load() {
  if (cred) return cred
  try { cred = JSON.parse(readFileSync(FILE, 'utf8')) } catch {}
  return cred
}
function save(c) {
  mkdirSync(DATA, { recursive: true })
  writeFileSync(FILE, JSON.stringify(c))
  cred = c
}
export const get = () =&gt; load()
export function clear() { cred = null; pending = null; try { writeFileSync(FILE, '{}') } catch {} }

async function auth() { return import(new URL(LIB, import.meta.url).href) }

export async function login(email, password, deviceType = 'tablet') {
  if (!email || !password) return { ok: false, message: '아이디·비번 필요' }
  const prev = load()
  const duuid = (prev &amp;&amp; prev.duuid) || randomUUID().replace(/-/g, '')
  const am = await auth()
  let r
  try { r = await am.attemptLogin(email, password, duuid, deviceType, false, null, DEVICE, DEVICE) }
  catch (e) { return { ok: false, message: String(e.message || e) } }

  const status = r &amp;&amp; r.status
  if (status === 0 &amp;&amp; r.oauthToken) {
    save({ oauthToken: r.oauthToken, userId: String(r.userId || ''), duuid, email, deviceType })
    return { ok: true, status, userId: String(r.userId || '') }
  }
  if (status === -100) {
    pending = { email, password, deviceType, duuid }
    let msg = '인증번호 요청됨'
    try {
      const pr = await am.requestPasscode(email, password, duuid, DEVICE, DEVICE)
      if (pr &amp;&amp; pr.message) msg = pr.message
    } catch (e) { msg = String(e.message || e) }
    return { ok: false, needPasscode: true, status, message: msg }
  }
  return { ok: false, status, message: (r &amp;&amp; r.message) || '로그인 실패' }
}

export async function passcode(code) {
  if (!pending) return { ok: false, message: '먼저 아이디·비번을 넣어라' }
  const { email, password, deviceType, duuid } = pending
  const am = await auth()
  try {
    const rg = await am.registerDevice(email, password, code, duuid, DEVICE, DEVICE)
    if (rg &amp;&amp; rg.status !== undefined &amp;&amp; rg.status !== 0) {
      return { ok: false, status: rg.status, message: rg.message || '기기 등록 실패' }
    }
  } catch (e) { return { ok: false, message: String(e.message || e) } }
  pending = null
  return login(email, password, deviceType)
}

export function me() {
  const c = load()
  if (!c || !c.oauthToken) return { loggedIn: false }
  return {
    loggedIn: true,
    userId: c.userId,
    email: String(c.email || '').replace(/^(.).*(@.*)$/, '$1***$2'),
    duuid: c.duuid,
  }
}