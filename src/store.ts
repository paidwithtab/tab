// SQLite state, on the built-in node:sqlite. One file per gateway. WAL mode.
// Holds: HMAC secret, ledger wallets, holds, receipts, mandate spend counters,
// redeemed challenge ids. The catalog uses its own smaller store below.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { Receipt } from './protocol.js';

export interface HoldRow {
  id: string;
  challenge_id: string;
  amount: number; // micro-USD
  payer: string; // agent wallet id
  owner: string; // owner wallet id
  recipient: string;
  resource: string;
  realm: string;
  rail: string;
  mandate_id: string;
  window_key: string; // '' for total, 'YYYY-MM-DD' for day windows
  state: 'reserved' | 'captured' | 'voided';
  ref: string | null;
  tx: string | null; // solana: the fully signed transaction, base64
  created_at: string;
}

export class Store {
  private db: DatabaseSync;
  readonly secret: Uint8Array;

  constructor(public readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wallets (id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS holds (
        id TEXT PRIMARY KEY, challenge_id TEXT NOT NULL, amount INTEGER NOT NULL,
        payer TEXT NOT NULL, owner TEXT NOT NULL, recipient TEXT NOT NULL,
        resource TEXT NOT NULL, realm TEXT NOT NULL, rail TEXT NOT NULL,
        mandate_id TEXT NOT NULL, window_key TEXT NOT NULL,
        state TEXT NOT NULL, ref TEXT, tx TEXT, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, realm TEXT NOT NULL, resource TEXT NOT NULL,
        amount INTEGER NOT NULL, rail TEXT NOT NULL, payer TEXT NOT NULL,
        owner TEXT NOT NULL, recipient TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS mandate_spend (
        mandate_id TEXT NOT NULL, window_key TEXT NOT NULL, spent INTEGER NOT NULL,
        PRIMARY KEY (mandate_id, window_key)
      );
      CREATE TABLE IF NOT EXISTS redeemed (challenge_id TEXT PRIMARY KEY, at TEXT NOT NULL);
    `);
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('secret') as
      | { value: string }
      | undefined;
    if (row) {
      this.secret = Buffer.from(row.value, 'hex');
    } else {
      const secret = randomBytes(32);
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('secret', secret.toString('hex'));
      this.secret = secret;
    }
  }

  /** Run fn inside a single transaction; the budget check and the funds check share it. */
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  // -- ledger wallets ------------------------------------------------------

  balance(wallet: string): number {
    const row = this.db.prepare('SELECT balance FROM wallets WHERE id = ?').get(wallet) as
      | { balance: number }
      | undefined;
    return row ? Number(row.balance) : 0;
  }

  credit(wallet: string, micro: number): void {
    this.db
      .prepare(
        'INSERT INTO wallets (id, balance) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET balance = balance + excluded.balance',
      )
      .run(wallet, micro);
  }

  /** Debit only if the balance covers it. Returns false otherwise. */
  debit(wallet: string, micro: number): boolean {
    const res = this.db
      .prepare('UPDATE wallets SET balance = balance - ? WHERE id = ? AND balance >= ?')
      .run(micro, wallet, micro);
    return Number(res.changes) > 0;
  }

  // -- challenge redemption (once, ever) -----------------------------------

  redeem(challengeId: string, at: string): boolean {
    const res = this.db
      .prepare('INSERT OR IGNORE INTO redeemed (challenge_id, at) VALUES (?, ?)')
      .run(challengeId, at);
    return Number(res.changes) > 0;
  }

  pruneRedeemed(beforeIso: string): void {
    this.db.prepare('DELETE FROM redeemed WHERE at < ?').run(beforeIso);
  }

  // -- mandate spend counters ----------------------------------------------

  spent(mandateId: string, windowKey: string): number {
    const row = this.db
      .prepare('SELECT spent FROM mandate_spend WHERE mandate_id = ? AND window_key = ?')
      .get(mandateId, windowKey) as { spent: number } | undefined;
    return row ? Number(row.spent) : 0;
  }

  /** Add to the counter only if it stays within budget. Returns false otherwise. */
  addSpend(mandateId: string, windowKey: string, micro: number, budget: number): boolean {
    if (this.spent(mandateId, windowKey) + micro > budget) return false;
    this.db
      .prepare(
        'INSERT INTO mandate_spend (mandate_id, window_key, spent) VALUES (?, ?, ?) ON CONFLICT(mandate_id, window_key) DO UPDATE SET spent = spent + excluded.spent',
      )
      .run(mandateId, windowKey, micro);
    return true;
  }

  refundSpend(mandateId: string, windowKey: string, micro: number): void {
    this.db
      .prepare(
        'UPDATE mandate_spend SET spent = MAX(0, spent - ?) WHERE mandate_id = ? AND window_key = ?',
      )
      .run(micro, mandateId, windowKey);
  }

  // -- holds and receipts ---------------------------------------------------

  createHold(row: HoldRow): void {
    this.db
      .prepare(
        `INSERT INTO holds (id, challenge_id, amount, payer, owner, recipient, resource, realm, rail,
         mandate_id, window_key, state, ref, tx, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.challenge_id, row.amount, row.payer, row.owner, row.recipient, row.resource,
        row.realm, row.rail, row.mandate_id, row.window_key, row.state, row.ref, row.tx, row.created_at,
      );
  }

  getHold(id: string): HoldRow | undefined {
    return this.db.prepare('SELECT * FROM holds WHERE id = ?').get(id) as HoldRow | undefined;
  }

  setHoldState(id: string, state: HoldRow['state'], ref: string | null = null): void {
    this.db.prepare('UPDATE holds SET state = ?, ref = ? WHERE id = ?').run(state, ref, id);
  }

  addReceipt(r: Receipt): void {
    this.db
      .prepare(
        'INSERT INTO receipts (id, realm, resource, amount, rail, payer, owner, recipient, ref, at) VALUES (?,?,?,?,?,?,?,?,?,?)',
      )
      .run(r.id, r.realm, r.resource, Number(r.amount), r.rail, r.payer, r.owner, r.recipient, r.ref, r.at);
  }

  receipts(limit: number): Receipt[] {
    const rows = this.db
      .prepare('SELECT * FROM receipts ORDER BY at DESC, rowid DESC LIMIT ?')
      .all(Math.max(1, Math.min(limit, 200))) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id), realm: String(r.realm), resource: String(r.resource),
      amount: String(r.amount), currency: 'USD' as const,
      rail: r.rail as 'ledger' | 'solana', payer: String(r.payer), owner: String(r.owner),
      recipient: String(r.recipient), ref: String(r.ref), at: String(r.at),
    }));
  }

  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// catalog store

