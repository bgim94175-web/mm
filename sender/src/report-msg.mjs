// 메시지 신고 — BLSPAMS 는 K bot 본체·agent-messenger 어디에도 없는 추정 메서드.
// 지금은 몇 가지 후보 이름을 동시에 때려서 어느 메서드가 -300(없는 명령) 이 아닌지 가려낸다.
// 바디도 추정이라, 실측 로그 받기 전까지는 답 상태코드 + body 전체를 그대로 돌려본다.
import { send, ready } from './report-loco.mjs'

// -300=없는 명령, -203=본문틀림, 0=성공, 그 외=서버 자체 코드
const REASONS = [0, 1, 2, 3, 4, 5]
// 후보 메서드명 — 실측 전까지는 못 확정. 사용자가 한 번 돌리고 어느 게 -300 안 뜨는지 알려 주면 그걸로 좁힌다.
const CANDIDATE_METHODS = ['BLSPAMS', 'LBLSPAMS', 'OREPORT', 'OCREPORT', 'REPORT', 'CHATREPORT', 'SPAMMSG']
const TEXT = {
  0: '아 씨발 좆같네 진짜 지랄하네',
  1: '텔레그램 오픈톡 홍보합니다 쪽지주세요 링크 확인',
  2: '야동 링크 올립니다 성인영상 필요하신분 쪽지',
  3: '리딩방 수익인증 합니다 원금보장 고수익 보장',
  4: '초등학생도 들어오는 방인데 성인광고 올리네요',
  5: '불법 프로그램 배포합니다 크랙 토렌트 링크',
}
const GAP = 1500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function longOf() {
  try { return (await import('bson')).Long } catch (e) {}
  throw new Error('Long 없음 — npm install bson')
}

function fmtResp(r) {
  if (!r) return { st: 'NULL', bs: null }
  const b = r.body || {}
  const keys = Object.keys(b)
  const bs = typeof b.status === 'number' ? b.status : null
  return { st: r.statusCode, bs, bodyKeys: keys, body: keys.length ? b : null }
}

function errRow(e) {
  const s = String(e && e.message ? e.message : e)
  if (/timeout/i.test(s)) return { st: 'TIMEOUT' }
  if (/연결/i.test(s)) return { st: 'LOCO_DEAD', err: s.slice(0, 80) }
  return { st: 'ERR', err: s.slice(0, 120) }
}

async function callOne(method, L, chatId, logIds, targetIds, datas, types, sr) {
  const body = {
    st: 3,
    c: L.fromString(String(chatId)),
    ls: logIds.map((x) => L.fromString(String(x))),
    ss: targetIds.map((x) => L.fromString(String(x))),
    lds: datas,
    lts: types,
    sr,
    bi: false,
  }
  try {
    const r = await send(method, body)
    return fmtResp(r)
  } catch (e) {
    return errRow(e)
  }
}

// 후보 메서드 다 때려본다. 성공 판정 = LOCO st==0 AND body.status==0 둘 다.
// 어떤 메서드가 "살아있는지" (-300 아님) 와 "바디까지 접수됐는지" (body.status==0) 를 분리해서 본다.
export async function probe(chatId, logId, targetId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음 — 로그인부터' }
  const L = await longOf()
  const rows = []
  const livingMethods = []
  let winner = null
  for (const method of CANDIDATE_METHODS) {
    const r = await callOne(method, L, chatId, [logId], [targetId], [TEXT[0]], [1], 0)
    const bsTag = r.bs != null ? '/b=' + r.bs : ''
    const keyTag = r.bodyKeys && r.bodyKeys.length ? '(' + r.bodyKeys.join(',') + ')' : ''
    rows.push(method + ':' + r.st + bsTag + keyTag)
    console.log('report probe ' + method + ' -> ' + JSON.stringify(r))
    await sleep(GAP)
    if (r.st === 0) {
      livingMethods.push({ method, bs: r.bs, body: r.body })
      if (r.bs === 0 && !winner) winner = { method, body: r.body }
    }
  }
  if (winner) {
    return { ok: true, method: winner.method, rows, text: '진짜 성공 메서드=' + winner.method + ' (body.status=0)\n' + rows.join(' · '), lastBody: winner.body }
  }
  const living = livingMethods.map((m) => m.method + '(body.status=' + m.bs + ')')
  const hint = living.length
    ? '메서드는 서버가 받아 줌 — 바디·sr·대상 조정 필요: ' + living.join(' · ')
    : '어떤 후보 메서드도 서버가 모름(-300) — 메서드명 자체가 틀림'
  return {
    ok: false, livingMethods: livingMethods.map((m) => m.method), rows,
    text: '전송 성공, 접수 실패\n' + rows.join(' · ') + '\n→ ' + hint
      + '\n\n팁: -301=중복/자기 자신/전제 부족, -302=권한 없음, -4042=없는 리소스. 다른 사람 글로 다시.',
    lastBody: livingMethods[0] && livingMethods[0].body,
  }
}

// 메시지 발사 — 확정된 메서드 하나로 sr0~5 전체 쏘기. 성공=body.status==0.
export async function fire(chatId, logIds, targetId, text, method) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음 — 로그인부터' }
  const m = String(method || 'BLSPAMS')
  const L = await longOf()
  const rows = []
  let accepted = 0
  for (const sr of REASONS) {
    const datas = text ? logIds.map(() => text) : logIds.map(() => TEXT[sr])
    const types = logIds.map(() => 1)
    const r = await callOne(m, L, chatId, logIds, logIds.map(() => targetId), datas, types, sr)
    const bsTag = r.bs != null ? '/b=' + r.bs : ''
    rows.push('sr' + sr + 'x' + logIds.length + ':' + r.st + bsTag)
    if (r.st === 0 && r.bs === 0) accepted += 1
    console.log('report fire ' + m + ' sr=' + sr + ' n=' + logIds.length + ' -> ' + JSON.stringify(r))
    await sleep(GAP)
  }
  return {
    ok: accepted > 0, method: m, count: accepted, rows,
    text: '실제 접수 ' + accepted + '/' + rows.length + ' (method=' + m + ')\n' + rows.join(' · ')
      + (accepted === 0 ? '\n\n팁: body=-301 중복/자기 자신, -302 권한 없음. 다른 사람 글로.' : ''),
  }
}

// 운영자가 직접 임의 LOCO 메서드·바디를 때려 보는 raw 엔드포인트. {method, body} 받아서 서버 응답을 그대로.
// body 안에 __long: [{field: value}] 식으로 넣으면 그 필드만 Long 으로 감싼다.
export async function raw(method, body) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  if (!method) return { ok: false, text: 'method 필요' }
  const L = await longOf()
  const b = { ...(body || {}) }
  const longFields = Array.isArray(b.__long) ? b.__long : []
  delete b.__long
  for (const f of longFields) {
    if (b[f] != null) {
      try { b[f] = L.fromString(String(b[f])) } catch (e) {}
    }
  }
  try {
    const r = await send(method, b)
    return { ok: r && r.statusCode === 0, statusCode: r ? r.statusCode : null, body: r && r.body ? r.body : null }
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) }
  }
}
