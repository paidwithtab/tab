// 3.3: `tab doctor`. One line per thing a first paid call depends on, each ok or failing with the
// command that fixes it: the keys, the mandate (and what is left of it), the gateway and the
// owner's balance there, the clock, the catalog, which agent tools have tab in their MCP config,
// and whether a newer release is out.

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadKey, type KeyPair } from './keys.js';
import { loadMandate, verifyMandate, mandateExpired, realmAllowed, type Mandate } from './mandate.js';
import { usdToMicro, microToUsd } from './protocol.js';
import { configPath, CLIENTS } from './setup.js';
import { PACKAGE_VERSION } from './version.js';

export type DoctorState = 'ok' | 'warn' | 'fail' | 'info';
export interface DoctorCheck { name: string; state: DoctorState; detail: string; fix?: string }

export interface DoctorOptions {
  dir: string; // ~/.tab
  agentFile?: string;
  mandateFile?: string;
  gateway: string;
  catalog: string;
  home?: string; // where agent tools keep their configs; default the user's home
  fetch?: typeof fetch;
  latestRelease?: () => Promise<string | null>; // default: asks GitHub
  now?: Date;
}

const RELEASES = 'https://github.com/paidwithtab/tab/releases/latest';

/** The newest release's version, from where GitHub's "latest" link points. */
export async function latestReleaseVersion(f: typeof fetch = fetch): Promise<string | null> {
  try {
    const r = await f(RELEASES, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(8_000) });
    const loc = r.headers.get('location') ?? '';
    const m = /\/tag\/v?([\d.]+)$/.exec(loc);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/** Which agent tools have a `tab` MCP server configured. */
export function configuredTools(home = homedir()): Array<{ tool: string; path: string; configured: boolean }> {
  const out: Array<{ tool: string; path: string; configured: boolean }> = [];
  const claude = join(home, '.claude.json');
  let inClaude = false;
  if (existsSync(claude)) {
    try {
      const doc = JSON.parse(readFileSync(claude, 'utf8')) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> };
      inClaude = !!doc.mcpServers?.tab || Object.values(doc.projects ?? {}).some((p) => !!p?.mcpServers?.tab);
    } catch { /* unreadable: say not configured */ }
  }
  out.push({ tool: 'claude', path: claude, configured: inClaude });
  for (const c of CLIENTS) {
    if (c === 'claude') continue;
    const path = configPath(c, home);
    let configured = false;
    if (existsSync(path)) {
      const text = readFileSync(path, 'utf8');
      configured = c === 'codex' ? /^\[mcp_servers\.tab\]/m.test(text) : (() => { try { const d = JSON.parse(text); return !!(d.mcpServers?.tab ?? d.servers?.tab); } catch { return false; } })();
    }
    out.push({ tool: c, path, configured });
  }
  return out;
}

