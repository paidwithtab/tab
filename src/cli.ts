// The `tab` command. One binary, three roles: owner (issues mandates), agent
// (pays), gateway/catalog (sells). See DEPLOY.md section 7 for the reference.

import { parseArgs } from 'node:util';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { newKeyPair, saveKey, loadKey, resolvePublicKey, type KeyPair } from './keys.js';
import { issueMandate, loadMandate, saveMandate, verifyMandate } from './mandate.js';
import { usdToMicro, microToUsd } from './protocol.js';
import { Store, CatalogStore } from './store.js';
import { loadSpec, createGateway, announce } from './gateway.js';
import { createCatalog } from './catalog.js';
import { TabClient, PaymentRefused, receiptOf } from './client.js';
import { runMcpServer } from './mcp.js';
import { scalarFromSeed, addressFromSeed, checksumAddress } from './evm/secp256k1.js';
import { EvmRpc } from './evm/rpc.js';
import { signTx, erc20 } from './evm/tx.js';

// Node's fetch tries each address of a host for 250 ms before moving to the next (happy eyeballs). From far
// away, a round trip alone can take that long, so upstreams on another continent fail to connect at all.
// 2 s per attempt is still fast to fail and connects everywhere.
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

const USAGE = `tab: a payment gateway for software agents (HTTP 402 + signed mandates)

  tab init  [--dir ~/.tab] [--budget 1.00] [--max-per-call 0.05] [--days 90]
            [--gateway https://pay.paidwithtab.com] [--catalog https://paidwithtab.com]
            give an agent a tab: keys, a mandate, starter credits, the Claude Code line
  tab key new [--out file]
  tab mandate issue --owner key.json --agent <pub|file> --budget 1.00
                    [--window total|day] [--max-per-call 0.05] [--allow realm]... [--days 7] [--out file]
  tab mint    --wallet <pub|file> --amount 5.00 [--db tab.db]
  tab balance --wallet <pub|file> [--db tab.db]
  tab serve   --spec spec.json [--db tab.db] [--port 1402] [--announce http://catalog:1403] [--origin url]
              [--faucet 1.00]   ledger rail: starter credits any wallet can claim once
  tab catalog serve [--db catalog.db] [--port 1403] [--try-agent key.json --try-mandate mandate.json]
                    [--try-max-per-call 0.05] [--allow-private-origins] [--seed origin]...
  tab evm address <key.json>                                          key file -> 0x address
  tab evm approve --owner key.json --agent <key.json|0x> --amount 1.00 --token <0x> [--rpc url]
  tab evm revoke  --owner key.json --token <0x> [--rpc url]
  tab evm balance --wallet <key.json|0x> --token <0x> [--agent <key.json|0x>] [--rpc url]
  tab evm fund    --from key.json --to <key.json|0x> --eth 0.005 [--rpc url]  gas for the agent
  tab fetch [--agent key.json --mandate mandate.json] [--max-per-call 0.05] [-X POST] [-d body] <url>
  tab mcp   (env: TAB_AGENT, TAB_MANDATE, [TAB_MAX_PER_CALL], [TAB_CATALOG])

  fetch and mcp default to the agent and mandate that tab init wrote in ~/.tab.
`;

export const PUBLIC_GATEWAY = 'https://pay.paidwithtab.com';
export const PUBLIC_CATALOG = 'https://paidwithtab.com';
const TAB_HOME = process.env.TAB_HOME || join(homedir(), '.tab');

