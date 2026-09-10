// On-chain checks against a local validator (or any cluster) at SOLANA_RPC.
// Start one first, e.g.: solana-test-validator --reset --quiet &
//   npm run test:solana

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { newKeyPair, saveKey, pubBytes } from '../src/keys.js';
import { usdToMicro, signCredential, encodeCredentialHeader, parseChallengeHeader } from '../src/protocol.js';
import { issueMandate } from '../src/mandate.js';
import { Store } from '../src/store.js';
import { createGateway, type Spec } from '../src/gateway.js';
import { TabClient, receiptOf } from '../src/client.js';
import { buildSignedPaymentTx } from '../src/solana/pay.js';
import { b58encode, b58decode, b58decode32 } from '../src/solana/base58.js';
import { onCurve, ata } from '../src/solana/pda.js';
import { shortvecEncode, shortvecDecode } from '../src/solana/tx.js';
import { SolanaRpc } from '../src/solana/rpc.js';
import { makeMint } from '../examples/make-mint.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const RPC_URL = process.env.SOLANA_RPC || 'http://127.0.0.1:8899';
const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-sol-'));
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));

function cli(...args: string[]): string {
  return execFileSync(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args],
    { encoding: 'utf8', env: { ...process.env, SOLANA_RPC: RPC_URL } },
  ).trim();
}

