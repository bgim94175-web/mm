// BLSPAMS 용 LOCO 세션. client.login() 은 자격증명만 담는다 — 실제 소켓은
// client.ensureSession() 이 만든다. 그 결과 {session, loginResult} 에서
// session.connection.sendPacket 이 우리가 쓰는 핸들.
import * as AUTH from './report-auth.mjs'

const LIB_REL = '../node_modules/agent-messenger/dist/src/platforms/kakaotalk/client.js'

let client = null
let state = null  // { session, loginResult } — ensureSession() 반환값
let lastErr = ''

export const ready = () => !!(state && state.session && state.session.connection && state.session.connection.sendPacket)
export const error = () => lastErr
export const loginResult = () => (state && state.loginResult) || null

export function close() {
  try { if (state && state.session && state.session.close) state.session.close() } catch (e) {}
  try { if (client && client.close) client.close() } catch (e) {}
  client = null
  state = null
  lastErr = ''
}

async function loadClient() {
  const mod = await import(new URL(LIB_REL, import.meta.url).href)
  const C = mod.KakaoTalkClient || mod.default || Object.values(mod).find(function (v) { return typeof v === 'function' && /Client/.test(v.name) })
  if (!C) throw new Error('KakaoTalkClient 클래스 없음')
  return C
}

export async function connect(deviceType) {
  close()
  const c = AUTH.get()
  if (!c || !c.oauthToken) throw new Error('HTTP 로그인이 먼저 필요하다')
  if (!c.userId) throw new Error('userId 없음 — 다시 로그인')

  const C = await loadClient()
  client = new C()
  await client.login({
    oauthToken: c.oauthToken,
    userId: String(c.userId),
    deviceUuid: c.duuid,
    deviceType: deviceType === 'pc' ? 'pc' : (c.deviceType || 'tablet'),
  })

  // 여기서 비로소 booking → checkin → LOGINLIST 가 돌아간다.
  try {
    state = await client.ensureSession()
  } catch (e) {
    lastErr = String(e && e.message ? e.message : e)
    const code = e && e.responseCode != null ? ' (코드 ' + e.responseCode + ')' : ''
    throw new Error('LOCO 세션 실패' + code + ': ' + lastErr)
  }
  if (!ready()) throw new Error('LOCO 세션은 열렸지만 connection 핸들 없음')
  lastErr = ''
  return true
}

function conn() {
  if (!ready()) {
    const tail = lastErr ? ' (' + lastErr + ')' : ''
    throw new Error('LOCO 연결 없음' + tail)
  }
  return state.session.connection
}

export async function send(method, body) {
  return conn().sendPacket(method, body)
}

// ★ v59-A §12 — report-loco::rewrites 스텁 (자리만). v59 본작업에서 실제 송출 구현.
// REWRITES body: {linkId:Long, chatId:Long, chatLogInfos:String}. category 키 없음 (§11).
// 구현 시 at50$a.a → tf3 BSON encoder 를 거친 body 를 sendPacket('REWRITES', body) 로 전달.
export async function rewrites(/* linkId, chatId, chatLogInfosString */) {
  throw new Error('v59-A: REWRITES 는 다음 태스크에서 구현 (스텁 상태)')
}

// ★ KICKMEM — openlink "차단하고 신고하기" 가 신고 성공 후 호출하는 LOCO 메서드.
// APK 4차 분석 (2026-11-15): Lbly$d.h → Lfzc0$d.h → Lfzc0$d.e → Ljs50.Y → core/loco/d.M0 →
// Lt131.W → Ltw30.f(yy50$a) 바디 조립. 필드 4개 확정: {li, c, mid, r}.
// 봇 (오픈챗 일반 멤버) 가 호출하면 자기 block 리스트에만 등록되는 효과이지만, 서버가
// "다수 유저의 block 집계" 를 Report 심사 큐에 가중치로 쓰는 것으로 강력 추정 → 임계 돌파 유리.
// primary LOCO 세션에서만 호출 가능 (fanout 추가 계정은 LOCO 미지원).
export async function kickMem(linkId, chatId, targetUserId, block = true) {
  if (!ready()) throw new Error('LOCO 연결 없음 — KICKMEM 호출 불가 (primary 계정 LOCO 복구 필요)')
  const { Long } = await import('bson')
  const body = {
    li: Long.fromString(String(linkId)),
    c: Long.fromString(String(chatId)),
    mid: Long.fromString(String(targetUserId)),
    r: !!block,
  }
  return conn().sendPacket('KICKMEM', body)
}
