// SQLite state, on the built-in node:sqlite. One file per gateway. WAL mode.
// Holds: HMAC secret, receipt signing key, ledger wallets, holds, receipts, mandate spend counters,
// redeemed challenge ids. The catalog uses its own smaller store below.

import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import type { Receipt } from './protocol.js';
import type { Revocation } from './revoke.js';
import type { Approval } from './approval.js';
import type { ChannelState } from './channel.js';
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
  // reserved: checks passed, nothing moved; escrowed: held for delivery (3.0), or a channel deposit;
  // lockwatch: the buyer's transfer into escrow did not confirm in time, so the call failed, and the
  // gateway watches for it landing late to send it back
  // locking: the transfer into escrow is being broadcast (its hash in ref); capturewatch: a direct payment a
  // crashed process left mid-flight, watched to see whether it was paid
  state: 'reserved' | 'escrowed' | 'captured' | 'voided' | 'lockwatch' | 'locking' | 'capturewatch';
  ref: string | null;
  tx: string | null; // evm: the fully signed transaction, 0x hex
  // evm: keccak of the raw tx. UNIQUE over non-voided holds, so one signed
  // payment can never back two served calls; a voided hold frees its hash
  // (after a void the same nonce legitimately produces the same bytes).
  tx_hash: string | null;
  // evm: "sender:nonce". UNIQUE over reserved holds: two payments at one nonce can both pass every
  // check while only one can ever mine, so the second waits until the first settles
  tx_slot?: string | null;
  // 3.0: the spend counters of a sub-mandate's ancestors, [[mandate id, window key], ...];
  // a payment counts against every one of them and a refund gives back to each
  chain?: Array<[string, string]> | null;
  // 3.0: evm: where escrowed money goes back to (the mandate's evm_owner)
  refund_to?: string | null;
  created_at: string;
}

/** One payout from held money (3.0). `sent`: an evm transaction is signed and stored and may be in flight. */
export interface PayoutRow {
  key: string; // e.g. escrow:<id>:seller, channel:<id>:buyer
  hold_id: string;
  to_addr: string;
  amount: number;
  state: 'pending' | 'sent' | 'confirmed' | 'stuck';
  ref: string | null;
  raw: string | null; // evm: the signed transaction, 0x hex
  hash: string | null;
  nonce: number | null;
  // evm: zero-value transactions of ours to ourselves at the same nonce, sent to free it when the node
  // keeps refusing the payout; every one is kept (raw and hash), rebroadcast on each try, and checked
  cancels?: Array<{ raw: string; hash: string }>;
  attempts: number;
  last_error: string | null;
  next_try_at: string;
  created_at: string;
  updated_at: string;
}

function rowToPayout(r: Record<string, unknown>): PayoutRow {
  const sOrNull = (k: string) => (r[k] == null ? null : String(r[k]));
  return {
    key: String(r.key), hold_id: String(r.hold_id), to_addr: String(r.to_addr), amount: Number(r.amount), state: r.state as PayoutRow['state'],
    ref: sOrNull('ref'), raw: sOrNull('raw'), hash: sOrNull('hash'), nonce: r.nonce == null ? null : Number(r.nonce), cancels: r.cancels ? JSON.parse(String(r.cancels)) : [], attempts: Number(r.attempts),
    last_error: sOrNull('last_error'), next_try_at: String(r.next_try_at), created_at: String(r.created_at), updated_at: String(r.updated_at),
  };
}

/** A pay-on-delivery order (3.0): the hold, what was asked, and what was delivered. */
export interface EscrowRow {
  hold_id: string;
  state: 'held' | 'delivered' | 'refunded';
  deadline: string;
  realm: string;
  resource: string;
  amount: number;
  payer: string;
  owner: string;
  mandate_id: string;
  request: { query: string; body_sha256: string };
  credential: string; // the agent's signature
  held_ref: string | null;
  result: Buffer | null;
  result_type: string | null;
  result_status: number | null;
  receipt: Receipt | null;
  refund_ref: string | null;
  reason: string | null; // why it was refunded
  created_at: string;
  settled_at: string | null;
  payout_state?: 'none' | 'pending' | 'done' | 'stuck';
}