function log(msg: string): void {
  console.error(`[${new Date().toISOString()}] ${msg}`);
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

function opts(args: string[], options: Record<string, any>, positionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals: positionals });
  } catch (err) {
    die((err as Error).message);
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'init': {
      const { values } = opts(rest, {
        dir: { type: 'string', default: TAB_HOME },
        budget: { type: 'string', default: '1.00' },
        'max-per-call': { type: 'string', default: '0.05' },
        days: { type: 'string', default: '90' },
        gateway: { type: 'string', default: PUBLIC_GATEWAY },
        catalog: { type: 'string', default: PUBLIC_CATALOG },
      });
      await initTab({
        dir: resolve(values.dir as string),
        budgetUsd: values.budget as string,
        maxPerCallUsd: values['max-per-call'] as string,
        days: Number(values.days),
        gateway: (values.gateway as string).replace(/\/$/, ''),
        catalog: (values.catalog as string).replace(/\/$/, ''),
      });
      return;
    }

    case 'key': {
      if (rest[0] !== 'new') die('usage: tab key new [--out file]');
      const { values } = opts(rest.slice(1), { out: { type: 'string' } });
      const pair = newKeyPair();
      if (values.out) {
        saveKey(values.out as string, pair);
        log(`wrote ${values.out} (wallet id ${pair.publicKey})`);
      } else {
        console.log(JSON.stringify(pair, null, 2));
      }
      return;
    }

    case 'mandate': {
      if (rest[0] !== 'issue') die('usage: tab mandate issue ...');
      const { values } = opts(rest.slice(1), {
        owner: { type: 'string' },
        agent: { type: 'string' },
        budget: { type: 'string' },
        window: { type: 'string' },
        'max-per-call': { type: 'string' },
        allow: { type: 'string', multiple: true },
        days: { type: 'string' },
        out: { type: 'string' },
      });
      if (!values.owner || !values.agent || !values.budget) {
        die('--owner, --agent and --budget are required');
      }
      const owner = loadKey(values.owner as string);
      const window = (values.window as string) ?? 'total';
      if (window !== 'total' && window !== 'day') die('--window must be total or day');
      const mandate = issueMandate(owner, {
        agent: resolvePublicKey(values.agent as string),
        budgetUsd: values.budget as string,
        window,
        maxPerCallUsd: values['max-per-call'] as string | undefined,
        allow: values.allow as string[] | undefined,
        days: values.days ? Number(values.days) : undefined,
        // attest the owner's EVM account so the mandate works on the evm rail
        evmOwner: addressFromSeed(new Uint8Array(Buffer.from(owner.privateKey, 'base64url'))),
      });
      if (values.out) {
        saveMandate(values.out as string, mandate);
        log(`wrote ${values.out} (mandate ${mandate.id})`);
      } else {
        console.log(JSON.stringify(mandate, null, 2));
      }
      return;
    }

    case 'mint': {
      const { values } = opts(rest, {
        wallet: { type: 'string' },
        amount: { type: 'string' },
        db: { type: 'string', default: 'tab.db' },
      });
      if (!values.wallet || !values.amount) die('--wallet and --amount are required');
      const wallet = resolvePublicKey(values.wallet as string);
      const store = new Store(values.db as string);
      store.credit(wallet, usdToMicro(values.amount as string));
      console.log(`minted ${values.amount} to ${wallet}; balance ${microToUsd(store.balance(wallet))}`);
      store.close();
      return;
    }

    case 'balance': {
      const { values } = opts(rest, {
        wallet: { type: 'string' },
        db: { type: 'string', default: 'tab.db' },
      });
      if (!values.wallet) die('--wallet is required');
      const wallet = resolvePublicKey(values.wallet as string);
      const store = new Store(values.db as string);
      console.log(microToUsd(store.balance(wallet)));
      store.close();
      return;
    }

    case 'serve': {
      const { values } = opts(rest, {
        spec: { type: 'string' },
        db: { type: 'string', default: 'tab.db' },
        port: { type: 'string', default: '1402' },
        announce: { type: 'string' },
        origin: { type: 'string' },
        faucet: { type: 'string' },
      });
      if (!values.spec) die('--spec is required');
      const spec = loadSpec(values.spec as string);
      for (const name of spec.skipped ?? []) log(`skipping service ${name}: set it in the environment and restart`);
      const store = new Store(values.db as string);
      const server = createGateway(spec, { store, log, faucetUsd: values.faucet as string | undefined });
      const port = Number(values.port);
      server.listen(port, () => {
        log(`gateway for realm ${spec.realm} (${spec.rail ?? 'ledger'} rail) listening on :${port}, db ${values.db}${values.faucet ? `, faucet ${values.faucet}` : ''}`);
        if (values.announce) {
          const origin = (values.origin as string) ?? `http://127.0.0.1:${port}`;
          void announce(values.announce as string, origin, log);
        }
      });
      return;
    }

    case 'catalog': {
      if (rest[0] !== 'serve') die('usage: tab catalog serve ...');
      const { values } = opts(rest.slice(1), {
        db: { type: 'string', default: 'catalog.db' },
        port: { type: 'string', default: '1403' },
        'try-agent': { type: 'string' },
        'try-mandate': { type: 'string' },
        'try-max-per-call': { type: 'string' },
        'allow-private-origins': { type: 'boolean', default: false },
        seed: { type: 'string', multiple: true },
      });
      const store = new CatalogStore(values.db as string);
      let tryAgent: KeyPair | undefined;
      let tryMandate;
      if (values['try-agent'] && values['try-mandate']) {
        tryAgent = loadKey(values['try-agent'] as string);
        tryMandate = loadMandate(values['try-mandate'] as string);
        const v = verifyMandate(tryMandate);
        if (!v.ok) die(`try mandate: ${v.error}`);
        if (tryMandate.agent !== tryAgent.publicKey) die('mandate is not for this agent key');
      }
      const server = createCatalog({
        store,
        tryAgent,
        tryMandate,
        tryMaxPerCallUsd: values['try-max-per-call'] as string | undefined,
        allowPrivateOrigins: values['allow-private-origins'] as boolean,
        log,
      });
      const port = Number(values.port);
      server.listen(port, () => {
        log(`catalog listening on :${port}, db ${values.db}${tryAgent ? ', try-it enabled' : ''}`);
        for (const origin of (values.seed as string[] | undefined) ?? []) {
          void (server as any).announce(origin.replace(/\/$/, ''));
        }
      });
      return;
    }

    case 'evm':
      await evmCommand(rest);
      return;

    case 'fetch': {
      const { values, positionals } = opts(
        rest,
        {
          agent: { type: 'string' },
          mandate: { type: 'string' },
          'max-per-call': { type: 'string' },
          method: { type: 'string', short: 'X' },
          data: { type: 'string', short: 'd' },
        },
        true,
      );
      if (positionals.length !== 1) {
        die('usage: tab fetch [--agent key.json --mandate mandate.json] [-X POST] [-d body] <url>');
      }
      const files = defaultAgentFiles(values.agent as string | undefined, values.mandate as string | undefined);
      const client = new TabClient({
        agent: loadKey(files.agent),
        mandate: loadMandate(files.mandate),
        maxPerCallUsd: values['max-per-call'] as string | undefined,
      });
      const method = ((values.method as string) ?? (values.data != null ? 'POST' : 'GET')).toUpperCase();
      try {
        const res = await client.fetch(positionals[0], {
          method,
          headers: values.data != null ? { 'content-type': 'application/json' } : undefined,
          body: values.data as string | undefined,
        });
        const body = await res.text();
        const receipt = receiptOf(res);
        if (receipt) log(`paid ${microToUsd(Number(receipt.amount))} (${receipt.ref})`);
        process.stdout.write(body.endsWith('\n') || body === '' ? body : body + '\n');
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        if (err instanceof PaymentRefused) {
          console.error(`refused: ${err.reason}`);
          process.exit(2);
        }
        throw err;
      }
    }

    case 'mcp': {
      const files = defaultAgentFiles(process.env.TAB_AGENT, process.env.TAB_MANDATE);
      const agent = loadKey(files.agent);
      const mandate = loadMandate(files.mandate);
      const v = verifyMandate(mandate);
      if (!v.ok) die(`mandate: ${v.error}`);
      if (mandate.agent !== agent.publicKey) die('mandate is not for this agent key');
      runMcpServer({
        agent,
        mandate,
        maxPerCallUsd: process.env.TAB_MAX_PER_CALL,
        catalog: process.env.TAB_CATALOG || PUBLIC_CATALOG,
      });
      return;
    }

    default:
      process.stderr.write(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// init: everything a new buyer needs, in one command

/** The agent and mandate files to use: explicit paths, else what `tab init` wrote. */
function defaultAgentFiles(agent?: string, mandate?: string): { agent: string; mandate: string } {
  const a = agent || join(TAB_HOME, 'agent.json');
  const m = mandate || join(TAB_HOME, 'mandate.json');
  if (!existsSync(a) || !existsSync(m)) {
    die(`no agent or mandate at ${a} and ${m}; run \`tab init\` first, or pass --agent and --mandate`);
  }
  return { agent: a, mandate: m };
}

interface InitOptions {
  dir: string;
  budgetUsd: string;
  maxPerCallUsd: string;
  days: number;
  gateway: string;
  catalog: string;
}

async function initTab(o: InitOptions): Promise<void> {
  const ownerPath = join(o.dir, 'owner.json');
  const agentPath = join(o.dir, 'agent.json');
  const mandatePath = join(o.dir, 'mandate.json');

  // keys: reuse what is there, so running init twice is safe
  let owner: KeyPair;
  let agent: KeyPair;
  if (existsSync(ownerPath)) {
    owner = loadKey(ownerPath);
    console.log(`owner key   ${ownerPath} (existing)`);
  } else {
    owner = newKeyPair();
    saveKey(ownerPath, owner);
    console.log(`owner key   ${ownerPath} (new)`);
  }
  if (existsSync(agentPath)) {
    agent = loadKey(agentPath);
    console.log(`agent key   ${agentPath} (existing)`);
  } else {
    agent = newKeyPair();
    saveKey(agentPath, agent);
    console.log(`agent key   ${agentPath} (new)`);
  }

  // the mandate: what the agent may spend, signed by the owner
  const mandate = issueMandate(owner, {
    agent: agent.publicKey,
    budgetUsd: o.budgetUsd,
    window: 'day',
    maxPerCallUsd: o.maxPerCallUsd,
    allow: ['*'],
    days: o.days,
    evmOwner: addressFromSeed(new Uint8Array(Buffer.from(owner.privateKey, 'base64url'))),
  });
  saveMandate(mandatePath, mandate);
  console.log(`mandate     ${mandatePath}: ${o.budgetUsd}/day, ${o.maxPerCallUsd} per call, ${o.days} days`);

  // starter credits from the public gateway, if it offers them
  let available: string | null = null;
  try {
    const disc = await fetch(o.gateway + '/.well-known/tab', { signal: AbortSignal.timeout(10_000) });
    if (!disc.ok) throw new Error(`HTTP ${disc.status}`);
    const doc = (await disc.json()) as { realm?: string; faucet?: string };
    if (doc.faucet) {
      const r = await fetch(o.gateway + '/.well-known/tab/faucet', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ wallet: owner.publicKey }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await r.json()) as { credited?: string; available?: string; error?: string };
      if (!r.ok) throw new Error(body.error ?? `HTTP ${r.status}`);
      available = body.available ?? null;
      console.log(
        body.credited && body.credited !== '0.00'
          ? `credits     ${body.credited} starter credits from ${doc.realm ?? o.gateway}; balance ${available}`
          : `credits     already claimed on ${doc.realm ?? o.gateway}; balance ${available}`,
      );
    } else {
      console.log(`credits     ${o.gateway} offers no starter credits; fund the owner wallet yourself`);
    }
  } catch (err) {
    console.log(`credits     could not reach ${o.gateway} (${(err as Error).message}); run tab init again later`);
  }

  console.log(`
owner wallet  ${owner.publicKey}
agent wallet  ${agent.publicKey}

Claude Code (once, for every project):

  claude mcp add --scope user tab -- npx -y paidwithtab mcp

Then ask Claude to find and buy something, for example "look up the weather in Lisbon through tab".
It gets tab_search, tab_fetch, tab_limits, tab_discover and tab_balance, and can never exceed the mandate.

From a shell:

  tab fetch "${o.gateway}/wikipedia/api/rest_v1/page/summary/HTTP_402"

Catalog: ${o.catalog}/catalog
`);
}

// ---------------------------------------------------------------------------
// evm subcommands (built for Robinhood Chain; any EVM chain works)

const EVM_RPC_DEFAULT = process.env.EVM_RPC || 'https://rpc.testnet.chain.robinhood.com';

function evmScalar(pair: KeyPair) {
  return scalarFromSeed(new Uint8Array(Buffer.from(pair.privateKey, 'base64url')));
}

function evmAddressOf(arg: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(arg)) return arg.toLowerCase();
  if (arg.endsWith('.json')) {
    return addressFromSeed(new Uint8Array(Buffer.from(loadKey(arg).privateKey, 'base64url')));
  }
  die(`expected a key file or 0x address, got ${arg}`);
}

