// BLSPAMS 용 LOCO 세션. 로그인 성공 시 함께 붙는다
import * as AUTH from './report-auth.mjs'

const LIB = 'agent-messenger/dist/src/platforms/kakaotalk/client.js'
const LIB_REL = '../node_modules/agent-messenger/dist/src/platforms/kakaotalk/client.js'

let session = null

export function ready() {
  return !!session
}

export function close() {
  try { if (session && session.close) session.close() } catch (e) {}
  session = null
}

export async function connect(email, password, deviceType) {
  const c = AUTH.get()
  if (!c || !c.oauthToken) throw new Error('HTTP 로그인이 먼저 필요하다')
  let mod
  try { mod = await import(LIB) } catch (e) { mod = await import(new URL(LIB_REL, import.meta.url).href) }
  const C = mod.default || mod.KakaoTalkClient || Object.values(mod).find(function (v) { return typeof v === 'function' })
  if (!C) throw new Error('client 클래스 없음')
  const client = new C()
  session = await client.login({
    email: email || c.email,
    password: password || '',
    oauthToken: c.oauthToken,
    accessToken: c.oauthToken,
    refreshToken: c.refreshToken || '',
    userId: c.userId,
    deviceType: deviceType === 'pc' ? 'pc' : 'tablet',
    deviceUuid: c.duuid,
    deviceName: 'SM-X710',
    modelName: 'SM-X710',
  })
  return true
}

function conn() {
  const s = session && (session.session || session)
  const c = s && (s.connection || s.conn)
  if (!c || !c.sendPacket) throw new Error('LOCO 연결 없음')
  return c
}

export async function send(method, body) {
  return conn().sendPacket(method, body)
}
