// LOCO 로 방 목록·최근 메시지 가져오기. 사람이 손으로 chat_id / log_id 를 못 뜰 때 쓴다.
import { send, ready, loginResult } from './report-loco.mjs'

async function longOf() {
  try { return (await import('bson')).Long } catch (e) {}
  throw new Error('Long 없음 — npm install bson')
}

function toIdString(v) {
  if (v == null) return ''
  if (typeof v === 'string' || typeof v === 'number') return String(v)
  if (typeof v === 'object' && 'low' in v && 'high' in v) {
    const low = BigInt.asUintN(32, BigInt(v.low))
    const high = BigInt(v.high)
    return String((high << 32n) | low)
  }
  if (typeof v.toString === 'function') return v.toString()
  return ''
}

function chatTypeName(t) {
  switch (Number(t)) {
    case 0: return 'Memo'
    case 1: return 'DM'
    case 2: return 'Group'
    case 3: return 'OpenGroup'
    case 32: case 33: case 34: return 'OpenMulti'
    case 15: return 'OpenDirect'
    default: return 'T' + t
  }
}

// 로그인 뒤 서버가 LOGINLIST 응답에 통째로 담아 준 방 목록
export function rooms() {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  const lr = loginResult()
  const chatDatas = (lr && Array.isArray(lr.chatDatas)) ? lr.chatDatas : []
  const items = chatDatas.map((c) => {
    const lastLog = c.l && typeof c.l === 'object' ? c.l : null
    const msg = lastLog && typeof lastLog.message === 'string' ? lastLog.message : ''
    const members = Array.isArray(c.k) ? c.k.slice(0, 3).join(', ') : ''
    return {
      chatId: toIdString(c.c),
      linkId: toIdString(c.li),
      type: Number(c.t),
      typeName: chatTypeName(c.t),
      activeMembers: Number(c.a) || 0,
      lastLogId: toIdString(c.ll),
      members,
      memberIds: Array.isArray(c.i) ? c.i.map(toIdString) : [],
      preview: msg.slice(0, 80),
    }
  })
  // 최근 활동(마지막 로그 id) 큰 순으로
  items.sort((a, b) => {
    const A = BigInt(a.lastLogId || '0'), B = BigInt(b.lastLogId || '0')
    return A > B ? -1 : A < B ? 1 : 0
  })
  return { ok: true, count: items.length, rooms: items, text: '방 ' + items.length + '개' }
}

// 방 하나의 최근 메시지. SYNCMSG {chatId, cur:0, cnt:N, max:0} → 가장 최근 N 개
export async function messages(chatId, cnt) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId) return { ok: false, text: 'chatId 필요' }
  const n = Math.max(1, Math.min(50, Number(cnt) || 10))
  const L = await longOf()
  let r
  try {
    r = await send('SYNCMSG', {
      chatId: L.fromString(String(chatId)),
      cur: L.fromNumber(0),
      cnt: n,
      max: L.fromNumber(0),
    })
  } catch (e) {
    return { ok: false, text: 'SYNCMSG 실패: ' + (e && e.message ? e.message : e) }
  }
  if (!r || r.statusCode !== 0) {
    return { ok: false, statusCode: r && r.statusCode, body: r && r.body, text: 'SYNCMSG 상태 ' + (r && r.statusCode) }
  }
  const logs = (r.body && Array.isArray(r.body.chatLogs)) ? r.body.chatLogs : []
  const items = logs.map((log) => {
    const text = typeof log.message === 'string' ? log.message : ''
    return {
      logId: toIdString(log.logId),
      authorId: toIdString(log.authorId),
      type: Number(log.type),
      sendAt: Number(log.sendAt) || 0,
      message: text.slice(0, 200),
    }
  })
  // 최신이 위로
  items.sort((a, b) => {
    const A = BigInt(a.logId || '0'), B = BigInt(b.logId || '0')
    return A > B ? -1 : A < B ? 1 : 0
  })
  return { ok: true, count: items.length, chatId: String(chatId), messages: items }
}

// CHATINFO 로 방 멤버 포함 상세. 열린 방의 공식 멤버 목록도 여기서.
export async function roomInfo(chatId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId) return { ok: false, text: 'chatId 필요' }
  const L = await longOf()
  try {
    const r = await send('CHATINFO', { chatId: L.fromString(String(chatId)) })
    return { ok: r && r.statusCode === 0, statusCode: r && r.statusCode, body: r && r.body }
  } catch (e) {
    return { ok: false, text: 'CHATINFO 실패: ' + (e && e.message ? e.message : e) }
  }
}
