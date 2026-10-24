// `tab company ...`: run the server, or talk to one. Credentials for the
// client commands live in ~/.tab/company.json (server, token, last company).

import { parseArgs } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { CompanyStore } from './store.js';
import { Engine } from './engine.js';
import { createCompanyServer } from './server.js';
import { guardedFetch } from '../net.js';
import { Secrets } from './secrets.js';
import { signBoardAction, type BoardActionKind } from './board.js';
import type { AdapterName } from './adapters.js';
import { loadKey } from '../keys.js';

export const COMPANY_USAGE = `  tab company serve  [--db company.db] [--port 1407] [--host app.example.com]... [--gateway https://pay.paidwithtab.com]
                     [--catalog https://paidwithtab.com] [--work company.work] [--allow-private-origins] [--tick 3]
                     [--listen 127.0.0.1] [--host-model-key] (companies without a key use $ANTHROPIC_API_KEY) [--local-claude] (allow claude-code agents)
  tab company signup --email you@example.com --password ... [--server http://127.0.0.1:1407]
  tab company login  --email you@example.com --password ... [--server http://127.0.0.1:1407]
  tab company quickstart [--topic "Robinhood Markets"]                 a $1 company whose starter agent pays for two lookups now, no model key
  tab company new    --name "Acme Research" [--mission "..."] [--budget 5.00] [--gateway origin]... [--template file.json]
  tab company fund   [--company id]                                    starter credits for the owner wallet, where offered
  tab company model-key [--key sk-ant-...] [--key-file path] [--remove] [--company id]   the Anthropic key its claude agents run on
  tab company hire   --name scout --role "researcher" --adapter claude|http|starter|claude-code [--url https://...] [--agent-pub <pub>]
                     [--budget-per-run 0.50] [--heartbeat 0] [--instructions "..."] [--model m] [--company id]
  tab company ticket --title "..." [--body "..."] [--assignee scout] [--budget 0.50] [--company id]
  tab company comment --ticket id --text "..." [--company id]
  tab company approve --approval id [--reject] [--company id] [--owner key.json]
  tab company pause|resume [--company id] [--owner key.json]
  tab company budget --amount 25.00 [--company id] [--owner key.json]
  tab company status [--company id] [--json]
  tab company key    [--company id]                                    export the owner key (custodial until you do)
`;

const TAB_HOME = process.env.TAB_HOME || join(homedir(), '.tab');
const CONF = join(TAB_HOME, 'company.json');

interface Conf { server?: string; token?: string; company?: string }

function readConf(): Conf {
  try { return JSON.parse(readFileSync(CONF, 'utf8')) as Conf; } catch { return {}; }
}
function writeConf(c: Conf): void {
  mkdirSync(dirname(CONF), { recursive: true });
  writeFileSync(CONF, JSON.stringify(c, null, 2) + '\n', { mode: 0o600 });
}

function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}
function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function opts(args: string[], options: Record<string, any>) {
  try {
    return parseArgs({ args, options, allowPositionals: false });
  } catch (err) {
    die((err as Error).message);
  }
}

