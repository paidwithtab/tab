// The `tab` command. One binary, three roles: owner (issues mandates), agent
// (pays), gateway/catalog (sells). See DEPLOY.md section 7 for the reference.

import { nameFetches } from './version.js';
import { runDoctor, printDoctor } from './doctor.js';
import { fixForCode, fixForRefusal, problemCodeOf } from './fixes.js';
import { parseArgs } from 'node:util';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { newKeyPair, saveKey, loadKey, resolvePublicKey, type KeyPair } from './keys.js';
import { issueMandate, delegateMandate, loadMandate, saveMandate, verifyMandate, mandateChain, parseHours, describeHours, type Mandate } from './mandate.js';
import { signRevocation, verifyRevocation, mayRevoke, type Revocation } from './revoke.js';
import { signApproval, approvalRequestValid, type Approval, type ApprovalRequest } from './approval.js';
import { usdToMicro, microToUsd, formatAmount, microToBaseUnits, baseUnitsToMicro } from './protocol.js';
import { Store, CatalogStore } from './store.js';
import { loadSpec, createGateway, announce } from './gateway.js';
import { createCatalog, siteReport } from './catalog.js';
import { TabClient, PaymentRefused, receiptOf, x402ResponseOf, escrowOf, approvalRequestOf, type EscrowTicket } from './client.js';
import { runMcpServer, serveMcpStdio } from './mcp.js';
import { connectTools, serveMcpHttp, listMcpTools } from './mcp-bridge.js';
import { signListing, mcpToolPath, LISTING_PATH, LISTING_LIMITS, type ListingRoute } from './listings.js';
import { signAlertSub, ALERTS_PATH } from './alerts.js';
import { randomBytes } from 'node:crypto';
import { saveProof, verifyProof, listProofs, costReport, type CostBy, type LogProof } from './proof.js';
import { verifyTreeHead, verifyConsistency, unb64, type TreeHead } from './log.js';
import { usageStats, sellerStatsMessage, type UsageReport } from './usage.js';
import { signBytes } from './keys.js';
import { BAZAAR_URL } from './x402-catalog.js';
import { currentTask } from './mcp.js';
import { setupCommand, RELEASE_TGZ } from './setup.js';
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

  tab doctor [--gateway url] [--catalog url] [--json]
            checks keys, mandate, budget left, balance, clock, catalog, MCP configs, version; names each fix
  tab init  [--dir ~/.tab] [--budget 1.00] [--max-per-call 0.05] [--days 90] [--no-demo]
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
  tab mandate issue ... [--paths "/search*"]... [--hours "mon-fri 9-17"]   only these routes, only then (UTC)
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
              [--stripe [--stripe-api url]]   ledger rail: card top-ups (env STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET)
              [--referrals]   a starter-credit claim may name a referrer, paid 10% of that buyer's card-funded spend
              [--house-ip ip]... [--house-owner id]...   the operator's own, left out of usage stats (env TAB_STATS_TOKEN)
  tab catalog serve [--db catalog.db] [--port 1403] [--listen 127.0.0.1] [--try-agent key.json --try-mandate mandate.json]
                    [--try-max-per-call 0.05] [--allow-private-origins] [--seed origin]... [--x402-list bazaar|url]...
  tab catalog add-x402 <https origin> [--catalog url]   list an x402 seller: reads its /.well-known/x402
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
  tab verify [proof folder | receipt.json] [--body file] [--key receipt-key] [--offline] [--json]
            check a purchase (the latest when none is named): gateway signature and key, body hash, request,
            the agent's own authorization, the mandate, and its entry in the gateway's public log
  tab cost [--by task|day|realm|route] [--since 2026-11-01] [--task name] [--json]   spend from your proofs, and cache savings
  tab log head|check [--gateway url]...   the public receipt log: check proves nothing already logged was changed
  tab setup <claude|cursor|windsurf|vscode|codex> [--print] [--github]   put tab in an agent tool's MCP config
  tab topup <dollars> [--gateway url]     add credit by card (on gateways that take it)
  tab stats (--db pay.db [--house-ip ip]... | --gateway url | --catalog url | --catalog-db catalog.db [--house-ip ip]...) [--days 30]   who uses a gateway or the site, the operator's own left out
  tab receipts [--dir ~/.tab/receipts] [--limit 20]      paid calls kept as proof folders
  tab sell <https upstream> --price 0.01 [--name] [--slug] [--description] [--route "GET /path [price]"]... [--gateway url]
            list your API on a hosted gateway, paid to your own wallet; no server of your own
  tab sell <MCP server URL> --mcp --price 0.01 [--tool-price name=0.02]...   one paid route per tool
            [--free 3] [--notify https://... | --notify-ntfy]   free calls a day per buyer; first sale and daily earnings
  tab sell list [--gateway url]          tab sell remove <slug> [--gateway url]
  tab sell stats [--days 30] [--gateway url]   your earnings, routes, reliability and top buyers
  tab alerts set (--url https://... | --ntfy) [--at 50,90,100] [--daily] [--gateway url]...
            be told when an agent reaches a share of its budget, and a daily statement
  tab alerts off [--gateway url]...
  tab version
  tab mcp   (env: TAB_AGENT, TAB_MANDATE, [TAB_MAX_PER_CALL], [TAB_CURRENCY], [TAB_CATALOG], [TAB_ALLOW_DELEGATE=1], [TAB_PROOFS=dir|off],
             [TAB_CACHE_TTL=600|off], [TAB_TASK=name])
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
  if (!process.env.TAB_SURFACE) process.env.TAB_SURFACE = cmd === 'mcp' ? 'mcp' : cmd === 'company' && rest[0] === 'serve' ? 'os' : cmd === 'catalog' ? 'catalog' : 'cli';
  nameFetches(process.env.TAB_SURFACE);

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
        'no-demo': { type: 'boolean', default: false },
      });
      await initTab({
        demo: !values['no-demo'],
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
        paths: { type: 'string', multiple: true },
        hours: { type: 'string' },
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
        paths: values.paths as string[] | undefined,
        hours: values.hours ? (() => { try { return parseHours(values.hours as string); } catch (err) { die((err as Error).message); } })() : undefined,
        // attest the owner's EVM account so the mandate works on the evm rail
        evmOwner: addressFromSeed(new Uint8Array(Buffer.from(owner.privateKey, 'base64url'))),
      });
      if (mandate.paths || mandate.hours) log(`rules: ${mandate.paths ? `only ${mandate.paths.join(', ')}` : ''}${mandate.paths && mandate.hours ? '; ' : ''}${mandate.hours ? describeHours(mandate.hours) : ''} (gateways before 3.2 refuse a mandate with rules)`);
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
        // 3.2
        stripe: { type: 'boolean', default: false },
        'stripe-api': { type: 'string' },
        referrals: { type: 'boolean', default: false },
        'house-ip': { type: 'string', multiple: true },
        'house-owner': { type: 'string', multiple: true },
      });
      if (!values.spec) die('--spec is required');
      let stripe;
      if (values.stripe) {
        const secretKey = process.env.STRIPE_SECRET_KEY, webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
        if (!secretKey || !webhookSecret) die('--stripe needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in the environment');
        stripe = { secretKey, webhookSecret, ...(values['stripe-api'] ? { api: values['stripe-api'] as string } : {}) };
      }
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
        stripe,
        referrals: values.referrals as boolean,
        houseIps: values['house-ip'] as string[] | undefined,
        houseOwners: values['house-owner'] as string[] | undefined,
        statsToken: process.env.TAB_STATS_TOKEN || undefined,
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
      if (rest[0] === 'add-x402') {
        // 3.2: put an x402 seller in the catalog: it reads their /.well-known/x402 and asks each resource its price
        const { values, positionals } = opts(rest.slice(1), { catalog: { type: 'string', default: PUBLIC_CATALOG } }, true);
        if (positionals.length !== 1) die('usage: tab catalog add-x402 <https origin> [--catalog url]');
        const out = await postJson(`${(values.catalog as string).replace(/\/$/, '')}/v1/x402/announce`, { origin: positionals[0] });
        if (out.status !== 200) die(String(out.doc.error ?? `HTTP ${out.status}`));
        console.log(`${out.doc.origin}: ${out.doc.routes} routes listed`);
        for (const r of (out.doc.listed as Array<{ url: string; price: string; network: string }>) ?? []) console.log(`  ${r.price.padStart(6)}  ${r.url}  (${r.network})`);
        return;
      }
      if (rest[0] !== 'serve') die('usage: tab catalog serve ... | tab catalog add-x402 <origin>');
      const { values } = opts(rest.slice(1), {
        db: { type: 'string', default: 'catalog.db' },
        port: { type: 'string', default: '1403' },
        listen: { type: 'string' },
        'try-agent': { type: 'string' },
        'try-mandate': { type: 'string' },
        'try-max-per-call': { type: 'string' },
        'allow-private-origins': { type: 'boolean', default: false },
        seed: { type: 'string', multiple: true },
        'x402-list': { type: 'string', multiple: true },
        'house-ip': { type: 'string', multiple: true },
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
        // 3.2: "bazaar" is the public x402 discovery list
        x402Lists: ((values['x402-list'] as string[] | undefined) ?? []).map((l) => (l === 'bazaar' ? BAZAAR_URL : l)),
        houseIps: values['house-ip'] as string[] | undefined,
        statsToken: process.env.TAB_STATS_TOKEN || undefined,
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
            const task = currentTask()();
            const kept = saveProof(process.env.TAB_PROOFS || join(dirname(files.mandate), 'receipts'), { url: positionals[0], method: String(init.method ?? 'GET'), body: typeof init.body === 'string' ? init.body : undefined, ...(task ? { task } : {}) }, { status: res.status, contentType: res.headers.get('content-type') }, bytes, receipt, loadMandate(files.mandate));
            if (kept) log(`proof kept in ${kept.dir} (check it with: tab verify ${kept.dir})`);
          }
        }
        process.stdout.write(body.endsWith('\n') || body === '' ? body : body + '\n');
        if (!res.ok && !receipt) {
          const f = fixForCode(problemCodeOf(res.headers.get('content-type'), body));
          if (f) console.error(`${f.what}: ${f.fix}`);
        }
        process.exit(res.ok ? 0 : 1);
      } catch (err) {
        if (err instanceof PaymentRefused) {
          console.error(`refused: ${err.reason}`);
          const f = fixForRefusal(err.reason);
          if (f) console.error(`fix: ${f.fix}`);
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
      if (positionals.length > 1) die('usage: tab verify [proof folder | receipt.json] [--body file] [--key receipt-key] [--offline] [--json]');
      // 3.2: with no folder, the latest purchase
      let target = positionals[0];
      if (!target) {
        const latest = listProofs(process.env.TAB_PROOFS || join(TAB_HOME, 'receipts'))[0];
        if (!latest) die(`no proofs yet in ${process.env.TAB_PROOFS || join(TAB_HOME, 'receipts')}; name a proof folder or receipt.json`);
        target = latest;
      }
      const report = await verifyProof(resolve(target), {
        bodyPath: values.body as string | undefined,
        key: values.key as string | undefined,
        publishedKey: values.offline ? undefined : publishedReceiptKey,
        logProof: values.offline ? undefined : fetchLogProof,
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

    // -- 3.3 ------------------------------------------------------------------------------------
    case 'doctor': {
      const { values } = opts(rest, { gateway: { type: 'string', default: PUBLIC_GATEWAY }, catalog: { type: 'string', default: process.env.TAB_CATALOG || PUBLIC_CATALOG }, json: { type: 'boolean', default: false } });
      const checks = await runDoctor({
        dir: TAB_HOME,
        agentFile: process.env.TAB_AGENT || undefined,
        mandateFile: process.env.TAB_MANDATE || undefined,
        gateway: (values.gateway as string).replace(/\/$/, ''),
        catalog: (values.catalog as string).replace(/\/$/, ''),
        ...(process.env.TAB_DOCTOR_HOME ? { home: process.env.TAB_DOCTOR_HOME } : {}),
        ...(process.env.TAB_DOCTOR_OFFLINE_VERSION ? { latestRelease: async () => null } : {}),
      });
      if (values.json) { console.log(JSON.stringify(checks, null, 2)); process.exit(checks.some((c) => c.state === 'fail') ? 1 : 0); }
      process.exit(printDoctor(checks) ? 0 : 1);
    }

    // -- 3.2 ------------------------------------------------------------------------------------
    case 'setup':
      await setupCommand(rest, { log, die });
      return;

    case 'cost': {
      const { values } = opts(rest, { by: { type: 'string', default: 'task' }, since: { type: 'string' }, task: { type: 'string' }, dir: { type: 'string' }, currency: { type: 'string', default: 'USD' }, json: { type: 'boolean', default: false } });
      if (!['task', 'day', 'realm', 'route'].includes(values.by as string)) die('--by must be task, day, realm or route');
      const root = (values.dir as string) || process.env.TAB_PROOFS || join(TAB_HOME, 'receipts');
      const rep = costReport(root, { by: values.by as CostBy, since: values.since as string | undefined, task: values.task as string | undefined, currency: values.currency as string });
      if (values.json) { console.log(JSON.stringify(rep, null, 2)); return; }
      const f = (n: number) => formatAmount(n, rep.currency);
      if (!rep.rows.length) { console.log(`no paid calls in ${root}${values.since ? ` since ${values.since}` : ''}`); return; }
      const w = Math.min(Math.max(...rep.rows.map((r) => r.key.length), 8), 60);
      console.log(`${String(values.by).padEnd(w)}  ${'calls'.padStart(6)}  ${'spent'.padStart(10)}  ${'cached'.padStart(6)}  ${'saved'.padStart(10)}`);
      for (const r of rep.rows) console.log(`${r.key.slice(0, 60).padEnd(w)}  ${String(r.calls).padStart(6)}  ${f(r.spent).padStart(10)}  ${String(r.cached).padStart(6)}  ${f(r.saved).padStart(10)}`);
      console.log(`${'total'.padEnd(w)}  ${String(rep.total.calls).padStart(6)}  ${f(rep.total.spent).padStart(10)}  ${String(rep.total.cached).padStart(6)}  ${f(rep.total.saved).padStart(10)}`);
      return;
    }

    case 'topup': {
      const { values, positionals } = opts(rest, { gateway: { type: 'string', default: PUBLIC_GATEWAY }, owner: { type: 'string' }, wait: { type: 'string', default: '900' } }, true);
      if (positionals.length !== 1 || !/^\d{1,3}$/.test(positionals[0])) die('usage: tab topup <dollars> [--gateway url] [--owner owner.json] [--wait 900]');
      const gateway = (values.gateway as string).replace(/\/$/, '');
      const wallet = resolvePublicKey((values.owner as string) || join(TAB_HOME, 'owner.json'));
      const out = await postJson(`${gateway}/.well-known/tab/topup`, { wallet, usd: Number(positionals[0]) });
      if (out.status !== 201) die(String(out.doc.error ?? `HTTP ${out.status}`));
      console.log(`Pay $${positionals[0]} by card here (Stripe's page; nothing about the card reaches tab):\n\n  ${out.doc.pay}\n`);
      const deadline = Date.now() + Number(values.wait) * 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3_000));
        try {
          const st = (await (await fetch(String(out.doc.status), { signal: AbortSignal.timeout(10_000) })).json()) as { state?: string; balance?: string };
          if (st.state === 'paid') { console.log(`paid: your wallet at ${new URL(gateway).host} now holds $${st.balance}`); return; }
        } catch { /* keep waiting */ }
      }
      console.log(`not paid yet; the credit lands when it is: ${out.doc.status}`);
      return;
    }

    case 'stats': {
      const { values } = opts(rest, { db: { type: 'string' }, gateway: { type: 'string' }, catalog: { type: 'string' }, 'catalog-db': { type: 'string' }, days: { type: 'string', default: '30' }, 'house-ip': { type: 'string', multiple: true }, 'house-owner': { type: 'string', multiple: true }, json: { type: 'boolean', default: false } });
      if (values.catalog || values['catalog-db']) {
        // 3.3: the site funnel, from the catalog that serves the site, or read from its database on the box
        let doc: { days: number; site: Array<{ step: string; detail: string; visitors: number; events: number }> };
        const where = (values.catalog ?? values['catalog-db']) as string;
        if (values['catalog-db']) {
          const cs = new CatalogStore(values['catalog-db'] as string);
          doc = siteReport(cs, Number(values.days) || 30, (values['house-ip'] as string[] | undefined) ?? []);
        } else {
          const token = process.env.TAB_STATS_TOKEN;
          if (!token) die('reading a catalog\'s stats takes its token in TAB_STATS_TOKEN');
          const r = await fetch(`${(values.catalog as string).replace(/\/$/, '')}/v1/stats?days=${Number(values.days) || 30}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
          if (!r.ok) die(`HTTP ${r.status}`);
          doc = (await r.json()) as typeof doc;
        }
        if (values.json) { console.log(JSON.stringify(doc, null, 2)); return; }
        console.log(`${where}, last ${doc.days} days, outside visitors a day, summed`);
        for (const step of ['page', 'ref', 'referer', 'search', 'try', 'announce']) {
          const rows = doc.site.filter((x) => x.step === step);
          if (!rows.length) continue;
          const total = rows.reduce((a, x) => a + x.visitors, 0);
          console.log(`  ${step.padEnd(9)} ${String(total).padStart(6)}`);
          for (const x of rows.slice(0, step === 'search' ? 15 : 10)) if (x.detail) console.log(`    ${x.detail.slice(0, 48).padEnd(48)} ${String(x.visitors).padStart(5)}`);
        }
        return;
      }
      let report: UsageReport;
      if (values.db) {
        const store = new Store(values.db as string);
        report = usageStats(store, { days: Number(values.days) || 30, houseIps: (values['house-ip'] as string[] | undefined) ?? [], houseOwners: (values['house-owner'] as string[] | undefined) ?? [], realm: values.db as string, listings: store.listings().length });
        store.close();
      } else if (values.gateway) {
        const token = process.env.TAB_STATS_TOKEN;
        if (!token) die('reading a gateway\'s stats takes its token in TAB_STATS_TOKEN');
        const r = await fetch(`${(values.gateway as string).replace(/\/$/, '')}/.well-known/tab/stats?days=${Number(values.days) || 30}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000) });
        if (!r.ok) die(`HTTP ${r.status}`);
        report = (await r.json()) as UsageReport;
      } else die('usage: tab stats (--db pay.db [--house-ip ip]... | --gateway url | --catalog url | --catalog-db catalog.db [--house-ip ip]...) [--days 30] [--json]');
      if (values.json) { console.log(JSON.stringify(report, null, 2)); return; }
      const o = report.outside;
      console.log(`${report.realm}, last ${report.days} days`);
      console.log(`  outside users   ${o.owners} paying owners, ${o.calls} calls, $${o.spend}`);
      console.log(`  outside claims  ${o.claims} starter-credit claims from ${o.claim_addresses} addresses, ${o.claimed_never_paid} never paid`);
      console.log(`  house           ${report.house.owners} owners, ${report.house.calls} calls, $${report.house.spend}`);
      console.log(`  listings        ${report.listings}`);
      for (const t of o.top.slice(0, 10)) console.log(`    ${t.owner}  ${String(t.calls).padStart(5)} calls  $${t.spend.padStart(8)}  ${t.first.slice(0, 10)} to ${t.last.slice(0, 10)}`);
      const f = report.funnel;
      if (f) {
        console.log('  funnel          outside visitors a day, summed (one visitor on three days counts 3)');
        for (const s of f.steps) console.log(`    ${s.step.padEnd(10)} ${String(s.visitors).padStart(6)}`);
        if (f.refused.length) console.log(`  refused         ${f.refused.map((r) => `${r.code} ${r.events}`).join(', ')}`);
        if (f.clients.length) console.log(`  clients         ${f.clients.map((c) => `${c.client} ${c.visitors}`).join(', ')}`);
        for (const r of f.routes.slice(0, 8)) console.log(`    ${r.route.slice(0, 48).padEnd(48)} asked ${String(r.challenged).padStart(4)}  paid ${String(r.paid).padStart(4)}`);
        for (const x of f.other.slice(0, 8)) console.log(`    ${x.step} ${x.detail} ${x.visitors} visitors, ${x.events} times`);
      }
      return;
    }

    case 'log': {
      const sub = rest[0];
      if (sub !== 'head' && sub !== 'check') die('usage: tab log head|check [--gateway url]...');
      const { values } = opts(rest.slice(1), { gateway: { type: 'string', multiple: true } });
      const gateways = ((values.gateway as string[] | undefined) ?? [PUBLIC_GATEWAY]).map((g) => g.replace(/\/$/, ''));
      const seenFile = join(TAB_HOME, 'log-heads.json');
      const seen: Record<string, TreeHead> = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : {};
      let bad = false;
      for (const g of gateways) {
        const key = await publishedReceiptKey(new URL(g).host).catch(() => null);
        const head = ((await (await fetch(`${g}/.well-known/tab/log`, { signal: AbortSignal.timeout(15_000) })).json()) as { head?: TreeHead }).head;
        if (!head || !verifyTreeHead(head, key ?? undefined)) { console.log(`${g}: the log head is ${head ? 'not signed by the gateway\'s receipt key' : 'missing (a gateway before 3.2)'}`); bad = bad || !!head; continue; }
        const prev = seen[g];
        if (sub === 'head' || !prev) {
          console.log(`${g}: ${head.size} receipts, root ${head.root}, signed ${head.at}${prev ? '' : sub === 'check' ? ' (first look: kept, the next check proves nothing was rewritten)' : ''}`);
          if (sub === 'check') seen[g] = head;
          continue;
        }
        if (head.size < prev.size) { console.log(`${g}: LOG SHRANK from ${prev.size} to ${head.size} receipts. Keep both heads as evidence:\n  before ${JSON.stringify(prev)}\n  now    ${JSON.stringify(head)}`); bad = true; continue; }
        const proof = (await (await fetch(`${g}/.well-known/tab/log/consistency?from=${prev.size}&size=${head.size}`, { signal: AbortSignal.timeout(30_000) })).json()) as { proof?: string[]; head?: TreeHead };
        const now = proof.head && verifyTreeHead(proof.head, key ?? undefined) ? proof.head : head;
        const ok = Array.isArray(proof.proof) && verifyConsistency(prev.size, now.size, proof.proof.map(unb64), unb64(prev.root), unb64(now.root));
        if (!ok) { console.log(`${g}: the log was REWRITTEN: no proof joins the head of ${prev.at} (${prev.size}) to now (${now.size}). Keep both heads as evidence:\n  before ${JSON.stringify(prev)}\n  now    ${JSON.stringify(now)}`); bad = true; continue; }
        console.log(`${g}: ${prev.size} to ${now.size} receipts, nothing before was changed`);
        seen[g] = now;
      }
      mkdirSync(TAB_HOME, { recursive: true, mode: 0o700 });
      writeFileSync(seenFile, JSON.stringify(seen, null, 2) + '\n');
      process.exit(bad ? 1 : 0);
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
/** 3.2: a gateway's inclusion proof for a receipt, or null when it has none (a gateway before 3.2). */
async function fetchLogProof(origin: string, receiptId: string): Promise<LogProof | null> {
  try {
    const r = await fetch(`${origin}/.well-known/tab/log/proof?receipt=${encodeURIComponent(receiptId)}`, { signal: AbortSignal.timeout(15_000) });
    return r.ok ? ((await r.json()) as LogProof) : null;
  } catch {
    return null;
  }
}

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
  demo?: boolean; // 3.3: make one first call (free where the gateway offers it) and check its proof
}

