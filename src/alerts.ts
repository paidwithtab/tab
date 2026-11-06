// 3.1: spend alerts. An owner signs a subscription at a gateway: a webhook URL, the budget
// percentages to be told about, and whether to get a daily statement. The gateway posts when
// one of the owner's mandates crosses a threshold in its window, once per threshold and window,
// and once a day a summary of what the owner's agents paid there. ntfy.sh topics work as is,
// which puts the alert on a phone with no account anywhere.

import { canonicalJson } from './protocol.js';
import { signBytes, verifyBytes, type KeyPair } from './keys.js';
import { upstreamProblem } from './listings.js';

export const ALERTS_PATH = '/.well-known/tab/alerts';

export interface AlertSub {
  ver: string;
  kind: 'alerts';
  realm: string;
  owner: string; // the owner's wallet id; signs the subscription
  url?: string; // https webhook
  format?: 'json' | 'text'; // text: a plain message with a Title header (ntfy); json: {event, text, ...}
  thresholds?: number[]; // budget percentages, 1 to 100; default 50, 90, 100
  daily?: boolean; // a statement every 24 hours when anything was paid
  off?: boolean; // a signed request to stop
  at: string;
  sig: string;
}

export const ALERT_LIMITS = { total: 10_000, maxThresholds: 5, skewMs: 10 * 60_000, maxFailures: 20 };

export function alertMessage(a: Omit<AlertSub, 'sig'> | AlertSub): Uint8Array {
  return Buffer.from(canonicalJson({ ...a, sig: undefined }));
}

export function signAlertSub(owner: KeyPair, a: Omit<AlertSub, 'sig' | 'owner' | 'ver' | 'kind' | 'at'> & { at?: string }): AlertSub {
  const body = { ...a, ver: 'tab/0', kind: 'alerts' as const, owner: owner.publicKey, at: a.at ?? new Date().toISOString() };
  return { ...body, sig: signBytes(owner, alertMessage(body)) };
}

export function alertSubProblem(a: AlertSub, o: { realm: string; now?: Date; allowPrivate?: boolean }): string | null {
  if (!a || typeof a !== 'object' || a.ver !== 'tab/0' || a.kind !== 'alerts') return 'not a tab/0 alert subscription';
  if (typeof a.owner !== 'string' || typeof a.sig !== 'string' || !verifyBytes(a.owner, alertMessage(a), a.sig)) return 'subscription signature does not verify';
  if (a.realm !== o.realm) return `subscription is for ${a.realm}, not ${o.realm}`;
  const at = Date.parse(a.at);
  if (!Number.isFinite(at) || Math.abs((o.now ?? new Date()).getTime() - at) > ALERT_LIMITS.skewMs) return 'subscription time is more than 10 minutes off; sign it again';
  if (a.off === true) return null;
  const up = o.allowPrivate ? (/^https?:\/\/[^/]+/.test(String(a.url ?? '')) ? null : 'webhook is not a URL') : upstreamProblem(String(a.url ?? ''), o.realm);
  if (up) return up.replace('upstream', 'webhook');
  if (a.format !== undefined && a.format !== 'json' && a.format !== 'text') return 'format must be json or text';
  if (a.thresholds !== undefined) {
    if (!Array.isArray(a.thresholds) || a.thresholds.length === 0 || a.thresholds.length > ALERT_LIMITS.maxThresholds) return `thresholds: 1 to ${ALERT_LIMITS.maxThresholds} percentages`;
    if (!a.thresholds.every((t) => Number.isInteger(t) && t >= 1 && t <= 100)) return 'thresholds are whole percentages from 1 to 100';
  }
  if (a.daily !== undefined && typeof a.daily !== 'boolean') return 'daily must be true or false';
  return null;
}

export function thresholdsOf(a: AlertSub): number[] {
  return [...new Set(a.thresholds ?? [50, 90, 100])].sort((x, y) => x - y);
}

/** Post one alert. Resolves true when the webhook took it (2xx). Never throws. */
export async function deliverAlert(send: typeof fetch, a: AlertSub, title: string, text: string, data: Record<string, unknown>): Promise<boolean> {
  try {
    const textMode = a.format === 'text';
    const r = await send(a.url!, {
      method: 'POST',
      headers: textMode ? { 'content-type': 'text/plain; charset=utf-8', title, tags: 'money_with_wings' } : { 'content-type': 'application/json' },
      body: textMode ? text : JSON.stringify({ title, text, ...data }),
      signal: AbortSignal.timeout(10_000),
    });
    await r.arrayBuffer().catch(() => undefined);
    return r.status >= 200 && r.status < 300;
  } catch {
    return false;
  }
}
