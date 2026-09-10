// The `tab` command. One binary, three roles: owner (issues mandates), agent
// (pays), gateway/catalog (sells). See DEPLOY.md section 7 for the reference.

import { parseArgs } from 'node:util';
import { newKeyPair, saveKey, loadKey, resolvePublicKey, pubBytes, signBytes, type KeyPair } from './keys.js';
import { issueMandate, loadMandate, saveMandate, verifyMandate } from './mandate.js';
import { usdToMicro, microToUsd } from './protocol.js';
import { Store, CatalogStore } from './store.js';
import { loadSpec, createGateway, announce } from './gateway.js';
import { createCatalog } from './catalog.js';
import { TabClient, PaymentRefused, receiptOf } from './client.js';
import { runMcpServer } from './mcp.js';
import { b58encode, b58decode32 } from './solana/base58.js';
import { ata } from './solana/pda.js';
import { SolanaRpc } from './solana/rpc.js';
import { approveChecked, revoke, createAtaIdempotent, type Instruction } from './solana/instructions.js';
import { compileMessage, serializeTransaction } from './solana/tx.js';

const USAGE = `tab: a payment gateway for software agents (HTTP 402 + signed mandates)

  tab key new [--out file]
  tab mandate issue --owner key.json --agent <pub|file> --budget 1.00
                    [--window total|day] [--max-per-call 0.05] [--allow realm]... [--days 7] [--out file]
  tab mint    --wallet <pub|file> --amount 5.00 [--db tab.db]
  tab balance --wallet <pub|file> [--db tab.db]
  tab serve   --spec spec.json [--db tab.db] [--port 1402] [--announce http://catalog:1403] [--origin url]
  tab catalog serve [--db catalog.db] [--port 1403] [--try-agent key.json --try-mandate mandate.json]
                    [--try-max-per-call 0.05] [--seed origin]...
  tab solana approve --owner key.json --agent <pub|file> --amount 1.00 --mint <addr> [--rpc url] [--fee-payer key.json]
  tab solana revoke  --owner key.json --mint <addr> [--rpc url]
  tab solana balance --wallet <pub|file> --mint <addr> [--rpc url]
  tab solana airdrop --wallet <pub|file> [--sol 1] [--rpc url]
  tab solana address <pub|file>
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

const RPC_DEFAULT = process.env.SOLANA_RPC || 'http://127.0.0.1:8899';

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

    case 'solana':
      await solanaCommand(rest);
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
// solana subcommands

async function sendInstructions(
  rpc: SolanaRpc,
  feePayer: KeyPair,
  signers: KeyPair[],
  instructions: Instruction[],
): Promise<string> {
  const blockhash = await rpc.getLatestBlockhash();
  const compiled = compileMessage(pubBytes(feePayer.publicKey), blockhash, instructions);
  const byPub = new Map<string, KeyPair>();
  for (const s of [feePayer, ...signers]) byPub.set(b58encode(pubBytes(s.publicKey)), s);
  const signatures = compiled.accounts.slice(0, compiled.numRequiredSignatures).map((acc) => {
    const pair = byPub.get(acc);
    if (!pair) throw new Error(`no key for required signer ${acc}`);
    return new Uint8Array(Buffer.from(signBytes(pair, compiled.bytes), 'base64url'));
  });
  const tx = Buffer.from(serializeTransaction({ signatures, message: compiled.bytes })).toString('base64');
  const sig = await rpc.sendTransaction(tx);
  await rpc.confirm(sig);
  return sig;
}

async function solanaCommand(rest: string[]): Promise<void> {
  const sub = rest[0];
  const args = rest.slice(1);
  switch (sub) {
    case 'address': {
      if (!args[0]) die('usage: tab solana address <pub|file>');
      console.log(b58encode(pubBytes(resolvePublicKey(args[0]))));
      return;
    }
    case 'airdrop': {
      const { values } = opts(args, {
        wallet: { type: 'string' },
        sol: { type: 'string', default: '1' },
        rpc: { type: 'string', default: RPC_DEFAULT },
      });
      if (!values.wallet) die('--wallet is required');
      const rpc = new SolanaRpc(values.rpc as string);
      const addr = b58encode(pubBytes(resolvePublicKey(values.wallet as string)));
      const sig = await rpc.requestAirdrop(addr, BigInt(Math.round(Number(values.sol) * 1e9)));
      await rpc.confirm(sig);
      console.log(`airdropped ${values.sol} SOL to ${addr}`);
      return;
    }
    case 'balance': {
      const { values } = opts(args, {
        wallet: { type: 'string' },
        mint: { type: 'string' },
        rpc: { type: 'string', default: RPC_DEFAULT },
      });
      if (!values.wallet || !values.mint) die('--wallet and --mint are required');
      const rpc = new SolanaRpc(values.rpc as string);
      const owner = pubBytes(resolvePublicKey(values.wallet as string));
      const ataAddr = b58encode(ata(owner, b58decode32(values.mint as string)));
      const acc = await rpc.getTokenAccount(ataAddr);
      console.log(
        JSON.stringify(
          {
            wallet: b58encode(owner),
            token_account: ataAddr,
            amount: acc ? microToUsd(Number(acc.amount)) : '0.00',
            delegate: acc?.delegate ?? null,
            delegated_amount: acc ? microToUsd(Number(acc.delegatedAmount)) : '0.00',
          },
          null,
          2,
        ),
      );
      return;
    }
    case 'approve': {
      const { values } = opts(args, {
        owner: { type: 'string' },
        agent: { type: 'string' },
        amount: { type: 'string' },
        mint: { type: 'string' },
        rpc: { type: 'string', default: RPC_DEFAULT },
        'fee-payer': { type: 'string' },
      });
      if (!values.owner || !values.agent || !values.amount || !values.mint) {
        die('--owner, --agent, --amount and --mint are required');
      }
      const rpc = new SolanaRpc(values.rpc as string);
      const owner = loadKey(values.owner as string);
      const feePayer = values['fee-payer'] ? loadKey(values['fee-payer'] as string) : owner;
      const mint = b58decode32(values.mint as string);
      const ownerPub = pubBytes(owner.publicKey);
      const agentPub = pubBytes(resolvePublicKey(values.agent as string));
      const ownerAta = ata(ownerPub, mint);
      const amount = BigInt(usdToMicro(values.amount as string));
      const sig = await sendInstructions(rpc, feePayer, [owner], [
        createAtaIdempotent(pubBytes(feePayer.publicKey), ownerAta, ownerPub, mint),
        approveChecked(ownerAta, mint, agentPub, ownerPub, amount, 6),
      ]);
      console.log(`approved ${b58encode(agentPub)} as delegate for ${values.amount} (${sig})`);
      return;
    }
    case 'revoke': {
      const { values } = opts(args, {
        owner: { type: 'string' },
        mint: { type: 'string' },
        rpc: { type: 'string', default: RPC_DEFAULT },
      });
      if (!values.owner || !values.mint) die('--owner and --mint are required');
      const rpc = new SolanaRpc(values.rpc as string);
      const owner = loadKey(values.owner as string);
      const mint = b58decode32(values.mint as string);
      const ownerPub = pubBytes(owner.publicKey);
      const sig = await sendInstructions(rpc, owner, [owner], [revoke(ata(ownerPub, mint), ownerPub)]);
      console.log(`revoked delegation (${sig})`);
      return;
    }
    default:
      die('usage: tab solana approve|revoke|balance|airdrop|address ...');
  }
}

main().catch((err) => die((err as Error).stack ?? String(err)));