/** 3.3: the call `tab init` makes so the first thing a new user sees is a purchase that worked and a proof that holds. */
export const DEMO_PATH = '/wikipedia/api/rest_v1/page/summary/HTTP_402';

async function demoCall(o: { gateway: string; agent: KeyPair; mandate: Mandate; dir: string; say: (m: string) => void }): Promise<void> {
  const url = o.gateway + DEMO_PATH;
  try {
    const client = new TabClient({ agent: o.agent, mandate: o.mandate });
    const res = await client.fetch(url, { signal: AbortSignal.timeout(20_000) });
    const bytes = new Uint8Array(await res.arrayBuffer());
    const receipt = receiptOf(res);
    if (!res.ok || !receipt) { o.say(`first call  ${url} answered ${res.status}; tab doctor says why`); return; }
    const kept = saveProof(process.env.TAB_PROOFS || join(o.dir, 'receipts'), { url, method: 'GET', task: 'tab init' }, { status: res.status, contentType: res.headers.get('content-type') }, bytes, receipt, o.mandate);
    let title = '';
    try { title = String((JSON.parse(Buffer.from(bytes).toString('utf8')) as { title?: string }).title ?? ''); } catch { /* not JSON */ }
    const paid = receipt.free ? 'free' : `paid ${formatAmount(Number(receipt.amount), receipt.currency)}`;
    o.say(`first call  ${title ? `Wikipedia "${title}"` : DEMO_PATH}, ${paid}, signed receipt`);
    if (!kept) return;
    const report = await verifyProof(kept.dir, { publishedKey: publishedReceiptKey, logProof: fetchLogProof });
    const failedChecks = report.checks.filter((c) => c.ok === false).map((c) => c.name);
    o.say(report.ok ? `proof       ${kept.dir}: holds (gateway key, body, request, your agent's signature${report.checks.some((c) => c.name.includes('log') && c.ok) ? ', public log' : ''})` : `proof       ${kept.dir}: does NOT hold (${failedChecks.join(', ')})`);
  } catch (err) {
    o.say(`first call  could not make it (${(err as Error).message}); tab doctor says why`);
  }
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

  if (o.demo && available !== null) await demoCall({ gateway: o.gateway, agent, mandate, dir: o.dir, say });

  if (o.brief) return;
  say(`
owner wallet  ${owner.publicKey}
agent wallet  ${agent.publicKey}

Claude Code (once, for every project; it sets itself up from here, even without init):

  claude mcp add --scope user tab -- npx -y ${RELEASE_TGZ} mcp

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
  const sub = rest[0] === 'list' || rest[0] === 'remove' || rest[0] === 'stats' ? rest[0] : 'add';
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
    free: { type: 'string' },
    notify: { type: 'string' },
    'notify-ntfy': { type: 'boolean', default: false },
    days: { type: 'string', default: '30' },
    'dry-run': { type: 'boolean', default: false },
  }, true);
  const gateway = (values.gateway as string).replace(/\/$/, '');
  if (sub === 'stats') {
    // 3.2: what your listings earned, signed with your seller key so only you see your buyers
    const seller = sellerKey(values.key as string | undefined);
    const disc = await gatewayDoc(gateway);
    const at = new Date().toISOString();
    const sig = signBytes(seller, sellerStatsMessage(disc.realm, seller.publicKey, at));
    const r = await fetch(`${gateway}/.well-known/tab/seller/stats?seller=${seller.publicKey}&at=${encodeURIComponent(at)}&sig=${sig}&days=${Number(values.days) || 30}`, { signal: AbortSignal.timeout(15_000) });
    const doc = (await r.json()) as any;
    if (!r.ok) die(doc.error ?? `HTTP ${r.status}`);
    console.log(`${disc.realm}, last ${doc.days} days: $${doc.total} from ${doc.calls} paid calls; wallet holds $${doc.balance}${doc.first_sale ? `; first sale ${doc.first_sale.slice(0, 10)}` : ''}`);
    for (const l of doc.listings) {
      console.log(`\n  ${l.slug}  ${l.calls} calls  $${l.earned}`);
      for (const rt of l.routes) console.log(`    ${rt.method.padEnd(5)} ${rt.path.padEnd(28)} ${rt.price.padStart(6)}${rt.free_per_day ? `  ${rt.free_per_day} free a day` : ''}${rt.stats ? `  ${Math.round(rt.stats.ok_rate * 100)}% ok of ${rt.stats.calls_7d} this week${rt.stats.avg_ms ? `, ${rt.stats.avg_ms} ms` : ''}` : ''}`);
    }
    if (doc.top_buyers?.length) console.log(`\n  top buyers: ${doc.top_buyers.map((b: any) => `${b.owner} $${b.paid} (${b.calls})`).join(', ')}`);
    if (doc.referrals) console.log(`  referrals: ${doc.referrals.buyers} buyers, $${doc.referrals.earned} earned`);
    return;
  }
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
  // 3.2: free calls per buyer per day on every route, and who to tell about sales
  if (values.free !== undefined) {
    const n = Number(values.free);
    if (!Number.isInteger(n) || n < 1 || n > LISTING_LIMITS.maxFreePerDay) die(`--free must be 1 to ${LISTING_LIMITS.maxFreePerDay} calls a day`);
    routes = routes.map((r) => ({ ...r, free_per_day: n }));
  }
  let notify = values.notify as string | undefined;
  if (!notify && values['notify-ntfy']) notify = `https://ntfy.sh/tab-sales-${randomBytes(9).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  name ??= new URL(upstream).hostname.replace(/^(api|www|mcp)\./, '');
  const slug = (values.slug as string) || slugOf(name);
  if (values['dry-run']) {
    // 3.3: what would be listed and what buyers would see, before anything is sent
    console.log(sellPreview({ realm: disc.realm, gateway, slug, name, upstream, routes, mcp: !!values.mcp, description: values.description as string | undefined, rail: String(disc.rail ?? 'ledger'), paidTo: evmPayout ?? seller.publicKey }));
    return;
  }
  const listing = signListing(seller, {
    realm: disc.realm, slug, name, upstream, routes,
    ...(values.description ? { description: values.description as string } : {}),
    ...(values.mcp ? { mcp: true } : {}),
    ...(evmPayout ? { evm_payout: evmPayout } : {}),
    ...(notify ? { notify } : {}),
  });
  const out = (await postSigned(gateway + LISTING_PATH, listing)) as { url: string; routes: Array<{ method: string; url: string; price: string; mcp_tool?: string }>; paid_to: string };
  console.log(`listed at ${out.url}, paid to ${out.paid_to}\n`);
  for (const r of out.routes) console.log(`  ${r.method.padEnd(6)} ${r.url}  ${r.price}${r.mcp_tool ? `  (tool ${r.mcp_tool})` : ''}`);
  console.log(`
Any agent with tab can buy it now:
  tab fetch ${values.mcp ? '-d \'{...tool arguments}\' ' : ''}${out.routes[0].url}
${values.mcp ? '  claude mcp add ' + slug + ' -- npx -y ' + RELEASE_TGZ + ' mcp connect ' + out.url + '\n' : ''}It shows in the catalog (paidwithtab.com/catalog) within a minute. Earnings: tab sell stats, and ${disc.rail === 'evm' ? 'your 0x address on chain' : `${gateway}/.well-known/tab/wallet/${seller.publicKey}`}.${values.free ? `\nEach buyer gets ${values.free} free calls a day per route.` : ''}${notify ? `\nSales notices go to ${notify}${new URL(notify).hostname === 'ntfy.sh' ? ` (subscribe to ${new URL(notify).pathname.slice(1)} in the ntfy app)` : ''}.` : ''}`);
}

/** 3.3: `tab sell --dry-run`: the listing as buyers would find it, what it earns, and the rules it is paid under. */
export function sellPreview(o: { realm: string; gateway: string; slug: string; name: string; upstream: string; routes: ListingRoute[]; mcp: boolean; description?: string; rail: string; paidTo: string }): string {
  const base = `${o.gateway}/s/${o.slug}`;
  const lines = [
    `dry run: nothing was listed. This is what ${o.realm} would publish.`,
    '',
    `  ${o.name}${o.description ? `: ${o.description}` : ''}`,
    `  ${base}   upstream ${o.upstream}${o.mcp ? ' (MCP server)' : ''}`,
    `  paid to ${o.paidTo}${o.rail === 'evm' ? ' (USDG on chain, per call)' : ' (credits that spend on this gateway; list with --gateway https://mainnet.paidwithtab.com to be paid USDG on chain)'}`,
    '',
    '  route                                    price   per 1,000 calls',
  ];
  for (const r of o.routes) {
    const per1000 = (Number(r.price) * 1000).toFixed(2);
    lines.push(`  ${`${r.method} ${r.path}`.slice(0, 40).padEnd(40)} ${String(r.price).padStart(6)}   $${per1000}${r.free_per_day ? `  (${r.free_per_day} free a day per buyer)` : ''}`);
    if (r.description) lines.push(`      ${r.description.replace(/\s+/g, ' ').slice(0, 100)}`);
  }
  lines.push(
    '',
    '  Buyers find it in tab_search and paidwithtab.com/catalog by the words in its name and descriptions.',
    `  You keep the whole price. A call is charged only when ${o.mcp ? 'the tool succeeds: a result with isError: true comes back as a 422 and' : 'your API answers 2xx: any other status'} costs the buyer nothing.`,
    '  Run it again without --dry-run to list it.',
  );
  return lines.join('\n');
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
