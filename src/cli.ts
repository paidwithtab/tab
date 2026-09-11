// The `tab` command. One binary, three roles: owner (issues mandates), agent
// (pays), gateway/catalog (sells). See DEPLOY.md section 7 for the reference.

import { parseArgs } from 'node:util';
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

const USAGE = `tab: a payment gateway for software agents (HTTP 402 + signed mandates)

  tab key new [--out file]
  tab mandate issue --owner key.json --agent <pub|file> --budget 1.00
                    [--window total|day] [--max-per-call 0.05] [--allow realm]... [--days 7] [--out file]
  tab mint    --wallet <pub|file> --amount 5.00 [--db tab.db]
  tab balance --wallet <pub|file> [--db tab.db]
  tab serve   --spec spec.json [--db tab.db] [--port 1402] [--announce http://catalog:1403] [--origin url]
  tab catalog serve [--db catalog.db] [--port 1403] [--try-agent key.json --try-mandate mandate.json]
                    [--try-max-per-call 0.05] [--allow-private-origins] [--seed origin]...
  tab evm address <key.json>                                          key file -> 0x address
  tab evm approve --owner key.json --agent <key.json|0x> --amount 1.00 --token <0x> [--rpc url]
  tab evm revoke  --owner key.json --token <0x> [--rpc url]
  tab evm balance --wallet <key.json|0x> --token <0x> [--agent <key.json|0x>] [--rpc url]
  tab evm fund    --from key.json --to <key.json|0x> --eth 0.005 [--rpc url]  gas for the agent
  tab fetch --agent key.json --mandate mandate.json [--max-per-call 0.05] [-X POST] [-d body] <url>
  tab mcp   (env: TAB_AGENT, TAB_MANDATE, [TAB_MAX_PER_CALL], [TAB_CATALOG])
`;

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
      });
      if (!values.spec) die('--spec is required');
      const spec = loadSpec(values.spec as string);
      const store = new Store(values.db as string);
      const server = createGateway(spec, { store, log });
      const port = Number(values.port);
      server.listen(port, () => {
        log(`gateway for realm ${spec.realm} (${spec.rail ?? 'ledger'} rail) listening on :${port}, db ${values.db}`);
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
      if (!values.agent || !values.mandate || positionals.length !== 1) {
        die('usage: tab fetch --agent key.json --mandate mandate.json [-X POST] [-d body] <url>');
      }
      const client = new TabClient({
        agent: loadKey(values.agent as string),
        mandate: loadMandate(values.mandate as string),
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
      const agentPath = process.env.TAB_AGENT;
      const mandatePath = process.env.TAB_MANDATE;
      if (!agentPath || !mandatePath) die('TAB_AGENT and TAB_MANDATE are required');
      const agent = loadKey(agentPath);
      const mandate = loadMandate(mandatePath);
      const v = verifyMandate(mandate);
      if (!v.ok) die(`mandate: ${v.error}`);
      if (mandate.agent !== agent.publicKey) die('mandate is not for this agent key');
      runMcpServer({
        agent,
        mandate,
        maxPerCallUsd: process.env.TAB_MAX_PER_CALL,
        catalog: process.env.TAB_CATALOG,
      });
      return;
    }

    default:
      process.stderr.write(USAGE);
      process.exit(cmd ? 1 : 0);
  }
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
