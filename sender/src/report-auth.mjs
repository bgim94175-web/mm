// 콘솔 로그인 — HTTP 로그인만. LOCO 세션 안 만든다
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const LIB = 'agent-messenger/dist/src/platforms/kakaotalk/auth/kakao-login.js'
const LIB_REL = '../node_modules/agent-messenger/dist/src/platforms/kakaotalk/auth/kakao-login.js'
const DATA = join(process.cwd(), 'data', 'report')
const FILE = join(DATA, 'console-auth.json')

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
export const get = () => load()
export function clear() { cred = null; pending = null; try { writeFileSync(FILE, '{}') } catch {} }

async function auth() {
  try { return await import(LIB) } catch {}
  return import(new URL(LIB_REL, import.meta.url).href)
}

export async function login(email, password, deviceType = 'tablet') {
  if (!email || !password) return { ok: false, message: '아이디·비번 필요' }
  const prev = load()
  const duuid = (prev && prev.duuid) || randomUUID().replace(/-/g, '')
  const am = await auth()

  let r
  try {
    r = await am.attemptLogin(email, password, duuid, deviceType === 'pc' ? 'pc' : 'tablet', false, null)
  } catch (e) { return { ok: false, message: String(e.message || e) } }

  if (r && r.authenticated && r.credentials) {
    const uid = String(r.user_id || r.account_id || r.credentials.user_id || '')
    save({
      oauthToken: r.credentials.access_token,
      refreshToken: r.credentials.refresh_token || '',
      userId: uid, duuid, email, deviceType,
    })
    return { ok: true, userId: uid }
  }

  if (r && r.next_action === 'provide_passcode') {
    pending = { email, password, deviceType, duuid }
    let msg = '새 기기 등록이 필요합니다'
    let showCode = ''
    try {
      const pr = await am.requestPasscode(email, password, duuid)
      if (pr && pr.passcode) {
        showCode = String(pr.passcode)
        msg = `폰 카카오톡에 뜨는 화면에서 이 인증번호를 입력하세요: ${showCode}\n입력한 뒤 아래 "확인"을 누르세요.`
      } else if (pr && pr.message) {
        msg = pr.message
      }
    } catch (e) { msg = String(e.message || e) }
    return { ok: false, needPasscode: true, showCode, message: msg }
  }

  return { ok: false, message: (r && r.message) || '로그인 실패' }
}

export async function passcode(code) {
  if (!pending) return { ok: false, message: '먼저 아이디·비번을 넣어라' }
  const { email, password, deviceType, duuid } = pending
  const am = await auth()
  try {
    const rg = await am.registerDevice(email, password, String(code || ''), duuid)
    if (rg && rg.error) {
      return { ok: false, message: rg.message || '기기 등록 실패' }
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