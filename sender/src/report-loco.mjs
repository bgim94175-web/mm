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