async function api(conf: Conf, method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
  if (!conf.server || !conf.token) die(`not logged in; run tab company login (or signup) first`);
  const r = await fetch(conf.server.replace(/\/$/, '') + path, {
    method,
    headers: { authorization: `Bearer ${conf.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const out = (await r.json()) as Record<string, unknown>;
  if (!r.ok) die(`${method} ${path}: ${String(out.error ?? `HTTP ${r.status}`)}`);
  return out;
}

function companyId(conf: Conf, given?: string): string {
  const id = given || conf.company;
  if (!id) die('--company is required (or create one with tab company new)');
  return id;
}

/** A board action signed with an exported owner key, submitted raw; or the convenience endpoint when no key is given. */
async function boardOrEndpoint(conf: Conf, company: string, ownerPath: string | undefined, action: BoardActionKind, payload: unknown, endpoint: string, body: unknown): Promise<unknown> {
  if (!ownerPath) return api(conf, 'POST', `/api/companies/${company}/${endpoint}`, body);
  const owner = loadKey(ownerPath);
  const board = await api(conf, 'GET', `/api/companies/${company}/board`);
  const signed = signBoardAction(owner, { company, seq: Number(board.next_seq), action, payload, at: new Date().toISOString() });
  return api(conf, 'POST', `/api/companies/${company}/board`, { action: signed });
}

export async function companyCommand(rest: string[]): Promise<void> {
  const sub = rest[0];
  const args = rest.slice(1);
  const conf = readConf();
  switch (sub) {
    case 'serve': {
      const { values } = opts(args, {
        db: { type: 'string', default: 'company.db' },
        port: { type: 'string', default: '1407' },
        listen: { type: 'string', default: '127.0.0.1' },
        host: { type: 'string', multiple: true },
        gateway: { type: 'string', default: 'https://pay.paidwithtab.com' },
        catalog: { type: 'string', default: 'https://paidwithtab.com' },
        work: { type: 'string' },
        tick: { type: 'string', default: '3' },
        'run-timeout': { type: 'string', default: '600' },
        'allow-private-origins': { type: 'boolean', default: false },
        'insecure-cookies': { type: 'boolean', default: false },
        'host-model-key': { type: 'boolean', default: false },
        'local-claude': { type: 'boolean', default: false },
      });
      const db = resolve(values.db as string);
      const store = new CompanyStore(db);
      const secrets = Secrets.fromFile(db + '.key');
      const hostModelKey = values['host-model-key'] ? process.env.ANTHROPIC_API_KEY ?? '' : '';
      if (values['host-model-key'] && !hostModelKey) die('--host-model-key needs ANTHROPIC_API_KEY in the environment');
      const anthropicUrl = process.env.TAB_ANTHROPIC_URL || undefined;
      const adapters: AdapterName[] = ['claude', 'http', 'starter', ...(values['local-claude'] ? ['claude-code' as const] : [])];
      // runs reach only public addresses: http agents, gateways and the URLs a model asks for
      const egress = values['allow-private-origins'] ? undefined : guardedFetch();
      const engine = new Engine({
        fetch: egress, store, workDir: (values.work as string | undefined) ?? db + '.work', log, secrets, hostModelKey: hostModelKey || null, anthropicUrl,
        tickMs: Math.max(1, Number(values.tick)) * 1000, runTimeoutMs: Math.max(10, Number(values['run-timeout'])) * 1000,
      });
      const hosts = (values.host as string[] | undefined) ?? [];
      const server = createCompanyServer({
        store, engine, hosts, log, secrets, adapters, hostModelKey: !!hostModelKey, anthropicUrl,
        defaultGateway: (values.gateway as string).replace(/\/$/, ''),
        defaultCatalog: (values.catalog as string).replace(/\/$/, '') || null,
        allowPrivateOrigins: values['allow-private-origins'] as boolean,
        secureCookies: values['insecure-cookies'] ? false : undefined,
      });
      const port = Number(values.port);
      server.listen(port, values.listen as string, () => {
        log(`company server listening on ${values.listen}:${port}, db ${db}, hosts ${hosts.length ? hosts.join(', ') : 'loopback only'}, default gateway ${values.gateway}, adapters ${adapters.join(', ')}${hostModelKey ? ', host model key set' : ''}`);
        engine.start();
      });
      return;
    }
    case 'signup':
    case 'login': {
      const { values } = opts(args, { email: { type: 'string' }, password: { type: 'string' }, server: { type: 'string', default: conf.server ?? 'http://127.0.0.1:1407' } });
      if (!values.email || !values.password) die('--email and --password are required');
      const server = (values.server as string).replace(/\/$/, '');
      const r = await fetch(`${server}/api/${sub}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: values.email, password: values.password }) });
      const out = (await r.json()) as { token?: string; error?: string; user?: { email: string } };
      if (!r.ok || !out.token) die(out.error ?? `HTTP ${r.status}`);
      writeConf({ ...conf, server, token: out.token });
      console.log(`${sub === 'signup' ? 'signed up' : 'logged in'} as ${out.user?.email} at ${server}; token saved to ${CONF}`);
      return;
    }
    case 'new': {
      const { values } = opts(args, {
        name: { type: 'string' }, mission: { type: 'string' }, budget: { type: 'string' },
        gateway: { type: 'string', multiple: true }, catalog: { type: 'string' }, template: { type: 'string' },
      });
      let body: Record<string, unknown> = {};
      if (values.template) {
        const p = values.template as string;
        if (!existsSync(p)) die(`no template at ${p}`);
        body = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
      }
      if (values.name) body.name = values.name;
      if (values.mission) body.mission = values.mission;
      if (values.budget) body.budget = values.budget;
      if (values.gateway) body.gateways = values.gateway;
      if (values.catalog) body.catalog = values.catalog;
      if (!body.name) die('--name is required (or a template with a name)');
      const out = await api(conf, 'POST', '/api/companies', body);
      const company = out.company as { id: string; name: string; owner_pub: string; realms: string[]; currency: string; budget: string };
      writeConf({ ...conf, company: company.id });
      console.log(`company ${company.id} (${company.name}): budget ${company.budget} ${company.currency}, spends at ${company.realms.join(', ')}\nowner wallet ${company.owner_pub}\nhired ${(out.agents as unknown[]).length} agents; it is now the default company for this CLI`);
      return;
    }
    case 'quickstart': {
      const { values } = opts(args, { topic: { type: 'string' } });
      const out = await api(conf, 'POST', '/api/quickstart', { topic: values.topic });
      const company = out.company as { id: string; name: string; owner_pub: string; realms: string[] };
      const ticket = out.ticket as { id: string; title: string };
      writeConf({ ...conf, company: company.id });
      for (const f of out.funding as Array<Record<string, unknown>>) console.log(`starter credits at ${f.origin}: ${f.credited ? `${f.credited} credited` : String(f.error ?? 'none')}`);
      console.log(`company ${company.id} (${company.name}) founded; ticket #${ticket.id} "${ticket.title}" is assigned to starter. Watching the run...`);
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1_500));
        const v = await api(conf, 'GET', `/api/companies/${company.id}`);
        const t = (v.tickets as Array<{ id: string; state: string; spent: string; evidence: Array<{ kind: string; value: string }> }>).find((x) => x.id === ticket.id);
        const run = (v.runs as Array<{ state: string; error: string | null; result: { summary?: string } | null }>)[0];
        if (!t || !run || run.state === 'running') continue;
        if (run.error && !run.result) die(`the run failed: ${run.error}`);
        console.log(`\n${t.state}: ${run.result?.summary ?? ''}\nspent ${t.spent}`);
        for (const r of v.receipts as Array<{ id: string; resource: string; amount: string; currency: string; verified: boolean }>) console.log(`  receipt ${r.id}  ${r.amount} ${r.currency}  ${r.resource}  ${r.verified ? 'signature verified' : 'NOT VERIFIED'}`);
        console.log(`\nNext: tab company model-key --key sk-ant-... and hire a claude agent for real work.`);
        return;
      }
      die('the run has not finished yet; check with tab company status');
    }
    case 'fund': {
      const { values } = opts(args, { company: { type: 'string' } });
      const out = await api(conf, 'POST', `/api/companies/${companyId(conf, values.company as string)}/fund`, {});
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'model-key': {
      const { values } = opts(args, { company: { type: 'string' }, key: { type: 'string' }, 'key-file': { type: 'string' }, remove: { type: 'boolean', default: false } });
      const c = companyId(conf, values.company as string);
      if (values.remove) {
        await api(conf, 'POST', `/api/companies/${c}/model-key`, { remove: true });
        console.log(`model key removed from ${c}`);
        return;
      }
      let key = (values.key as string | undefined) ?? process.env.ANTHROPIC_API_KEY ?? '';
      if (values['key-file']) key = readFileSync(values['key-file'] as string, 'utf8').trim();
      if (!key) die('give the key with --key, --key-file, or ANTHROPIC_API_KEY in the environment');
      const out = await api(conf, 'POST', `/api/companies/${c}/model-key`, { key });
      console.log(`model key set for ${c} (...${String(out.model_key_hint)}); its claude agents run on it from the next tick`);
      return;
    }
    case 'hire': {
      const { values } = opts(args, {
        company: { type: 'string' }, name: { type: 'string' }, role: { type: 'string' }, adapter: { type: 'string', default: 'claude' },
        url: { type: 'string' }, 'agent-pub': { type: 'string' }, 'budget-per-run': { type: 'string', default: '0.50' },
        heartbeat: { type: 'string', default: '0' }, instructions: { type: 'string' }, model: { type: 'string' }, 'max-per-call': { type: 'string' },
      });
      if (!values.name || !values.role) die('--name and --role are required');
      const config: Record<string, unknown> = {};
      if (values.url) config.url = values.url;
      if (values.model) config.model = values.model;
      if (values['max-per-call']) config.max_per_call = values['max-per-call'];
      const out = await api(conf, 'POST', `/api/companies/${companyId(conf, values.company as string)}/agents`, {
        name: values.name, role: values.role, adapter: values.adapter, config, agent_pub: values['agent-pub'],
        budget_per_run: values['budget-per-run'], heartbeat_s: Number(values.heartbeat), instructions: values.instructions ?? '',
      });
      const a = out.agent as { id: string; name: string; agent_pub: string };
      console.log(`hired ${a.name} (${a.id}); agent wallet ${a.agent_pub}`);
      return;
    }
    case 'ticket': {
      const { values } = opts(args, { company: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, assignee: { type: 'string' }, budget: { type: 'string' } });
      if (!values.title) die('--title is required');
      const out = await api(conf, 'POST', `/api/companies/${companyId(conf, values.company as string)}/tickets`, {
        title: values.title, body: values.body ?? '', assignee: values.assignee, budget: values.budget,
      });
      const t = out.ticket as { id: string; state: string };
      console.log(`ticket #${t.id} ${t.state}${values.assignee ? `, ${values.assignee} woken` : ''}`);
      return;
    }
    case 'comment': {
      const { values } = opts(args, { company: { type: 'string' }, ticket: { type: 'string' }, text: { type: 'string' } });
      if (!values.ticket || !values.text) die('--ticket and --text are required');
      await api(conf, 'POST', `/api/companies/${companyId(conf, values.company as string)}/tickets/${values.ticket}/comment`, { text: values.text });
      console.log('posted');
      return;
    }
    case 'approve': {
      const { values } = opts(args, { company: { type: 'string' }, approval: { type: 'string' }, reject: { type: 'boolean', default: false }, owner: { type: 'string' } });
      if (!values.approval) die('--approval is required');
      const c = companyId(conf, values.company as string);
      const action: BoardActionKind = values.reject ? 'reject' : 'approve';
      await boardOrEndpoint(conf, c, values.owner as string | undefined, action, { approval_id: values.approval }, `approvals/${values.approval}`, { decision: action });
      console.log(`${action === 'approve' ? 'approved' : 'rejected'} ${values.approval}`);
      return;
    }
    case 'pause':
    case 'resume': {
      const { values } = opts(args, { company: { type: 'string' }, owner: { type: 'string' }, reason: { type: 'string' } });
      const c = companyId(conf, values.company as string);
      await boardOrEndpoint(conf, c, values.owner as string | undefined, sub, { reason: values.reason ?? '' }, sub, { reason: values.reason ?? '' });
      console.log(`${sub}d ${c}`);
      return;
    }
    case 'budget': {
      const { values } = opts(args, { company: { type: 'string' }, amount: { type: 'string' }, owner: { type: 'string' } });
      if (!values.amount) die('--amount is required');
      const c = companyId(conf, values.company as string);
      await boardOrEndpoint(conf, c, values.owner as string | undefined, 'budget', { budget: values.amount }, 'budget', { budget: values.amount });
      console.log(`budget of ${c} set to ${values.amount}`);
      return;
    }
    case 'status': {
      const { values } = opts(args, { company: { type: 'string' }, json: { type: 'boolean', default: false } });
      if (!values.company && !conf.company) {
        const out = await api(conf, 'GET', '/api/companies');
        for (const c of out.companies as Array<{ id: string; name: string; state: string; budget: string; currency: string; spent: { total: string } }>) {
          console.log(`${c.id}  ${c.name}  ${c.state}  ${c.spent.total}/${c.budget} ${c.currency}`);
        }
        return;
      }
      const out = await api(conf, 'GET', `/api/companies/${companyId(conf, values.company as string)}`);
      if (values.json) { console.log(JSON.stringify(out, null, 2)); return; }
      const c = out.company as { name: string; state: string; budget: string; currency: string; spent: { total: string; tab: string; model: string; percent: number }; owner_pub: string; realms: string[] };
      console.log(`${c.name}: ${c.state}, spent ${c.spent.total} of ${c.budget} ${c.currency} (${c.spent.percent}%; ${c.spent.tab} through tab, ${c.spent.model} model)\nowner wallet ${c.owner_pub}; spends at ${c.realms.join(', ')}\n`);
      console.log('agents');
      for (const a of out.agents as Array<{ name: string; role: string; adapter: string; state: string; budget_per_run: string }>) console.log(`  ${a.name}  ${a.role}  ${a.adapter}  ${a.state}  ${a.budget_per_run}/run`);
      console.log('tickets');
      for (const t of out.tickets as Array<{ id: string; title: string; state: string; assignee: string; spent: string }>) console.log(`  #${t.id}  ${t.state.padEnd(11)}  ${t.assignee.padEnd(12)}  ${t.spent}  ${t.title}`);
      const pending = (out.approvals as Array<{ id: string; kind: string; state: string; agent: string; payload: { amount?: string; reason?: string } }>).filter((a) => a.state === 'pending');
      if (pending.length) {
        console.log('awaiting approval');
        for (const a of pending) console.log(`  ${a.id}  ${a.kind} ${a.payload.amount ?? ''} from ${a.agent}: ${a.payload.reason ?? ''}`);
      }
      return;
    }
    case 'key': {
      const { values } = opts(args, { company: { type: 'string' } });
      const out = await api(conf, 'GET', `/api/companies/${companyId(conf, values.company as string)}/key`);
      console.log(JSON.stringify({ publicKey: out.publicKey, privateKey: out.privateKey }, null, 2));
      return;
    }
    default:
      process.stderr.write(COMPANY_USAGE);
      process.exit(sub ? 1 : 0);
  }
}
