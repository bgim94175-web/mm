// 다계정 LOCO 풀 (lazy open) — fanout 각 계정이 "자기 KICKMEM" 호출하기 위한 세션 풀.
//
// 왜 분리: 기존 report-loco.mjs 는 primary 1개만 관리 (방 둘러보기·상시 세션).
// 이 풀은 fanout 추가 계정들이 "차단하고 신고" UX 재현을 위해 각자 KICKMEM 쏘는 용도.
// lazy = 호출 시점에만 attach, idle TTL 지나면 close. anti-abuse 최소화.
//
// 안전 룰 (agent-messenger AGENTS.md + K bot 운영 경험):
// - 실패하면 멈추고 사용자에게 보고. 자동 재로그인 금지.
// - 실패 → 쿨다운 (LOCO_RETRY_COOLDOWN_MIN 분, 기본 60) 기록.
// - 한 번에 여러 계정 동시 attach 금지 — 순차 (서버가 "짧은 시간 LOGINLIST 폭발" 로 self-eviction 유발).
// - PING 20s 는 ensureSession 이 자동 처리.

import * as DB from './report-db.mjs'

const LIB_REL = '../node_modules/agent-messenger/dist/src/platforms/kakaotalk/client.js'

const IDLE_TTL_MS = Math.max(60, Number(process.env.LOCO_POOL_IDLE_TTL_MIN) || 30) * 60 * 1000
const COOLDOWN_MIN = Math.max(5, Number(process.env.LOCO_RETRY_COOLDOWN_MIN) || 60)

let ClientClass = null
const slots = new Map()  // userId -> { client, state, openedAt, lastUsedAt }
const inflight = new Map()  // userId -> Promise (중복 open 방지)

async function loadClientClass() {
  if (ClientClass) return ClientClass
  const mod = await import(new URL(LIB_REL, import.meta.url).href)
  const C = mod.KakaoTalkClient || mod.default || Object.values(mod).find(function (v) { return typeof v === 'function' && /Client/.test(v.name) })
  if (!C) throw new Error('KakaoTalkClient 클래스 없음')
  ClientClass = C
  return C
}

function slotReady(slot) {
  return !!(slot && slot.state && slot.state.session && slot.state.session.connection && slot.state.session.connection.sendPacket)
}

async function _openSlot(userId) {
  const acc = await DB.getAccount(String(userId))
  if (!acc) throw new Error('계정 없음 (uid=' + userId + ')')
  if (!acc.oauthToken || !acc.duuid) throw new Error('oauth/duuid 없음 (uid=' + userId + ')')
  if (acc.active === false) throw new Error('비활성 계정 (uid=' + userId + ')')
  const C = await loadClientClass()
  const client = new C()
  await client.login({
    oauthToken: acc.oauthToken,
    userId: String(acc.userId),
    deviceUuid: acc.duuid,
    deviceType: acc.deviceType === 'pc' ? 'pc' : 'tablet',
  })
  const state = await client.ensureSession()
  const slot = { client, state, openedAt: Date.now(), lastUsedAt: Date.now() }
  if (!slotReady(slot)) {
    try { state && state.session && state.session.close && state.session.close() } catch (e) {}
    try { client.close && client.close() } catch (e) {}
    throw new Error('LOCO 세션은 열렸지만 connection 핸들 없음')
  }
  return slot
}

export async function ensureSlot(userId) {
  const uid = String(userId)
  const existing = slots.get(uid)
  if (slotReady(existing)) {
    existing.lastUsedAt = Date.now()
    return existing
  }
  // 쿨다운 체크
  const fail = await DB.loadLocoPoolState(uid).catch(() => null)
  if (fail && fail.lastFailAt) {
    const sinceMin = Math.floor((Date.now() - fail.lastFailAt) / 60000)
    if (sinceMin < COOLDOWN_MIN) {
      throw new Error('쿨다운 중 (uid=' + uid + ', ' + sinceMin + '분 전 실패, 쿨다운 ' + COOLDOWN_MIN + '분, 사유: ' + (fail.lastErr || '-') + ')')
    }
  }
  // 중복 open 방지 (같은 계정에 동시 호출 들어오면 하나로 묶음)
  if (inflight.has(uid)) return inflight.get(uid)
  const p = (async () => {
    try {
      const slot = await _openSlot(uid)
      slots.set(uid, slot)
      await DB.clearLocoPoolFail(uid).catch(() => {})
      console.log('[loco-pool] open OK uid=' + uid)
      return slot
    } catch (e) {
      const msg = String(e && e.message ? e.message : e)
      await DB.recordLocoPoolFail(uid, msg).catch(() => {})
      console.log('[loco-pool] open FAIL uid=' + uid + ' err=' + msg.slice(0, 120))
      throw e
    } finally {
      inflight.delete(uid)
    }
  })()
  inflight.set(uid, p)
  return p
}

