// The `tab` command. One binary, three roles: owner (issues mandates), agent
// (pays), gateway/catalog (sells). See DEPLOY.md section 7 for the reference.

import { parseArgs } from 'node:util';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { newKeyPair, saveKey, loadKey, resolvePublicKey, type KeyPair } from './keys.js';
import { issueMandate, delegateMandate, loadMandate, saveMandate, verifyMandate, mandateChain, type Mandate } from './mandate.js';
import { signRevocation, verifyRevocation, mayRevoke, type Revocation } from './revoke.js';
import { signApproval, approvalRequestValid, type Approval, type ApprovalRequest } from './approval.js';
import { usdToMicro, microToUsd, formatAmount, microToBaseUnits, baseUnitsToMicro } from './protocol.js';
import { Store, CatalogStore } from './store.js';
import { loadSpec, createGateway, announce } from './gateway.js';
import { createCatalog } from './catalog.js';
import { TabClient, PaymentRefused, receiptOf, x402ResponseOf, escrowOf, approvalRequestOf, type EscrowTicket } from './client.js';
import { runMcpServer, serveMcpStdio } from './mcp.js';
import { connectTools, serveMcpHttp, listMcpTools } from './mcp-bridge.js';
import { signListing, mcpToolPath, LISTING_PATH, LISTING_LIMITS, type ListingRoute } from './listings.js';
import { signAlertSub, ALERTS_PATH } from './alerts.js';
import { randomBytes } from 'node:crypto';
import { saveProof, verifyProof, listProofs } from './proof.js';
import { addressFromSeed, checksumAddress } from './evm/secp256k1.js';
import { EvmRpc } from './evm/rpc.js';
import { evmSend } from './evm/send.js';
import { erc20, isAddress, signTx, hexToBytes, bytesToHex, bigToMinimal } from './evm/tx.js';
import { scalarFromSeed } from './evm/secp256k1.js';
import { rlpEncode } from './evm/rlp.js';
import { keccak256 } from './evm/keccak.js';
import { companyCommand, COMPANY_USAGE } from './company/cli.js';

// Node's fetch tries each address of a host for 250 ms before moving to the next (happy eyeballs). From far
// away, a round trip alone can take that long, so upstreams on another continent fail to connect at all.
// 2 s per attempt is still fast to fail and connects everywhere.
setDefaultAutoSelectFamilyAttemptTimeout(2_000);

/** A file shipped in the package: two levels up from dist/src, one from src in a checkout. */
function packageFile(rel: string): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return /[\\/]dist[\\/]src$/.test(here) ? join(here, '..', '..', rel) : join(here, '..', rel);
}

export const VERSION_STRING: string = (() => {
  try { return JSON.parse(readFileSync(packageFile('package.json'), 'utf8')).version; } catch { return '0'; }
})();

const USAGE = `tab ${VERSION_STRING}: a payment gateway for software agents (HTTP 402 + signed mandates)

  tab init  [--dir ~/.tab] [--budget 1.00] [--max-per-call 0.05] [--days 90]
            [--gateway https://pay.paidwithtab.com] [--catalog https://paidwithtab.com]
            give an agent a tab: keys, a mandate, starter credits, the Claude Code line
  tab key new [--out file]
  tab mandate issue --owner key.json --agent <pub|file> --budget 1.00
                    [--window total|day] [--max-per-call 0.05] [--allow realm]... [--days 7]
                    [--approve-above 0.50] [--out file]
  tab mandate delegate --agent-key agent.json --mandate parent.json --to <pub|file>
                    [--budget 0.25] [--max-per-call] [--allow realm]... [--days] [--window] [--approve-above] [--out file]
                    a sub-mandate: a narrower slice of your mandate for another agent key
  tab mandate revoke --key key.json (--mandate file | --id <mandate id>) [--reason text] [--gateway url]...
                    [--token <0x> --evm-agent <key.json|0x>... [--rpc url]]   evm: zero the agents' allowances too
                    signed by the owner, the delegating agent or the agent itself; gateways refuse it within seconds
  tab mandate status (--mandate file | --id <mandate id>) [--gateway url]   revoked? spent?
  tab mandate approve --owner key.json --request <file|json> [--ttl 900] [--gateway url]
                    approve one payment above a mandate's threshold; the agent's retry goes through
  tab mint    --wallet <pub|file> --amount 5.00 [--db tab.db]
  tab balance --wallet <pub|file> [--db tab.db]
  tab serve   --spec spec.json [--db tab.db] [--port 1402] [--listen 127.0.0.1] [--announce http://catalog:1403] [--origin url] [--x402-settler key.json] [--upstream-timeout s] [--faucet amount [--faucet-key key.json --faucet-gas eth]]
              [--peer https://other-gateway]...   share revocations with other gateways
              [--listings]   take hosted listings sellers sign and post (tab sell)
              [--alerts]     send owners the spend alerts they subscribe to (tab alerts)
              [--escrow-key key.json]   evm rail: the address that holds pay-on-delivery orders and channel deposits
              [--faucet 1.00]   ledger rail: starter credits any wallet can claim once
              [--faucet-per-ip 20]   claims per address per day (a hosted company server claims for all its users from one)
  tab catalog serve [--db catalog.db] [--port 1403] [--listen 127.0.0.1] [--try-agent key.json --try-mandate mandate.json]
                    [--try-max-per-call 0.05] [--allow-private-origins] [--seed origin]...
  tab evm address <key.json>                                          key file -> 0x address
  tab evm approve --owner key.json --agent <key.json|0x> --amount 1.00 --token <0x> [--rpc url]
  tab evm revoke  --owner key.json --agent <key.json|0x> --token <0x> [--rpc url]
  tab evm balance --wallet <key.json|0x> --token <0x> [--agent <key.json|0x>] [--rpc url]
  tab evm fund    --from key.json --to <key.json|0x> --eth 0.005 [--rpc url]  gas for the agent
  tab evm fund    --from key.json --to <key.json|0x> --amount 5.00 --token <0x> [--decimals 6]
                                                    tokens to the agent itself, for paying x402 sites
  tab evm deploy-channel --from key.json [--rpc url]    the trustless TabChannel contract, testnets only
  tab fetch [--agent key.json --mandate mandate.json] [--max-per-call 0.05] [--currency USD] [-X POST] [-d body] <url>
            [--escrow [--wait 300]]   pay on delivery: held until the seller delivers, refunded if it does not
            [--wait-approval 300]     above the approval threshold: wait for the owner, then pay
            [--approval file]         attach an approval the owner signed
            [--channel [--deposit 1.00]]   pay from a payment channel at that gateway, opening one if needed
  tab escrow status <status url> --token <token> [--wait 300] [--out file]
  tab channel open  --gateway url --deposit 1.00 [--ttl seconds]   one deposit, then vouchers per call
  tab channel list
  tab channel close --gateway url                                  settle: spent to the seller, the rest back
  tab verify <proof folder | receipt.json> [--body file] [--key receipt-key] [--offline] [--json]
            check a purchase: gateway signature and key, body hash, request, the agent's own authorization, the mandate
  tab receipts [--dir ~/.tab/receipts] [--limit 20]      paid calls kept as proof folders
  tab sell <https upstream> --price 0.01 [--name] [--slug] [--description] [--route "GET /path [price]"]... [--gateway url]
            list your API on a hosted gateway, paid to your own wallet; no server of your own
  tab sell <MCP server URL> --mcp --price 0.01 [--tool-price name=0.02]...   one paid route per tool
  tab sell list [--gateway url]          tab sell remove <slug> [--gateway url]
  tab alerts set (--url https://... | --ntfy) [--at 50,90,100] [--daily] [--gateway url]...
            be told when an agent reaches a share of its budget, and a daily statement
  tab alerts off [--gateway url]...
  tab version
  tab mcp   (env: TAB_AGENT, TAB_MANDATE, [TAB_MAX_PER_CALL], [TAB_CURRENCY], [TAB_CATALOG], [TAB_ALLOW_DELEGATE=1], [TAB_PROOFS=dir|off])
            sets itself up on first launch (keys, a $1/day mandate, starter credits) when tab init never ran
  tab mcp connect <listing url>          a hosted listing's routes as MCP tools, paid per call
  tab mcp http [--port 8808] [--listen 127.0.0.1] [--path /mcp] -- <command> [args]   a stdio MCP server over HTTP, to sell it
  tab company serve|signup|login|new|fund|hire|ticket|comment|approve|pause|resume|budget|status|key
            a company of agents with tab as its money layer; tab company --help for the flags

  fetch and mcp default to the agent and mandate that tab init wrote in ~/.tab, and pay in USD
  unless --currency or TAB_CURRENCY names the token a gateway charges in.
`;

