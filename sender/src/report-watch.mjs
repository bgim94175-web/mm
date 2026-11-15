// 서버 측 처분 감시 + 새 메시지 감지 시 자동 신고.
import * as BROWSE from './report-browse.mjs'
import * as OPEN from './report-openchat.mjs'

const INTERVAL_MS = 30000
const watches = new Map()
let timer = null

function keyOf(chatId, userId) { return String(chatId) + '::' + String(userId) }

export function list() {
  return Array.from(watches.values()).map((w) => ({
    chatId: w.chatId, userId: w.userId, addedAt: w.addedAt, lastCheck: w.lastCheck,
    summary: w.result && w.result.summary || null, confident: w.result && w.result.confident || false,
    text: w.result && w.result.text || '', limitedAt: w.limitedAt || null,
    autoFire: w.autoFire || null, lastFiredLogId: w.lastFiredLogId || null,
    signals: w.result && w.result.signals || null,
  }))
}

export function status(chatId, userId) {
  const w = watches.get(keyOf(chatId, userId))
  if (!w) return { watching: false }
  return {
    watching: true, addedAt: w.addedAt, lastCheck: w.lastCheck,
    summary: w.result && w.result.summary || null, confident: w.result && w.result.confident || false,
    text: w.result && w.result.text || '', limitedAt: w.limitedAt || null,
    autoFire: w.autoFire || null, lastFiredLogId: w.lastFiredLogId || null,
    signals: w.result && w.result.signals || null,
  }
}

export function add(chatId, userId, opts = {}) {
  const k = keyOf(chatId, userId)
  if (!watches.has(k)) {
    watches.set(k, {
      chatId: String(chatId), userId: String(userId),
      addedAt: Date.now(), lastCheck: null, result: null, limitedAt: null,
      autoFire: opts.autoFire || null, lastFiredLogId: null,
    })
  } else if (opts.autoFire) {
    watches.get(k).autoFire = opts.autoFire
  }
  startTimer()
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
    if (r && r.summary === 'LIMITED' && r.confident && !w.limitedAt) {
      w.limitedAt = Date.now()
      console.log('[watch] ★ LIMITED 확정 c=' + w.chatId + ' uid=' + w.userId + ' "' + (r.text || '') + '"')
    }
    if (w.autoFire && w.autoFire.injectText && w.autoFire.linkId && !w.limitedAt) {
      try {
        const msgs = await BROWSE.messagesByAuthor(w.chatId, w.userId, 5)
        const newest = (msgs && msgs.messages && msgs.messages[0]) || null
        if (newest && newest.logId && String(newest.logId) !== String(w.lastFiredLogId)) {
          w.lastFiredLogId = String(newest.logId)
          const ctx = {
            chatId: w.chatId, linkId: w.autoFire.linkId,
            logId: String(newest.logId), authorId: String(w.userId),
            sendAt: newest.sendAt || Math.floor(Date.now() / 1000),
            message: newest.message || '',
            type: newest.type != null ? newest.type : 1,
            injectText: w.autoFire.injectText,
          }
          const cat = w.autoFire.category || OPEN.PROFANITY_CATEGORY
          console.log('[watch] autoFire c=' + w.chatId + ' uid=' + w.userId + ' logId=' + w.lastFiredLogId + ' cat=' + cat)
          const res = await OPEN.fanout(ctx, cat, [], {
            gapMs: w.autoFire.gapMs || 2500, jitterMs: w.autoFire.jitterMs || 1500, shuffle: true,
          })
          console.log('[watch] autoFire 결과: ' + (res.text || '').split('\n')[0])
        }
      } catch (e) {
        console.log('[watch] autoFire err c=' + w.chatId + ': ' + (e && e.message))
      }
    }
  } catch (e) {
    w.lastCheck = Date.now()
    console.log('[watch] tick err c=' + w.chatId + ' uid=' + w.userId + ': ' + (e && e.message))
  }
}

async function tick() {
  if (!watches.size) return
  await Promise.all(Array.from(watches.values()).map(tickOne))
}
