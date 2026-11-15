// 다계정 관리 — HTTP 신고 fanout 용. primary 계정 (LOCO 세션) 과 별개로 N 개의
// oauth 토큰을 추가 저장하고 각각 신고 요청에 독립적으로 사용.
//
//   primary 계정  : report-auth.mjs 가 관리, LOCO 세션 유지, 방 둘러보기 전용
//   추가 계정들   : 여기서 관리, HTTP 로그인만 하고 oauth 토큰만 보관
//
// 추가 계정은 LOCO 세션을 열지 않으므로 report-loco.mjs 는 건드리지 않는다.

import { randomUUID } from 'node:crypto'
import * as DB from './report-db.mjs'

const LIB = 'agent-messenger/dist/src/platforms/kakaotalk/auth/kakao-login.js'
const LIB_REL = '../node_modules/agent-messenger/dist/src/platforms/kakaotalk/auth/kakao-login.js'

async function auth() {
  try { return await import(LIB) } catch {}
  return import(new URL(LIB_REL, import.meta.url).href)
}

// 계정 추가 로그인 진행 중 상태 (passcode 대기용) — 한 번에 한 계정만 추가 가능
let pending = null

function maskEmail(em) {
  const s = String(em || '')
  return s.replace(/^(.).*(@.*)$/, '$1***$2')
}

function publicView(a) {
  return {
    userId: a.userId,
    email: maskEmail(a.email),
    deviceType: a.deviceType,
    nick: a.nick || '',
    isPrimary: !!a.isPrimary,
    active: a.active !== false,
    lastUsed: a.lastUsed || null,
    lastStatus: a.lastStatus || '',
  }
}

export async function list() {
  const all = await DB.listAccounts()
  return all.map(publicView)
}

// 활성 계정 전체 — 신고 발사 대상
export async function listActive() {
  const all = await DB.listAccounts()
  return all.filter((a) => a.active !== false && a.oauthToken && a.duuid)
}

// userId 로 전체 cred 조회 (fanout 내부용)
export async function getCred(userId) {
  return DB.getAccount(String(userId))
}

// 특정 계정 비활성화/삭제
export async function setActive(userId, active) {
  await DB.setAccountActive(String(userId), !!active)
  return { ok: true }
}
export async function remove(userId) {
  await DB.deleteAccount(String(userId))
  return { ok: true }
}

// ─── 추가 로그인 ───
// 다른 계정의 email/password 를 받아 로그인 진행. passcode 필요하면 pending 유지.
// LOCO 세션은 **열지 않는다** — 오직 oauth 토큰만 획득해서 DB 에 저장.
export async function addLogin(email, password, deviceType = 'tablet') {
  if (!email || !password) return { ok: false, message: '아이디·비번 필요' }
  // 이미 저장된 계정이면 재로그인 — 기존 duuid 보존
  const existing = await DB.listAccounts()
  const prev = existing.find((a) => String(a.email).toLowerCase() === String(email).toLowerCase())
  const duuid = (prev && prev.duuid) || randomUUID().replace(/-/g, '')
  const am = await auth()

  let r
  try {
    r = await am.attemptLogin(email, password, duuid, deviceType === 'pc' ? 'pc' : 'tablet', false, null)
  } catch (e) { return { ok: false, message: String(e.message || e) } }

  if (r && r.authenticated && r.credentials) {
    const uid = String(r.user_id || r.account_id || r.credentials.user_id || '')
    if (!uid) return { ok: false, message: '로그인 성공했지만 userId 가 비어 있음' }
    await DB.saveAccount({
      userId: uid,
      oauthToken: r.credentials.access_token,
      refreshToken: r.credentials.refresh_token || '',
      duuid, email, deviceType,
      isPrimary: false,  // primary 는 report-auth.mjs 가 자동 설정
      active: true,
    })
    pending = null
    return { ok: true, userId: uid, message: '계정 추가됨: ' + maskEmail(email) }
  }

  if (r && r.next_action === 'provide_passcode') {
    pending = { email, password, deviceType, duuid }
    let msg = '새 기기 등록이 필요합니다'
    let showCode = ''
    try {
      const pr = await am.requestPasscode(email, password, duuid)
      if (pr && pr.passcode) {
        showCode = String(pr.passcode)
        msg = `폰 카카오톡에 뜨는 화면에서 이 인증번호를 입력하세요: ${showCode}`
      } else if (pr && pr.message) { msg = pr.message }
    } catch (e) { msg = String(e.message || e) }
    return { ok: false, needPasscode: true, showCode, message: msg }
  }

  return { ok: false, message: (r && r.message) || '로그인 실패' }
}

export async function addPasscode(code) {
  if (!pending) return { ok: false, message: '먼저 "계정 추가" 로 아이디·비번을 넣으세요' }
  const { email, password, deviceType, duuid } = pending
  const am = await auth()
  try {
    const rg = await am.registerDevice(email, password, String(code || ''), duuid)
    if (rg && rg.error) return { ok: false, message: rg.message || '기기 등록 실패' }
  } catch (e) { return { ok: false, message: String(e.message || e) } }
  pending = null
  return addLogin(email, password, deviceType)
}

export async function pendingState() {
  return pending ? { email: maskEmail(pending.email), deviceType: pending.deviceType } : null
}