export const PUBLIC_GATEWAY = process.env.TAB_GATEWAY || 'https://pay.paidwithtab.com';
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
    case 'version':
    case '--version':
    case '-v':
      console.log(VERSION_STRING);
      return;

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
      if (rest[0] === 'delegate' || rest[0] === 'revoke' || rest[0] === 'status' || rest[0] === 'approve') {
        await mandateCommand(rest[0], rest.slice(1));
        return;
      }
      if (rest[0] !== 'issue') die('usage: tab mandate issue|delegate|revoke|status|approve ...');
      const { values } = opts(rest.slice(1), {
        owner: { type: 'string' },
        agent: { type: 'string' },
        budget: { type: 'string' },
        window: { type: 'string' },
        'max-per-call': { type: 'string' },
        allow: { type: 'string', multiple: true },
        days: { type: 'string' },
        'approve-above': { type: 'string' },
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
        approveAboveUsd: values['approve-above'] as string | undefined,
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
        listen: { type: 'string' },
        announce: { type: 'string' },
        origin: { type: 'string' },
        faucet: { type: 'string' },
        'faucet-per-ip': { type: 'string' },
        // evm testnets: the wallet that sends faucet tokens and gas, and how much gas
        'faucet-key': { type: 'string' },
        'faucet-gas': { type: 'string' },
        'x402-settler': { type: 'string' },
        // seconds the upstream may take; a service whose work takes minutes (an agent team) needs more than the default 60
        'upstream-timeout': { type: 'string' },
        peer: { type: 'string', multiple: true },
        listings: { type: 'boolean', default: false },
        alerts: { type: 'boolean', default: false },
        'escrow-key': { type: 'string' },
      });
      if (!values.spec) die('--spec is required');
      const spec = loadSpec(values.spec as string);
      for (const name of spec.skipped ?? []) log(`skipping service ${name}: set it in the environment and restart`);
      const store = new Store(values.db as string);
      const x402Settler = values['x402-settler'] ? loadKey(values['x402-settler'] as string) : undefined;
      const server = createGateway(spec, {
        store, log, faucetUsd: values.faucet as string | undefined, x402Settler,
        faucetKey: values['faucet-key'] ? loadKey(values['faucet-key'] as string) : undefined, faucetGas: values['faucet-gas'] as string | undefined,
        faucetPerIpPerDay: values['faucet-per-ip'] ? Math.max(1, Number(values['faucet-per-ip']) || 20) : undefined,
        origin: values.origin as string | undefined,
        upstreamTimeoutMs: values['upstream-timeout'] ? Math.max(1, Number(values['upstream-timeout']) || 60) * 1000 : undefined,
        listings: values.listings as boolean,
        alerts: values.alerts as boolean,
        revocationPeers: (values.peer as string[] | undefined)?.map((p) => p.replace(/\/$/, '')),
        escrowKey: values['escrow-key'] ? loadKey(values['escrow-key'] as string) : undefined,
      });
      const port = Number(values.port);
      // --listen 127.0.0.1 keeps the gateway off every other interface when a tunnel or proxy fronts it
      server.listen(port, values.listen as string | undefined, () => {
        log(`gateway for realm ${spec.realm} (${spec.rail ?? 'ledger'} rail) listening on ${values.listen ?? ''}:${port}, db ${values.db}${values.faucet ? `, faucet ${values.faucet}` : ''}${x402Settler ? `, x402 settled by ${addressFromSeed(new Uint8Array(Buffer.from(x402Settler.privateKey, 'base64url')))}` : ''}`);
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
        listen: { type: 'string' },
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
      server.listen(port, values.listen as string | undefined, () => {
        log(`catalog listening on ${values.listen ?? ''}:${port}, db ${values.db}${tryAgent ? ', try-it enabled' : ''}`);
        for (const origin of (values.seed as string[] | undefined) ?? []) {
          void (server as any).announce(origin.replace(/\/$/, ''));
        }
      });
      return;
    }

    case 'evm':
      await evmCommand(rest);
      return;

    case 'escrow':
      await escrowCommand(rest);
      return;

    case 'channel':
      await channelCommand(rest);
      return;

    case 'company':
      if (rest[0] === '--help' || rest[0] === '-h') { process.stdout.write(COMPANY_USAGE); return; }
      await companyCommand(rest);
      return;

    case 'fetch': {
      const { values, positionals } = opts(
        rest,
        {
          agent: { type: 'string' },
          mandate: { type: 'string' },
          'max-per-call': { type: 'string' },
          currency: { type: 'string' },
          method: { type: 'string', short: 'X' },
          data: { type: 'string', short: 'd' },
          escrow: { type: 'boolean', default: false },
          wait: { type: 'string' },
          'wait-approval': { type: 'string' },
          approval: { type: 'string' },
          channel: { type: 'boolean', default: false },
          deposit: { type: 'string' },
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
        currency: values.currency as string | undefined,
        x402Ledger: join(dirname(files.mandate), 'x402-spent.json'),
        channels: values.channel ? { depositUsd: values.deposit as string | undefined, file: join(dirname(files.mandate), 'channels.json') } : undefined,
      });
      const method = ((values.method as string) ?? (values.data != null ? 'POST' : 'GET')).toUpperCase();
      const pay = {
        escrow: values.escrow as boolean,
        approval: values.approval ? (JSON.parse(readFileSync(values.approval as string, 'utf8')) as Approval) : undefined,
        waitForApprovalMs: values['wait-approval'] ? Number(values['wait-approval']) * 1000 : undefined,
      };
      try {
        const init = {
          method,
          headers: values.data != null ? { 'content-type': 'application/json' } : undefined,
          body: values.data as string | undefined,
        };
        const res = await client.fetch(positionals[0], init, pay);
        const pending = await approvalRequestOf(res);
        if (pending) {
          const file = join(dirname(files.mandate), `approval-request-${pending.id.slice(0, 12)}.json`);
          writeFileSync(file, JSON.stringify(pending, null, 2) + '\n');
          console.error(`approval needed: ${formatAmount(Number(pending.amount), pending.currency)} for ${pending.resource} at ${pending.realm}`);
          console.error(`the owner approves with:\n  tab mandate approve --owner owner.json --request ${file} --gateway ${new URL(positionals[0]).origin}`);
          console.error('then run this fetch again (or pass --wait-approval 300 to wait for it)');
          process.exit(3);
        }
        const ticket = escrowOf(res);
        if (ticket) {
          log(`pay on delivery: order ${ticket.id} ${ticket.state} until ${ticket.deadline}`);
          if (ticket.state === 'held') {
            console.error(`follow it with: tab escrow status ${ticket.status} --token ${ticket.token} --wait 300`);
            if (values.wait) {
              const out = await client.escrowResult(ticket, Number(values.wait) * 1000);
              log(`order ${ticket.id}: ${out.state}${out.receipt ? `, delivery receipt ${out.verified?.ok ? 'verified' : `NOT verified: ${out.verified?.reason}`}` : ''}`);
              if (out.body) process.stdout.write(new TextDecoder().decode(out.body) + '\n');
              process.exit(out.state === 'delivered' ? 0 : 1);
            }
          }
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        const body = new TextDecoder().decode(bytes);
        const receipt = receiptOf(res);
        const settled = x402ResponseOf(res);
        if (settled?.success) log(`paid an x402 site on ${settled.network} (${settled.transaction})`);
        if (receipt) {
          const check = await client.verify(positionals[0], res, bytes, init);
          const via = receipt.channel ? ` from channel ${receipt.channel.id}, ${formatAmount(Number(receipt.channel.spent ?? 0), receipt.currency)} spent on it` : '';
          log(`paid ${formatAmount(Number(receipt.amount), receipt.currency)} (${receipt.ref})${via}, receipt ${check?.ok ? 'verified' : `NOT verified: ${check?.reason}`}`);
          if (process.env.TAB_PROOFS !== 'off') {
            const kept = saveProof(process.env.TAB_PROOFS || join(dirname(files.mandate), 'receipts'), { url: positionals[0], method: String(init.method ?? 'GET'), body: typeof init.body === 'string' ? init.body : undefined }, { status: res.status, contentType: res.headers.get('content-type') }, bytes, receipt, loadMandate(files.mandate));
            if (kept) log(`proof kept in ${kept.dir} (check it with: tab verify ${kept.dir})`);
          }
        }
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

    case 'sell':
      await sellCommand(rest);
      return;

    case 'alerts':
      await alertsCommand(rest);
      return;

    case 'verify': {
      const { values, positionals } = opts(rest, { body: { type: 'string' }, key: { type: 'string' }, offline: { type: 'boolean', default: false }, json: { type: 'boolean', default: false } }, true);
      if (positionals.length !== 1) die('usage: tab verify <proof folder | receipt.json> [--body file] [--key receipt-key] [--offline] [--json]');
      const report = await verifyProof(resolve(positionals[0]), {
        bodyPath: values.body as string | undefined,
        key: values.key as string | undefined,
        publishedKey: values.offline ? undefined : publishedReceiptKey,
      });
      if (values.json) console.log(JSON.stringify(report, null, 2));
      else {
        const s = report.summary;
        console.log(`${s.realm}${s.resource.replace(/^[A-Z]+ /, ' ')}: ${formatAmount(Number(s.amount), s.currency)} at ${s.at} (${s.ref})`);
        for (const c of report.checks) console.log(`  ${c.ok === true ? 'ok  ' : c.ok === false ? 'FAIL' : '--  '} ${c.name.padEnd(20)} ${c.detail ?? ''}`);
        console.log(report.ok ? 'proof holds' : 'proof does NOT hold');
      }
      process.exit(report.ok ? 0 : 1);
    }

    case 'receipts': {
      const { values } = opts(rest, { dir: { type: 'string' }, limit: { type: 'string', default: '20' } });
      const root = (values.dir as string) || process.env.TAB_PROOFS || join(TAB_HOME, 'receipts');
      const all = listProofs(root);
      if (!all.length) { console.log(`no proofs in ${root} yet; paid calls from tab fetch and the MCP server are kept there`); return; }
      for (const d of all.slice(0, Number(values.limit))) {
        const r = JSON.parse(readFileSync(join(d, 'receipt.json'), 'utf8')) as { realm: string; resource: string; amount: string; currency: string; at: string };
        console.log(`${r.at}  ${formatAmount(Number(r.amount), r.currency).padStart(10)}  ${r.realm}${r.resource.replace(/^[A-Z]+ /, ' ')}  ${d}`);
      }
      if (all.length > Number(values.limit)) console.log(`(${all.length - Number(values.limit)} more; --limit to see them)`);
      return;
    }

    case 'mcp': {
      if (rest[0] === 'connect' || rest[0] === 'http') {
        await mcpSubcommand(rest[0], rest.slice(1));
        return;
      }
      // first launch with nothing set up: do what `tab init` does, quietly on stderr, since stdout carries the protocol
      if (!process.env.TAB_AGENT && !process.env.TAB_MANDATE && !existsSync(join(TAB_HOME, 'mandate.json'))) {
        await initTab({ dir: TAB_HOME, budgetUsd: '1.00', maxPerCallUsd: '0.05', days: 90, gateway: PUBLIC_GATEWAY, catalog: PUBLIC_CATALOG, say: (m) => process.stderr.write(m + '\n'), brief: true });
      }
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
        currency: process.env.TAB_CURRENCY || undefined,
        catalog: process.env.TAB_CATALOG || PUBLIC_CATALOG,
        x402Ledger: join(dirname(files.mandate), 'x402-spent.json'),
        channelsFile: join(dirname(files.mandate), 'channels.json'),
        proofDir: process.env.TAB_PROOFS === 'off' ? undefined : process.env.TAB_PROOFS || join(dirname(files.mandate), 'receipts'),
      });
      return;
    }

    default:
      process.stderr.write(USAGE);
      process.exit(cmd ? 1 : 0);
  }
}

