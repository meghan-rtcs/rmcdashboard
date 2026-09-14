// Owner credentials are deliberately stored only as a salted scrypt hash in
// app_state. The session-signing key is process-local: a process restart is a
// safe, conservative owner-session invalidation.
import crypto from "crypto";
import { getDb } from "./db.js";

const OWNER_AUTH_KEY = "owner_auth_v1";
const OWNER_GENERATION_KEY = "owner_auth_generation_v1";
const SCRYPT_KEY_LENGTH = 64;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };
const sessionSigningKey = crypto.randomBytes(32);

function safeEqual(a, b) {
  const ab = Buffer.isBuffer(a) ? a : Buffer.from(String(a));
  const bb = Buffer.isBuffer(b) ? b : Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function parseRecord(row) {
  if (!row?.value) return null;
  try {
    const record = JSON.parse(row.value);
    if (!record?.salt || !record?.hash || !Number.isInteger(record.generation)) return null;
    return record;
  } catch {
    return null;
  }
}

function getRecord() {
  return parseRecord(getDb().prepare("SELECT value FROM app_state WHERE key = ?").get(OWNER_AUTH_KEY));
}

function hasCredentialRecord() {
  return !!getDb().prepare("SELECT 1 FROM app_state WHERE key = ?").get(OWNER_AUTH_KEY);
}

function getGeneration() {
  const row = getDb().prepare("SELECT value FROM app_state WHERE key = ?").get(OWNER_GENERATION_KEY);
  const value = Number(row?.value);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function setGeneration(generation) {
  getDb().prepare(`INSERT INTO app_state (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(OWNER_GENERATION_KEY, String(generation));
}

function derive(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEY_LENGTH, SCRYPT_OPTIONS, (err, hash) => {
      if (err) reject(err);
      else resolve(hash);
    });
  });
}

export function validOwnerPassword(password) {
  return typeof password === "string" && Array.from(password).length >= 12 && Buffer.byteLength(password) <= 1024;
}

async function newRecord(password, generation) {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt);
  return { salt: salt.toString("base64"), hash: hash.toString("base64"), generation };
}

export function ownerSetupRequired() {
  return !hasCredentialRecord();
}

// The unique app_state key makes this atomic across concurrent setup requests:
// exactly one INSERT succeeds and all others receive an already-configured result.
export async function setInitialOwnerPassword(password) {
  if (!validOwnerPassword(password)) return { ok: false, reason: "invalid_password" };
  // Hash outside SQLite's write transaction. The transaction chooses a fresh
  // generation at commit time and protects the first-setup race.
  const record = await newRecord(password, 0);
  const db = getDb();
  return db.transaction(() => {
    if (hasCredentialRecord()) return { ok: false, reason: "already_configured" };
    record.generation = getGeneration() + 1;
    setGeneration(record.generation);
    db.prepare("INSERT INTO app_state (key, value) VALUES (?, ?)").run(OWNER_AUTH_KEY, JSON.stringify(record));
    return { ok: true };
  })();
}

export async function verifyOwnerPassword(password) {
  if (typeof password !== "string") return false;
  const record = getRecord();
  if (!record) return false;
  try {
    const candidate = await derive(password, Buffer.from(record.salt, "base64"));
    const current = getRecord();
    // A reset/setup may complete while scrypt is running. Never authenticate
    // against a credential that is no longer the persisted current record.
    if (!current || current.generation !== record.generation ||
      !safeEqual(current.salt, record.salt) || !safeEqual(current.hash, record.hash)) return false;
    return safeEqual(candidate, Buffer.from(record.hash, "base64"));
  } catch {
    return false;
  }
}

export function makeOwnerSession(maxAgeSeconds) {
  const record = getRecord();
  if (!record) return null;
  const payload = Buffer.from(JSON.stringify({
    role: "owner",
    exp: Date.now() + maxAgeSeconds * 1000,
    generation: record.generation,
    nonce: crypto.randomBytes(18).toString("base64url"),
  })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSigningKey).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

export function validOwnerSession(token) {
  if (!token || typeof token !== "string" || !token.includes(".")) return false;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra) return false;
  const expected = crypto.createHmac("sha256", sessionSigningKey).update(payload).digest("base64url");
  if (!safeEqual(sig, expected)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const record = getRecord();
    return !!record && data.role === "owner" && Number(data.exp) > Date.now() &&
      Number(data.generation) === record.generation;
  } catch {
    return false;
  }
}

// Reset removes the credential rather than installing a new one. The next
// owner must complete the same first-run setup flow; incrementing generation
// ensures every previously issued owner cookie immediately becomes unusable.
export function clearOwnerPassword() {
  const db = getDb();
  const transaction = db.transaction(() => {
    if (!hasCredentialRecord()) return false;
    db.prepare("DELETE FROM app_state WHERE key = ?").run(OWNER_AUTH_KEY);
    setGeneration(getGeneration() + 1);
    return true;
  });
  return transaction();
}