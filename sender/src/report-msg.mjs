// BLSPAMS — 메시지 신고. body 키: st c ls ss lds lts sr bi
// st=3(로그 문맥 메뉴), sr 0~5, lds 에 원문 대신 우리 문장을 넣는다
import { send, ready } from './report-loco.mjs'

const SR = [0, 1, 2, 3, 4, 5]
const TEXT = {
  0: '아 씨발 좆같네 진짜 지랄하네',
  1: '텔레그램 오픈톡 홍보합니다 쪽지주세요 링크 확인',
  2: '야동 링크 올립니다 성인영상 필요하신분 쪽지',
  3: '리딩방 수익인증 합니다 원금보장 고수익 보장',
  4: '초등학생도 들어오는 방인데 성인광고 올리네요',
  5: '불법 프로그램 배포합니다 크랙 토렌트 링크',
}
const GAP = 1500

function sleep(ms) {
  return new Promise(function (r) { setTimeout(r, ms) })
}

async function longOf() {
  try { return (await import('bson')).Long } catch (e) {}
  throw new Error('Long 없음')
}

async function call(L, chatId, logIds, targetIds, datas, types, sr) {
  const body = {
    st: 3,
    c: L.fromString(String(chatId)),
    ls: logIds.map(function (x) { return L.fromString(String(x)) }),
    ss: targetIds.map(function (x) { return L.fromString(String(x)) }),
    lds: datas,
    lts: types,
    sr: sr,
    bi: false,
  }
  try {
    const r = await send('BLSPAMS', body)
    return { st: r ? r.statusCode : 'NULL' }
  } catch (e) {
    const s = String(e && e.message ? e.message : e)
    return { st: /timeout/i.test(s) ? 'TIMEOUT' : 'ERR ' + s.slice(0, 60) }
  }
}

export async function probe(chatId, logId, targetId) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  const L = await longOf()
  const rows = []
  for (const sr of SR) {
    const r = await call(L, chatId, [logId], [targetId], [TEXT[sr]], [1], sr)
    rows.push('sr' + sr + ':' + r.st)
    console.log('blspams probe sr=' + sr + ' -> ' + r.st)
    await sleep(GAP)
    if (r.st === 0) return { ok: true, sr: sr, rows: rows, text: '성공 sr=' + sr + '\n' + rows.join(' · ') }
  }
  return { ok: false, rows: rows, text: '전멸\n' + rows.join(' · ') }
}

export async function fire(chatId, logIds, targetId, text) {
  if (!ready()) return { ok: false, text: 'LOCO 세션 없음' }
  const L = await longOf()
  const rows = []
  for (const sr of SR) {
    const datas = text ? logIds.map(function () { return text }) : logIds.map(function () { return TEXT[sr] })
    const types = logIds.map(function () { return 1 })
    const r = await call(L, chatId, logIds, logIds.map(function () { return targetId }), datas, types, sr)
    rows.push('sr' + sr + 'x' + logIds.length + ':' + r.st)
    console.log('blspams fire sr=' + sr + ' n=' + logIds.length + ' -> ' + r.st)
    await sleep(GAP)
  }
  const ok = rows.filter(function (x) { return x.endsWith(':0') }).length
  return { ok: ok > 0, count: ok, rows: rows, text: '접수 ' + ok + '/' + rows.length + '\n' + rows.join(' · ') }
}