// ---------------------------------------------------------------------------
// 3.0: delegation, revocation, approval, escrow, channels

/** A mandate from --mandate (a file) or --id. */
function mandateArg(values: Record<string, unknown>): { id: string; mandate: Mandate | null } {
  if (values.mandate) { const m = loadMandate(values.mandate as string); return { id: m.id, mandate: m }; }
  if (values.id && /^[A-Za-z0-9_-]{43}$/.test(values.id as string)) return { id: values.id as string, mandate: null };
  die('--mandate <file> or --id <mandate id> is required');
}

async function postJson(url: string, body: unknown): Promise<{ status: number; doc: Record<string, unknown> }> {
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    return { status: r.status, doc: (await r.json().catch(() => ({}))) as Record<string, unknown> };
  } catch (err) {
    return { status: 0, doc: { error: (err as Error).message } };
  }
}

async function mandateCommand(sub: string, args: string[]): Promise<void> {
  switch (sub) {
    case 'delegate': {
      const { values } = opts(args, {
        'agent-key': { type: 'string' }, mandate: { type: 'string' }, to: { type: 'string' }, budget: { type: 'string' },
        window: { type: 'string' }, 'max-per-call': { type: 'string' }, allow: { type: 'string', multiple: true },
        days: { type: 'string' }, 'approve-above': { type: 'string' }, out: { type: 'string' },
      });
      if (!values['agent-key'] || !values.mandate || !values.to) die('--agent-key, --mandate and --to are required');
      const window = values.window as string | undefined;
      if (window !== undefined && window !== 'total' && window !== 'day') die('--window must be total or day');
      let child: Mandate;
      try {
        child = delegateMandate(loadKey(values['agent-key'] as string), loadMandate(values.mandate as string), {
          agent: resolvePublicKey(values.to as string), budgetUsd: values.budget as string | undefined, window: window as 'total' | 'day' | undefined,
          maxPerCallUsd: values['max-per-call'] as string | undefined, allow: values.allow as string[] | undefined,
          days: values.days ? Number(values.days) : undefined, approveAboveUsd: values['approve-above'] as string | undefined,
        });
      } catch (err) { die((err as Error).message); }
      if (values.out) { saveMandate(values.out as string, child); log(`wrote ${values.out} (sub-mandate ${child.id}, ${mandateChain(child).length - 1} level${mandateChain(child).length > 2 ? 's' : ''} below the owner)`); }
      else console.log(JSON.stringify(child, null, 2));
      return;
    }
    case 'revoke': {
      const { values } = opts(args, {
        key: { type: 'string' }, mandate: { type: 'string' }, id: { type: 'string' }, reason: { type: 'string' }, gateway: { type: 'string', multiple: true },
        // on chain a gateway's refusal is not the limit, the allowance is: the owner can zero it in the same step
        token: { type: 'string' }, 'evm-agent': { type: 'string', multiple: true }, rpc: { type: 'string', default: EVM_RPC_DEFAULT },
      });
      if (!values.key) die('--key is required: the owner, the agent that delegated the mandate, or its own agent');
      const { id, mandate } = mandateArg(values);
      const key = loadKey(values.key as string);
      const rev = signRevocation(key, id, values.reason as string | undefined);
      const gateways = (values.gateway as string[] | undefined) ?? [PUBLIC_GATEWAY];
      let ok = 0;
      for (const g of gateways) {
        // the mandate goes with it, so a gateway that has not seen it yet can check who may revoke it
        const { status, doc } = await postJson(`${g.replace(/\/$/, '')}/.well-known/tab/revocations`, mandate ? { revocation: rev, mandate } : rev);
        const result = (doc.results as Array<{ error?: string }> | undefined)?.[0];
        if (status === 200 && !result?.error) ok++;
        log(`${g}: ${status === 200 && !result?.error ? 'revoked' : `failed (${result?.error ?? doc.error ?? status})`}`);
      }
      const evmOwner = mandate ? mandateChain(mandate).at(-1)!.evm_owner : undefined;
      if (evmOwner && evmAddressOf(values.key as string) === evmOwner) {
        const agents = (values['evm-agent'] as string[] | undefined) ?? [];
        if (values.token && agents.length) {
          const rpc = new EvmRpc(values.rpc as string);
          for (const a of agents) {
            const spender = evmAddressOf(a);
            const hash = await evmSend(rpc, key, (values.token as string).toLowerCase(), 0n, erc20.approve(spender, 0n));
            log(`on chain: the allowance of ${checksumAddress(spender)} is now zero (${hash})`);
          }
        } else {
          console.error('note: on chain the ERC-20 allowance is the hard cap, and gateways only refuse what they are told about. Zero it too:\n  tab mandate revoke ... --token <0x token> --evm-agent <agent key.json|0x>   (or tab evm revoke)');
        }
      }
      console.log(JSON.stringify(rev, null, 2));
      process.exit(ok ? 0 : 1);
    }
    case 'status': {
      const { values } = opts(args, { mandate: { type: 'string' }, id: { type: 'string' }, gateway: { type: 'string', multiple: true } });
      const { id, mandate } = mandateArg(values);
      const ids = mandate ? mandateChain(mandate).map((m) => m.id) : [id];
      const out: Record<string, unknown> = { mandate: id, chain: ids.length > 1 ? ids : undefined };
      for (const g of (values.gateway as string[] | undefined) ?? [PUBLIC_GATEWAY]) {
        const origin = g.replace(/\/$/, '');
        try {
          const revoked: string[] = [];
          for (const x of ids) {
            const r = (await (await fetch(`${origin}/.well-known/tab/revocations/${x}`, { signal: AbortSignal.timeout(10_000) })).json()) as { revoked?: boolean; revocations?: Revocation[] };
            // with the mandate in hand, check each revocation here rather than take the gateway's word
            const target = mandate ? mandateChain(mandate).find((m) => m.id === x) : undefined;
            const real = target ? (r.revocations ?? []).some((v) => verifyRevocation(v) && v.mandate === x && mayRevoke(target, v.by)) : r.revoked;
            if (real) revoked.push(x);
          }
          const spent = (await (await fetch(`${origin}/.well-known/tab/mandate/${id}/spent`, { signal: AbortSignal.timeout(10_000) })).json()) as { spent?: string; currency?: string };
          out[origin] = { revoked: revoked.length > 0, revoked_ids: revoked.length ? revoked : undefined, spent: spent.spent, currency: spent.currency };
        } catch (err) {
          out[origin] = { error: (err as Error).message };
        }
      }
      console.log(JSON.stringify(out, null, 2));
      return;
    }
    case 'approve': {
      const { values } = opts(args, { owner: { type: 'string' }, request: { type: 'string' }, ttl: { type: 'string', default: '900' }, gateway: { type: 'string', multiple: true } });
      if (!values.owner || !values.request) die('--owner and --request are required');
      const raw = values.request as string;
      const req = JSON.parse(existsSync(raw) ? readFileSync(raw, 'utf8') : raw) as ApprovalRequest;
      if (!approvalRequestValid(req)) die('that is not an approval request a gateway sent (its id does not match)');
      let approval: Approval;
      try { approval = signApproval(loadKey(values.owner as string), req, Number(values.ttl) * 1000); } catch (err) { die((err as Error).message); }
      console.error(`approving ${formatAmount(Number(req.amount), req.currency)} for ${req.resource} at ${req.realm} by agent ${req.payer}, until ${approval.expires_at}`);
      for (const g of (values.gateway as string[] | undefined) ?? []) {
        const { status, doc } = await postJson(`${g.replace(/\/$/, '')}/.well-known/tab/approvals`, { request: req, approval });
        log(`${g}: ${status === 200 ? 'posted; the agent\'s retry will find it' : `failed (${doc.error ?? status})`}`);
      }
      console.log(JSON.stringify(approval, null, 2));
      return;
    }
  }
}