// 세션에 KICKMEM 송출 — "차단하고 신고" afterAction=Block 재현.
export async function kickMem(userId, linkId, chatId, targetUserId, block) {
  if (block === undefined) block = true
  const slot = await ensureSlot(userId)
  const { Long } = await import('bson')
  const body = {
    li: Long.fromString(String(linkId)),
    c: Long.fromString(String(chatId)),
    mid: Long.fromString(String(targetUserId)),
    r: !!block,
  }
  slot.lastUsedAt = Date.now()
  try {
    return await slot.state.session.connection.sendPacket('KICKMEM', body)
  } catch (e) {
    // sendPacket 실패 → 세션 깨짐 가능성. slot 제거해서 다음 호출시 재오픈.
    closeSlot(userId).catch(() => {})
    throw e
  }
}

export function closeSlot(userId) {
  const uid = String(userId)
  const slot = slots.get(uid)
  if (!slot) return Promise.resolve()
  slots.delete(uid)
  try { if (slot.state && slot.state.session && slot.state.session.close) slot.state.session.close() } catch (e) {}
  try { if (slot.client && slot.client.close) slot.client.close() } catch (e) {}
  console.log('[loco-pool] close uid=' + uid)
  return Promise.resolve()
}

export function closeAll() {
  const uids = Array.from(slots.keys())
  for (const uid of uids) closeSlot(uid)
}

// idle sweep — 설정 시간(기본 30분) 안 쓴 slot 닫기. 5분마다 돌음.
let sweepTimer = null
export function startIdleSweep() {
  if (sweepTimer) return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [uid, slot] of slots) {
      if (now - slot.lastUsedAt > IDLE_TTL_MS) {
        console.log('[loco-pool] idle close uid=' + uid + ' (idle ' + Math.floor((now - slot.lastUsedAt) / 60000) + '분)')
        closeSlot(uid)
      }
    }
  }, 5 * 60 * 1000)
  sweepTimer.unref && sweepTimer.unref()
}

export function stopIdleSweep() {
  if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
}

// UI 용 상태 요약
export async function status() {
  const fails = await DB.listLocoPoolFails().catch(() => [])
  const failMap = new Map(fails.map((f) => [String(f.userId), f]))
  const items = []
  const now = Date.now()
  for (const [uid, slot] of slots) {
    items.push({
      userId: uid,
      open: true,
      ready: slotReady(slot),
      openedAgoMin: Math.floor((now - slot.openedAt) / 60000),
      idleMin: Math.floor((now - slot.lastUsedAt) / 60000),
      inCooldown: false,
    })
  }
  // 열려있지 않은 fail 계정도 표시
  for (const f of fails) {
    if (slots.has(String(f.userId))) continue
    const sinceMin = f.lastFailAt ? Math.floor((now - f.lastFailAt) / 60000) : null
    items.push({
      userId: String(f.userId),
      open: false,
      ready: false,
      inCooldown: sinceMin != null && sinceMin < COOLDOWN_MIN,
      sinceFailMin: sinceMin,
      lastErr: f.lastErr,
    })
  }
  return {
    cooldownMin: COOLDOWN_MIN,
    idleTtlMin: Math.floor(IDLE_TTL_MS / 60000),
    totalOpen: slots.size,
    items,
  }
}

// 특정 계정의 쿨다운 해제 (수동 "재시도" 버튼용)
export async function resetCooldown(userId) {
  await DB.clearLocoPoolFail(String(userId))
  return { ok: true, userId: String(userId) }
}
