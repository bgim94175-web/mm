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
      nick: '',  // 아래에서 채움
    }
  })
  items.sort((a, b) => {
    const A = BigInt(a.logId || '0'), B = BigInt(b.logId || '0')
    return A > B ? -1 : A < B ? 1 : 0
  })
  const top = items.slice(0, n)

  // 저자 nick 매핑 — MEMBER 로 저자 셋 한 번에 받아서 닉 채움. 메시지에 "123…" 숫자만
  // 뜨면 누가 누군지 몰라 선택이 힘드니, 바로 여기서 채워준다.
  const authors = Array.from(new Set(top.map((it) => it.authorId).filter(Boolean)))
  if (authors.length) {
    try {
      const r = await send('MEMBER', { chatId: cid, memberIds: authors.map((id) => L.fromString(id)) })
      const arr = r && r.body && Array.isArray(r.body.members) ? r.body.members : []
      const nicks = new Map()
      for (const m of arr) {
        const uid = toIdString(m.userId)
        if (uid) nicks.set(uid, typeof m.nickName === 'string' ? m.nickName : '')
      }
      top.forEach((it) => { it.nick = nicks.get(it.authorId) || '' })
      trace.push('MEMBER(nicks)=' + nicks.size)
    } catch (e) {
      trace.push('MEMBER(nicks) ERR ' + (e && e.message ? e.message : e))
    }
  }

  const newest = top[0] || null
  console.log('[msgs] c=' + chatId
    + ' chatinfoMax=' + (maxLogId ? toIdString(maxLogId) : 'null')
    + ' got=' + top.length
    + ' newestLog=' + (newest ? newest.logId : '-')
    + ' newestAt=' + (newest ? new Date((newest.sendAt || 0) * 1000).toISOString() : '-')
    + ' trace=' + trace.join('|'))

  return { ok: true, count: top.length, chatId: String(chatId), messages: top, trace }
}

// 방의 전체 멤버 목록 — 닉으로 찾아서 바로 신고 플로우로 넘기기 위한 소스.
// 로그인 응답(LOGINLIST) 에 담긴 memberIds 를 MEMBER 로 청크 조회 (한 번에 50명씩).
// pli(오픈프로필 링크 id) 가 있는 멤버는 그 값까지 들고오되, 실제 URL(INFOLINK)은
// 멤버가 선택될 때 memberProfile() 로 따로 받는다 — 전원 INFOLINK 는 너무 비쌈.
export async function members(chatId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!chatId) return { ok: false, text: 'chatId 필요' }
  const L = await longOf()
  const cid = L.fromString(String(chatId))
  const lr = loginResult()
  const chatDatas = (lr && Array.isArray(lr.chatDatas)) ? lr.chatDatas : []
  const room = chatDatas.find((c) => toIdString(c.c) === String(chatId))
  let ids = room && Array.isArray(room.i) ? room.i.map(toIdString).filter(Boolean) : []
  // LOGINLIST 에 멤버 ID 없으면 CHATINFO 로 보충
  if (!ids.length) {
    try {
      const r = await send('CHATINFO', { chatId: cid })
      const ci = r && r.body && r.body.chatInfo
      if (ci) {
        for (const key of ['memberIds', 'displayMemberIds', 'activeMemberIds']) {
          if (Array.isArray(ci[key])) ids = ci[key].map(toIdString).filter(Boolean)
          if (ids.length) break
        }
      }
    } catch (e) {}
  }
  if (!ids.length) return { ok: true, count: 0, members: [], text: '멤버 ID 못 가져옴 (방장이 멤버 공개를 제한했을 수 있음)' }

  const CHUNK = 50
  const out = []
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK).map((id) => L.fromString(id))
    try {
      const r = await send('MEMBER', { chatId: cid, memberIds: chunk })
      const arr = r && r.body && Array.isArray(r.body.members) ? r.body.members : []
      for (const m of arr) {
        const pliStr = toIdString(m.pli)
        out.push({
          userId: toIdString(m.userId),
          nick: typeof m.nickName === 'string' ? m.nickName : '',
          ptp: Number(m.ptp) || 0,
          pli: pliStr,
          // `toIdString(null/0)` 이 '0' 을 뱉으므로 "0" 도 명시적으로 제외해야 함 — 안 그러면
          // 일반 프로필 멤버에게도 OpenProfile 칩이 붙고 memberProfile() 조회에서 혼선.
          hasOpenProfile: Number(m.ptp) === 16 && pliStr && pliStr !== '0',
        })
      }
    } catch (e) {
      // 한 청크 실패해도 다음 진행
    }
  }
  // 닉 기준 정렬 (빈 닉은 뒤로)
  out.sort((a, b) => (a.nick || '￿').localeCompare(b.nick || '￿', 'ko'))
  return { ok: true, count: out.length, members: out, text: '멤버 ' + out.length + '명' }
}

// 특정 저자의 과거 메시지만 뽑기 — messages() 결과에서 authorId 필터.
// messages() 가 최대 80 개 창을 반환하니, 그 안에 해당 저자가 있어야 보임.
// 더 올리고 싶으면 messages() cnt 를 80 으로 쓰고 클라이언트에서 필터.
export async function messagesByAuthor(chatId, authorId, cnt) {
  const base = await messages(chatId, cnt || 80)
  if (!base.ok) return base
  const target = String(authorId)
  const filtered = (base.messages || []).filter((m) => String(m.authorId) === target)
  return { ok: true, count: filtered.length, chatId: base.chatId, authorId: target, messages: filtered, trace: base.trace }
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