async function escrowCommand(args: string[]): Promise<void> {
  if (args[0] !== 'status') die('usage: tab escrow status <status url> --token <token> [--wait 300] [--out file]');
  const { values, positionals } = opts(args.slice(1), { token: { type: 'string' }, wait: { type: 'string', default: '0' }, out: { type: 'string' }, agent: { type: 'string' }, mandate: { type: 'string' } }, true);
  if (positionals.length !== 1 || !values.token) die('usage: tab escrow status <status url> --token <token> [--wait 300]');
  const files = defaultAgentFiles(values.agent as string | undefined, values.mandate as string | undefined);
  const client = new TabClient({ agent: loadKey(files.agent), mandate: loadMandate(files.mandate) });
  const status = positionals[0].replace(/\/$/, '');
  const ticket: EscrowTicket = { id: status.split('/').pop()!, state: 'held', deadline: '', token: values.token as string, status };
  const out = await client.escrowResult(ticket, Number(values.wait) * 1000);
  console.error(`order ${ticket.id}: ${out.state}${out.receipt ? `, delivery receipt ${out.verified?.ok ? 'verified' : `NOT verified: ${out.verified?.reason}`} (${out.receipt.ref})` : ''}${out.order.refund_ref ? `, refunded (${out.order.refund_ref}): ${out.order.reason}` : ''}`);
  if (out.body && values.out) writeFileSync(values.out as string, out.body);
  else if (out.body) process.stdout.write(new TextDecoder().decode(out.body) + '\n');
  else console.log(JSON.stringify(out.order, null, 2));
  process.exit(out.state === 'delivered' ? 0 : out.state === 'held' ? 4 : 1);
}

