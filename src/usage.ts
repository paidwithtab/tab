// 3.2: who uses a gateway, with the operator's own wallets left out. An owner counts as the
// house when its starter credits were claimed from one of the operator's addresses (or the
// gateway's own loopback), or when it is listed by hand. Everything else is an outside user.

import type { Store } from './store.js';
import { microToUsd } from './protocol.js';

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/** What a seller signs to read its own earnings: bound to the gateway, the seller and a time. */
export function sellerStatsMessage(realm: string, seller: string, at: string): Uint8Array {
  return Buffer.from(`tab-seller-stats\n${realm}\n${seller}\n${at}`);
}

export interface UsageReport {
  realm: string;
  days: number;
  since: string;
  outside: {
    owners: number; // owners outside the house that paid at least once
    calls: number;
    spend: string;
    claims: number; // starter-credit claims from outside addresses
    claim_addresses: number;
    claimed_never_paid: number;
    top: Array<{ owner: string; calls: number; spend: string; first: string; last: string }>;
  };
  house: { owners: number; calls: number; spend: string };
  listings: number;
}

export function usageStats(store: Store, o: { days: number; houseIps: string[]; houseOwners: string[]; realm: string; listings: number; now?: Date }): UsageReport {
  const now = o.now ?? new Date();
  const since = new Date(now.getTime() - o.days * 86_400_000).toISOString();
  const houseIps = new Set([...o.houseIps, ...LOOPBACK]);
  const house = new Set([...o.houseOwners, ...store.ownersClaimedFrom([...houseIps])]);
  const usage = store.usageSince(since);
  const out = usage.filter((u) => !house.has(u.owner));
  const ours = usage.filter((u) => house.has(u.owner));
  const claims = store.claimsSince(since).filter((c) => !houseIps.has(c.ip));
  const payers = new Set(usage.map((u) => u.owner));
  const sum = (xs: Array<{ calls: number; amount: number }>, k: 'calls' | 'amount') => xs.reduce((a, x) => a + x[k], 0);
  return {
    realm: o.realm,
    days: o.days,
    since,
    outside: {
      owners: out.length,
      calls: sum(out, 'calls'),
      spend: microToUsd(sum(out, 'amount')),
      claims: claims.length,
      claim_addresses: new Set(claims.map((c) => c.ip)).size,
      claimed_never_paid: claims.filter((c) => !payers.has(c.wallet)).length,
      top: out.sort((a, b) => b.amount - a.amount || b.calls - a.calls).slice(0, 20)
        .map((u) => ({ owner: u.owner.slice(0, 10), calls: u.calls, spend: microToUsd(u.amount), first: u.first, last: u.last })),
    },
    house: { owners: ours.length, calls: sum(ours, 'calls'), spend: microToUsd(sum(ours, 'amount')) },
    listings: o.listings,
  };
}
