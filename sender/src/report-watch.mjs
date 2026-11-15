// 서버 측 처분 감시 — 클라이언트가 PWA 닫거나 새로고침해도 Render 프로세스가
// 30초마다 targetStatus() 돌림. LIMITED 감지하면 메모리에 시각 기록해두고 다음 접속 때
// 그대로 전달. Render Free 는 15분 idle 이면 sleep 되지만, 이 poller 자체가 트래픽을
// 유발해서 활성 상태 유지됨.
//
// 메모리 Map 이라 Render 재배포/재시작 시 리스트 날아감 — 영속이 필요하면 DB 로 승격.
import * as BROWSE from './report-browse.mjs'

const INTERVAL_MS = 30000
const watches = new Map()   // key = chatId+'::'+userId → row
let timer = null

function keyOf(chatId, userId) { return String(chatId) + '::' + String(userId) }

export function list() {
  return Array.from(watches.values()).map((w) => ({
    chatId: w.chatId,
    userId: w.userId,
    addedAt: w.addedAt,
    lastCheck: w.lastCheck,
    summary: w.result && w.result.summary || null,
    text: w.result && w.result.text || '',
    limitedAt: w.limitedAt || null,
    signals: w.result && w.result.signals || null,
  }))
}

export function status(chatId, userId) {
  const w = watches.get(keyOf(chatId, userId))
  if (!w) return { watching: false }
  return {
    watching: true,
    addedAt: w.addedAt,
    lastCheck: w.lastCheck,
    summary: w.result && w.result.summary || null,
    text: w.result && w.result.text || '',
    limitedAt: w.limitedAt || null,
    signals: w.result && w.result.signals || null,
  }
}

export function add(chatId, userId) {
  const k = keyOf(chatId, userId)
  if (!watches.has(k)) {
    watches.set(k, {
      chatId: String(chatId),
      userId: String(userId),
      addedAt: Date.now(),
      lastCheck: null,
      result: null,
      limitedAt: null,
    })
  }
  startTimer()
  // 처음 추가되면 즉시 한 번 체크해서 baseline 확보
  setImmediate(() => tickOne(watches.get(k)).catch(() => {}))
  return { ok: true, count: watches.size }
}

export function remove(chatId, userId) {
  watches.delete(keyOf(chatId, userId))
  if (!watches.size && timer) { clearInterval(timer); timer = null; console.log('[watch] 모든 감시 종료') }
  return { ok: true, count: watches.size }
}

export function removeAll() {
  watches.clear()
  if (timer) { clearInterval(timer); timer = null }
  return { ok: true, count: 0 }
}

function startTimer() {
  if (timer) return
  timer = setInterval(tick, INTERVAL_MS)
  console.log('[watch] 서버 폴링 시작 (' + INTERVAL_MS + 'ms, ' + watches.size + '건)')
}

async function tickOne(w) {
  if (!w) return
  try {
    const r = await BROWSE.targetStatus(w.chatId, w.userId)
    w.lastCheck = Date.now()
    w.result = r
    if (r && r.summary === 'LIMITED' && !w.limitedAt) {
      w.limitedAt = Date.now()
      console.log('[watch] ★ LIMITED 감지 c=' + w.chatId + ' uid=' + w.userId + ' "' + (r.text || '') + '"')
    }
  } catch (e) {
    w.lastCheck = Date.now()
    console.log('[watch] tick err c=' + w.chatId + ' uid=' + w.userId + ': ' + (e && e.message))
  }
}

async function tick() {
  if (!watches.size) return
  // 병렬이지만 LOCO 세션 1개라 큐잉은 report-server.mjs 가 처리.
  await Promise.all(Array.from(watches.values()).map(tickOne))
}