async function channelCommand(args: string[]): Promise<void> {
  const sub = args[0];
  const { values } = opts(args.slice(1), { gateway: { type: 'string' }, deposit: { type: 'string' }, ttl: { type: 'string' }, agent: { type: 'string' }, mandate: { type: 'string' }, currency: { type: 'string' } });
  const files = defaultAgentFiles(values.agent as string | undefined, values.mandate as string | undefined);
  const client = new TabClient({
    agent: loadKey(files.agent), mandate: loadMandate(files.mandate), currency: values.currency as string | undefined,
    channels: { file: join(dirname(files.mandate), 'channels.json') },
  });
  const fmtCh = (c: { origin?: string; id: string; deposit: string; spent: string; calls: number; currency: string; state: string; expires_at: string }) =>
    `${c.origin ?? ''} channel ${c.id}: ${formatAmount(Number(c.spent), c.currency)} of ${formatAmount(Number(c.deposit), c.currency)} spent over ${c.calls} call${c.calls === 1 ? '' : 's'}, ${c.state}, until ${c.expires_at}`;
  try {
    switch (sub) {
      case 'open': {
        if (!values.gateway || !values.deposit) die('--gateway and --deposit are required');
        const c = await client.openChannel(values.gateway as string, values.deposit as string, values.ttl ? Number(values.ttl) : undefined);
        console.log(fmtCh(c));
        return;
      }
      case 'list': {
        const all = Object.values(client.channels());
        if (!all.length) console.log('no channels held; tab channel open --gateway url --deposit 1.00');
        for (const c of all) console.log(fmtCh(c));
        return;
      }
      case 'close': {
        if (!values.gateway) die('--gateway is required');
        const out = await client.closeChannel(values.gateway as string);
        console.log(`${fmtCh({ ...out.channel, origin: (values.gateway as string).replace(/\/$/, '') })}; settled ${out.channel.settle_ref ?? '-'}, refunded ${out.channel.refund_ref ?? '-'}`);
        return;
      }
      default:
        die('usage: tab channel open|list|close ...');
    }
  } catch (err) {
    if (err instanceof PaymentRefused) die(`refused: ${err.reason}`);
    die((err as Error).message);
  }
}

