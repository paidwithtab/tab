// SQLite state, on the built-in node:sqlite. One file per gateway. WAL mode.
// Holds: HMAC secret, receipt signing key, ledger wallets, holds, receipts, mandate spend counters,
// redeemed challenge ids. The catalog uses its own smaller store below.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { Receipt } from './protocol.js';
import { newKeyPair, type KeyPair } from './keys.js';

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
  tx: string | null; // evm: the fully signed transaction, 0x hex
  // evm: keccak of the raw tx. UNIQUE over non-voided holds, so one signed
  // payment can never back two served calls; a voided hold frees its hash
  // (after a void the same nonce legitimately produces the same bytes).
  tx_hash: string | null;
  // evm: "sender:nonce". UNIQUE over reserved holds: two payments at one nonce can both pass every
  // check while only one can ever mine, so the second waits until the first settles
  tx_slot?: string | null;
  created_at: string;
}

export class Store {
  private db: DatabaseSync;
  readonly secret: Uint8Array;
  readonly receiptKey: KeyPair; // Ed25519; signs every receipt, public half in discovery

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
        state TEXT NOT NULL, ref TEXT, tx TEXT, tx_hash TEXT, created_at TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS holds_tx_hash ON holds (tx_hash) WHERE tx_hash IS NOT NULL AND state != 'voided';
      CREATE TABLE IF NOT EXISTS receipts (
        id TEXT PRIMARY KEY, realm TEXT NOT NULL, resource TEXT NOT NULL,
        amount INTEGER NOT NULL, rail TEXT NOT NULL, payer TEXT NOT NULL,
        owner TEXT NOT NULL, recipient TEXT NOT NULL, ref TEXT NOT NULL, at TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD'
      );
      CREATE TABLE IF NOT EXISTS mandate_spend (
        mandate_id TEXT NOT NULL, window_key TEXT NOT NULL, spent INTEGER NOT NULL,
        PRIMARY KEY (mandate_id, window_key)
      );
      CREATE TABLE IF NOT EXISTS redeemed (challenge_id TEXT PRIMARY KEY, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS faucet_claims (wallet TEXT PRIMARY KEY, ip TEXT NOT NULL, amount INTEGER NOT NULL, at TEXT NOT NULL);
    `);
    // databases created before the evm rail lack the tx_hash column
    try {
      this.db.exec('ALTER TABLE holds ADD COLUMN tx_hash TEXT');
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS holds_tx_hash ON holds (tx_hash) WHERE tx_hash IS NOT NULL AND state != 'voided'");
    } catch {
      /* column already exists */
    }
    // databases created before one-payment-per-nonce lack tx_slot
    try {
      this.db.exec('ALTER TABLE holds ADD COLUMN tx_slot TEXT');
    } catch {
      /* column already exists */
    }
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS holds_tx_slot ON holds (tx_slot) WHERE tx_slot IS NOT NULL AND state = 'reserved'");
    // databases created before gateways could charge in their own token lack the currency column
    try {
      this.db.exec("ALTER TABLE receipts ADD COLUMN currency TEXT NOT NULL DEFAULT 'USD'");
    } catch {
      /* column already exists */
    }
    // databases created before signed receipts lack the full signed document
    try {
      this.db.exec('ALTER TABLE receipts ADD COLUMN doc TEXT');
    } catch {
      /* column already exists */
    }
    const keyRow = this.db.prepare('SELECT value FROM meta WHERE key = ?').get('receipt_key') as { value: string } | undefined;
    if (keyRow) {
      this.receiptKey = JSON.parse(keyRow.value) as KeyPair;
    } else {
      this.receiptKey = newKeyPair();
      this.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('receipt_key', JSON.stringify(this.receiptKey));
    }
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

  // -- starter credits ------------------------------------------------------

  /**
   * Credit a wallet once from the faucet. Returns false if this wallet already
   * claimed. The claim and the credit share one transaction.
   */
  claimFaucet(wallet: string, ip: string, micro: number, at: string): boolean {
    return this.tx(() => {
      const res = this.db
        .prepare('INSERT OR IGNORE INTO faucet_claims (wallet, ip, amount, at) VALUES (?, ?, ?, ?)')
        .run(wallet, ip, micro, at);
      if (Number(res.changes) === 0) return false;
      this.credit(wallet, micro);
      return true;
    });
  }

  /** Claims from one address since a given time, for rate limiting. */
  faucetClaimsFrom(ip: string, sinceIso: string): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM faucet_claims WHERE ip = ? AND at >= ?')
      .get(ip, sinceIso) as { n: number };
    return Number(row.n);
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

  /** Every window's counter for one mandate, for attributing spend to the job it was issued for. */
  spentAll(mandateId: string): Array<{ window_key: string; spent: number }> {
    const rows = this.db
      .prepare('SELECT window_key, spent FROM mandate_spend WHERE mandate_id = ? ORDER BY window_key')
      .all(mandateId) as Array<{ window_key: string; spent: number }>;
    return rows.map((r) => ({ window_key: String(r.window_key), spent: Number(r.spent) }));
  }

  refundSpend(mandateId: string, windowKey: string, micro: number): void {
    this.db
      .prepare(
        'UPDATE mandate_spend SET spent = MAX(0, spent - ?) WHERE mandate_id = ? AND window_key = ?',
      )
      .run(micro, mandateId, windowKey);
  }

  // -- holds and receipts ---------------------------------------------------

  /** Throws with UNIQUE in the message if row.tx_hash was already used. */
  createHold(row: HoldRow): void {
    this.db
      .prepare(
        `INSERT INTO holds (id, challenge_id, amount, payer, owner, recipient, resource, realm, rail,
         mandate_id, window_key, state, ref, tx, tx_hash, tx_slot, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.challenge_id, row.amount, row.payer, row.owner, row.recipient, row.resource,
        row.realm, row.rail, row.mandate_id, row.window_key, row.state, row.ref, row.tx, row.tx_hash,
        row.tx_slot ?? null, row.created_at,
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
        'INSERT INTO receipts (id, realm, resource, amount, currency, rail, payer, owner, recipient, ref, at, doc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(r.id, r.realm, r.resource, Number(r.amount), r.currency ?? 'USD', r.rail, r.payer, r.owner, r.recipient, r.ref, r.at, r.sig ? JSON.stringify(r) : null);
  }

  receipts(limit: number, filter: { payer?: string; since?: string } = {}): Receipt[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.payer) { where.push('payer = ?'); args.push(filter.payer); }
    if (filter.since) { where.push('at >= ?'); args.push(filter.since); }
    args.push(Math.max(1, Math.min(limit, 200)));
    const rows = this.db
      .prepare(`SELECT * FROM receipts${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY at DESC, rowid DESC LIMIT ?`)
      .all(...args) as Array<Record<string, unknown>>;
    // a signed receipt is returned exactly as signed, so anyone can check it later
    return rows.map((r) => r.doc ? JSON.parse(String(r.doc)) as Receipt : ({
      id: String(r.id), realm: String(r.realm), resource: String(r.resource),
      amount: String(r.amount), currency: String(r.currency ?? 'USD'),
      rail: r.rail as Receipt['rail'], payer: String(r.payer), owner: String(r.owner),
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
  last_ok_at?: string | null; // the last fetch that succeeded; the payload is from then
  forget?: boolean; // on put: drop the stored payload (the origin is now refused)
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
    // catalogs created before stale serving lack last_ok_at
    try {
      this.db.exec('ALTER TABLE gateways ADD COLUMN last_ok_at TEXT');
      this.db.exec('UPDATE gateways SET last_ok_at = fetched_at WHERE ok = 1');
    } catch {
      /* column already exists */
    }
  }

  private cached: GatewayRow[] | null = null; // all() parses every payload; search calls it per request

  put(row: GatewayRow): void {
    this.cached = null;
    if (row.forget) this.db.prepare('UPDATE gateways SET payload = NULL, last_ok_at = NULL WHERE origin = ?').run(row.origin);
    this.db
      .prepare(
        `INSERT INTO gateways (origin, ok, error, payload, fetched_at, last_ok_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(origin) DO UPDATE SET ok=excluded.ok, error=excluded.error,
           payload=COALESCE(excluded.payload, gateways.payload), fetched_at=excluded.fetched_at,
           last_ok_at=COALESCE(excluded.last_ok_at, gateways.last_ok_at)`,
      )
      .run(row.origin, row.ok ? 1 : 0, row.error, row.payload ? JSON.stringify(row.payload) : null, row.fetched_at, row.ok ? row.fetched_at : null);
  }

  all(): GatewayRow[] {
    if (this.cached) return this.cached;
    const rows = this.db.prepare('SELECT * FROM gateways ORDER BY origin').all() as Array<
      Record<string, unknown>
    >;
    this.cached = rows.map((r) => ({
      origin: String(r.origin),
      ok: Number(r.ok) === 1,
      error: r.error == null ? null : String(r.error),
      payload: r.payload == null ? null : JSON.parse(String(r.payload)),
      fetched_at: String(r.fetched_at),
      last_ok_at: r.last_ok_at == null ? null : String(r.last_ok_at),
    }));
    return this.cached;
  }

  close(): void {
    this.db.close();
  }
}
