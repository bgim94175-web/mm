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
//
// ★ 2026-11-15 버그 수정 (passcode 무한반복):
// 이전 코드는 addPasscode() 가 registerDevice 뒤 addLogin() 을 재귀 호출했는데,
// 재귀 addLogin() 에서 `existing.find(email)` 이 아직 null (DB 저장 전) 이라
// **duuid 를 새로 만들어버렸음**. 서버는 "모르는 새 기기" 라 다시 provide_passcode
// 반환 → 무한 루프. 수정: addLogin() 의 코어 로직을 _coreLogin(duuid) 로 뽑고,
// addPasscode() 는 pending.duuid 를 그대로 전달해서 재시도. 1차 addLogin() 도
// 같은 _coreLogin 을 쓰되 기존/새 duuid 자동 선택.
async function _coreLogin(email, password, deviceType, duuid) {
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
      isPrimary: false,
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

export async function addLogin(email, password, deviceType = 'tablet') {
  if (!email || !password) return { ok: false, message: '아이디·비번 필요' }
  // 1) pending 에 같은 email 이 이미 들어있으면 그 duuid 를 **최우선**으로 재사용
  //    (passcode 받는 동안 사용자가 "추가" 버튼 다시 눌러도 duuid 유지)
  // 2) 아니면 DB 에 저장된 같은 email 의 duuid
  // 3) 둘 다 없으면 새로 생성
  let duuid
  if (pending && String(pending.email).toLowerCase() === String(email).toLowerCase()) {
    duuid = pending.duuid
  } else {
    const existing = await DB.listAccounts()
    const prev = existing.find((a) => String(a.email).toLowerCase() === String(email).toLowerCase())
    duuid = (prev && prev.duuid) || randomUUID().replace(/-/g, '')
  }
  return _coreLogin(email, password, deviceType, duuid)
}

export async function addPasscode(code) {
  if (!pending) return { ok: false, message: '먼저 "계정 추가" 로 아이디·비번을 넣으세요' }
  const { email, password, deviceType, duuid } = pending
  const am = await auth()
  try {
    const rg = await am.registerDevice(email, password, String(code || ''), duuid)
    if (rg && rg.error) return { ok: false, message: rg.message || '기기 등록 실패' }
  } catch (e) { return { ok: false, message: String(e.message || e) } }
  // ★ 핵심 수정: addLogin() 재귀 X — pending.duuid 그대로 _coreLogin 재호출.
  // 이렇게 해야 재시도가 "같은 기기" 로 attemptLogin 하고 서버가 "등록된 기기" 로 인식.
  return _coreLogin(email, password, deviceType, duuid)
}

export async function pendingState() {
  return pending ? { email: maskEmail(pending.email), deviceType: pending.deviceType } : null
}

// ★ primary 교체 — DB 플래그 변경 + report-auth 의 cred 교체 + LOCO 재접속.
// 지금 primary 가 서버 격리 (LOGINLIST/LCHATLIST 둘 다 empty) 당한 경우 탈출용.
export async function promoteToPrimary(userId) {
  const AUTH = await import('./report-auth.mjs')
  const LOCO = await import('./report-loco.mjs')
  const POOL = await import('./report-loco-pool.mjs')
  try {
    const acc = await DB.setPrimary(userId)
    // report-auth 의 메모리 cred 교체 (saveCred 가 Postgres 의 report_auth 테이블에도 기록)
    await AUTH._setCredDirect({
      oauthToken: acc.oauthToken,
      refreshToken: acc.refreshToken || '',
      userId: String(acc.userId),
      duuid: acc.duuid,
      email: acc.email || '',
      deviceType: acc.deviceType || 'tablet',
    })
    // LOCO 세션 끊고 pool slot 도 정리 (이전 계정 세션 해제)
    try { LOCO.close() } catch (e) {}
    try { POOL.closeAll() } catch (e) {}
    // 새 primary 로 LOCO 재접속
    try {
      await LOCO.connect()
      return { ok: true, userId: acc.userId, email: maskEmail(acc.email), locoConnected: true, message: 'primary 교체 + LOCO 재연결 OK' }
    } catch (e) {
      return { ok: true, userId: acc.userId, email: maskEmail(acc.email), locoConnected: false, message: 'primary 교체는 됐지만 LOCO 재연결 실패: ' + (e && e.message) }
    }
  } catch (e) {
    return { ok: false, message: String(e && e.message ? e.message : e) }
  }
}
