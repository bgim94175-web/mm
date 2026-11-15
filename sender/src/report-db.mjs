// 자격 저장 — 두 테이블:
//   report_auth       : LOCO 세션용 primary 계정 (한 행, id=1) — LOCO 세션은 1개만 유지
//   report_accounts   : HTTP 신고 fanout 용 다계정 (user_id PK) — primary 포함 전부 리스트
// DATABASE_URL 이 있으면 Postgres (Neon), 없으면 로컬 파일(ephemeral).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = join(process.cwd(), 'data', 'report')
const FILE = join(DATA_DIR, 'console-auth.json')
const ACC_FILE = join(DATA_DIR, 'accounts.json')

let pool = null
let backend = 'file'

export async function init() {
  const url = process.env.DATABASE_URL
  if (!url) {
    backend = 'file'
    console.log('[db] DATABASE_URL 없음 — 로컬 파일 사용(재배포 때 사라짐)')
    return
  }
  const { default: pg } = await import('pg')
  pool = new pg.Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false }, // Neon 기본 self-signed-like cert
    max: 3,
    idleTimeoutMillis: 30000,
  })
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_auth (
      id          integer PRIMARY KEY,
      oauth_token text,
      refresh_token text,
      user_id     text,
      duuid       text,
      email       text,
      device_type text,
      updated_at  timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_accounts (
      user_id     text PRIMARY KEY,
      oauth_token text NOT NULL,
      refresh_token text,
      duuid       text NOT NULL,
      email       text,
      device_type text,
      nick        text,
      is_primary  boolean NOT NULL DEFAULT false,
      active      boolean NOT NULL DEFAULT true,
      last_used   timestamptz,
      last_status text,
      adid        text,
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `)
  // 기존 테이블에 adid 컬럼 없으면 추가 (migration)
  try { await pool.query('ALTER TABLE report_accounts ADD COLUMN IF NOT EXISTS adid text') } catch (e) {}
  try { await pool.query('ALTER TABLE report_auth ADD COLUMN IF NOT EXISTS adid text') } catch (e) {}
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_loco_state (
      id           integer PRIMARY KEY,
      last_fail_at timestamptz,
      last_err     text,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_loco_pool_state (
      user_id      text PRIMARY KEY,
      last_fail_at timestamptz,
      last_err     text,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
  `)
  // ★ v59-A new D10 — 응답 전체 영구 기록. message/reason/url 이 서버의 유일한 설명이므로
  // 해석 없이 원문 그대로 보존. UI가 round/phase 를 전달하지 않으면 null 로 기록.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_response (
      id            bigserial PRIMARY KEY,
      round         text,
      phase         text,
      log_id        text,
      http          integer,
      status        integer,
      message       text,
      reason        text,
      err_url       text,
      err_url_label text,
      url           text,
      raw_body      text,
      created_at    timestamptz NOT NULL DEFAULT now()
    )
  `)
  try { await pool.query('CREATE INDEX IF NOT EXISTS report_response_created_idx ON report_response (created_at DESC)') } catch (e) {}
  try { await pool.query('CREATE INDEX IF NOT EXISTS report_response_log_idx ON report_response (log_id)') } catch (e) {}
  backend = 'pg'
  console.log('[db] Postgres 준비 완료 (Neon) — report_auth + report_accounts + report_loco_state + report_loco_pool_state + report_response')
}

export function usingPg() { return backend === 'pg' }
export function status() { return { backend, hasPool: !!pool } }

export async function loadCred() {
  if (backend === 'pg') {
    const r = await pool.query('SELECT oauth_token, refresh_token, user_id, duuid, email, device_type, adid FROM report_auth WHERE id=1')
    if (!r.rows.length) return null
    const row = r.rows[0]
    return {
      oauthToken: row.oauth_token || '',
      refreshToken: row.refresh_token || '',
      userId: row.user_id || '',
      duuid: row.duuid || '',
      email: row.email || '',
      deviceType: row.device_type || 'tablet',
      adid: row.adid || '',
    }
  }
  try { return JSON.parse(readFileSync(FILE, 'utf8')) } catch (e) { return null }
}

export async function saveCred(cred) {
  if (backend === 'pg') {
    await pool.query(
      `INSERT INTO report_auth (id, oauth_token, refresh_token, user_id, duuid, email, device_type, adid, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7, now())
       ON CONFLICT (id) DO UPDATE SET
         oauth_token = EXCLUDED.oauth_token,
         refresh_token = EXCLUDED.refresh_token,
         user_id = EXCLUDED.user_id,
         duuid = EXCLUDED.duuid,
         email = EXCLUDED.email,
         device_type = EXCLUDED.device_type,
         adid = COALESCE(EXCLUDED.adid, report_auth.adid),
         updated_at = now()`,
      [cred.oauthToken || '', cred.refreshToken || '', cred.userId || '', cred.duuid || '', cred.email || '', cred.deviceType || 'tablet', cred.adid || null],
    )
    return
  }
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(FILE, JSON.stringify(cred))
}

export async function clearCred() {
  if (backend === 'pg') {
    await pool.query('DELETE FROM report_auth WHERE id=1')
    return
  }
  try { writeFileSync(FILE, '{}') } catch (e) {}
}

// ──────────── 다계정 (report_accounts) CRUD ────────────
// account 레코드 형식: {userId, oauthToken, refreshToken, duuid, email, deviceType, nick, isPrimary, active, lastUsed, lastStatus}

function fileAccountsLoad() {
  try { const arr = JSON.parse(readFileSync(ACC_FILE, 'utf8')); return Array.isArray(arr) ? arr : [] }
  catch (e) { return [] }
}
function fileAccountsSave(arr) {
  mkdirSync(DATA_DIR, { recursive: true })
  writeFileSync(ACC_FILE, JSON.stringify(arr))
}

export async function listAccounts() {
  if (backend === 'pg') {
    const r = await pool.query(`SELECT user_id, oauth_token, refresh_token, duuid, email, device_type, nick, is_primary, active, last_used, last_status, adid FROM report_accounts ORDER BY is_primary DESC, created_at ASC`)
    return r.rows.map((row) => ({
      userId: row.user_id,
      oauthToken: row.oauth_token,
      refreshToken: row.refresh_token || '',
      duuid: row.duuid,
      email: row.email || '',
      deviceType: row.device_type || 'tablet',
      nick: row.nick || '',
      isPrimary: !!row.is_primary,
      active: !!row.active,
      lastUsed: row.last_used,
      lastStatus: row.last_status || '',
      adid: row.adid || '',
    }))
  }
  return fileAccountsLoad()
}

export async function saveAccount(acc) {
  if (!acc || !acc.userId || !acc.oauthToken || !acc.duuid) throw new Error('userId·oauthToken·duuid 필요')
  if (backend === 'pg') {
    await pool.query(
      `INSERT INTO report_accounts (user_id, oauth_token, refresh_token, duuid, email, device_type, nick, is_primary, active, adid, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (user_id) DO UPDATE SET
         oauth_token   = EXCLUDED.oauth_token,
         refresh_token = EXCLUDED.refresh_token,
         duuid         = EXCLUDED.duuid,
         email         = COALESCE(EXCLUDED.email, report_accounts.email),
         device_type   = COALESCE(EXCLUDED.device_type, report_accounts.device_type),
         nick          = COALESCE(EXCLUDED.nick, report_accounts.nick),
         is_primary    = EXCLUDED.is_primary OR report_accounts.is_primary,
         active        = EXCLUDED.active,
         adid          = COALESCE(report_accounts.adid, EXCLUDED.adid),
         updated_at    = now()`,
      [
        String(acc.userId), String(acc.oauthToken), acc.refreshToken || '',
        String(acc.duuid), acc.email || '', acc.deviceType || 'tablet',
        acc.nick || '', !!acc.isPrimary, acc.active !== false, acc.adid || null,
      ],
    )
    return
  }
  const arr = fileAccountsLoad()
  const i = arr.findIndex((x) => String(x.userId) === String(acc.userId))
  const merged = Object.assign({}, i >= 0 ? arr[i] : {}, acc, { updatedAt: new Date().toISOString() })
  if (i >= 0) arr[i] = merged; else arr.push(merged)
  fileAccountsSave(arr)
}

export async function deleteAccount(userId) {
  if (backend === 'pg') {
    await pool.query('DELETE FROM report_accounts WHERE user_id=$1', [String(userId)])
    return
  }
  const arr = fileAccountsLoad().filter((x) => String(x.userId) !== String(userId))
  fileAccountsSave(arr)
}

// ★ primary 교체 — 이 userId 만 is_primary=true, 나머지 전부 false. 트랜잭션.
export async function setPrimary(userId) {
  const uid = String(userId)
  if (backend === 'pg') {
    const c = await pool.connect()
    try {
      await c.query('BEGIN')
      await c.query('UPDATE report_accounts SET is_primary=false WHERE user_id<>$1', [uid])
      const r = await c.query('UPDATE report_accounts SET is_primary=true, updated_at=now() WHERE user_id=$1 RETURNING user_id, oauth_token, refresh_token, duuid, email, device_type', [uid])
      await c.query('COMMIT')
      if (!r.rows.length) throw new Error('userId=' + uid + ' 계정 없음')
      const row = r.rows[0]
      return {
        userId: row.user_id, oauthToken: row.oauth_token, refreshToken: row.refresh_token || '',
        duuid: row.duuid, email: row.email || '', deviceType: row.device_type || 'tablet',
      }
    } catch (e) { try { await c.query('ROLLBACK') } catch (x) {}; throw e }
    finally { c.release() }
  }
  const arr = fileAccountsLoad()
  const t = arr.find((x) => String(x.userId) === uid)
  if (!t) throw new Error('userId=' + uid + ' 계정 없음')
  for (const a of arr) a.isPrimary = (String(a.userId) === uid)
  fileAccountsSave(arr)
  return { userId: t.userId, oauthToken: t.oauthToken, refreshToken: t.refreshToken || '', duuid: t.duuid, email: t.email || '', deviceType: t.deviceType || 'tablet' }
}

export async function setAccountActive(userId, active) {
  if (backend === 'pg') {
    await pool.query('UPDATE report_accounts SET active=$1, updated_at=now() WHERE user_id=$2', [!!active, String(userId)])
    return
  }
  const arr = fileAccountsLoad()
  const i = arr.findIndex((x) => String(x.userId) === String(userId))
  if (i >= 0) { arr[i].active = !!active; arr[i].updatedAt = new Date().toISOString(); fileAccountsSave(arr) }
}

export async function markAccountUsed(userId, status) {
  if (backend === 'pg') {
    await pool.query('UPDATE report_accounts SET last_used=now(), last_status=$1, updated_at=now() WHERE user_id=$2', [String(status || ''), String(userId)])
    return
  }
  const arr = fileAccountsLoad()
  const i = arr.findIndex((x) => String(x.userId) === String(userId))
  if (i >= 0) { arr[i].lastUsed = new Date().toISOString(); arr[i].lastStatus = String(status || ''); fileAccountsSave(arr) }
}

export async function getAccount(userId) {
  const all = await listAccounts()
  return all.find((a) => String(a.userId) === String(userId)) || null
}

// ──────────── LOCO 쿨다운 상태 (report_loco_state · report_loco_pool_state) ────────────
// primary = report_loco_state (한 행, id=1)
// fanout 계정 pool = report_loco_pool_state (user_id PK)
// cold-start 때마다 LOCO 재접속 시도해 서버가 anti-abuse 걸리는 걸 방지.
// recordLocoFail() 하면 cooldownMin(기본 60분) 동안 preload 가 자동 접속 스킵.
// clearLocoFail() 은 성공 시·수동 재연결 시 호출.
const LOCO_FILE = join(DATA_DIR, 'loco-state.json')
const LOCO_POOL_FILE = join(DATA_DIR, 'loco-pool-state.json')

export async function loadLocoState() {
  if (backend === 'pg') {
    try {
      const r = await pool.query('SELECT last_fail_at, last_err FROM report_loco_state WHERE id=1')
      if (!r.rows.length) return null
      const row = r.rows[0]
      return { lastFailAt: row.last_fail_at ? new Date(row.last_fail_at).getTime() : 0, lastErr: row.last_err || '' }
    } catch (e) { return null }
  }
  try { return JSON.parse(readFileSync(LOCO_FILE, 'utf8')) } catch (e) { return null }
}

export async function recordLocoFail(err) {
  const msg = String(err || '').slice(0, 500)
  if (backend === 'pg') {
    await pool.query(
      `INSERT INTO report_loco_state (id, last_fail_at, last_err, updated_at)
       VALUES (1, now(), $1, now())
       ON CONFLICT (id) DO UPDATE SET last_fail_at = now(), last_err = EXCLUDED.last_err, updated_at = now()`,
      [msg],
    )
    return
  }
  try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(LOCO_FILE, JSON.stringify({ lastFailAt: Date.now(), lastErr: msg })) } catch (e) {}
}

export async function clearLocoFail() {
  if (backend === 'pg') {
    try { await pool.query('DELETE FROM report_loco_state WHERE id=1') } catch (e) {}
    return
  }
  try { writeFileSync(LOCO_FILE, '{}') } catch (e) {}
}

// ──────────── fanout 계정별 LOCO Pool 상태 (report_loco_pool_state) ────────────
function _poolFileLoad() {
  try { const o = JSON.parse(readFileSync(LOCO_POOL_FILE, 'utf8')); return (o && typeof o === 'object') ? o : {} } catch (e) { return {} }
}
function _poolFileSave(obj) {
  try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(LOCO_POOL_FILE, JSON.stringify(obj)) } catch (e) {}
}

export async function loadLocoPoolState(userId) {
  const uid = String(userId)
  if (backend === 'pg') {
    try {
      const r = await pool.query('SELECT last_fail_at, last_err FROM report_loco_pool_state WHERE user_id=$1', [uid])
      if (!r.rows.length) return null
      const row = r.rows[0]
      return { lastFailAt: row.last_fail_at ? new Date(row.last_fail_at).getTime() : 0, lastErr: row.last_err || '' }
    } catch (e) { return null }
  }
  const o = _poolFileLoad()
  return o[uid] || null
}

export async function recordLocoPoolFail(userId, err) {
  const uid = String(userId)
  const msg = String(err || '').slice(0, 500)
  if (backend === 'pg') {
    try {
      await pool.query(
        `INSERT INTO report_loco_pool_state (user_id, last_fail_at, last_err, updated_at)
         VALUES ($1, now(), $2, now())
         ON CONFLICT (user_id) DO UPDATE SET last_fail_at = now(), last_err = EXCLUDED.last_err, updated_at = now()`,
        [uid, msg],
      )
    } catch (e) {}
    return
  }
  const o = _poolFileLoad()
  o[uid] = { lastFailAt: Date.now(), lastErr: msg }
  _poolFileSave(o)
}

export async function clearLocoPoolFail(userId) {
  const uid = String(userId)
  if (backend === 'pg') {
    try { await pool.query('DELETE FROM report_loco_pool_state WHERE user_id=$1', [uid]) } catch (e) {}
    return
  }
  const o = _poolFileLoad()
  delete o[uid]
  _poolFileSave(o)
}

// ──────────── v59-A new D10 — report_response (응답 캡처) ────────────
// 신고 응답의 message · reason · errUrl · url · rawBody 를 해석 없이 전부 보존.
// UI 에서 라운드/페이즈별로 모아 보고 쿼터·중복·검증 거부 설명을 직접 읽을 수 있게.
const RESP_FILE = join(DATA_DIR, 'report-response.jsonl')

export async function saveReportResponse(rec) {
  if (!rec) return
  const row = {
    round: rec.round != null ? String(rec.round) : null,
    phase: rec.phase != null ? String(rec.phase) : null,
    logId: rec.logId != null ? String(rec.logId) : null,
    http: Number.isFinite(Number(rec.http)) ? Number(rec.http) : null,
    status: Number.isFinite(Number(rec.status)) ? Number(rec.status) : null,
    message: rec.message != null ? String(rec.message) : null,
    reason: rec.reason != null ? String(rec.reason) : null,
    errUrl: rec.errUrl != null ? String(rec.errUrl) : null,
    errUrlLabel: rec.errUrlLabel != null ? String(rec.errUrlLabel) : null,
    url: rec.url != null ? String(rec.url) : null,
    rawBody: rec.rawBody != null ? String(rec.rawBody).slice(0, 4000) : null,
  }
  if (backend === 'pg') {
    try {
      await pool.query(
        `INSERT INTO report_response
         (round, phase, log_id, http, status, message, reason, err_url, err_url_label, url, raw_body, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())`,
        [row.round, row.phase, row.logId, row.http, row.status, row.message, row.reason, row.errUrl, row.errUrlLabel, row.url, row.rawBody],
      )
    } catch (e) {
      console.log('[report_response] pg insert 실패: ' + (e && e.message ? e.message : e))
    }
    return
  }
  // 파일 백엔드 — JSONL. 재배포 때 날아가지만 라운드 중에는 보존.
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const line = JSON.stringify({ ...row, createdAt: new Date().toISOString() }) + '\n'
    const { appendFileSync } = await import('node:fs')
    appendFileSync(RESP_FILE, line)
  } catch (e) {}
}

// 최근 응답 조회 — UI 가 round/phase/log_id 로 좁혀서 읽을 수 있게.
export async function listReportResponses({ limit = 100, logId, round, phase } = {}) {
  const lim = Math.max(1, Math.min(1000, Number(limit) || 100))
  if (backend === 'pg') {
    try {
      const wh = []
      const args = []
      if (logId) { args.push(String(logId)); wh.push('log_id = $' + args.length) }
      if (round) { args.push(String(round)); wh.push('round = $' + args.length) }
      if (phase) { args.push(String(phase)); wh.push('phase = $' + args.length) }
      const where = wh.length ? 'WHERE ' + wh.join(' AND ') : ''
      args.push(lim)
      const r = await pool.query(
        `SELECT id, round, phase, log_id, http, status, message, reason, err_url, err_url_label, url, raw_body, created_at
         FROM report_response ${where} ORDER BY created_at DESC LIMIT $${args.length}`,
        args,
      )
      return r.rows.map((row) => ({
        id: row.id, round: row.round, phase: row.phase, logId: row.log_id,
        http: row.http, status: row.status,
        message: row.message, reason: row.reason,
        errUrl: row.err_url, errUrlLabel: row.err_url_label, url: row.url,
        rawBody: row.raw_body, createdAt: row.created_at,
      }))
    } catch (e) { return [] }
  }
  try {
    const { readFileSync } = await import('node:fs')
    const txt = readFileSync(RESP_FILE, 'utf8')
    const rows = txt.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch (e) { return null } }).filter(Boolean)
    const filtered = rows.filter((r) =>
      (!logId || String(r.logId) === String(logId)) &&
      (!round || String(r.round) === String(round)) &&
      (!phase || String(r.phase) === String(phase))
    )
    return filtered.slice(-lim).reverse()
  } catch (e) { return [] }
}

export async function listLocoPoolFails() {
  if (backend === 'pg') {
    try {
      const r = await pool.query('SELECT user_id, last_fail_at, last_err FROM report_loco_pool_state')
      return r.rows.map((row) => ({ userId: row.user_id, lastFailAt: row.last_fail_at ? new Date(row.last_fail_at).getTime() : 0, lastErr: row.last_err || '' }))
    } catch (e) { return [] }
  }
  const o = _poolFileLoad()
  return Object.entries(o).map(([userId, v]) => ({ userId, ...v }))
}
