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
      updated_at  timestamptz NOT NULL DEFAULT now(),
      created_at  timestamptz NOT NULL DEFAULT now()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_loco_state (
      id           integer PRIMARY KEY,
      last_fail_at timestamptz,
      last_err     text,
      updated_at   timestamptz NOT NULL DEFAULT now()
    )
  `)
  backend = 'pg'
  console.log('[db] Postgres 준비 완료 (Neon) — report_auth + report_accounts + report_loco_state')
}

export function usingPg() { return backend === 'pg' }
export function status() { return { backend, hasPool: !!pool } }

export async function loadCred() {
  if (backend === 'pg') {
    const r = await pool.query('SELECT oauth_token, refresh_token, user_id, duuid, email, device_type FROM report_auth WHERE id=1')
    if (!r.rows.length) return null
    const row = r.rows[0]
    return {
      oauthToken: row.oauth_token || '',
      refreshToken: row.refresh_token || '',
      userId: row.user_id || '',
      duuid: row.duuid || '',
      email: row.email || '',
      deviceType: row.device_type || 'tablet',
    }
  }
  try { return JSON.parse(readFileSync(FILE, 'utf8')) } catch (e) { return null }
}

export async function saveCred(cred) {
  if (backend === 'pg') {
    await pool.query(
      `INSERT INTO report_auth (id, oauth_token, refresh_token, user_id, duuid, email, device_type, updated_at)
       VALUES (1, $1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (id) DO UPDATE SET
         oauth_token = EXCLUDED.oauth_token,
         refresh_token = EXCLUDED.refresh_token,
         user_id = EXCLUDED.user_id,
         duuid = EXCLUDED.duuid,
         email = EXCLUDED.email,
         device_type = EXCLUDED.device_type,
         updated_at = now()`,
      [cred.oauthToken || '', cred.refreshToken || '', cred.userId || '', cred.duuid || '', cred.email || '', cred.deviceType || 'tablet'],
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
    const r = await pool.query(`SELECT user_id, oauth_token, refresh_token, duuid, email, device_type, nick, is_primary, active, last_used, last_status FROM report_accounts ORDER BY is_primary DESC, created_at ASC`)
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
    }))
  }
  return fileAccountsLoad()
}

export async function saveAccount(acc) {
  if (!acc || !acc.userId || !acc.oauthToken || !acc.duuid) throw new Error('userId·oauthToken·duuid 필요')
  if (backend === 'pg') {
    await pool.query(
      `INSERT INTO report_accounts (user_id, oauth_token, refresh_token, duuid, email, device_type, nick, is_primary, active, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (user_id) DO UPDATE SET
         oauth_token   = EXCLUDED.oauth_token,
         refresh_token = EXCLUDED.refresh_token,
         duuid         = EXCLUDED.duuid,
         email         = COALESCE(EXCLUDED.email, report_accounts.email),
         device_type   = COALESCE(EXCLUDED.device_type, report_accounts.device_type),
         nick          = COALESCE(EXCLUDED.nick, report_accounts.nick),
         is_primary    = EXCLUDED.is_primary OR report_accounts.is_primary,
         active        = EXCLUDED.active,
         updated_at    = now()`,
      [
        String(acc.userId), String(acc.oauthToken), acc.refreshToken || '',
        String(acc.duuid), acc.email || '', acc.deviceType || 'tablet',
        acc.nick || '', !!acc.isPrimary, acc.active !== false,
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

// ──────────── LOCO 쿨다운 상태 (report_loco_state) ────────────
// cold-start 때마다 LOCO 재접속 시도해 서버가 anti-abuse 걸리는 걸 방지.
// recordLocoFail() 하면 cooldownMin(기본 60분) 동안 preload 가 자동 접속 스킵.
// clearLocoFail() 은 성공 시·수동 재연결 시 호출.
const LOCO_FILE = join(DATA_DIR, 'loco-state.json')

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
