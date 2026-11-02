// Payment channels (3.0): one deposit, then a signed cumulative voucher per call,
// settled once at close. The deposit is an ordinary paid call to the gateway's
// channel endpoint, so it runs through every mandate check; a voucher only moves
// a counter. Metered routes charge what the upstream reports it used, up to the
// route's price, so a call may cost a fraction of a cent.

import { canonicalJson, randomId, VERSION } from './protocol.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';

/** The route a paid call opens a channel through. */
export const CHANNEL_PATH = '/.well-known/tab/channels';

export interface Voucher {
  ver: string;
  channel: string;
  amount: string; // cumulative micro units this channel may charge, never lower than the last voucher
  resource: string; // "METHOD /path" of the call it pays for
  query: string;
  body_sha256: string;
  nonce: string; // makes every voucher single use, even two for the same call and amount
  sig: string; // the channel agent's signature over the canonical body minus sig
}

/** What a gateway reports about a channel, in Tab-Channel headers and its status endpoint. */
export interface ChannelState {
  id: string;
  realm: string;
  agent: string;
  owner: string;
  mandate: string;
  currency: string;
  deposit: string; // micro
  authorized: string; // highest voucher accepted, micro
  spent: string; // charged so far, micro
  held: string; // reserved by calls in flight, micro
  calls: number;
  state: 'open' | 'closed';
  opened_at: string;
  expires_at: string;
  closed_at?: string | null;
  settle_ref?: string | null; // how the spent part reached the seller
  refund_ref?: string | null; // how the rest went back
}

export function signVoucher(agent: KeyPair, f: Omit<Voucher, 'ver' | 'sig' | 'nonce'> & { nonce?: string }): Voucher {
  const body = { ver: VERSION, ...f, nonce: f.nonce ?? randomId(12) };
  return { ...body, sig: signBytes(agent, Buffer.from(canonicalJson(body))) };
}

export function verifyVoucher(v: Voucher, agent: string): boolean {
  if (!v || typeof v !== 'object' || v.ver !== VERSION || typeof v.sig !== 'string') return false;
  if (!/^\d+$/.test(String(v.amount)) || typeof v.channel !== 'string' || typeof v.nonce !== 'string' || v.nonce.length > 64) return false;
  if (typeof v.resource !== 'string' || typeof v.query !== 'string' || typeof v.body_sha256 !== 'string') return false;
  const { sig, ...body } = v;
  return verifyBytes(agent, Buffer.from(canonicalJson(body)), sig);
}

/** What the agent signs to close its own channel early. */
export function closeMessage(channelId: string): Uint8Array {
  return Buffer.from(canonicalJson({ action: 'close', channel: channelId, ver: VERSION }));
}

export function signClose(agent: KeyPair, channelId: string): string {
  return signBytes(agent, closeMessage(channelId));
}

// Authorization: TabVoucher <base64url of the voucher JSON>
export function encodeVoucherHeader(v: Voucher): string {
  return `TabVoucher ${Buffer.from(JSON.stringify(v)).toString('base64url')}`;
}

export function parseVoucherHeader(header: string | null | undefined): Voucher | null {
  if (!header) return null;
  const m = /^\s*TabVoucher\s+([A-Za-z0-9_-]+)\s*$/.exec(header);
  if (!m) return null;
  try {
    const v = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    if (v && typeof v === 'object' && typeof v.sig === 'string' && typeof v.channel === 'string') return v as Voucher;
  } catch { /* fall through */ }
  return null;
}

/** The voucher amount for the next call: at least the last one, enough to cover what is spent, in flight, and this price. */
export function nextVoucherAmount(s: Pick<ChannelState, 'authorized' | 'spent' | 'held'>, priceMicro: number): number {
  return Math.max(Number(s.authorized), Number(s.spent) + Number(s.held) + priceMicro);
}
