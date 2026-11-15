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

// 방 하나의 최근 메시지.
//   ① CHATINFO → 방의 최신 lastLogId (max)
//   ② SYNCMSG 이분탐색: SYNCMSG 는 "cur 이후 오름차순 최대 ~80개" 를 준다.
//      카카오 logId 는 1씩 늘지 않고 간격이 수천억대라, max-N 같은 산술 점프는
//      그 사이에 로그가 없어 빈 결과가 된다. 그래서 "비지 않는 가장 큰 cur"
//      을 이분탐색으로 찾으면 그 응답이 곧 방의 최신 묶음이 된다.
//   ③ 폴백: MCHATLOGS (봇 로컬 캐시 — 과거만)
export async function messages(chatId, cnt) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId) return { ok: false, text: 'chatId 필요' }
  const n = Math.max(1, Math.min(80, Number(cnt) || 15))
  const L = await longOf()
  const cid = L.fromString(String(chatId))
  const trace = []

  // ① CHATINFO → max
  let maxLogId = null
  try {
    const info = await send('CHATINFO', { chatId: cid })
    trace.push('CHATINFO st=' + (info && info.statusCode))
    const ci = info && info.body && info.body.chatInfo
    if (ci && ci.lastLogId != null) {
      const s = toIdString(ci.lastLogId)
      if (s && s !== '0') maxLogId = L.fromString(s)
    }
  } catch (e) {
    trace.push('CHATINFO ERR ' + (e && e.message ? e.message : e))
  }

  // ② SYNCMSG 이분탐색으로 최신 묶음
  let logs = []
  if (maxLogId) {
    try {
      const maxBig = BigInt(toIdString(maxLogId))
      const syncAt = async (curBig) => {
        const c = curBig < 0n ? 0n : curBig
        const r = await send('SYNCMSG', { chatId: cid, cur: L.fromString(String(c)), cnt: n, max: maxLogId })
        const arr = (r && r.statusCode === 0 && r.body && Array.isArray(r.body.chatLogs)) ? r.body.chatLogs : []
        return arr.filter((lg) => toIdString(lg.chatId) === String(chatId))
      }
      // 해상도 = 로그 한 개분 간격의 대략치. 이보다 좁혀지면 종료.
      const RES = 200000000000n
      let lo = 0n, hi = maxBig, best = [], iter = 0
      while (hi - lo > RES && iter < 20) {
        iter++
        const mid = lo + (hi - lo) / 2n
        const arr = await syncAt(mid)
        if (arr.length) { best = arr; lo = mid } else { hi = mid }
      }
      logs = best
      trace.push('SYNC bsearch iter=' + iter + ' got=' + best.length)
    } catch (e) {
      trace.push('SYNC bsearch ERR ' + (e && e.message ? e.message : e))
    }
  }

  // ③ 폴백: MCHATLOGS
  if (!logs.length) {
    try {
      const r = await send('MCHATLOGS', { chatIds: [cid], sinces: [L.fromNumber(0)] })
      trace.push('MCHATLOGS st=' + (r && r.statusCode))
      if (r && r.statusCode === 0 && r.body && Array.isArray(r.body.chatLogs)) {
        logs = r.body.chatLogs.filter((lg) => toIdString(lg.chatId) === String(chatId))
        trace.push('mchat=' + logs.length)
      }
    } catch (e) {
      trace.push('MCHATLOGS ERR ' + (e && e.message ? e.message : e))
    }
  }

  // 최신순 정렬 후 상위 N (slice 를 sort 뒤에 — 그래야 최신 N 개)
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
  items.sort((a, b) => {
    const A = BigInt(a.logId || '0'), B = BigInt(b.logId || '0')
    return A > B ? -1 : A < B ? 1 : 0
  })
  const top = items.slice(0, n)

  const newest = top[0] || null
  console.log('[msgs] c=' + chatId
    + ' chatinfoMax=' + (maxLogId ? toIdString(maxLogId) : 'null')
    + ' got=' + top.length
    + ' newestLog=' + (newest ? newest.logId : '-')
    + ' newestAt=' + (newest ? new Date((newest.sendAt || 0) * 1000).toISOString() : '-')
    + ' trace=' + trace.join('|'))

  return { ok: true, count: top.length, chatId: String(chatId), messages: top, trace }
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

// 방의 멤버 한 명의 오픈프로필 링크. MEMBER 로 pli 받고 INFOLINK 로 lu 받는다.
// ptp == 16 (오픈프로필) 인 멤버만 pli 를 갖는다. 그렇지 않으면 링크 없음.
export async function memberProfile(chatId, userId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId || !userId) return { ok: false, text: 'chatId · userId 필요' }
  const L = await longOf()
  const cid = L.fromString(String(chatId))
  const uid = L.fromString(String(userId))
  const trace = []

  let member = null
  try {
    const r = await send('MEMBER', { chatId: cid, memberIds: [uid] })
    trace.push('MEMBER st=' + (r && r.statusCode))
    const members = r && r.body && Array.isArray(r.body.members) ? r.body.members : []
    member = members.find((m) => toIdString(m.userId) === String(userId)) || members[0] || null
  } catch (e) {
    trace.push('MEMBER ERR ' + (e && e.message ? e.message : e))
    return { ok: false, trace, text: trace.join(' · ') }
  }
  if (!member) return { ok: false, trace, text: '멤버 못 찾음 · ' + trace.join(' · ') }

  const nick = typeof member.nickName === 'string' ? member.nickName : ''
  const ptp = Number(member.ptp)
  const pliStr = toIdString(member.pli)
  trace.push('ptp=' + ptp + ' pli=' + (pliStr || '-'))

  if (!pliStr || pliStr === '0') {
    return { ok: true, nick, ptp, url: null, trace, text: '오픈프로필 없음(일반 프로필)' }
  }

  try {
    const r = await send('INFOLINK', { lis: [L.fromString(pliStr)] })
    trace.push('INFOLINK st=' + (r && r.statusCode))
    const ols = r && r.body && Array.isArray(r.body.ols) ? r.body.ols : []
    const ol = ols[0]
    const url = ol && typeof ol.lu === 'string' ? ol.lu : null
    const linkName = ol && typeof ol.ln === 'string' ? ol.ln : ''
    return { ok: true, nick, ptp, url, linkName, trace }
  } catch (e) {
    trace.push('INFOLINK ERR ' + (e && e.message ? e.message : e))
    return { ok: false, nick, ptp, trace, text: trace.join(' · ') }
  }
}