/** The receipt key a gateway publishes in its discovery document; null when it cannot be read. */
async function publishedReceiptKey(realm: string): Promise<string | null> {
  const origin = /^(localhost|127\.|\[::1\])/.test(realm) ? `http://${realm}` : `https://${realm}`;
  const r = await fetch(origin + '/.well-known/tab', { signal: AbortSignal.timeout(10_000) });
  if (!r.ok) return null;
  const key = ((await r.json()) as { receipt_key?: unknown }).receipt_key;
  return typeof key === 'string' ? key : null;
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
  say?: (line: string) => void; // default stdout
  brief?: boolean; // skip the closing instructions (the MCP server sets itself up this way)
}

async function initTab(o: InitOptions): Promise<void> {
  const say = o.say ?? ((m: string) => console.log(m));
  const ownerPath = join(o.dir, 'owner.json');
  const agentPath = join(o.dir, 'agent.json');
  const mandatePath = join(o.dir, 'mandate.json');

  // keys: reuse what is there, so running init twice is safe
  let owner: KeyPair;
  let agent: KeyPair;
  if (existsSync(ownerPath)) {
    owner = loadKey(ownerPath);
    say(`owner key   ${ownerPath} (existing)`);
  } else {
    owner = newKeyPair();
    saveKey(ownerPath, owner);
    say(`owner key   ${ownerPath} (new)`);
  }
  if (existsSync(agentPath)) {
    agent = loadKey(agentPath);
    say(`agent key   ${agentPath} (existing)`);
  } else {
    agent = newKeyPair();
    saveKey(agentPath, agent);
    say(`agent key   ${agentPath} (new)`);
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
  say(`mandate     ${mandatePath}: ${o.budgetUsd}/day, ${o.maxPerCallUsd} per call, ${o.days} days`);

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
      say(
        body.credited && body.credited !== '0.00'
          ? `credits     ${body.credited} starter credits from ${doc.realm ?? o.gateway}; balance ${available}`
          : `credits     already claimed on ${doc.realm ?? o.gateway}; balance ${available}`,
      );
    } else {
      say(`credits     ${o.gateway} offers no starter credits; fund the owner wallet yourself`);
    }
  } catch (err) {
    say(`credits     could not reach ${o.gateway} (${(err as Error).message}); run tab init again later`);
  }

  if (o.brief) return;
  say(`
owner wallet  ${owner.publicKey}
agent wallet  ${agent.publicKey}

Claude Code (once, for every project; it sets itself up from here, even without init):

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

function evmAddressOf(arg: string): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(arg)) return arg.toLowerCase();
  if (arg.endsWith('.json')) {
    return addressFromSeed(new Uint8Array(Buffer.from(loadKey(arg).privateKey, 'base64url')));
  }
  die(`expected a key file or 0x address, got ${arg}`);
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
      const decimals = await rpc.erc20Decimals(token);
      const out: Record<string, unknown> = {
        wallet: checksumAddress(addr),
        token: checksumAddress(token),
        decimals,
        amount: microToUsd(Number(baseUnitsToMicro(await rpc.erc20BalanceOf(token, addr), decimals))),
        eth: (Number(await rpc.balance(addr)) / 1e18).toFixed(6),
      };
      if (values.agent) {
        const spender = evmAddressOf(values.agent as string);
        out.allowance_to = checksumAddress(spender);
        out.allowance = microToUsd(Number(baseUnitsToMicro(await rpc.erc20Allowance(token, addr, spender), decimals)));
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
      const amount = microToBaseUnits(BigInt(usdToMicro(values.amount as string)), await rpc.erc20Decimals(token));
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
        // send a token instead of ETH: an agent paying x402 sites spends from its own address
        amount: { type: 'string' },
        token: { type: 'string' },
        decimals: { type: 'string', default: '6' },
        rpc: { type: 'string', default: EVM_RPC_DEFAULT },
      });
      if (!values.from || !values.to) die('--from and --to are required');
      const rpc = new EvmRpc(values.rpc as string);
      const from = loadKey(values.from as string);
      const to = evmAddressOf(values.to as string);
      if (values.amount != null) {
        if (!values.token || !isAddress(values.token as string)) die('--amount needs --token <0x contract>');
        const base = microToBaseUnits(BigInt(usdToMicro(values.amount as string)), Number(values.decimals));
        const hash = await evmSend(rpc, from, (values.token as string).toLowerCase(), 0n, erc20.transfer(to, base));
        console.log(`sent ${values.amount} of ${values.token} to ${checksumAddress(to)} (${hash})`);
        return;
      }
      const wei = BigInt(Math.round(Number(values.eth) * 1e6)) * 10n ** 12n;
      const hash = await evmSend(rpc, from, to, wei, new Uint8Array(0));
      console.log(`sent ${values.eth} ETH to ${checksumAddress(to)} (${hash})`);
      return;
    }
    case 'deploy-channel': {
      // the trustless channel contract, contracts/TabChannel.sol, compiled in contracts/TabChannel.json
      const { values } = opts(args, { from: { type: 'string' }, rpc: { type: 'string', default: EVM_RPC_DEFAULT } });
      if (!values.from) die('--from key.json is required: the account that pays the deployment gas');
      const rpc = new EvmRpc(values.rpc as string);
      const chainId = Number(await rpc.chainId());
      if ([1, 10, 56, 137, 4663, 8453, 42161, 43114].includes(chainId)) die(`chain ${chainId} is a mainnet; 3.0 deploys TabChannel to testnets only`);
      const artifact = JSON.parse(readFileSync(packageFile('contracts/TabChannel.json'), 'utf8')) as { bytecode: string };
      const from = loadKey(values.from as string);
      const sender = evmAddressOf(values.from as string);
      const nonce = await rpc.transactionCount(sender);
      const tip = await rpc.maxPriorityFeePerGas();
      const { raw, hash } = signTx({ chainId: BigInt(chainId), nonce, maxPriorityFeePerGas: tip, maxFeePerGas: (await rpc.gasPrice()) * 2n + tip, gasLimit: 2_500_000n, to: '0x', value: 0n, data: hexToBytes(artifact.bytecode) }, scalarFromSeed(new Uint8Array(Buffer.from(from.privateKey, 'base64url'))));
      await rpc.sendRawTransaction(raw);
      await rpc.waitForReceipt(hash, 120_000);
      const address = bytesToHex(keccak256(rlpEncode([hexToBytes(sender), bigToMinimal(nonce)])).slice(12));
      console.log(JSON.stringify({ chain_id: chainId, contract: checksumAddress(address), tx: hash }, null, 2));
      return;
    }
    default:
      die('usage: tab evm address|approve|revoke|balance|fund|deploy-channel ...');
  }
}

main().catch((err) => die((err as Error).stack ?? String(err)));

// ---------------------------------------------------------------------------
// 3.1: MCP connect (buy a hosted listing's tools) and MCP over HTTP (so a stdio server can be sold)

async function mcpSubcommand(sub: string, args: string[]): Promise<void> {
  if (sub === 'http') {
    const dash = args.indexOf('--');
    if (dash < 0 || dash === args.length - 1) die('usage: tab mcp http [--port 8808] [--listen 127.0.0.1] [--path /mcp] -- <command> [args...]');
    const { values } = opts(args.slice(0, dash), { port: { type: 'string', default: '8808' }, listen: { type: 'string', default: '127.0.0.1' }, path: { type: 'string', default: '/mcp' } });
    serveMcpHttp({ command: args[dash + 1], args: args.slice(dash + 2), port: Number(values.port), host: values.listen as string, path: values.path as string, log });
    return;
  }
  // connect: a hosted listing's routes as tools of a local MCP server
  if (!args[0]) die('usage: tab mcp connect <listing url, e.g. https://pay.paidwithtab.com/s/weather>');
  if (!process.env.TAB_AGENT && !process.env.TAB_MANDATE && !existsSync(join(TAB_HOME, 'mandate.json'))) {
    await initTab({ dir: TAB_HOME, budgetUsd: '1.00', maxPerCallUsd: '0.05', days: 90, gateway: PUBLIC_GATEWAY, catalog: PUBLIC_CATALOG, say: (m) => process.stderr.write(m + '\n'), brief: true });
  }
  const files = defaultAgentFiles(process.env.TAB_AGENT, process.env.TAB_MANDATE);
  const mandate = loadMandate(files.mandate);
  const tools = await connectTools({
    url: args[0],
    agent: loadKey(files.agent),
    mandate,
    maxPerCallUsd: process.env.TAB_MAX_PER_CALL,
    x402Ledger: join(dirname(files.mandate), 'x402-spent.json'),
    proofDir: process.env.TAB_PROOFS === 'off' ? undefined : process.env.TAB_PROOFS || join(dirname(files.mandate), 'receipts'),
  }).catch((err) => die((err as Error).message));
  serveMcpStdio(tools, `tab: ${tools.service}`);
}

// ---------------------------------------------------------------------------
// 3.1: sell on a hosted gateway

function sellerKey(path?: string): KeyPair {
  const file = path || join(TAB_HOME, 'seller.json');
  if (existsSync(file)) return loadKey(file);
  const pair = newKeyPair();
  saveKey(file, pair);
  log(`seller key ${file} (new): this key owns your listings and is paid for them; back it up`);
  return pair;
}

async function gatewayDoc(gateway: string): Promise<{ realm: string; rail: string; listings?: string; alerts?: string }> {
  const r = await fetch(gateway + '/.well-known/tab', { signal: AbortSignal.timeout(15_000) }).catch((err) => die(`cannot reach ${gateway}: ${(err as Error).message}`));
  if (!r.ok) die(`${gateway} has no tab discovery document (HTTP ${r.status})`);
  return (await r.json()) as { realm: string; rail: string; listings?: string; alerts?: string };
}

async function postSigned(url: string, doc: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(doc), signal: AbortSignal.timeout(30_000) });
  const out = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) die(String(out.error ?? `HTTP ${r.status}`));
  return out;
}

const slugOf = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');

async function sellCommand(rest: string[]): Promise<void> {
  const sub = rest[0] === 'list' || rest[0] === 'remove' ? rest[0] : 'add';
  const { values, positionals } = opts(sub === 'add' ? rest : rest.slice(1), {
    price: { type: 'string' },
    name: { type: 'string' },
    slug: { type: 'string' },
    description: { type: 'string' },
    route: { type: 'string', multiple: true },
    mcp: { type: 'boolean', default: false },
    'tool-price': { type: 'string', multiple: true },
    gateway: { type: 'string', default: PUBLIC_GATEWAY },
    key: { type: 'string' },
    'evm-payout': { type: 'string' },
  }, true);
  const gateway = (values.gateway as string).replace(/\/$/, '');
  if (sub === 'list') {
    const r = await fetch(gateway + LISTING_PATH, { signal: AbortSignal.timeout(15_000) });
    const doc = (await r.json()) as { listings?: Array<{ slug: string; name: string; url: string; routes: number; seller: string; mcp?: boolean }>; error?: string };
    if (!r.ok) die(doc.error ?? `HTTP ${r.status}`);
    const mine = values.key || existsSync(join(TAB_HOME, 'seller.json')) ? sellerKey(values.key as string | undefined).publicKey : null;
    if (!doc.listings?.length) { console.log(`no hosted listings at ${gateway} yet`); return; }
    for (const l of doc.listings) console.log(`${l.slug.padEnd(24)} ${String(l.routes).padStart(3)} routes  ${l.mcp ? 'MCP  ' : 'API  '} ${l.url}${mine === l.seller ? '  (yours)' : ''}  ${l.name}`);
    return;
  }
  const disc = await gatewayDoc(gateway);
  if (!disc.listings) die(`${gateway} does not take hosted listings`);
  const seller = sellerKey(values.key as string | undefined);
  const evmPayout = disc.rail === 'evm' ? ((values['evm-payout'] as string) || checksumAddress(addressFromSeed(new Uint8Array(Buffer.from(seller.privateKey, 'base64url'))))) : undefined;
  if (sub === 'remove') {
    if (!positionals[0]) die('usage: tab sell remove <slug> [--gateway url] [--key seller.json]');
    const out = await postSigned(gateway + LISTING_PATH, signListing(seller, { realm: disc.realm, slug: positionals[0], name: '', upstream: '', routes: [], remove: true }));
    console.log(`removed ${out.removed}`);
    return;
  }
  if (positionals.length !== 1 || !values.price) {
    die('usage: tab sell <https upstream> --price 0.01 [--name "Weather"] [--slug weather] [--description text] [--route "GET /forecast"]... [--mcp [--tool-price name=0.02]...] [--gateway url] [--key seller.json] [--evm-payout 0x]');
  }
  const upstream = positionals[0].replace(/\/$/, '');
  const price = values.price as string;
  let routes: ListingRoute[];
  let name = values.name as string | undefined;
  if (values.mcp) {
    const tools = await listMcpTools(upstream).catch((err) => die(`could not list the MCP server's tools at ${upstream}: ${(err as Error).message}`));
    if (!tools.length) die(`${upstream} offers no tools`);
    const special = new Map((values['tool-price'] as string[] | undefined ?? []).map((t) => { const [k, v] = t.split('='); return [k, v] as [string, string]; }));
    routes = tools.slice(0, LISTING_LIMITS.maxRoutes).map((t) => ({
      method: 'POST', path: mcpToolPath(t.name), price: special.get(t.name) ?? price, mcp_tool: t.name,
      ...(t.description ? { description: t.description.slice(0, 500) } : {}),
      ...(t.inputSchema && JSON.stringify(t.inputSchema).length <= 8000 ? { input_schema: t.inputSchema } : {}),
    }));
    log(`${tools.length} tools found${tools.length > LISTING_LIMITS.maxRoutes ? `, the first ${LISTING_LIMITS.maxRoutes} listed` : ''}: ${tools.slice(0, 8).map((t) => t.name).join(', ')}${tools.length > 8 ? ', ...' : ''}`);
  } else {
    const given = (values.route as string[] | undefined) ?? ['GET /', 'POST /'];
    routes = given.map((r) => {
      const [method, path, p] = r.trim().split(/\s+/);
      if (!method || !path) die(`--route must look like "GET /forecast" (optionally followed by a price), got ${JSON.stringify(r)}`);
      return { method: method.toUpperCase(), path, price: p ?? price };
    });
  }
  name ??= new URL(upstream).hostname.replace(/^(api|www|mcp)\./, '');
  const slug = (values.slug as string) || slugOf(name);
  const listing = signListing(seller, {
    realm: disc.realm, slug, name, upstream, routes,
    ...(values.description ? { description: values.description as string } : {}),
    ...(values.mcp ? { mcp: true } : {}),
    ...(evmPayout ? { evm_payout: evmPayout } : {}),
  });
  const out = (await postSigned(gateway + LISTING_PATH, listing)) as { url: string; routes: Array<{ method: string; url: string; price: string; mcp_tool?: string }>; paid_to: string };
  console.log(`listed at ${out.url}, paid to ${out.paid_to}\n`);
  for (const r of out.routes) console.log(`  ${r.method.padEnd(6)} ${r.url}  ${r.price}${r.mcp_tool ? `  (tool ${r.mcp_tool})` : ''}`);
  console.log(`
Any agent with tab can buy it now:
  tab fetch ${values.mcp ? '-d \'{...tool arguments}\' ' : ''}${out.routes[0].url}
${values.mcp ? '  claude mcp add ' + slug + ' -- npx -y paidwithtab mcp connect ' + out.url + '\n' : ''}It shows in the catalog (paidwithtab.com/catalog) within a minute. Earnings: tab sell list, and ${disc.rail === 'evm' ? 'your 0x address on chain' : `${gateway}/.well-known/tab/wallet/${seller.publicKey}`}.`);
}