async function evmSend(rpc: EvmRpc, from: KeyPair, to: string, value: bigint, data: Uint8Array): Promise<string> {
  const fromAddr = addressFromSeed(new Uint8Array(Buffer.from(from.privateKey, 'base64url')));
  const gasPrice = await rpc.gasPrice();
  const tip = await rpc.maxPriorityFeePerGas();
  const tx = {
    chainId: await rpc.chainId(),
    nonce: await rpc.transactionCount(fromAddr),
    maxPriorityFeePerGas: tip,
    maxFeePerGas: gasPrice * 2n + tip,
    gasLimit: 250_000n,
    to,
    value,
    data,
  };
  const { raw, hash } = signTx(tx, evmScalar(from));
  await rpc.sendRawTransaction(raw);
  await rpc.waitForReceipt(hash);
  return hash;
}

async function evmCommand(rest: string[]): Promise<void> {
  const sub = rest[0];
  const args = rest.slice(1);
  switch (sub) {
    case 'address': {
      if (!args[0]) die('usage: tab evm address <key.json>');
      console.log(checksumAddress(evmAddressOf(args[0])));
      return;
    }
    case 'balance': {
      const { values } = opts(args, {
        wallet: { type: 'string' },
        token: { type: 'string' },
        agent: { type: 'string' },
        rpc: { type: 'string', default: EVM_RPC_DEFAULT },
      });
      if (!values.wallet || !values.token) die('--wallet and --token are required');
      const rpc = new EvmRpc(values.rpc as string);
      const addr = evmAddressOf(values.wallet as string);
      const token = (values.token as string).toLowerCase();
      const out: Record<string, unknown> = {
        wallet: checksumAddress(addr),
        token: checksumAddress(token),
        amount: microToUsd(Number(await rpc.erc20BalanceOf(token, addr))),
        eth: (Number(await rpc.balance(addr)) / 1e18).toFixed(6),
      };
      if (values.agent) {
        const spender = evmAddressOf(values.agent as string);
        out.allowance_to = checksumAddress(spender);
        out.allowance = microToUsd(Number(await rpc.erc20Allowance(token, addr, spender)));
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'approve': {
      const { values } = opts(args, {
        owner: { type: 'string' },
        agent: { type: 'string' },
        amount: { type: 'string' },
        token: { type: 'string' },
        rpc: { type: 'string', default: EVM_RPC_DEFAULT },
      });
      if (!values.owner || !values.agent || !values.amount || !values.token) {
        die('--owner, --agent, --amount and --token are required');
      }
      const rpc = new EvmRpc(values.rpc as string);
      const owner = loadKey(values.owner as string);
      const spender = evmAddressOf(values.agent as string);
      const token = (values.token as string).toLowerCase();
      const amount = BigInt(usdToMicro(values.amount as string));
      const hash = await evmSend(rpc, owner, token, 0n, erc20.approve(spender, amount));
      console.log(`approved ${checksumAddress(spender)} to spend ${values.amount} (${hash})`);
      return;
    }
    case 'revoke': {
      const { values } = opts(args, {
        owner: { type: 'string' },
        agent: { type: 'string' },
        token: { type: 'string' },
        rpc: { type: 'string', default: EVM_RPC_DEFAULT },
      });
      if (!values.owner || !values.token || !values.agent) {
        die('--owner, --agent and --token are required (the spender whose allowance drops to zero)');
      }
      const rpc = new EvmRpc(values.rpc as string);
      const owner = loadKey(values.owner as string);
      const spender = evmAddressOf(values.agent as string);
      const token = (values.token as string).toLowerCase();
      const hash = await evmSend(rpc, owner, token, 0n, erc20.approve(spender, 0n));
      console.log(`revoked the allowance of ${checksumAddress(spender)} (${hash})`);
      return;
    }
    case 'fund': {
      const { values } = opts(args, {
        from: { type: 'string' },
        to: { type: 'string' },
        eth: { type: 'string', default: '0.005' },
        rpc: { type: 'string', default: EVM_RPC_DEFAULT },
      });
      if (!values.from || !values.to) die('--from and --to are required');
      const rpc = new EvmRpc(values.rpc as string);
      const from = loadKey(values.from as string);
      const to = evmAddressOf(values.to as string);
      const wei = BigInt(Math.round(Number(values.eth) * 1e6)) * 10n ** 12n;
      const hash = await evmSend(rpc, from, to, wei, new Uint8Array(0));
      console.log(`sent ${values.eth} ETH to ${checksumAddress(to)} (${hash})`);
      return;
    }
    default:
      die('usage: tab evm address|approve|revoke|balance|fund ...');
  }
}

main().catch((err) => die((err as Error).stack ?? String(err)));
