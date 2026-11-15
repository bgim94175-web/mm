// 콘솔 로그인 — HTTP 로그인만. LOCO 세션 안 만든다.
// 자격증명은 DATABASE_URL 이 있으면 Postgres(Neon), 없으면 로컬 파일.
import { randomUUID } from 'node:crypto'
import * as DB from './report-db.mjs'

const LIB = 'agent-messenger/dist/src/platforms/kakaotalk/auth/kakao-login.js'
const LIB_REL = '../node_modules/agent-messenger/dist/src/platforms/kakaotalk/auth/kakao-login.js'

let cred = null  // 메모리 캐시 — 부팅 후 preload() 로 채워짐
let pending = null

export async function preload() {
  try { cred = await DB.loadCred() } catch (e) { console.log('[auth] preload 실패: ' + (e && e.message)); cred = null }
  return cred
}

async function save(c) {
  cred = c
  try { await DB.saveCred(c) } catch (e) { console.log('[auth] 저장 실패: ' + (e && e.message)) }
}

export const get = () => cred
export async function clear() {
  cred = null; pending = null
  try { await DB.clearCred() } catch (e) {}
}

async function auth() {
  try { return await import(LIB) } catch {}
  return import(new URL(LIB_REL, import.meta.url).href)
}

export async function login(email, password, deviceType = 'tablet') {
  if (!email || !password) return { ok: false, message: '아이디·비번 필요' }
  const prev = cred
  const duuid = (prev && prev.duuid) || randomUUID().replace(/-/g, '')
  // duuid는 로그인→패스코드→기기등록→재로그인 전 과정에서 같아야 한다.
  // 성공 전에도 즉시 저장해 매 시도마다 새 기기가 생기는 무한 루프를 막는다.
  if (!prev || !prev.duuid) await save({ duuid })
  const am = await auth()

  let r
  try {
    r = await am.attemptLogin(email, password, duuid, deviceType === 'pc' ? 'pc' : 'tablet', false, null)
  } catch (e) { return { ok: false, message: String(e.message || e) } }

  if (r && r.authenticated && r.credentials) {
    const uid = String(r.user_id || r.account_id || r.credentials.user_id || '')
    if (!uid) return { ok: false, message: '로그인 성공했지만 userId 가 비어 있음 (서버 응답 이상)' }
    const c = {
      oauthToken: r.credentials.access_token,
      refreshToken: r.credentials.refresh_token || '',
      userId: uid, duuid, email, deviceType,
    }
    await save(c)
    // 다계정 테이블에도 primary 로 자동 등록 (실패해도 primary 로그인 자체는 성공 처리)
    try { await DB.saveAccount(Object.assign({}, c, { isPrimary: true, active: true })) }
    catch (e) { console.log('[auth] saveAccount(primary) 실패: ' + (e && e.message)) }
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
  const c = cred
  if (!c || !c.oauthToken) return { loggedIn: false }
  return {
    loggedIn: true,
    userId: c.userId,
    email: String(c.email || '').replace(/^(.).*(@.*)$/, '$1***$2'),
    duuid: c.duuid,
  }
}