// ---------------------------------------------------------------------------
// 3.1: spend alerts

async function alertsCommand(rest: string[]): Promise<void> {
  const sub = rest[0];
  if (sub !== 'set' && sub !== 'off') die('usage: tab alerts set (--url https://... | --ntfy) [--at 50,90,100] [--daily] [--gateway url]... [--owner owner.json]\n       tab alerts off [--gateway url]... [--owner owner.json]');
  const { values } = opts(rest.slice(1), {
    url: { type: 'string' }, ntfy: { type: 'boolean', default: false }, at: { type: 'string' }, daily: { type: 'boolean', default: false },
    gateway: { type: 'string', multiple: true }, owner: { type: 'string' }, format: { type: 'string' },
  });
  const owner = loadKey((values.owner as string) || join(TAB_HOME, 'owner.json'));
  const gateways = ((values.gateway as string[] | undefined) ?? [PUBLIC_GATEWAY]).map((g) => g.replace(/\/$/, ''));
  let url = values.url as string | undefined;
  if (sub === 'set' && !url && values.ntfy) url = `https://ntfy.sh/tab-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  if (sub === 'set' && !url) die('give --url https://your-webhook, or --ntfy for a private ntfy.sh topic (phone push, no account)');
  const format = (values.format as 'json' | 'text' | undefined) ?? (url && new URL(url).hostname === 'ntfy.sh' ? 'text' : 'json');
  const thresholds = values.at ? String(values.at).split(',').map((t) => Number(t.trim())) : undefined;
  for (const g of gateways) {
    const disc = await gatewayDoc(g);
    if (!disc.alerts) { console.log(`${g}: sends no alerts, skipped`); continue; }
    const doc = signAlertSub(owner, sub === 'off' ? { realm: disc.realm, off: true } : { realm: disc.realm, url, format, ...(thresholds ? { thresholds } : {}), daily: values.daily as boolean });
    const out = await postSigned(g + ALERTS_PATH, doc);
    console.log(sub === 'off' ? `${g}: alerts off` : `${g}: alerts at ${(out.thresholds as number[]).join(', ')}%${out.daily ? ' and a daily statement' : ''}; test message ${out.test_delivered ? 'delivered' : 'NOT delivered (check the URL)'}`);
  }
  if (sub === 'set' && url && new URL(url).hostname === 'ntfy.sh') console.log(`\nOn your phone: install ntfy, subscribe to ${new URL(url).pathname.slice(1)} (or open ${url}).`);
}