async function main(): Promise<void> {
  const rpc = new SolanaRpc(RPC_URL);
  try {
    await rpc.getLatestBlockhash();
  } catch {
    console.error(`no validator answering at ${RPC_URL} — start one (see examples/demo-solana.sh)`);
    process.exit(1);
  }

  // -- 1. offline primitives ------------------------------------------------

  check('base58 roundtrip with leading zeros', b58encode(b58decode('11ABC')).startsWith('11')
    && b58encode(b58decode32('So11111111111111111111111111111111111111112')) === 'So11111111111111111111111111111111111111112');
  const sv = shortvecEncode(300);
  check('shortvec roundtrip', shortvecDecode(sv, 0)[0] === 300 && shortvecDecode(Uint8Array.of(5), 0)[0] === 5);

  const seller = newKeyPair();
  const owner = newKeyPair();
  const agent = newKeyPair();
  const feePayer = newKeyPair();
  const usdcMintLike = b58decode32('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  check('ed25519 pubkeys on curve, PDAs off curve',
    onCurve(pubBytes(owner.publicKey)) && !onCurve(ata(pubBytes(owner.publicKey), usdcMintLike)));

  for (const [name, pair] of [['seller', seller], ['owner', owner], ['agent', agent], ['feepayer', feePayer]] as const) {
    saveKey(join(scratch, `${name}.json`), pair);
  }
  const owner58 = b58encode(pubBytes(owner.publicKey));
  check('tab solana address', cli('solana', 'address', join(scratch, 'owner.json')) === owner58);

  // -- 2. fund everyone, fabricate the stablecoin ---------------------------

  cli('solana', 'airdrop', '--wallet', join(scratch, 'feepayer.json'), '--sol', '2');
  cli('solana', 'airdrop', '--wallet', join(scratch, 'owner.json'), '--sol', '2');
  check('airdrops landed', (await rpc.getBalance(b58encode(pubBytes(feePayer.publicKey)))) >= 1_000_000_000n
    && (await rpc.getBalance(owner58)) >= 1_000_000_000n);

  const mint58 = await makeMint(rpc, owner, owner.publicKey, '100.00');
  const mint = b58decode32(mint58);
  const ownerAta58 = b58encode(ata(pubBytes(owner.publicKey), mint));
  check('mint fabricated, owner funded 100.00', (await rpc.tokenBalance(ownerAta58)) === 100_000_000n);

  // -- 3. the on-chain half of the mandate: delegation ----------------------

  cli('solana', 'approve', '--owner', join(scratch, 'owner.json'), '--agent', join(scratch, 'agent.json'),
    '--amount', '0.03', '--mint', mint58);
  const accAfterApprove = await rpc.getTokenAccount(ownerAta58);
  check('delegate and amount recorded on chain', accAfterApprove?.delegate === b58encode(pubBytes(agent.publicKey))
    && accAfterApprove?.delegatedAmount === 30_000n);
  const balOut = JSON.parse(cli('solana', 'balance', '--wallet', join(scratch, 'owner.json'), '--mint', mint58));
  check('tab solana balance shows the delegation', balOut.amount === '100.00' && balOut.delegated_amount === '0.03');

  // -- 4. a solana gateway in front of a demo upstream ----------------------

  const upstream = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/boom') { res.writeHead(500); res.end('{"error":"boom"}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path, payer: req.headers['tab-payer'] ?? null }));
  });
  const upPort = await listen(upstream);
  const spec: Spec = {
    realm: 'quotes.local',
    recipient: seller.publicKey,
    rail: 'solana',
    solana: { rpc: RPC_URL, mint: mint58, decimals: 6, fee_payer: join(scratch, 'feepayer.json') },
    public_receipts: true,
    services: [{
      name: 'demo', prefix: '', upstream: `http://127.0.0.1:${upPort}`,
      routes: [
        { method: 'GET', path: '/quote', price: '0.01', description: 'a quote' },
        { method: 'GET', path: '/premium', price: '0.02', description: 'pricier' },
        { method: 'GET', path: '/boom', price: '0.01', description: 'always fails' },
        { method: 'GET', path: '/free', price: '0', description: 'free' },
      ],
    }],
  };
  const store = new Store(join(scratch, 'tab-solana.db'));
  const gateway = createGateway(spec, { store });
  const gwPort = await listen(gateway);
  const GW = `http://127.0.0.1:${gwPort}`;

  const disc = await (await fetch(`${GW}/.well-known/tab`)).json() as any;
  check('discovery: solana rail with mint and fee payer', disc.rail === 'solana'
    && disc.rail_info.mint === mint58 && disc.rail_info.fee_payer === b58encode(pubBytes(feePayer.publicKey)));

  const c402 = await fetch(`${GW}/quote`);
  const chal = parseChallengeHeader(c402.headers.get('www-authenticate'))!;
  check('402 challenge carries the solana rail info', c402.status === 402 && chal.rail === 'solana'
    && chal.solana?.mint === mint58 && chal.solana?.decimals === 6
    && typeof chal.solana?.recent_blockhash === 'string' && b58decode(chal.solana!.recent_blockhash).length === 32);

  const mandate = issueMandate(owner, {
    agent: agent.publicKey, budgetUsd: '1.00', window: 'day', maxPerCallUsd: '0.02', allow: ['quotes.local'], days: 30,
  });
  const client = new TabClient({ agent, mandate, maxPerCallUsd: '0.015' });

  const sellerAta58 = b58encode(ata(pubBytes(seller.publicKey), mint));
  const paid = await client.fetch(`${GW}/quote`);
  const receipt = receiptOf(paid);
  check('paid call settles on chain', paid.status === 200 && receipt !== null && receipt.ref.startsWith('solana:'));
  check('recipient ATA credited, owner debited', (await rpc.tokenBalance(sellerAta58)) === 10_000n
    && (await rpc.tokenBalance(ownerAta58)) === 100_000_000n - 10_000n);
  const accAfterPay = await rpc.getTokenAccount(ownerAta58);
  check('delegated amount decremented on chain', accAfterPay?.delegatedAmount === 20_000n);

  const freeRes = await fetch(`${GW}/free`);
  check('free route needs no payment on the solana rail', freeRes.status === 200 && receiptOf(freeRes) === null);

  // -- 5. voids broadcast nothing -------------------------------------------

  const sellerBefore = await rpc.tokenBalance(sellerAta58);
  const delegatedBefore = (await rpc.getTokenAccount(ownerAta58))!.delegatedAmount;
  const boom = await client.fetch(`${GW}/boom`);
  check('upstream failure: passed through, voided', boom.status === 500 && boom.headers.get('tab-void') !== null && receiptOf(boom) === null);
  check('nothing was broadcast for the voided call', (await rpc.tokenBalance(sellerAta58)) === sellerBefore
    && (await rpc.getTokenAccount(ownerAta58))!.delegatedAmount === delegatedBefore);

  // -- 6. bad credentials ---------------------------------------------------

  const freshChal = async (path = '/quote') =>
    parseChallengeHeader((await fetch(`${GW}${path}`)).headers.get('www-authenticate'))!;

  let chalA = await freshChal();
  const noTx = await fetch(`${GW}/quote`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, chalA, mandate)) } });
  check('credential without a transaction is malformed', noTx.status === 402
    && ((await noTx.json()) as any).type === 'urn:tab:problem:malformed-credential');

  chalA = await freshChal();
  const wrongAmount = { ...chalA, amount: '1' };
  const tamperedTx = buildSignedPaymentTx(wrongAmount, mandate.owner, agent);
  const tampered = await fetch(`${GW}/quote`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, chalA, mandate, { solana: { tx: tamperedTx } })) } });
  check('transaction not matching the challenge is rejected', tampered.status === 402
    && ((await tampered.json()) as any).type === 'urn:tab:problem:verification-failed');

  chalA = await freshChal();
  const goodCred = encodeCredentialHeader(signCredential(agent, chalA, mandate, { solana: { tx: buildSignedPaymentTx(chalA, mandate.owner, agent) } }));
  const ok1 = await fetch(`${GW}/quote`, { headers: { authorization: goodCred } });
  const ok2 = await fetch(`${GW}/quote`, { headers: { authorization: goodCred } });
  check('challenge redeems once on the solana rail', ok1.status === 200 && ok2.status === 402
    && ((await ok2.json()) as any).type === 'urn:tab:problem:invalid-challenge');

  const capRes = await client.fetch(`${GW}/premium`).catch((e) => e);
  check('client cap blocks the pricier route before paying', capRes?.name === 'PaymentRefused' || capRes?.status === 402);

  // -- 7. the delegation is a hard cap --------------------------------------

  // 0.03 approved; 0.01 + 0.01 spent so far. One more 0.01 fits, the next does not.
  const fits = await client.fetch(`${GW}/quote`);
  check('third payment exhausts the delegation', fits.status === 200
    && (await rpc.getTokenAccount(ownerAta58))!.delegatedAmount === 0n);
  const broke = await client.fetch(`${GW}/quote`);
  check('exhausted delegation is insufficient-funds', broke.status === 402
    && ((await broke.json()) as any).type === 'urn:tab:problem:insufficient-funds');

  cli('solana', 'approve', '--owner', join(scratch, 'owner.json'), '--agent', join(scratch, 'agent.json'),
    '--amount', '1.00', '--mint', mint58);
  const reup = await client.fetch(`${GW}/quote`);
  check('re-approval restores spending', reup.status === 200);

  cli('solana', 'revoke', '--owner', join(scratch, 'owner.json'), '--mint', mint58);
  const revoked = await client.fetch(`${GW}/quote`);
  check('revoke clears the delegate and ends spending', (await rpc.getTokenAccount(ownerAta58))!.delegate === null
    && revoked.status === 402
    && ((await revoked.json()) as any).type === 'urn:tab:problem:insufficient-funds');

  // -- 8. gateway surfaces on this rail -------------------------------------

  const wallet = await (await fetch(`${GW}/.well-known/tab/wallet/${owner.publicKey}`)).json() as any;
  check('wallet endpoint reads the chain', wallet.micro === Number(await rpc.tokenBalance(ownerAta58)));
  const recs = await (await fetch(`${GW}/.well-known/tab/receipts`)).json() as any;
  check('receipts carry solana refs', recs.receipts.length >= 4
    && recs.receipts.every((r: any) => r.ref.startsWith('solana:')));

  gateway.close();
  upstream.close();
  store.close();
  rmSync(scratch, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