export async function runDoctor(o: DoctorOptions): Promise<DoctorCheck[]> {
  const f = o.fetch ?? fetch;
  const now = o.now ?? new Date();
  const checks: DoctorCheck[] = [];
  const add = (name: string, state: DoctorState, detail: string, fix?: string) => checks.push({ name, state, detail, ...(fix ? { fix } : {}) });

  // 1. keys and the mandate
  const agentFile = o.agentFile ?? join(o.dir, 'agent.json');
  const mandateFile = o.mandateFile ?? join(o.dir, 'mandate.json');
  let agent: KeyPair | null = null;
  let mandate: Mandate | null = null;
  try { agent = loadKey(agentFile); add('agent key', 'ok', `${agentFile} (${agent.publicKey.slice(0, 10)})`); }
  catch { add('agent key', 'fail', `no readable key at ${agentFile}`, 'tab init makes one (or set TAB_AGENT to its file)'); }
  try { mandate = loadMandate(mandateFile); } catch { add('mandate', 'fail', `no readable mandate at ${mandateFile}`, 'tab init issues one (or set TAB_MANDATE to its file)'); }
  if (mandate) {
    const v = verifyMandate(mandate);
    if (!v.ok) add('mandate', 'fail', `does not verify: ${v.error}`, 'tab init issues a fresh one');
    else if (agent && mandate.agent !== agent.publicKey) add('mandate', 'fail', 'is for a different agent key', 'use the mandate issued for this agent, or tab init to issue a matching one');
    else if (mandateExpired(mandate, now)) add('mandate', 'fail', `expired ${mandate.expires_at.slice(0, 10)}`, 'tab init issues a fresh one from the same keys');
    else {
      const days = Math.floor((Date.parse(mandate.expires_at) - now.getTime()) / 86_400_000);
      const cap = mandate.max_per_call ? `, ${microToUsd(Number(mandate.max_per_call))} per call` : '';
      add('mandate', days < 7 ? 'warn' : 'ok', `${microToUsd(Number(mandate.budget))} ${mandate.window === 'day' ? 'a day' : 'in total'}${cap}, expires in ${days} days, allows ${mandate.allow.join(' ')}`, days < 7 ? 'tab init issues a fresh one before it expires' : undefined);
    }
  }
  const owner = (() => { try { return loadKey(join(o.dir, 'owner.json')); } catch { return null; } })();

  // 2. the gateway, the clock, the balance and the budget there
  let realm = '';
  try {
    const r = await f(`${o.gateway}/.well-known/tab`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const doc = (await r.json()) as { realm?: string; rail?: string; currency?: string; services?: Array<{ routes?: unknown[] }>; faucet?: string };
    realm = String(doc.realm ?? '');
    const routes = (doc.services ?? []).reduce((n, s) => n + (s.routes?.length ?? 0), 0);
    add('gateway', 'ok', `${o.gateway}: ${realm}, ${doc.rail ?? '?'} rail, ${routes} routes`);
    const date = Date.parse(r.headers.get('date') ?? '');
    if (Number.isFinite(date)) {
      const skew = Math.round((now.getTime() - date) / 1000);
      if (Math.abs(skew) > 60) add('clock', 'fail', `this machine is ${Math.abs(skew)} s ${skew > 0 ? 'ahead of' : 'behind'} the gateway`, 'set the clock (timedatectl set-ntp true, or your OS time settings); price quotes last about 2 minutes');
      else add('clock', 'ok', `within ${Math.abs(skew)} s of the gateway`);
    }
    if (mandate && realm && !realmAllowed(mandate, realm)) add('allowed here', 'fail', `the mandate does not allow ${realm}`, `the owner issues one with --allow ${realm} (or --allow "*")`);
    if (mandate) {
      try {
        const s = (await (await f(`${o.gateway}/.well-known/tab/mandate/${encodeURIComponent(mandate.id)}/spent`, { signal: AbortSignal.timeout(10_000) })).json()) as { spent?: string };
        if (s.spent != null) {
          const left = Number(mandate.budget) - usdToMicro(s.spent);
          add('budget left', left <= 0 ? 'fail' : 'ok', `${microToUsd(Math.max(0, left))} of ${microToUsd(Number(mandate.budget))} left here${mandate.window === 'day' ? ' today' : ''}`, left <= 0 ? (mandate.window === 'day' ? 'it resets at midnight UTC, or the owner issues a larger budget' : 'the owner issues a new mandate with a budget') : undefined);
        }
      } catch { /* older gateways do not report spend */ }
    }
    if (owner && doc.rail === 'ledger') {
      try {
        const w = (await (await f(`${o.gateway}/.well-known/tab/wallet/${owner.publicKey}`, { signal: AbortSignal.timeout(10_000) })).json()) as { available?: string; currency?: string };
        const avail = w.available != null ? usdToMicro(w.available) : null;
        if (avail !== null) add('balance', avail > 0 ? 'ok' : 'fail', `owner wallet holds ${w.available} ${w.currency ?? 'USD'} here`, avail > 0 ? undefined : doc.faucet ? 'claim starter credits with tab init, or add some with tab topup 5' : 'tab topup 5 adds credits with a card');
      } catch { /* no balance lookup */ }
    } else if (!owner) add('balance', 'info', 'no owner key here; the owner funds the agent from another machine');
  } catch (err) {
    add('gateway', 'fail', `cannot reach ${o.gateway} (${(err as Error).message})`, 'check the network, or point TAB_GATEWAY at a gateway that is up');
  }

  // 3. the catalog
  try {
    const r = await f(`${o.catalog}/v1/health`, { signal: AbortSignal.timeout(10_000) });
    const doc = (await r.json().catch(() => ({}))) as { routes?: number; x402_routes?: number };
    const n = (doc.routes ?? 0) + (doc.x402_routes ?? 0);
    add('catalog', r.ok ? 'ok' : 'warn', r.ok ? `${o.catalog}: search is up${n ? `, ${n} routes` : ''}` : `${o.catalog} answered ${r.status}`, r.ok ? undefined : 'search may find less until it recovers; tab_fetch still works with a URL');
  } catch (err) {
    add('catalog', 'warn', `cannot reach ${o.catalog} (${(err as Error).message})`, 'tab_search needs it; tab_fetch still works with a URL');
  }

  // 4. agent tools with tab in their MCP config
  const tools = configuredTools(o.home);
  const on = tools.filter((t) => t.configured).map((t) => t.tool);
  add('agent tools', on.length ? 'ok' : 'warn', on.length ? `tab is configured in ${on.join(', ')}` : 'no agent tool has tab configured yet', on.length ? undefined : 'tab setup claude (or cursor, windsurf, vscode, codex)');

  // 5. the version
  const latest = await (o.latestRelease ?? (() => latestReleaseVersion(f)))();
  if (latest && newer(latest, PACKAGE_VERSION)) add('version', 'warn', `tab ${PACKAGE_VERSION}; ${latest} is out`, 'npm i -g https://github.com/paidwithtab/tab/releases/latest/download/paidwithtab.tgz (npx -y with that URL always runs the newest)');
  else add('version', 'ok', `tab ${PACKAGE_VERSION}${latest ? ' (the latest)' : ''}`);

  return checks;
}

export function printDoctor(checks: DoctorCheck[], log: (m: string) => void = console.log): boolean {
  const mark: Record<DoctorState, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', info: '--  ' };
  for (const c of checks) {
    log(`${mark[c.state]} ${c.name.padEnd(13)} ${c.detail}`);
    if (c.fix && c.state !== 'ok') log(`     ${''.padEnd(13)} fix: ${c.fix}`);
  }
  const bad = checks.filter((c) => c.state === 'fail').length;
  log(bad ? `${bad} thing${bad === 1 ? '' : 's'} to fix before a paid call works` : 'ready: a paid call should work');
  return bad === 0;
}