/** A payment channel as the gateway keeps it (3.0). Amounts in micro units. */
export interface ChannelRow {
  id: string;
  hold_id: string;
  agent: string;
  owner: string;
  mandate: string; // the mandate JSON it was opened under, whole chain, for revocation checks
  mandate_id: string;
  deposit: number;
  authorized: number;
  spent: number;
  held: number;
  calls: number;
  state: 'open' | 'closed';
  opened_at: string;
  expires_at: string;
  closed_at: string | null;
  settle_ref: string | null;
  refund_ref: string | null;
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
      CREATE TABLE IF NOT EXISTS revocations (
        mandate_id TEXT NOT NULL, by TEXT NOT NULL, doc TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY (mandate_id, by)
      );
      CREATE INDEX IF NOT EXISTS revocations_received ON revocations (received_at);
      CREATE TABLE IF NOT EXISTS mandates_seen (id TEXT PRIMARY KEY, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS owners_seen (owner TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS revocations_pending (
        mandate_id TEXT NOT NULL, by TEXT NOT NULL, doc TEXT NOT NULL, mandate_doc TEXT NOT NULL, expires_at TEXT NOT NULL, received_at TEXT NOT NULL,
        PRIMARY KEY (mandate_id, by)
      );
      CREATE TABLE IF NOT EXISTS approvals (request_id TEXT PRIMARY KEY, doc TEXT NOT NULL, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS spent_approvals (sig_hash TEXT PRIMARY KEY, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS escrows (
        hold_id TEXT PRIMARY KEY, state TEXT NOT NULL, deadline TEXT NOT NULL, realm TEXT NOT NULL, resource TEXT NOT NULL,
        amount INTEGER NOT NULL, payer TEXT NOT NULL, owner TEXT NOT NULL, mandate_id TEXT NOT NULL, request TEXT NOT NULL,
        credential TEXT NOT NULL, held_ref TEXT, result BLOB, result_type TEXT, result_status INTEGER, receipt TEXT,
        refund_ref TEXT, reason TEXT, created_at TEXT NOT NULL, settled_at TEXT
      );
      CREATE INDEX IF NOT EXISTS escrows_state ON escrows (state, deadline);
      CREATE TABLE IF NOT EXISTS channels (
        id TEXT PRIMARY KEY, hold_id TEXT NOT NULL, agent TEXT NOT NULL, owner TEXT NOT NULL, mandate TEXT NOT NULL,
        mandate_id TEXT NOT NULL, deposit INTEGER NOT NULL, authorized INTEGER NOT NULL DEFAULT 0, spent INTEGER NOT NULL DEFAULT 0,
        held INTEGER NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL, opened_at TEXT NOT NULL,
        expires_at TEXT NOT NULL, closed_at TEXT, settle_ref TEXT, refund_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS vouchers (channel TEXT NOT NULL, nonce TEXT NOT NULL, PRIMARY KEY (channel, nonce));
      CREATE TABLE IF NOT EXISTS payouts (
        key TEXT PRIMARY KEY, hold_id TEXT NOT NULL, to_addr TEXT NOT NULL, amount INTEGER NOT NULL, state TEXT NOT NULL,
        ref TEXT, raw TEXT, hash TEXT, nonce INTEGER, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
        next_try_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS payouts_due ON payouts (state, next_try_at);
    `);
    try { this.db.exec('ALTER TABLE payouts ADD COLUMN cancels TEXT'); } catch { /* column already exists */ }
    // 3.0: revocations keep the mandate that authorizes them, so peers can check it too
    try { this.db.exec('ALTER TABLE revocations ADD COLUMN mandate_doc TEXT'); } catch { /* column already exists */ }
    // 3.0.1: approvals are counted per owner, so one owner cannot fill the table for everyone
    try { this.db.exec('ALTER TABLE approvals ADD COLUMN owner TEXT'); } catch { /* column already exists */ }
    this.db.exec('CREATE INDEX IF NOT EXISTS approvals_owner ON approvals (owner)');
    // 3.0: whether an escrow's payout went out (done), is still owed (pending), or has stopped retrying (stuck)
    try { this.db.exec("ALTER TABLE escrows ADD COLUMN payout_state TEXT NOT NULL DEFAULT 'none'"); } catch { /* column already exists */ }
    // 3.0: sub-mandate spend chains and escrow refund addresses on holds
    for (const col of ['chain', 'refund_to']) {
      try { this.db.exec(`ALTER TABLE holds ADD COLUMN ${col} TEXT`); } catch { /* column already exists */ }
    }
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
    // a payment being locked into escrow still holds its sender and nonce
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS holds_tx_slot_locking ON holds (tx_slot) WHERE tx_slot IS NOT NULL AND state IN ('reserved', 'locking')");
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

  /** An evm faucet claim: recorded once per wallet, before the tokens are sent; false if this wallet already claimed. */
  recordFaucetClaim(wallet: string, ip: string, micro: number, at: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO faucet_claims (wallet, ip, amount, at) VALUES (?, ?, ?, ?)').run(wallet, ip, micro, at).changes) > 0;
  }

  /** Undo a claim whose transfer failed, so the wallet can try again. */
  dropFaucetClaim(wallet: string): void {
    this.db.prepare('DELETE FROM faucet_claims WHERE wallet = ?').run(wallet);
  }

  /** How many wallets have claimed from the faucet, ever. */
  faucetClaimCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM faucet_claims').get() as { n: number }).n);
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

  isRedeemed(id: string): boolean {
    return this.db.prepare('SELECT 1 FROM redeemed WHERE challenge_id = ?').get(id) !== undefined;
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
         mandate_id, window_key, state, ref, tx, tx_hash, tx_slot, chain, refund_to, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.id, row.challenge_id, row.amount, row.payer, row.owner, row.recipient, row.resource,
        row.realm, row.rail, row.mandate_id, row.window_key, row.state, row.ref, row.tx, row.tx_hash,
        row.tx_slot ?? null, row.chain?.length ? JSON.stringify(row.chain) : null, row.refund_to ?? null, row.created_at,
      );
  }

  getHold(id: string): HoldRow | undefined {
    const r = this.db.prepare('SELECT * FROM holds WHERE id = ?').get(id) as (HoldRow & { chain: unknown }) | undefined;
    if (!r) return undefined;
    return { ...r, chain: typeof r.chain === 'string' ? JSON.parse(r.chain) : null };
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

  // -- revocations (3.0) ---------------------------------------------------

  /** Keep a revocation whose authority was checked against `mandate`; false if this signer had already revoked it. */
  addRevocation(r: Revocation, receivedAt: string, mandate?: unknown): boolean {
    const res = this.db.prepare('INSERT OR IGNORE INTO revocations (mandate_id, by, doc, received_at, mandate_doc) VALUES (?,?,?,?,?)')
      .run(r.mandate, r.by, JSON.stringify(r), receivedAt, mandate ? JSON.stringify(mandate) : null);
    return Number(res.changes) > 0;
  }

  /** Remember a mandate (and every mandate in its chain) this gateway was paid under, so a later revocation can be checked against it. */
  rememberMandates(docs: Array<{ id: string; owner?: string }>): void {
    const ins = this.db.prepare('INSERT OR IGNORE INTO mandates_seen (id, doc) VALUES (?, ?)');
    const own = this.db.prepare('INSERT OR IGNORE INTO owners_seen (owner) VALUES (?)');
    for (const d of docs) { ins.run(d.id, JSON.stringify(d)); if (d.owner) own.run(d.owner); }
  }

  ownerSeen(owner: string): boolean {
    return this.db.prepare('SELECT 1 FROM owners_seen WHERE owner = ?').get(owner) !== undefined;
  }

  /**
   * A revocation for a mandate this gateway has never been paid under: kept (without the mandate, which
   * is checked when it is presented) until `expiresAt`, never forwarded to peers. Consulted at payment, so
   * it still stops the mandate if it is ever presented here. Nothing is ever evicted to make room: past
   * `cap` rows a new one is refused (null), so a flood cannot push out a revocation an owner relies on.
   */
  addPendingRevocation(r: Revocation, expiresAt: string, receivedAt: string, cap = 200_000): boolean | null {
    if (this.db.prepare('SELECT 1 FROM revocations_pending WHERE mandate_id = ? AND by = ?').get(r.mandate, r.by)) {
      this.db.prepare('UPDATE revocations_pending SET expires_at = ? WHERE mandate_id = ? AND by = ? AND expires_at < ?').run(expiresAt, r.mandate, r.by, expiresAt);
      return false;
    }
    if (this.pendingRevocationCount() >= cap) return null;
    return Number(this.db.prepare('INSERT OR IGNORE INTO revocations_pending (mandate_id, by, doc, mandate_doc, expires_at, received_at) VALUES (?,?,?,?,?,?)')
      .run(r.mandate, r.by, JSON.stringify(r), '', expiresAt, receivedAt).changes) > 0;
  }

  pendingRevocations(mandateId: string): Array<{ revocation: Revocation }> {
    return (this.db.prepare('SELECT doc FROM revocations_pending WHERE mandate_id = ?').all(mandateId) as Array<{ doc: string }>)
      .map((r) => ({ revocation: JSON.parse(String(r.doc)) }));
  }

  dropPendingRevocation(mandateId: string, by: string): void {
    this.db.prepare('DELETE FROM revocations_pending WHERE mandate_id = ? AND by = ?').run(mandateId, by);
  }

  prunePendingRevocations(nowIso: string): void {
    this.db.prepare('DELETE FROM revocations_pending WHERE expires_at < ?').run(nowIso);
  }

  pendingRevocationCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM revocations_pending').get() as { n: number }).n);
  }

  approvalCountOf(owner: string): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE owner = ?').get(owner) as { n: number }).n);
  }

  approvalCount(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM approvals').get() as { n: number }).n);
  }

  seenMandate(id: string): unknown | undefined {
    const r = this.db.prepare('SELECT doc FROM mandates_seen WHERE id = ?').get(id) as { doc: string } | undefined;
    return r ? JSON.parse(String(r.doc)) : undefined;
  }

  /** Who has revoked this mandate id (signers, not yet checked against the mandate). */
  revocationSigners(mandateId: string): string[] {
    return (this.db.prepare('SELECT by FROM revocations WHERE mandate_id = ?').all(mandateId) as Array<{ by: string }>).map((r) => String(r.by));
  }

  revocationsOf(mandateId: string): Revocation[] {
    return (this.db.prepare('SELECT doc FROM revocations WHERE mandate_id = ?').all(mandateId) as Array<{ doc: string }>).map((r) => JSON.parse(String(r.doc)));
  }

  /**
   * Revocations after a sequence number, in the order stored, for peers that poll. A sequence, not a
   * time: rows sharing a millisecond, or a clock step, would make a time cursor skip some for good.
   */
  revocationsAfter(seq: number, limit = 500): Array<{ seq: number; revocation: Revocation; mandate: unknown; received_at: string }> {
    const rows = this.db.prepare('SELECT rowid AS seq, doc, mandate_doc, received_at FROM revocations WHERE rowid > ? ORDER BY rowid LIMIT ?')
      .all(seq, Math.max(1, Math.min(limit, 1000))) as Array<{ seq: number; doc: string; mandate_doc: string | null; received_at: string }>;
    return rows.map((r) => ({ seq: Number(r.seq), revocation: JSON.parse(String(r.doc)), mandate: r.mandate_doc ? JSON.parse(String(r.mandate_doc)) : null, received_at: String(r.received_at) }));
  }

  // -- approvals posted to the gateway (3.0) ------------------------------

  putApproval(requestId: string, a: Approval): void {
    this.db.prepare('INSERT INTO approvals (request_id, doc, expires_at, owner) VALUES (?,?,?,?) ON CONFLICT(request_id) DO UPDATE SET doc = excluded.doc, expires_at = excluded.expires_at, owner = excluded.owner')
      .run(requestId, JSON.stringify(a), a.expires_at, a.by);
  }

  approvalFor(requestId: string): Approval | undefined {
    const r = this.db.prepare('SELECT doc FROM approvals WHERE request_id = ?').get(requestId) as { doc: string } | undefined;
    return r ? JSON.parse(String(r.doc)) : undefined;
  }

  pruneApprovals(beforeIso: string): void {
    this.db.prepare('DELETE FROM approvals WHERE expires_at < ?').run(beforeIso);
    // a spent approval is remembered until it could no longer be used anyway
    this.db.prepare('DELETE FROM spent_approvals WHERE expires_at < ?').run(beforeIso);
  }

  /** Spend an approval, once: false when it was spent before. Kept until its own expiry, whatever prunes the redeemed set. */
  spendApproval(sigHash: string, expiresAt: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO spent_approvals (sig_hash, expires_at) VALUES (?, ?)').run(sigHash, expiresAt).changes) > 0;
  }

  approvalSpent(sigHash: string): boolean {
    return this.db.prepare('SELECT 1 FROM spent_approvals WHERE sig_hash = ?').get(sigHash) !== undefined;
  }

  deleteApproval(requestId: string): void {
    this.db.prepare('DELETE FROM approvals WHERE request_id = ?').run(requestId);
  }

  // -- payouts (3.0) -------------------------------------------------------
  // Money the gateway pays out of what it holds (escrow, channel deposits) goes through one row per
  // payout key, written before anything is sent. A retry finds the row and settles that same payout
  // (on the evm rail the same signed transaction); it never starts a second one for the same key.

  payout(key: string): PayoutRow | undefined {
    const r = this.db.prepare('SELECT * FROM payouts WHERE key = ?').get(key) as Record<string, unknown> | undefined;
    return r ? rowToPayout(r) : undefined;
  }

  putPayout(p: PayoutRow): void {
    this.db.prepare(`INSERT INTO payouts (key, hold_id, to_addr, amount, state, ref, raw, hash, nonce, cancels, attempts, last_error, next_try_at, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET state = excluded.state, ref = excluded.ref, raw = excluded.raw,
      hash = excluded.hash, nonce = excluded.nonce, cancels = excluded.cancels, attempts = excluded.attempts, last_error = excluded.last_error,
      next_try_at = excluded.next_try_at, updated_at = excluded.updated_at`)
      .run(p.key, p.hold_id, p.to_addr, p.amount, p.state, p.ref, p.raw, p.hash, p.nonce, p.cancels?.length ? JSON.stringify(p.cancels) : null, p.attempts, p.last_error, p.next_try_at, p.created_at, p.updated_at);
  }

  /** Payouts marked stuck that sent a transaction, for the sweeper to check now and then. */
  stuckPayouts(): PayoutRow[] {
    return (this.db.prepare("SELECT * FROM payouts WHERE state = 'stuck' AND hash IS NOT NULL").all() as Array<Record<string, unknown>>).map(rowToPayout);
  }

  /** Payouts still owed whose next try is due. */
  duePayouts(nowIso: string): PayoutRow[] {
    return (this.db.prepare("SELECT * FROM payouts WHERE state IN ('pending', 'sent') AND next_try_at <= ? ORDER BY created_at").all(nowIso) as Array<Record<string, unknown>>).map(rowToPayout);
  }

  /**
   * The highest nonce any payout row still holds (sent, pending or stuck: anything not confirmed);
   * null when none does. A new payout never takes a nonce a row is still answerable for.
   */
  maxPendingNonce(): number | null {
    const r = this.db.prepare("SELECT MAX(nonce) AS n FROM payouts WHERE state != 'confirmed' AND nonce IS NOT NULL").get() as { n: number | null };
    return r.n == null ? null : Number(r.n);
  }

  holdsInState(state: HoldRow['state']): HoldRow[] {
    return (this.db.prepare('SELECT id FROM holds WHERE state = ?').all(state) as Array<{ id: string }>).map((r) => this.getHold(String(r.id))!);
  }

  /** Holds whose lock (the buyer's transfer into escrow) timed out, so the gateway watches for it landing late. */
  lockWatches(): HoldRow[] {
    return (this.db.prepare("SELECT id FROM holds WHERE state = 'lockwatch'").all() as Array<{ id: string }>).map((r) => this.getHold(String(r.id))!);
  }

  setEscrowPayout(holdId: string, state: 'none' | 'pending' | 'done' | 'stuck'): void {
    this.db.prepare('UPDATE escrows SET payout_state = ? WHERE hold_id = ?').run(state, holdId);
  }

  escrowsOwed(): EscrowRow[] {
    return (this.db.prepare("SELECT * FROM escrows WHERE state IN ('delivered', 'refunded') AND payout_state = 'pending'").all() as Array<Record<string, unknown>>).map((r) => this.rowToEscrow(r));
  }

  // -- escrow (3.0) --------------------------------------------------------

  createEscrow(e: Omit<EscrowRow, 'result' | 'result_type' | 'result_status' | 'receipt' | 'refund_ref' | 'reason' | 'settled_at'>): void {
    this.db.prepare(`INSERT INTO escrows (hold_id, state, deadline, realm, resource, amount, payer, owner, mandate_id, request, credential, held_ref, created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(e.hold_id, e.state, e.deadline, e.realm, e.resource, e.amount, e.payer, e.owner, e.mandate_id, JSON.stringify(e.request), e.credential, e.held_ref, e.created_at);
  }

  private rowToEscrow(r: Record<string, unknown>): EscrowRow {
    return {
      hold_id: String(r.hold_id), state: r.state as EscrowRow['state'], deadline: String(r.deadline), realm: String(r.realm),
      resource: String(r.resource), amount: Number(r.amount), payer: String(r.payer), owner: String(r.owner), mandate_id: String(r.mandate_id),
      request: JSON.parse(String(r.request)), credential: String(r.credential), held_ref: r.held_ref == null ? null : String(r.held_ref),
      result: r.result == null ? null : Buffer.from(r.result as Uint8Array), result_type: r.result_type == null ? null : String(r.result_type),
      result_status: r.result_status == null ? null : Number(r.result_status), receipt: r.receipt == null ? null : JSON.parse(String(r.receipt)),
      refund_ref: r.refund_ref == null ? null : String(r.refund_ref), reason: r.reason == null ? null : String(r.reason),
      created_at: String(r.created_at), settled_at: r.settled_at == null ? null : String(r.settled_at),
      payout_state: (r.payout_state ?? 'none') as EscrowRow['payout_state'],
    };
  }

  escrow(holdId: string): EscrowRow | undefined {
    const r = this.db.prepare('SELECT * FROM escrows WHERE hold_id = ?').get(holdId) as Record<string, unknown> | undefined;
    return r ? this.rowToEscrow(r) : undefined;
  }

  /** Move a held escrow to its end state; false when it was no longer held (a race with the sweeper or a second delivery). */
  settleEscrow(holdId: string, to: 'delivered' | 'refunded', at: string): boolean {
    return Number(this.db.prepare("UPDATE escrows SET state = ?, settled_at = ? WHERE hold_id = ? AND state = 'held'").run(to, at, holdId).changes) > 0;
  }

  setEscrowDelivery(holdId: string, f: { result: Buffer; result_type: string | null; result_status: number; receipt: Receipt | null }): void {
    this.db.prepare('UPDATE escrows SET result = ?, result_type = ?, result_status = ?, receipt = ? WHERE hold_id = ?')
      .run(f.result, f.result_type, f.result_status, f.receipt ? JSON.stringify(f.receipt) : null, holdId);
  }

  setEscrowRefund(holdId: string, f: { refund_ref: string | null; reason: string }): void {
    this.db.prepare('UPDATE escrows SET refund_ref = ?, reason = ? WHERE hold_id = ?').run(f.refund_ref, f.reason, holdId);
  }

  /** Held escrows past their deadline, for the sweeper. */
  overdueEscrows(nowIso: string): EscrowRow[] {
    return (this.db.prepare("SELECT * FROM escrows WHERE state = 'held' AND deadline <= ?").all(nowIso) as Array<Record<string, unknown>>).map((r) => this.rowToEscrow(r));
  }

  escrowsOf(filter: { payer?: string; since?: string; limit?: number }): EscrowRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.payer) { where.push('payer = ?'); args.push(filter.payer); }
    if (filter.since) { where.push('created_at >= ?'); args.push(filter.since); }
    args.push(Math.max(1, Math.min(filter.limit ?? 50, 200)));
    return (this.db.prepare(`SELECT * FROM escrows${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...args) as Array<Record<string, unknown>>)
      .map((r) => this.rowToEscrow(r));
  }

  // -- channels (3.0) ------------------------------------------------------

  createChannel(c: Omit<ChannelRow, 'authorized' | 'spent' | 'held' | 'calls' | 'closed_at' | 'settle_ref' | 'refund_ref'>): void {
    this.db.prepare(`INSERT INTO channels (id, hold_id, agent, owner, mandate, mandate_id, deposit, state, opened_at, expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(c.id, c.hold_id, c.agent, c.owner, c.mandate, c.mandate_id, c.deposit, c.state, c.opened_at, c.expires_at);
  }

  channel(id: string): ChannelRow | undefined {
    const r = this.db.prepare('SELECT * FROM channels WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!r) return undefined;
    const n = (k: string) => Number(r[k]);
    const sOrNull = (k: string) => (r[k] == null ? null : String(r[k]));
    return {
      id: String(r.id), hold_id: String(r.hold_id), agent: String(r.agent), owner: String(r.owner), mandate: String(r.mandate),
      mandate_id: String(r.mandate_id), deposit: n('deposit'), authorized: n('authorized'), spent: n('spent'), held: n('held'),
      calls: n('calls'), state: r.state as ChannelRow['state'], opened_at: String(r.opened_at), expires_at: String(r.expires_at),
      closed_at: sOrNull('closed_at'), settle_ref: sOrNull('settle_ref'), refund_ref: sOrNull('refund_ref'),
    };
  }

  /**
   * Take a voucher: raise authorized to `amount` and hold `price` for the call, only if the
   * channel is open, the voucher does not go backwards or past the deposit, and it covers
   * what is spent, in flight, and this call. False otherwise. Call inside tx().
   */
  channelReserve(id: string, amount: number, price: number): boolean {
    const res = this.db.prepare(`UPDATE channels SET authorized = ?, held = held + ?
      WHERE id = ? AND state = 'open' AND ? >= authorized AND ? <= deposit AND ? - spent - held >= ?`)
      .run(amount, price, id, amount, amount, amount, price);
    return Number(res.changes) > 0;
  }

  /** A call finished: release its hold and charge what it cost (0 when it failed). */
  channelSettleCall(id: string, held: number, charged: number): void {
    this.db.prepare('UPDATE channels SET held = MAX(0, held - ?), spent = spent + ?, calls = calls + ? WHERE id = ?')
      .run(held, charged, charged > 0 ? 1 : 0, id);
  }

  /** Mark a channel closed; false when it was not open with nothing in flight. */
  closeChannel(id: string, at: string): boolean {
    return Number(this.db.prepare("UPDATE channels SET state = 'closed', closed_at = ? WHERE id = ? AND state = 'open' AND held = 0").run(at, id).changes) > 0;
  }

  setChannelRefs(id: string, settle: string | null, refund: string | null): void {
    this.db.prepare('UPDATE channels SET settle_ref = ?, refund_ref = ? WHERE id = ?').run(settle, refund, id);
  }

  /** A voucher nonce, once per channel forever. False when it was used. */
  useVoucher(channelId: string, nonce: string): boolean {
    return Number(this.db.prepare('INSERT OR IGNORE INTO vouchers (channel, nonce) VALUES (?, ?)').run(channelId, nonce).changes) > 0;
  }

  /** Closed channels with a payout still owed, for the sweeper's retry. */
  channelsUnpaid(): ChannelRow[] {
    return (this.db.prepare("SELECT id FROM channels WHERE state = 'closed' AND (settle_ref IS NULL OR refund_ref IS NULL)").all() as Array<{ id: string }>)
      .map((r) => this.channel(String(r.id))!);
  }

  /** Open channels, for the sweeper. */
  openChannels(): ChannelRow[] {
    return (this.db.prepare("SELECT id FROM channels WHERE state = 'open'").all() as Array<{ id: string }>).map((r) => this.channel(String(r.id))!);
  }

  channelsOf(filter: { agent?: string; owner?: string; limit?: number }): ChannelRow[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (filter.agent) { where.push('agent = ?'); args.push(filter.agent); }
    if (filter.owner) { where.push('owner = ?'); args.push(filter.owner); }
    args.push(Math.max(1, Math.min(filter.limit ?? 50, 200)));
    return (this.db.prepare(`SELECT id FROM channels${where.length ? ' WHERE ' + where.join(' AND ') : ''} ORDER BY opened_at DESC LIMIT ?`).all(...args) as Array<{ id: string }>)
      .map((r) => this.channel(String(r.id))!);
  }

  close(): void {
    this.db.close();
  }
}

/** A channel row as the protocol reports it. */
export function channelState(c: ChannelRow, realm: string, currency: string): ChannelState {
  return {
    id: c.id, realm, agent: c.agent, owner: c.owner, mandate: c.mandate_id, currency,
    deposit: String(c.deposit), authorized: String(c.authorized), spent: String(c.spent), held: String(c.held), calls: c.calls,
    state: c.state, opened_at: c.opened_at, expires_at: c.expires_at, closed_at: c.closed_at, settle_ref: c.settle_ref, refund_ref: c.refund_ref,
  };
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

  /** Drop an origin the catalog should not keep (one that never answered with a discovery document). */
  remove(origin: string): void {
    this.cached = null;
    this.db.prepare('DELETE FROM gateways WHERE origin = ?').run(origin);
  }

  count(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM gateways').get() as { n: number }).n);
  }

  close(): void {
    this.db.close();
  }
}