export interface GatewayRow {
  origin: string;
  ok: boolean;
  error: string | null;
  payload: Record<string, unknown> | null; // the /.well-known/tab document
  fetched_at: string;
}

export class CatalogStore {
  private db: DatabaseSync;

  constructor(public readonly path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS gateways (
        origin TEXT PRIMARY KEY, ok INTEGER NOT NULL, error TEXT,
        payload TEXT, fetched_at TEXT NOT NULL
      );
    `);
  }

  put(row: GatewayRow): void {
    this.db
      .prepare(
        `INSERT INTO gateways (origin, ok, error, payload, fetched_at) VALUES (?,?,?,?,?)
         ON CONFLICT(origin) DO UPDATE SET ok=excluded.ok, error=excluded.error,
           payload=COALESCE(excluded.payload, gateways.payload), fetched_at=excluded.fetched_at`,
      )
      .run(row.origin, row.ok ? 1 : 0, row.error, row.payload ? JSON.stringify(row.payload) : null, row.fetched_at);
  }

  all(): GatewayRow[] {
    const rows = this.db.prepare('SELECT * FROM gateways ORDER BY origin').all() as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      origin: String(r.origin),
      ok: Number(r.ok) === 1,
      error: r.error == null ? null : String(r.error),
      payload: r.payload == null ? null : JSON.parse(String(r.payload)),
      fetched_at: String(r.fetched_at),
    }));
  }

  close(): void {
    this.db.close();
  }
}
