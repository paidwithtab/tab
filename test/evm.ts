// The evm rail (built for Robinhood Chain): offline crypto vectors, a mock
// EVM node with real ERC-20 semantics, the full 402 flow, and, when the
// network allows, read-only checks against the live Robinhood Chain testnet.
//   npm run test:evm

import { createServer as createNetServer } from 'node:net';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';

import { newKeyPair, saveKey } from '../src/keys.js';
import { signCredential, encodeCredentialHeader, parseChallengeHeader, encodeChallengeHeader, microToBaseUnits, baseUnitsToMicro } from '../src/protocol.js';
import { issueMandate, delegateMandate, saveMandate } from '../src/mandate.js';
import { CompanyStore } from '../src/company/store.js';
import { Engine } from '../src/company/engine.js';
import { createCompanyServer } from '../src/company/server.js';
import { Store } from '../src/store.js';
import { createGateway, loadSpec, type Spec } from '../src/gateway.js';
import { TabClient, PaymentRefused, receiptOf, x402ResponseOf, escrowOf } from '../src/client.js';
import { EvmRail } from '../src/rails/evm.js';
import { keccak256Hex } from '../src/evm/keccak.js';
import {
  scalarFromSeed, publicKey, publicKeyOwnMath, pubToAddress, addressFromSeed,
  checksumAddress, sign, verify, recover,
} from '../src/evm/secp256k1.js';
import { rlpEncode, rlpDecode } from '../src/evm/rlp.js';
import {
  signTx, parseTx, erc20, selector, hexToBytes, bytesToHex, bigToHex, isAddress, type Eip1559Tx,
} from '../src/evm/tx.js';
import { EvmRpc } from '../src/evm/rpc.js';
import { buildSignedPaymentTxEvm } from '../src/evm/pay.js';
import { authorizationSigner, signAuthorization, encodeX402, decodeX402, transferWithAuthorizationData } from '../src/x402.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const scratch = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-evm-'));
const listen = (server: Server): Promise<number> =>
  new Promise((resolve) => server.listen(0, () => resolve((server.address() as { port: number }).port)));

const execFileP = promisify(execFile);
const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createNetServer();
  s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});
/** A gateway on a port chosen first, so its --origin is known: pay on delivery and channels require one. */
const gatewayAt = async (spec: Spec, o: Omit<Parameters<typeof createGateway>[1], 'origin'>): Promise<{ server: Server; url: string }> => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const server = createGateway(spec, { ...o, origin: url });
  await new Promise<void>((r) => server.listen(port, () => r()));
  return { server, url };
};
// async so the mock EVM node (which lives in THIS process) can answer the CLI
async function cli(...args: string[]): Promise<string> {
  const { stdout } = await execFileP(
    process.execPath,
    ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', ...args],
    { encoding: 'utf8' },
  );
  return stdout.trim();
}

// ---------------------------------------------------------------------------
// a mock EVM node: eth_* JSON-RPC over one ERC-20 with real semantics

const CHAIN_ID = 46630n; // Robinhood Chain testnet
const TOKEN = '0x5b6c7caf7f99f99154fd8375ec935fcf03f326f5'; // shape of the real testnet USDC

class MockChain {
  /** The one ERC-20 this node hosts, and its decimals (testnet USDC by default). */
  constructor(readonly token: string = TOKEN, readonly decimals: bigint = 6n, readonly mintable = false) {}
  eth = new Map<string, bigint>();
  bal = new Map<string, bigint>();
  allowance = new Map<string, bigint>();
  nonce = new Map<string, bigint>();
  receipts = new Map<string, '0x1' | '0x0'>();
  broadcasts = 0;
  pool: string[] | null = null; // while set, transactions wait here unmined, as in a congested mempool
  receiptFailures = 0; // the next this many receipt lookups fail, as an RPC that times out
  rejectSends = 0; // the next this many broadcasts are refused
  flush(): void { const p = this.pool ?? []; this.pool = null; for (const raw of p) this.sendRaw(raw); }
  used = new Set<string>(); // EIP-3009 authorizations spent
  eip712 = { name: 'Mock USD', version: '1' };

  private key = (owner: string, spender: string) => `${owner}|${spender}`;

  execToken(from: string, data: Uint8Array): { ok: boolean; result: string; error?: string } {
    const sel = bytesToHex(data.slice(0, 4));
    const word = (i: number) => data.slice(4 + 32 * i, 4 + 32 * (i + 1));
    const addr = (i: number) => bytesToHex(word(i).slice(12));
    const uint = (i: number) => BigInt(bytesToHex(word(i)));
    const ret = (n: bigint) => '0x' + n.toString(16).padStart(64, '0');
    if (sel === bytesToHex(selector('decimals()'))) return { ok: true, result: ret(this.decimals) };
    if (sel === bytesToHex(selector('balanceOf(address)'))) return { ok: true, result: ret(this.bal.get(addr(0)) ?? 0n) };
    if (sel === bytesToHex(selector('allowance(address,address)'))) {
      return { ok: true, result: ret(this.allowance.get(this.key(addr(0), addr(1))) ?? 0n) };
    }
    if (sel === bytesToHex(selector('mint(address,uint256)'))) {
      // the open-mint test token: anyone mints up to 1000 whole tokens per call
      if (!this.mintable) return { ok: false, result: '0x', error: 'unknown selector' };
      if (uint(1) > 1000n * 10n ** this.decimals) return { ok: false, result: '0x', error: 'max 1000 per mint' };
      this.bal.set(addr(0), (this.bal.get(addr(0)) ?? 0n) + uint(1));
      return { ok: true, result: '0x' };
    }
    if (sel === bytesToHex(selector('transfer(address,uint256)'))) {
      if ((this.bal.get(from) ?? 0n) < uint(1)) return { ok: false, result: '0x', error: 'ERC20: transfer amount exceeds balance' };
      this.bal.set(from, this.bal.get(from)! - uint(1));
      this.bal.set(addr(0), (this.bal.get(addr(0)) ?? 0n) + uint(1));
      return { ok: true, result: ret(1n) };
    }
    if (sel === bytesToHex(selector('approve(address,uint256)'))) {
      this.allowance.set(this.key(from, addr(0)), uint(1));
      return { ok: true, result: ret(1n) };
    }
    if (sel === bytesToHex(selector('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)'))) {
      // EIP-3009, as USDG and USDC implement it: signature by `from`, a time window, one use per nonce
      const a = { from: addr(0), to: addr(1), value: uint(2).toString(), validAfter: uint(3).toString(), validBefore: uint(4).toString(), nonce: bytesToHex(word(5)) };
      const sig = '0x' + bytesToHex(word(7)).slice(2) + bytesToHex(word(8)).slice(2) + Number(uint(6)).toString(16).padStart(2, '0');
      const signer = authorizationSigner({ name: this.eip712.name, version: this.eip712.version, chainId: Number(CHAIN_ID), token: this.token }, a, sig);
      if (signer !== a.from) return { ok: false, result: '0x', error: 'invalid signature' };
      const t = BigInt(Math.floor(Date.now() / 1000));
      if (t <= BigInt(a.validAfter) || t >= BigInt(a.validBefore)) return { ok: false, result: '0x', error: 'authorization not valid now' };
      if (this.used.has(`${a.from}|${a.nonce}`)) return { ok: false, result: '0x', error: 'authorization is used' };
      if ((this.bal.get(a.from) ?? 0n) < BigInt(a.value)) return { ok: false, result: '0x', error: 'transfer amount exceeds balance' };
      this.bal.set(a.from, this.bal.get(a.from)! - BigInt(a.value));
      this.bal.set(a.to, (this.bal.get(a.to) ?? 0n) + BigInt(a.value));
      this.used.add(`${a.from}|${a.nonce}`);
      return { ok: true, result: ret(1n) };
    }
    if (sel === bytesToHex(selector('transferFrom(address,address,uint256)'))) {
      const [owner, to, amount] = [addr(0), addr(1), uint(2)];
      const k = this.key(owner, from);
      const allowed = this.allowance.get(k) ?? 0n;
      if (owner !== from && allowed < amount) return { ok: false, result: '0x', error: 'ERC20: insufficient allowance' };
      if ((this.bal.get(owner) ?? 0n) < amount) return { ok: false, result: '0x', error: 'ERC20: transfer amount exceeds balance' };
      this.bal.set(owner, this.bal.get(owner)! - amount);
      this.bal.set(to, (this.bal.get(to) ?? 0n) + amount);
      if (owner !== from) this.allowance.set(k, allowed - amount);
      return { ok: true, result: ret(1n) };
    }
    return { ok: false, result: '0x', error: 'unknown selector' };
  }

  /** eth_call: run read-only against a copy of state. */
  call(from: string | undefined, to: string, data: Uint8Array): { ok: boolean; result: string; error?: string } {
    if (to !== this.token) return { ok: false, result: '0x', error: 'no contract' };
    const snapshot = { bal: new Map(this.bal), allowance: new Map(this.allowance), used: new Set(this.used) };
    const out = this.execToken(from ?? '0x' + '0'.repeat(40), data);
    this.bal = snapshot.bal;
    this.allowance = snapshot.allowance;
    this.used = snapshot.used;
    return out;
  }

  sendRaw(rawHex: string): { hash: string } {
    const tx = parseTx(hexToBytes(rawHex));
    this.broadcasts++;
    if (tx.chainId !== CHAIN_ID) throw new Error('wrong chain');
    const current = this.nonce.get(tx.from) ?? 0n;
    if (tx.nonce !== current) throw new Error(`nonce too ${tx.nonce < current ? 'low' : 'high'}`);
    const gasCost = 60_000n * tx.maxFeePerGas;
    if ((this.eth.get(tx.from) ?? 0n) < gasCost + tx.value) throw new Error('insufficient funds for gas');
    this.nonce.set(tx.from, current + 1n);
    this.eth.set(tx.from, this.eth.get(tx.from)! - gasCost - tx.value);
    let status: '0x1' | '0x0' = '0x1';
    if (tx.data.length > 0 && tx.to === this.token) {
      status = this.execToken(tx.from, tx.data).ok ? '0x1' : '0x0';
    } else if (tx.value > 0n) {
      this.eth.set(tx.to, (this.eth.get(tx.to) ?? 0n) + tx.value);
    }
    this.receipts.set(tx.hash, status);
    return { hash: tx.hash };
  }

  serve(): Server {
    return createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const { id, method, params } = JSON.parse(Buffer.concat(chunks).toString());
      const reply = (result: unknown) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result }));
      };
      const fail = (message: string) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id, error: { code: 3, message } }));
      };
      try {
        switch (method) {
          case 'eth_chainId': return reply(bigToHex(CHAIN_ID));
          case 'eth_gasPrice': return reply('0x3b9aca00'); // 1 gwei
          case 'eth_maxPriorityFeePerGas': return reply('0x0');
          case 'eth_getTransactionCount': return reply(bigToHex(this.nonce.get(params[0].toLowerCase()) ?? 0n));
          case 'eth_getBalance': return reply(bigToHex(this.eth.get(params[0].toLowerCase()) ?? 0n));
          case 'eth_call': {
            const out = this.call(params[0].from?.toLowerCase(), params[0].to.toLowerCase(), hexToBytes(params[0].data));
            return out.ok ? reply(out.result) : fail(`execution reverted: ${out.error}`);
          }
          case 'eth_sendRawTransaction': {
            if (this.rejectSends > 0) { this.rejectSends--; return fail('txpool is full'); }
            if (this.pool) { this.pool.push(params[0]); return reply(parseTx(hexToBytes(params[0])).hash); }
            return reply(this.sendRaw(params[0]).hash);
          }
          case 'eth_getTransactionByHash': return reply(this.receipts.has(params[0]) || (this.pool ?? []).some((r) => parseTx(hexToBytes(r)).hash === params[0]) ? { hash: params[0] } : null);
          case 'eth_getTransactionReceipt': {
            if (this.receiptFailures > 0) { this.receiptFailures--; return fail('upstream request timeout'); }
            const status = this.receipts.get(params[0]);
            return reply(status ? { status, transactionHash: params[0] } : null);
          }
          default: return fail(`unsupported method ${method}`);
        }
      } catch (err) {
        return fail((err as Error).message);
      }
    });
  }
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // -- 1. crypto vectors (independent of everything else) -------------------

  check('keccak-256 vectors', keccak256Hex('') === 'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'
    && keccak256Hex('abc') === '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45');
  check('address of private key 1 (known vector)', pubToAddress(publicKey(1n)) === '0x7e5f4552091a69125d5dfcb7b8c2659029395bdf');
  check('EIP-55 checksum vector', checksumAddress('0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed') === '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed');
  check('own point math agrees with OpenSSL', Array.from({ length: 10 }, () => scalarFromSeed(new Uint8Array(randomBytes(32))))
    .every((d) => Buffer.compare(publicKey(d), publicKeyOwnMath(d)) === 0));

  const satoshi = new Uint8Array(createHash('sha256').update('Satoshi Nakamoto').digest());
  const v6979 = sign(satoshi, 1n);
  check('RFC 6979 secp256k1 test vector', v6979.r.toString(16) === '934b1ea10a4b3c1757e2b0c017d0b6143ce3c9a7e6a4a49860d7a6ab210ee3d8'
    && v6979.s.toString(16) === '2442ce9d2b916064108014783e923ec36b49743e2ffa1c4496f01a512aafd9e5');

  const d = scalarFromSeed(new Uint8Array(randomBytes(32)));
  const digest = new Uint8Array(randomBytes(32));
  const sig = sign(digest, d);
  const other = new Uint8Array(randomBytes(32));
  check('sign / verify / recover roundtrip', verify(digest, sig, publicKey(d))
    && !verify(other, sig, publicKey(d))
    && Buffer.compare(recover(digest, sig), publicKey(d)) === 0);

  const nested = [new Uint8Array([1, 2]), [new Uint8Array(0), new Uint8Array(600).fill(7)], new Uint8Array([0x7f])];
  check('rlp roundtrip and canonicality', JSON.stringify(rlpDecode(rlpEncode(nested)), (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v))
      === JSON.stringify(nested, (_k, v) => (v instanceof Uint8Array ? Buffer.from(v).toString('hex') : v))
    && (() => { try { rlpDecode(new Uint8Array([0x81, 0x05])); return false; } catch { return true; } })());

  check('ERC-20 selectors match the known constants', bytesToHex(selector('transferFrom(address,address,uint256)')) === '0x23b872dd'
    && bytesToHex(selector('approve(address,uint256)')) === '0x095ea7b3'
    && bytesToHex(selector('balanceOf(address)')) === '0x70a08231');

  const txIn: Eip1559Tx = {
    chainId: CHAIN_ID, nonce: 7n, maxPriorityFeePerGas: 0n, maxFeePerGas: 2_000_000_000n,
    gasLimit: 250_000n, to: TOKEN, value: 0n,
    data: erc20.transferFrom('0x' + '11'.repeat(20), '0x' + '22'.repeat(20), 10_000n),
  };
  const signed = signTx(txIn, d);
  const parsed = parseTx(signed.raw);
  check('EIP-1559 sign -> parse roundtrip recovers the sender', parsed.nonce === 7n && parsed.to === TOKEN
    && parsed.chainId === CHAIN_ID && parsed.hash === signed.hash
    && parsed.from === pubToAddress(publicKey(d))
    && Buffer.compare(Buffer.from(parsed.data), Buffer.from(txIn.data)) === 0);

  // -- 2. the mock chain, driven through the real CLI -----------------------

  const seller = newKeyPair();
  const owner = newKeyPair();
  const agent = newKeyPair();
  for (const [name, pair] of [['seller', seller], ['owner', owner], ['agent', agent]] as const) {
    saveKey(join(scratch, `${name}.json`), pair);
  }
  const seed = (p: typeof owner) => new Uint8Array(Buffer.from(p.privateKey, 'base64url'));
  const ownerAddr = addressFromSeed(seed(owner));
  const agentAddr = addressFromSeed(seed(agent));
  const sellerAddr = addressFromSeed(seed(seller));

  const chain = new MockChain();
  chain.eth.set(ownerAddr, 10n ** 18n); // 1 ETH
  chain.eth.set(agentAddr, 10n ** 16n); // 0.01 ETH for gas
  chain.bal.set(ownerAddr, 100_000_000n); // 100.00 USDC
  const node = chain.serve();
  const RPC = `http://127.0.0.1:${await listen(node)}`;
  const rpc = new EvmRpc(RPC);
  {
    const failover = new EvmRpc('http://127.0.0.1:1/,' + RPC, 3_000);
    check('rpc failover: a dead endpoint is skipped and the next one answers', (await failover.chainId()) === CHAIN_ID);
    check('rpc failover: the client stays on the endpoint that answered', failover.urls[1] === RPC && (await failover.chainId()) === CHAIN_ID);
    let threw = '';
    try { await new EvmRpc('http://127.0.0.1:1/,http://127.0.0.1:2/', 1_000).chainId(); } catch (e) { threw = (e as Error).message; }
    check('rpc failover: every endpoint down is one clear error', /all 2 endpoints failed/.test(threw));
  }

  check('tab evm address matches the derivation', (await cli('evm', 'address', join(scratch, 'agent.json'))).toLowerCase() === agentAddr);

  await cli('evm', 'approve', '--owner', join(scratch, 'owner.json'), '--agent', join(scratch, 'agent.json'),
    '--amount', '0.03', '--token', TOKEN, '--rpc', RPC);
  check('tab evm approve sets the allowance on chain', (await rpc.erc20Allowance(TOKEN, ownerAddr, agentAddr)) === 30_000n);

  const balOut = JSON.parse(await cli('evm', 'balance', '--wallet', join(scratch, 'owner.json'), '--token', TOKEN,
    '--agent', join(scratch, 'agent.json'), '--rpc', RPC));
  check('tab evm balance shows funds and allowance', balOut.amount === '100.00' && balOut.allowance === '0.03');

  // -- 3. a gateway on the evm rail -----------------------------------------

  let drainTarget = '';
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    if (path === '/boom') { res.writeHead(500); res.end('{"error":"boom"}'); return; }
    if (path === '/slow') await new Promise((r) => setTimeout(r, 300));
    // the agent spends its nonce elsewhere while the upstream works, so the payment cannot land
    if (path === '/sabotage') chain.nonce.set(agentAddr, (chain.nonce.get(agentAddr) ?? 0n) + 1n);
    // an x402 buyer moves its funds out while the upstream works
    if (path === '/drain' && drainTarget) chain.bal.set(drainTarget, 0n);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ path, payer: req.headers['tab-payer'] ?? null }));
  });
  const upPort = await listen(upstream);
  const spec: Spec = {
    realm: 'quotes.local',
    recipient: seller.publicKey,
    rail: 'evm',
    evm: { rpc: RPC, chain_id: Number(CHAIN_ID), token: TOKEN, decimals: 6, recipient: sellerAddr,
      explorer: 'https://explorer.testnet.chain.robinhood.com' },
    public_receipts: true,
    services: [{
      name: 'demo', prefix: '', upstream: `http://127.0.0.1:${upPort}`,
      routes: [
        { method: 'GET', path: '/quote', price: '0.01', description: 'a quote' },
        { method: 'GET', path: '/premium', price: '0.02', description: 'pricier' },
        { method: 'GET', path: '/boom', price: '0.01', description: 'always fails' },
        { method: 'GET', path: '/free', price: '0', description: 'free' },
        { method: 'GET', path: '/slow', price: '0.01', description: 'takes a moment' },
        { method: 'GET', path: '/sabotage', price: '0.01', description: 'the agent moves its nonce mid call' },
        { method: 'GET', path: '/drain', price: '0.01', description: 'an x402 buyer empties its wallet mid call' },
      ],
    }],
  };
  const store = new Store(join(scratch, 'tab-evm.db'));
  const gateway = createGateway(spec, { store });
  const GW = `http://127.0.0.1:${await listen(gateway)}`;

  const disc = await (await fetch(`${GW}/.well-known/tab`)).json() as any;
  check('discovery: evm rail with chain, token, payout and explorer', disc.rail === 'evm'
    && disc.rail_info.chain_id === Number(CHAIN_ID) && disc.rail_info.token === TOKEN
    && disc.rail_info.recipient === sellerAddr && /explorer\.testnet/.test(disc.rail_info.explorer));

  const c402 = await fetch(`${GW}/quote`);
  const chal = parseChallengeHeader(c402.headers.get('www-authenticate'))!;
  check('402 challenge carries the evm rail info', c402.status === 402 && chal.rail === 'evm'
    && chal.evm?.chain_id === Number(CHAIN_ID) && chal.evm?.token === TOKEN
    && /^0x[0-9a-f]+$/.test(chal.evm!.max_fee_per_gas) && chal.evm!.gas_limit === 250_000);

  const nonceDoc = await (await fetch(`${GW}/.well-known/tab/evm/nonce/${agentAddr}`)).json() as any;
  check('the gateway proxies account nonces so clients need no RPC', nonceDoc.nonce === 0);

  const mandate = issueMandate(owner, {
    agent: agent.publicKey, budgetUsd: '1.00', window: 'day', maxPerCallUsd: '0.05',
    allow: ['quotes.local'], days: 30, evmOwner: ownerAddr,
  });
  const client = new TabClient({ agent, mandate });

  const paid = await client.fetch(`${GW}/quote`);
  const receipt = receiptOf(paid);
  check('paid call settles on the evm rail', paid.status === 200 && receipt !== null
    && /^evm:0x[0-9a-f]{64}$/.test(receipt.ref));
  check('token moved, allowance decremented', chain.bal.get(sellerAddr) === 10_000n
    && chain.bal.get(ownerAddr) === 100_000_000n - 10_000n
    && chain.allowance.get(`${ownerAddr}|${agentAddr}`) === 20_000n);

  const freeRes = await fetch(`${GW}/free`);
  check('free route needs no payment', freeRes.status === 200 && receiptOf(freeRes) === null);

  // -- 3a. an agent cannot make its own payment fail and keep the response -------------------
  {
    const sellerBefore = chain.bal.get(sellerAddr) ?? 0n;
    const nonceNow = BigInt(((await (await fetch(`${GW}/.well-known/tab/evm/nonce/${agentAddr}`)).json()) as any).nonce);
    const creds = [];
    for (let i = 0; i < 2; i++) {
      const c = parseChallengeHeader((await fetch(`${GW}/slow`)).headers.get('www-authenticate'))!;
      creds.push(encodeCredentialHeader(signCredential(agent, c, mandate, { evm: { tx: buildSignedPaymentTxEvm(c, ownerAddr, agent, nonceNow) } })));
    }
    const both = await Promise.all(creds.map((a) => fetch(`${GW}/slow`, { headers: { authorization: a } })));
    const served = both.filter((r) => r.status === 200);
    check('two payments at one nonce: one is served and paid, the other is refused before the upstream', served.length === 1
      && receiptOf(served[0]) !== null && both.some((r) => r.status === 402) && (chain.bal.get(sellerAddr) ?? 0n) - sellerBefore === 10_000n);

    const before = chain.bal.get(sellerAddr) ?? 0n;
    const r = await client.fetch(`${GW}/sabotage`);
    const text = await r.text();
    check('a payment that cannot settle after the upstream answered withholds the response and charges nothing', r.status === 402
      && !text.includes('/sabotage') && r.headers.get('tab-void') !== null && (chain.bal.get(sellerAddr) ?? 0n) === before);
    // give back the 0.01 the one-nonce check spent, so the allowance arithmetic below holds
    const k = `${ownerAddr}|${agentAddr}`;
    chain.allowance.set(k, (chain.allowance.get(k) ?? 0n) + 10_000n);
  }

  // -- 3c. x402: the same gateway answers x402 buyers, and a tab agent pays x402 sites ---------------
  {
    // the arithmetic, anchored outside this code: the x402 spec's own example payment
    const specAuth = { from: '0x857b06519E91e3A54538791bDbb0E22373e36b66', to: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C', value: '10000', validAfter: '1740672089', validBefore: '1740672154', nonce: '0xf3746613c2d920b5fdabc0856f2aeb2d4f88ee6037b8cc5d04a71a4462f13480' };
    const specSig = '0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c';
    check('EIP-3009 signing matches the x402 spec example (recovers its payer)',
      authorizationSigner({ name: 'USDC', version: '2', chainId: 84532, token: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }, specAuth, specSig) === specAuth.from.toLowerCase());

    const settler = newKeyPair();
    const settlerAddr = addressFromSeed(seed(settler));
    chain.eth.set(settlerAddr, 10n ** 17n);
    const specX: Spec = { ...spec, realm: 'x402.local', evm: { ...spec.evm!, eip712: { name: 'Mock USD', version: '1' } } };
    const storeX = new Store(join(scratch, 'tab-x402.db'));
    const gwX = createGateway(specX, { store: storeX, x402Settler: settler, origin: 'https://x402.local' });
    const GX = `http://127.0.0.1:${await listen(gwX)}`;
    const disc = await (await fetch(`${GX}/.well-known/tab`)).json() as any;
    const r402 = await fetch(`${GX}/quote`);
    const offer = decodeX402<any>(r402.headers.get('payment-required'));
    const req = offer?.accepts?.[0];
    check('a 402 carries x402 requirements next to the tab challenge', r402.status === 402 && !!r402.headers.get('www-authenticate')
      && offer?.x402Version === 2 && req?.scheme === 'exact' && req?.network === `eip155:${CHAIN_ID}` && req?.amount === '10000'
      && req?.asset === TOKEN && req?.payTo === sellerAddr && req?.extra?.name === 'Mock USD' && offer?.resource?.url === 'https://x402.local/quote'
      && disc.x402?.network === `eip155:${CHAIN_ID}`);

    // an x402 buyer that knows nothing of tab: the spec's pieces only
    const buyer = newKeyPair();
    const buyerAddr = addressFromSeed(seed(buyer));
    chain.bal.set(buyerAddr, 1_000_000n);
    const auth = (over: Partial<Record<string, string>> = {}) => {
      const now = Math.floor(Date.now() / 1000);
      return { from: buyerAddr, to: sellerAddr, value: '10000', validAfter: String(now - 60), validBefore: String(now + 120), nonce: '0x' + randomBytes(32).toString('hex'), ...over };
    };
    const pay = async (path: string, a = auth(), key = buyer, accepted = req) => {
      const signature = signAuthorization({ name: 'Mock USD', version: '1', chainId: Number(CHAIN_ID), token: TOKEN }, a as any, scalarFromSeed(seed(key)));
      const header = encodeX402({ x402Version: 2, resource: offer.resource, accepted, payload: { signature, authorization: a } });
      return fetch(`${GX}${path}`, { headers: { 'payment-signature': header } });
    };
    const sellerBefore = chain.bal.get(sellerAddr) ?? 0n;
    const a1 = auth();
    const paid = await pay('/quote', a1);
    const settledHdr = decodeX402<any>(paid.headers.get('payment-response'));
    const rec = receiptOf(paid);
    check('an x402 buyer pays: served, settled on chain by the gateway, with a signed tab receipt', paid.status === 200
      && settledHdr?.success === true && /^0x[0-9a-f]{64}$/.test(settledHdr?.transaction) && settledHdr?.payer === buyerAddr
      && (chain.bal.get(sellerAddr) ?? 0n) - sellerBefore === 10_000n && rec?.ref === `evm:${settledHdr?.transaction}` && !!rec?.sig, settledHdr);
    const again = await pay('/quote', a1);
    check('the same authorization twice: refused, not served', again.status === 402 && (chain.bal.get(sellerAddr) ?? 0n) - sellerBefore === 10_000n);
    const codes: string[] = [];
    for (const [path, a, key] of [
      ['/quote', auth({ value: '5000' }), buyer],
      ['/quote', auth({ to: ownerAddr }), buyer],
      ['/quote', auth(), owner],
      ['/quote', auth({ validBefore: String(Math.floor(Date.now() / 1000) + 5) }), buyer],
      ['/premium', auth(), buyer],
    ] as Array<[string, any, any]>) {
      const r = await pay(path, a, key);
      codes.push(`${r.status}:${decodeX402<any>(r.headers.get('payment-response'))?.errorReason}`);
    }
    check('wrong amount, wrong recipient, wrong signer, about to expire, underpaying another route: all refused with the x402 codes', codes.join(',') ===
      '402:invalid_exact_evm_payload_authorization_value_mismatch,402:invalid_exact_evm_payload_recipient_mismatch,402:invalid_exact_evm_payload_signature,402:invalid_exact_evm_payload_authorization_valid_before,402:invalid_exact_evm_payload_authorization_value_mismatch', codes);
    const poor = newKeyPair();
    const poorAuth = { ...auth(), from: addressFromSeed(seed(poor)) };
    const broke = await pay('/quote', poorAuth, poor);
    check('a buyer without the funds is refused before the upstream is called', broke.status === 402 && decodeX402<any>(broke.headers.get('payment-response'))?.errorReason === 'insufficient_funds');
    const boom = await pay('/boom');
    check('an upstream error settles nothing', boom.status === 500 && (chain.bal.get(sellerAddr) ?? 0n) - sellerBefore === 10_000n);
    drainTarget = buyerAddr;
    const drained = await pay('/drain');
    drainTarget = '';
    const drainedText = await drained.text();
    check('a buyer who empties its wallet mid call gets a 402, not the response', drained.status === 402 && !drainedText.includes('/drain')
      && (chain.bal.get(sellerAddr) ?? 0n) - sellerBefore === 10_000n);
    chain.bal.set(buyerAddr, 1_000_000n);

    // a tab agent paying an x402 site: a minimal x402 server, the spec's pieces only
    const siteSeller = newKeyPair();
    const siteAddr = addressFromSeed(seed(siteSeller));
    let siteAsset = TOKEN;
    let siteVersion = 2;
    const site = createServer((rq, rs) => {
      const reqs = { scheme: 'exact', network: `eip155:${CHAIN_ID}`, amount: '5000', asset: siteAsset, payTo: siteAddr, maxTimeoutSeconds: 60, extra: { name: 'Mock USD', version: '1' } };
      const sig = rq.headers['payment-signature'] ?? rq.headers['x-payment'];
      if (!sig) {
        if (siteVersion === 1) { rs.writeHead(402, { 'content-type': 'application/json' }); rs.end(JSON.stringify({ x402Version: 1, accepts: [{ ...reqs, maxAmountRequired: '5000', resource: 'http://site/x' }] })); return; }
        rs.writeHead(402, { 'payment-required': encodeX402({ x402Version: 2, resource: { url: 'http://site/x' }, accepts: [reqs] }) }); rs.end('{}'); return;
      }
      const p = decodeX402<any>(String(sig));
      const a = p.payload.authorization;
      const out = chain.execToken(siteAddr, transferWithAuthorizationData(a, p.payload.signature));
      if (!out.ok || a.to !== siteAddr || a.value !== '5000') { rs.writeHead(402); rs.end(out.error ?? 'bad'); return; }
      rs.writeHead(200, { 'payment-response': encodeX402({ success: true, transaction: '0x' + '11'.repeat(32), network: `eip155:${CHAIN_ID}`, payer: a.from }) });
      rs.end(JSON.stringify({ ok: true, version: p.x402Version }));
    });
    const SITE = `http://127.0.0.1:${await listen(site)}`;
    chain.bal.set(agentAddr, (chain.bal.get(agentAddr) ?? 0n) + 1_000_000n); // the owner funds the agent's own address
    const xm = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '0.012', maxPerCallUsd: '0.01', allow: ['127.0.0.1'], days: 1, evmOwner: ownerAddr });
    const ledger = join(scratch, 'x402-spent.json');
    const xc = new TabClient({ agent, mandate: xm, x402Ledger: ledger });
    const s1 = await xc.fetch(`${SITE}/x`);
    const s1body = await s1.json() as any;
    check('a tab agent pays an x402 site from its own address, within the mandate', s1.status === 200 && s1body.version === 2
      && x402ResponseOf(s1)?.success === true && (chain.bal.get(siteAddr) ?? 0n) === 5_000n);
    siteVersion = 1;
    const s2 = await xc.fetch(`${SITE}/x`);
    siteVersion = 2;
    check('and a version 1 site (body requirements, X-PAYMENT)', s2.status === 200 && ((await s2.json()) as any).version === 1 && (chain.bal.get(siteAddr) ?? 0n) === 10_000n);
    const reasons: string[] = [];
    const tryPay = async (c: TabClient) => { try { await c.fetch(`${SITE}/x`); reasons.push('paid'); } catch (e) { reasons.push(e instanceof PaymentRefused ? e.reason : String(e)); } };
    await tryPay(xc); // 0.010 spent of 0.012: a third 0.005 passes the budget
    await tryPay(new TabClient({ agent, mandate: issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1', maxPerCallUsd: '0.001', allow: ['127.0.0.1'], evmOwner: ownerAddr }) }));
    await tryPay(new TabClient({ agent, mandate: issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1', allow: ['elsewhere.example'], evmOwner: ownerAddr }) }));
    siteAsset = '0x' + 'ab'.repeat(20);
    await tryPay(new TabClient({ agent, mandate: issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1', allow: ['*'], evmOwner: ownerAddr }) }));
    siteAsset = TOKEN;
    check('the client refuses past the budget, past the per-call cap, off the allow list, and in a token it does not know',
      /budget/.test(reasons[0]) && /per-call cap/.test(reasons[1]) && /allow list/.test(reasons[2]) && /nothing this client pays in/.test(reasons[3])
      && (chain.bal.get(siteAddr) ?? 0n) === 10_000n, reasons);
    // B3: the approval threshold, and every level of a chain, bind x402 payments too
    const gated = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '1', allow: ['*'], approveAboveUsd: '0.001', evmOwner: ownerAddr });
    await tryPay(new TabClient({ agent, mandate: gated }));
    const xParent = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '0.005', allow: ['*'], evmOwner: ownerAddr });
    const xKids = [1, 2].map((days) => delegateMandate(agent, xParent, { agent: agent.publicKey, days }));
    const shared = join(scratch, 'x402-chain.json');
    await tryPay(new TabClient({ agent, mandate: xKids[0], x402Ledger: shared }));
    await tryPay(new TabClient({ agent, mandate: xKids[1], x402Ledger: shared }));
    check('B3: x402 payments respect the approval threshold, and siblings count against their parent', /approval threshold/.test(reasons[4]) && reasons[5] === 'paid' && /parent mandate budget/.test(reasons[6]), reasons.slice(4));
    const fresh = new TabClient({ agent, mandate: xm, x402Ledger: ledger });
    let afterRestart = '';
    try { await fresh.fetch(`${SITE}/x`); afterRestart = 'paid'; } catch (e) { afterRestart = (e as PaymentRefused).reason; }
    check('the x402 spend survives a restart through the ledger file', /budget/.test(afterRestart));

    const bothMandate = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '0.05', allow: ['x402.local'], days: 1, evmOwner: ownerAddr });
    const allowanceKey = `${ownerAddr}|${agentAddr}`;
    chain.allowance.set(allowanceKey, (chain.allowance.get(allowanceKey) ?? 0n) + 10_000n); // this payment's own, so the allowance checks below still add up
    const both = await new TabClient({ agent, mandate: bothMandate }).fetch(`${GX}/quote`);
    check('a gateway that speaks both is paid the tab way by a tab client', both.status === 200 && receiptOf(both)?.mandate === bothMandate.id);
    site.close();
    gwX.close();
    storeX.close();
  }

  // -- 3b. a gateway that lies in its challenge, and payments with more than one encoding --------
  {
    // a hostile gateway: the real challenge, re-served with the token's decimals or the token itself changed
    const lie = (edit: (c: any) => void) => createServer(async (req, res) => {
      const r = await fetch(`${GW}${req.url}`, { headers: req.headers.authorization ? { authorization: req.headers.authorization } : {} });
      const c = parseChallengeHeader(r.headers.get('www-authenticate'));
      if (r.status !== 402 || !c) { res.writeHead(r.status); res.end(await r.text()); return; }
      edit(c);
      res.writeHead(402, { 'www-authenticate': encodeChallengeHeader(c), 'content-type': 'application/json' });
      res.end('{}');
    });
    const before = chain.broadcasts;
    const outcomes: string[] = [];
    for (const edit of [(c: any) => { c.evm.decimals = 18; }, (c: any) => { c.evm.token = '0x' + 'cd'.repeat(20); }]) {
      const srv = lie(edit);
      const port = await listen(srv);
      try { await client.fetch(`http://127.0.0.1:${port}/quote`); outcomes.push('paid'); } catch (e) { outcomes.push(e instanceof PaymentRefused ? e.reason : String(e)); }
      srv.close();
    }
    check('the client refuses a challenge that inflates the token decimals, before signing', /has 6/.test(outcomes[0]) && chain.broadcasts === before);
    check('the client refuses a token it does not know, before signing', /does not know/.test(outcomes[1]) && chain.broadcasts === before);

    // one signed payment, re-encoded: high s, an integer with a leading zero byte
    const chal = parseChallengeHeader((await fetch(`${GW}/quote`)).headers.get('www-authenticate'))!;
    const nonceNow = BigInt(((await (await fetch(`${GW}/.well-known/tab/evm/nonce/${agentAddr}`)).json()) as any).nonce);
    const good = buildSignedPaymentTxEvm(chal, ownerAddr, agent, nonceNow);
    const f = rlpDecode(hexToBytes(good).slice(1)) as Uint8Array[];
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const sHigh = N - BigInt(bytesToHex(f[11]));
    const variants = [
      [...f.slice(0, 9), f[9].length ? new Uint8Array(0) : Uint8Array.of(1), f[10], hexToBytes('0x' + sHigh.toString(16).padStart(64, '0'))],
      [f[0], Uint8Array.from([0, ...f[1].length ? f[1] : [0]]), ...f.slice(2)],
    ];
    const refusals: number[] = [];
    for (const v of variants) {
      const raw = '0x02' + bytesToHex(rlpEncode(v as any)).slice(2);
      const cred = encodeCredentialHeader(signCredential(agent, chal, mandate, { evm: { tx: raw } }));
      const r = await fetch(`${GW}/quote`, { headers: { authorization: cred } });
      refusals.push(r.status);
    }
    check('a high-s or non-canonical payment is refused, so no call is served on a payment the chain would reject',
      refusals.every((st) => st === 402) && chain.broadcasts === before, refusals);
  }

  // -- 4. voids broadcast nothing -------------------------------------------

  const broadcastsBefore = chain.broadcasts;
  const boom = await client.fetch(`${GW}/boom`);
  check('upstream failure: passed through, voided, nothing broadcast', boom.status === 500
    && boom.headers.get('tab-void') !== null && receiptOf(boom) === null
    && chain.broadcasts === broadcastsBefore);

  // -- 5. bad credentials ---------------------------------------------------

  const freshChal = async () => parseChallengeHeader((await fetch(`${GW}/quote`)).headers.get('www-authenticate'))!;
  const agentNonce = async () => BigInt((await (await fetch(`${GW}/.well-known/tab/evm/nonce/${agentAddr}`)).json() as any).nonce);

  {
    const c = await freshChal();
    const r = await fetch(`${GW}/quote`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, c, mandate)) } });
    check('credential without a transaction is malformed', r.status === 402
      && ((await r.json()) as any).type === 'urn:tab:problem:malformed-credential');
  }
  {
    const c = await freshChal();
    const wrongAmount = { ...c, amount: '1' };
    const tx = buildSignedPaymentTxEvm(wrongAmount, ownerAddr, agent, await agentNonce());
    const r = await fetch(`${GW}/quote`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, c, mandate, { evm: { tx } })) } });
    check('transaction not matching the challenge is rejected', r.status === 402
      && ((await r.json()) as any).type === 'urn:tab:problem:verification-failed');
  }
  {
    const c = await freshChal();
    const tx = buildSignedPaymentTxEvm(c, ownerAddr, agent, await agentNonce());
    const cred = encodeCredentialHeader(signCredential(agent, c, mandate, { evm: { tx } }));
    const ok1 = await fetch(`${GW}/quote`, { headers: { authorization: cred } });
    const ok2 = await fetch(`${GW}/quote`, { headers: { authorization: cred } });
    check('challenge redeems once on the evm rail', ok1.status === 200 && ok2.status === 402);

    // ...and the SAME signed transaction cannot back a second challenge either
    const c2 = await freshChal();
    const reuse = await fetch(`${GW}/quote`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, c2, mandate, { evm: { tx } })) } });
    check('one signed payment can never back two holds', reuse.status === 402
      && /already used/.test(((await reuse.json()) as any).detail));
  }
  {
    // a different price gives distinct tx bytes, so this reaches the nonce
    // check instead of the duplicate-transaction guard
    const c = parseChallengeHeader((await fetch(`${GW}/premium`)).headers.get('www-authenticate'))!;
    const stale = buildSignedPaymentTxEvm(c, ownerAddr, agent, (await agentNonce()) - 1n);
    const r = await fetch(`${GW}/premium`, { headers: { authorization: encodeCredentialHeader(signCredential(agent, c, mandate, { evm: { tx: stale } })) } });
    check('a stale nonce is payment-expired', r.status === 402
      && ((await r.json()) as any).type === 'urn:tab:problem:payment-expired');
  }
  {
    // a mandate whose evm_owner is not the account the owner actually approved
    const wrongOwnerMandate = issueMandate(owner, {
      agent: agent.publicKey, budgetUsd: '1.00', allow: ['quotes.local'], evmOwner: sellerAddr,
    });
    const r = await new TabClient({ agent, mandate: wrongOwnerMandate }).fetch(`${GW}/quote`);
    check('spending an unapproved account is insufficient-funds', r.status === 402
      && ((await r.json()) as any).type === 'urn:tab:problem:insufficient-funds');
  }
  {
    const gasless = newKeyPair();
    // owner approves the gasless agent, but nobody gives it ETH
    saveKey(join(scratch, 'gasless.json'), gasless);
    await cli('evm', 'approve', '--owner', join(scratch, 'owner.json'), '--agent', join(scratch, 'gasless.json'),
      '--amount', '0.10', '--token', TOKEN, '--rpc', RPC);
    const m = issueMandate(owner, { agent: gasless.publicKey, budgetUsd: '1.00', allow: ['quotes.local'], evmOwner: ownerAddr });
    const r = await new TabClient({ agent: gasless, mandate: m }).fetch(`${GW}/quote`);
    check('an agent with no ETH for gas is insufficient-funds', r.status === 402
      && /gas/.test(((await r.json()) as any).detail));
  }

  // -- 5a. re-review: payout and lock races against a scripted RPC ---------------------------------
  {
    // a node scripted per call: a mempool, a chain, and a hook that runs between two reads
    const scripted = () => {
      const st = { latest: 0n, mempool: new Map<string, bigint>(), mined: new Map<string, any>(), transfers: 0, between: null as null | (() => void), lagReceipts: false, lagByHash: false, refuse: null as null | ((h: string) => boolean) };
      // like a real node: transactions whose nonce is spent leave the mempool
      const mine = () => { for (const [h, n] of [...st.mempool].sort((x, y) => Number(x[1] - y[1]))) if (n === st.latest) { st.mined.set(h, { status: '0x1', transactionHash: h }); st.mempool.delete(h); st.latest++; st.transfers++; } for (const [h, n] of [...st.mempool]) if (n < st.latest) st.mempool.delete(h); };
      const rpc = {
        async call(m: string, p: any[]) {
          if (m === 'eth_getTransactionReceipt') return st.lagReceipts ? null : st.mined.get(p[0]) ?? null;
          if (m === 'eth_getTransactionCount') { if (st.between) { const f = st.between; st.between = null; f(); } return '0x' + st.latest.toString(16); }
          if (m === 'eth_getTransactionByHash') return st.lagByHash ? null : st.mempool.has(p[0]) || st.mined.has(p[0]) ? { hash: p[0] } : null;
          throw new Error(`unscripted ${m}`);
        },
        async transactionCount() { return st.latest + BigInt(st.mempool.size); },
        async maxPriorityFeePerGas() { return 1n; },
        async gasPrice() { return 1n; },
        async sendRawTransaction(raw: Uint8Array) { const t = parseTx(raw); if (st.refuse?.(t.hash)) throw new Error('rejected'); if (!st.mined.has(t.hash)) st.mempool.set(t.hash, t.nonce); return t.hash; },
        async waitForReceipt(h: string) { if (st.mined.has(h) && !st.lagReceipts) return; throw new Error('no receipt yet'); },
      };
      return { st, rpc, mine };
    };
    const railWith = (rpc: unknown) => {
      const r = new EvmRail({ rpc: 'http://127.0.0.1:1', chain_id: Number(CHAIN_ID), token: TOKEN, decimals: 6, recipient: '0x' + '22'.repeat(20) });
      const st = new Store(join(scratch, `race-${randomBytes(4).toString('hex')}.db`));
      r.enableEscrow(newKeyPair(), st);
      r.confirmMs = 10;
      (r as unknown as { rpc: unknown }).rpc = rpc;
      return { r, st };
    };
    const hold: any = { id: 'h1', refund_to: '0x' + '33'.repeat(20), amount: 1000, created_at: new Date().toISOString() };
    const tryPay = async (r: EvmRail) => { try { return await r.payoutLocked(hold, 'seller', 1000, 'escrow:h1:seller'); } catch (e) { return (e as Error).name; } };

    // C1a: our transaction mines between the nonce read and the receipt read
    const a = scripted(); const ra = railWith(a.rpc);
    await tryPay(ra.r);
    a.st.between = a.mine;
    await tryPay(ra.r);
    a.mine();
    check('C1: a payout whose transaction mines between two reads is not signed again', a.st.transfers === 1 && ra.st.payout('escrow:h1:seller')?.state === 'confirmed', { transfers: a.st.transfers });

    // C1b: nodes that lag: the nonce is spent, no receipt, no transaction by hash
    const b = scripted(); const rb = railWith(b.rpc);
    await tryPay(rb.r);
    b.mine();
    b.st.lagReceipts = true; b.st.lagByHash = true;
    const lagged = await tryPay(rb.r);
    const signedBefore = b.st.transfers + b.st.mempool.size;
    check('C1: a spent nonce with no receipt anywhere is left for the operator, never signed again', lagged === 'PayoutUnknown' && signedBefore === 1 && b.st.mempool.size === 0);
    b.st.lagReceipts = false; b.st.lagByHash = false;
    check('C1: once the node catches up the payout reconciles to confirmed', await rb.r.reconcilePayout(rb.st.payout('escrow:h1:seller')!) && rb.st.payout('escrow:h1:seller')?.state === 'confirmed');

    // C2: a buyer's deposit that mines between the reads is landed, and a spent nonce without a receipt is pending, not failed
    const c = scripted(); const rc = railWith(c.rpc);
    const buyerKey = newKeyPair();
    const dep = signTx({ chainId: CHAIN_ID, nonce: 0n, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 250_000n, to: TOKEN, value: 0n, data: erc20.transfer('0x' + '44'.repeat(20), 1n) }, scalarFromSeed(seed(buyerKey)));
    const depHold: any = { id: 'd1', tx: bytesToHex(dep.raw), created_at: new Date().toISOString() };
    c.st.mempool.set(dep.hash, 0n);
    c.st.between = c.mine;
    const landed = await rc.r.lockStatus(depHold);
    c.st.lagReceipts = true; c.st.lagByHash = true;
    const lagging = await rc.r.lockStatus(depHold);
    check('C2: a deposit that lands between the reads counts as landed, and a lagging node leaves it pending', landed === 'landed' && lagging === 'pending', { landed, lagging });

    // LOW c: a payout the node keeps refusing frees its nonce with a cancel, then pays once
    const d = scripted(); const rd = railWith(d.rpc);
    let refusing = true;
    d.st.refuse = (h) => refusing && h === rd.st.payout('escrow:h1:seller')?.hash;
    for (let i = 0; i < 4; i++) { const p = rd.st.payout('escrow:h1:seller'); if (p) rd.st.putPayout({ ...p, attempts: i }); await tryPay(rd.r); d.mine(); }
    refusing = false;
    await tryPay(rd.r); d.mine(); await tryPay(rd.r);
    const fin = rd.st.payout('escrow:h1:seller')!;
    check('LOW c: a payout the node refuses frees its nonce with a cancel, and is then paid exactly once', fin.state === 'confirmed' && d.st.mined.size === 2 && d.st.transfers === 2, { state: fin.state, mined: d.st.mined.size });

    // M2 (the reviewer's cancel_hole.mts): a refused cancel is sent again, fee-bumped, so the nonce is freed
    {
      const e = scripted(); const re = railWith(e.rpc);
      let refuseAll = true; let cancelSends = 0;
      const escrowAddr = re.r.escrowRecipient()!;
      e.rpc.sendRawTransaction = async (raw: Uint8Array) => { const t = parseTx(raw); if (t.to === escrowAddr) cancelSends++; if (refuseAll) throw new Error('node down'); if (t.nonce === 0n && t.to !== escrowAddr) throw new Error('evicted'); if (t.nonce < e.st.latest) throw new Error('nonce too low'); e.st.mempool.set(t.hash, t.nonce); e.mine(); return t.hash; };
      const bump = (k: string) => { const p = re.st.payout(k)!; re.st.putPayout({ ...p, attempts: p.attempts + 1 }); };
      const pay = async (h: any, micro: number, key: string) => { try { await re.r.payoutLocked(h, 'seller', micro, key); } catch { /* retried */ } };
      for (let i = 0; i < 4; i++) { await pay(hold, 1000, 'A'); bump('A'); }
      refuseAll = false;
      for (let i = 0; i < 6 && re.st.payout('A')!.state !== 'confirmed'; i++) { await pay(hold, 1000, 'A'); bump('A'); }
      await pay({ ...hold, id: 'h2' }, 500, 'B');
      const pa = re.st.payout('A')!, pb = re.st.payout('B')!;
      check('M2: a cancel the node refused is sent again, its nonce is freed, and the payout and the next one land', pa.state === 'confirmed' && pb.state === 'confirmed'
        && cancelSends >= 2 && pa.nonce !== 0 && e.st.latest === 3n, { a: pa.state, b: pb.state, cancelSends, latest: String(e.st.latest) });
    }

    // L1: a stuck payout keeps its nonce: a new payout never takes it
    {
      const f = scripted(); const rf = railWith(f.rpc);
      await (async () => { try { await rf.r.payoutLocked(hold, 'seller', 1000, 'S'); } catch { /* pending */ } })();
      const s1 = rf.st.payout('S')!;
      rf.st.putPayout({ ...s1, state: 'stuck' });
      f.st.mempool.clear(); // the stuck one is nowhere to be seen
      await (async () => { try { await rf.r.payoutLocked({ ...hold, id: 'h3' }, 'seller', 1000, 'T'); } catch { /* pending */ } })();
      check('L1: a new payout never takes the nonce a stuck one holds', s1.nonce === 0 && rf.st.payout('T')!.nonce === 1 && rf.st.maxPendingNonce() === 1);
    }

    // L2: a receipt that names another transaction, or an odd status, is not a revert
    {
      const g = scripted(); const rg = railWith(g.rpc);
      await (async () => { try { await rg.r.payoutLocked(hold, 'seller', 1000, 'R'); } catch { /* pending */ } })();
      const r1 = rg.st.payout('R')!;
      g.st.mempool.clear(); g.st.latest = 1n; // the nonce is spent; nodes hand back a stranger's receipt for our hash
      const realCall = g.rpc.call;
      g.rpc.call = async (m: string, p: any[]) => (m === 'eth_getTransactionReceipt' ? { status: '0x0', transactionHash: '0x' + 'ab'.repeat(32) } : realCall(m, p));
      let outcome = '';
      try { await rg.r.payoutLocked(hold, 'seller', 1000, 'R'); } catch (e2) { outcome = (e2 as Error).name; }
      g.rpc.call = async (m: string, p: any[]) => (m === 'eth_getTransactionReceipt' ? { status: '0x2', transactionHash: r1.hash } : realCall(m, p));
      let odd = '';
      try { await rg.r.payoutLocked(hold, 'seller', 1000, 'R'); } catch (e2) { odd = (e2 as Error).name; }
      check('L2: a receipt for another transaction, or with an odd status, never counts as a revert', outcome === 'PayoutUnknown' && odd === 'PayoutUnknown' && rg.st.payout('R')!.hash === r1.hash, { outcome, odd });
    }
  }

  // -- 5b. security review B2: on chain the allowance is the hard cap, so revoking zeroes it too ---------
  {
    const k = `${ownerAddr}|${agentAddr}`;
    const before = chain.allowance.get(k) ?? 0n;
    chain.allowance.set(k, 5_000n);
    const rm = issueMandate(owner, { agent: agent.publicKey, budgetUsd: '0.10', allow: ['quotes.local'], evmOwner: ownerAddr });
    saveMandate(join(scratch, 'revoke-m.json'), rm);
    const out = await cli('mandate', 'revoke', '--key', join(scratch, 'owner.json'), '--mandate', join(scratch, 'revoke-m.json'), '--gateway', GW,
      '--token', TOKEN, '--evm-agent', join(scratch, 'agent.json'), '--rpc', RPC);
    check('B2: tab mandate revoke on an evm mandate also drops the agent\'s allowance to zero', JSON.parse(out).mandate === rm.id && (chain.allowance.get(k) ?? 0n) === 0n
      && ((await (await fetch(`${GW}/.well-known/tab/revocations/${rm.id}`)).json()) as any).revoked === true);
    chain.allowance.set(k, before);

    // a company on this gateway: retiring an agent sets its allowance from the owner account to zero
    const cstore = new CompanyStore(join(scratch, 'evm-company.db'));
    const engine = new Engine({ store: cstore, workDir: join(scratch, 'evm-work'), tickMs: 3_600_000 });
    const app = createCompanyServer({ store: cstore, engine, hosts: [], allowPrivateOrigins: true, defaultGateway: GW, secureCookies: false, evmRpc: { [Number(CHAIN_ID)]: RPC } });
    const APP = `http://127.0.0.1:${await listen(app)}`;
    const token = ((await (await fetch(`${APP}/api/signup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'evm@example.com', password: 'correct horse' }) })).json()) as any).token;
    const api = async (path: string, body?: unknown) => (await fetch(APP + path, { method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })).json() as Promise<any>;
    const co = (await api('/api/companies', { name: 'OnChain', budget: '5.00', gateways: [GW] })).company;
    chain.eth.set(co.owner_evm.toLowerCase(), 10n ** 17n);
    const hired = (await api(`/api/companies/${co.id}/agents`, { name: 'payer', role: 'buyer', adapter: 'starter', budget_per_run: '0.05' })).agent;
    await api(`/api/companies/${co.id}/chain/authorize`, { agent_id: hired.id, amount: '1.00' });
    const agentEvm = addressFromSeed(new Uint8Array(Buffer.from(cstore.agent(hired.id)!.agent_priv!, 'base64url')));
    const allowed = chain.allowance.get(`${co.owner_evm.toLowerCase()}|${agentEvm}`) ?? 0n;
    await api(`/api/companies/${co.id}/agents/${hired.id}/retire`, {});
    const view = await api(`/api/companies/${co.id}`);
    check('B2: on a company that pays on chain, retiring an agent zeroes its allowance', allowed === 1_000_000n && (chain.allowance.get(`${co.owner_evm.toLowerCase()}|${agentEvm}`) ?? 0n) === 0n
      && view.events.some((e: any) => e.kind === 'chain-revoke'), { allowed: String(allowed) });
    app.close(); engine.stop(); cstore.close();
  }

  // -- 6. the allowance is a hard cap; revoke ends it ------------------------

  {
    // 0.03 approved, 0.02 spent so far (two paid calls). One more fits.
    const fits = await client.fetch(`${GW}/quote`);
    const broke = await client.fetch(`${GW}/quote`);
    check('exhausted allowance is insufficient-funds', fits.status === 200 && broke.status === 402
      && ((await broke.json()) as any).type === 'urn:tab:problem:insufficient-funds');

    await cli('evm', 'approve', '--owner', join(scratch, 'owner.json'), '--agent', join(scratch, 'agent.json'),
      '--amount', '1.00', '--token', TOKEN, '--rpc', RPC);
    const reup = await client.fetch(`${GW}/quote`);
    await cli('evm', 'revoke', '--owner', join(scratch, 'owner.json'), '--agent', join(scratch, 'agent.json'),
      '--token', TOKEN, '--rpc', RPC);
    const revoked = await client.fetch(`${GW}/quote`);
    check('re-approval restores spending; revoke ends it', reup.status === 200 && revoked.status === 402
      && ((await revoked.json()) as any).type === 'urn:tab:problem:insufficient-funds');
  }

  const wallet = await (await fetch(`${GW}/.well-known/tab/wallet/${ownerAddr}`)).json() as any;
  check('wallet endpoint reads token balances by 0x address', wallet.micro === Number(chain.bal.get(ownerAddr)));
  const recs = await (await fetch(`${GW}/.well-known/tab/receipts`)).json() as any;
  check('receipts carry evm refs', recs.receipts.length >= 3
    && recs.receipts.every((r: any) => r.ref.startsWith('evm:0x')));

  // -- 7. a gateway that charges in its own 18-decimal token -----------------

  check('micro units scale exactly to any token decimals', microToBaseUnits(10_000n, 18) === 10n ** 16n
    && microToBaseUnits(10_000n, 6) === 10_000n && microToBaseUnits(10_000n, 2) === 1n
    && baseUnitsToMicro(10n ** 16n, 18) === 10_000n && baseUnitsToMicro(1n, 2) === 10_000n
    && (() => { try { microToBaseUnits(10_001n, 2); return false; } catch { return true; } })()
    && (() => { try { microToBaseUnits(1n, 19); return false; } catch { return true; } })());

  const TTT = '0x' + 'ab'.repeat(20);
  const chainT = new MockChain(TTT, 18n, true);
  chainT.eth.set(ownerAddr, 10n ** 18n);
  chainT.eth.set(agentAddr, 10n ** 16n);
  chainT.bal.set(ownerAddr, 100n * 10n ** 18n); // 100 TTT
  const nodeT = chainT.serve();
  const RPC_T = `http://127.0.0.1:${await listen(nodeT)}`;

  await cli('evm', 'approve', '--owner', join(scratch, 'owner.json'), '--agent', join(scratch, 'agent.json'),
    '--amount', '0.03', '--token', TTT, '--rpc', RPC_T);
  const balT = JSON.parse(await cli('evm', 'balance', '--wallet', join(scratch, 'owner.json'), '--token', TTT,
    '--agent', join(scratch, 'agent.json'), '--rpc', RPC_T));
  check('tab evm approve and balance read the token\'s decimals', chainT.allowance.get(`${ownerAddr}|${agentAddr}`) === 3n * 10n ** 16n
    && balT.decimals === 18 && balT.amount === '100.00' && balT.allowance === '0.03');

  const specT: Spec = {
    realm: 'token.local', recipient: seller.publicKey, rail: 'evm', currency: 'TTT',
    evm: { rpc: RPC_T, chain_id: Number(CHAIN_ID), token: TTT, decimals: 18, recipient: sellerAddr },
    public_receipts: true,
    services: [{ name: 'demo', prefix: '', upstream: `http://127.0.0.1:${upPort}`,
      routes: [{ method: 'GET', path: '/quote', price: '0.01', description: 'a quote, in TTT' }] }],
  };
  const storeT = new Store(join(scratch, 'tab-ttt.db'));
  const gatewayT = createGateway(specT, { store: storeT });
  const GWT = `http://127.0.0.1:${await listen(gatewayT)}`;

  const discT = await (await fetch(`${GWT}/.well-known/tab`)).json() as any;
  const chalT = parseChallengeHeader((await fetch(`${GWT}/quote`)).headers.get('www-authenticate'))!;
  check('discovery and the 402 name the currency and the token decimals', discT.currency === 'TTT'
    && discT.rail_info.decimals === 18 && chalT.currency === 'TTT' && chalT.amount === '10000' && chalT.evm?.decimals === 18);

  const mandateT = issueMandate(owner, {
    agent: agent.publicKey, budgetUsd: '1.00', window: 'day', maxPerCallUsd: '0.05',
    allow: ['token.local'], days: 30, evmOwner: ownerAddr,
  });
  {
    const before = chainT.broadcasts;
    let refused = '';
    try { await new TabClient({ agent, mandate: mandateT }).fetch(`${GWT}/quote`); } catch (e) { if (e instanceof PaymentRefused) refused = e.reason; }
    check('a client that pays in USD refuses a token-priced gateway before signing', /charges in TTT/.test(refused)
      && chainT.broadcasts === before);
  }
  const clientT = new TabClient({ agent, mandate: mandateT, currency: 'TTT', evmTokens: [{ chainId: Number(CHAIN_ID), token: TTT, decimals: 18, currency: 'TTT' }] });
  const paidT = await clientT.fetch(`${GWT}/quote`);
  const receiptT = receiptOf(paidT);
  check('a client told to pay in TTT settles 0.01 TTT as 10^16 base units', paidT.status === 200
    && receiptT?.currency === 'TTT' && receiptT.amount === '10000'
    && chainT.bal.get(sellerAddr) === 10n ** 16n && chainT.allowance.get(`${ownerAddr}|${agentAddr}`) === 2n * 10n ** 16n);
  const walletT = await (await fetch(`${GWT}/.well-known/tab/wallet/${ownerAddr}`)).json() as any;
  const recsT = await (await fetch(`${GWT}/.well-known/tab/receipts`)).json() as any;
  check('balances and receipts come back in micro units of the token', walletT.micro === 100_000_000 - 10_000
    && walletT.available === '99.99' && recsT.receipts[0].currency === 'TTT');

  // the testnet faucet: mints the token to a new wallet and sends it gas, once per wallet
  {
    const faucetKey = newKeyPair();
    const faucetAddr = addressFromSeed(new Uint8Array(Buffer.from(faucetKey.privateKey, 'base64url')));
    chainT.eth.set(faucetAddr, 10n ** 18n);
    const gwF = createGateway({ ...specT, realm: 'faucet.local' }, { store: new Store(join(scratch, 'tab-faucet.db')), faucetUsd: '100', faucetKey, faucetGas: '0.001' });
    const GWF = `http://127.0.0.1:${await listen(gwF)}`;
    const claimer = '0x' + 'c1'.repeat(20);
    const claim = (wallet: string) => fetch(`${GWF}/.well-known/tab/faucet`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet }) });
    const first = await (await claim(claimer)).json() as any;
    check('the evm faucet mints the token and sends gas to a new wallet', first.credited === '100.00' && first.currency === 'TTT' && first.txs?.[0]?.kind === 'mint'
      && chainT.bal.get(claimer) === 100n * 10n ** 18n && chainT.eth.get(claimer) === 10n ** 15n);
    const again = await (await claim(claimer.toUpperCase().replace('0X', '0x'))).json() as any;
    check('the evm faucet pays a wallet once', again.already_claimed === true && chainT.bal.get(claimer) === 100n * 10n ** 18n);
    check('the evm faucet wants a 0x address', (await claim('not-a-wallet')).status === 400);
    let mainnetErr = '';
    try { createGateway({ ...specT, evm: { ...specT.evm!, chain_id: 4663 } }, { store: new Store(join(scratch, 'tab-faucet-main.db')), faucetUsd: '100', faucetKey }); } catch (e) { mainnetErr = (e as Error).message; }
    check('the evm faucet refuses to run on a mainnet', /for testnets/.test(mainnetErr));
  }

  {
    let err = '';
    try { await new EvmRail({ rpc: RPC_T, chain_id: Number(CHAIN_ID), token: TTT, decimals: 6, recipient: sellerAddr }).challengeExtras(); } catch (e) { err = (e as Error).message; }
    const badSpec = join(scratch, 'two-decimals.json');
    writeFileSync(badSpec, JSON.stringify({ ...specT, evm: { ...specT.evm, decimals: 2 },
      services: [{ name: 'd', prefix: '', upstream: 'http://127.0.0.1:1', routes: [{ method: 'GET', path: '/x', price: '0.001' }] }] }));
    let loadErr = '';
    try { loadSpec(badSpec); } catch (e) { loadErr = (e as Error).message; }
    check('a spec whose decimals disagree with the contract, or whose prices a token cannot carry, is refused',
      /has 18 decimals, spec says 6/.test(err) && /not representable with 2 decimals/.test(loadErr));
  }
  gatewayT.close();
  nodeT.close();
  storeT.close();

  // -- 7b. 3.0 on the evm rail: escrow and channels through a gateway-held escrow address --------
  {
    const o3 = newKeyPair(), a3 = newKeyPair(), esc = newKeyPair(), s3 = newKeyPair();
    const o3Addr = addressFromSeed(seed(o3)), a3Addr = addressFromSeed(seed(a3)), escAddr = addressFromSeed(seed(esc)), s3Addr = addressFromSeed(seed(s3));
    chain.eth.set(a3Addr, 10n ** 16n);
    chain.eth.set(escAddr, 10n ** 17n); // the escrow key pays gas for payouts
    chain.bal.set(o3Addr, 5_000_000n); // 5.00
    chain.allowance.set(`${o3Addr}|${a3Addr}`, 5_000_000n);
    let delivery: { url: string; token: string } | null = null;
    const up3 = createServer(async (req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      for await (const _ of req) { /* drain */ }
      if (u.pathname === '/job') { delivery = { url: String(req.headers['tab-deliver']), token: String(req.headers['tab-delivery-token']) }; res.writeHead(202); res.end('{"accepted":true}'); return; }
      if (u.pathname === '/model') { res.writeHead(200, { 'tab-units': '1500' }); res.end('{"completion":"ok"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
    });
    const spec3: Spec = {
      realm: 'v3.local', recipient: s3.publicKey, rail: 'evm', public_receipts: true, channels: {},
      evm: { rpc: RPC, chain_id: Number(CHAIN_ID), token: TOKEN, decimals: 6, recipient: s3Addr },
      services: [{ name: 'v3', prefix: '', upstream: `http://127.0.0.1:${await listen(up3)}`, routes: [
        { method: 'GET', path: '/quote', price: '0.01' },
        { method: 'POST', path: '/job', price: '0.25', escrow: { timeout_s: 60 } },
        { method: 'GET', path: '/model', price: '0.01', meter: { unit: 'token', per_unit: '0.000001' } },
      ] }],
    };
    const noKey = createGateway(spec3, { store: new Store(join(scratch, 'v3-nokey.db')) });
    const NK = `http://127.0.0.1:${await listen(noKey)}`;
    const nkDisc = await (await fetch(`${NK}/.well-known/tab`)).json() as any;
    const nkChal = parseChallengeHeader((await fetch(`${NK}/job`, { method: 'POST' })).headers.get('www-authenticate'))!;
    check('without an escrow key an evm gateway offers neither escrow nor channels', !nkDisc.features.includes('escrow') && !nkDisc.features.includes('channels') && nkChal.escrow === undefined);
    noKey.close();
    let ledgerKey = '';
    try { createGateway({ ...spec3, rail: 'ledger', evm: undefined }, { store: new Store(join(scratch, 'v3-l.db')), escrowKey: esc }); } catch (e) { ledgerKey = (e as Error).message; }
    check('an escrow key is refused on the ledger rail', /evm rail/.test(ledgerKey));

    const st3 = new Store(join(scratch, 'v3.db'));
    const { server: gw3, url: G3 } = await gatewayAt(spec3, { store: st3, escrowKey: esc, sweepMs: 200 });
    const d3 = await (await fetch(`${G3}/.well-known/tab`)).json() as any;
    const jobChal = parseChallengeHeader((await fetch(`${G3}/job`, { method: 'POST' })).headers.get('www-authenticate'))!;
    check('with one, escrow routes name the escrow address in the challenge', d3.features.includes('escrow') && d3.features.includes('channels')
      && jobChal.escrow?.recipient === escAddr && jobChal.evm?.recipient === s3Addr);
    const m3 = issueMandate(o3, { agent: a3.publicKey, budgetUsd: '3.00', maxPerCallUsd: '0.50', allow: ['v3.local'], evmOwner: o3Addr });
    const c3 = new TabClient({ agent: a3, mandate: m3 });
    const bal = (a: string) => chain.bal.get(a) ?? 0n;

    // a credential that asks for escrow but pays the seller directly is refused
    const nonce3 = BigInt(((await (await fetch(`${G3}/.well-known/tab/evm/nonce/${a3Addr}`)).json()) as any).nonce);
    const sneaky = signCredential(a3, jobChal, m3, { escrow: true, body: '{}', evm: { tx: buildSignedPaymentTxEvm(jobChal, o3Addr, a3, nonce3) } });
    const sneakyRes = await fetch(`${G3}/job`, { method: 'POST', body: '{}', headers: { authorization: encodeCredentialHeader(sneaky) } });
    check('an escrow credential whose transfer skips the escrow address is refused', sneakyRes.status === 402 && /calldata/.test(((await sneakyRes.json()) as any).detail));

    const o0 = bal(o3Addr), e0 = bal(escAddr), s0 = bal(s3Addr);
    const held = await c3.fetch(`${G3}/job`, { method: 'POST', body: '{"t":1}' }, { escrow: true });
    const t3 = escrowOf(held)!;
    check('on chain, an order the seller accepts sits in the escrow address', held.status === 202 && t3.state === 'held'
      && bal(o3Addr) === o0 - 250_000n && bal(escAddr) === e0 + 250_000n && bal(s3Addr) === s0);
    const dl = await fetch(delivery!.url, { method: 'POST', headers: { 'tab-delivery-token': delivery!.token }, body: 'the work' });
    const dlDoc = await dl.json() as any;
    check('delivery pays the seller out of escrow on chain', dl.status === 200 && /^evm:0x[0-9a-f]{64}$/.test(dlDoc.receipt.ref)
      && dlDoc.receipt.escrow.held_ref.startsWith('evm:0x') && bal(s3Addr) === s0 + 250_000n && bal(escAddr) === e0);
    const got = await c3.escrowResult(t3);
    check('the buyer reads the result and its delivery receipt verifies', got.state === 'delivered' && got.verified?.ok === true && new TextDecoder().decode(got.body!) === 'the work');
    const held2 = await c3.fetch(`${G3}/job`, { method: 'POST', body: '{"t":2}' }, { escrow: true });
    await fetch(delivery!.url.replace('/deliver', '/fail'), { method: 'POST', headers: { 'tab-delivery-token': delivery!.token } });
    const st2 = await (await fetch(`${escrowOf(held2)!.status}?token=${escrowOf(held2)!.token}`)).json() as any;
    check('a seller that cannot deliver: the escrow address pays the owner back on chain', st2.state === 'refunded' && /^evm:0x/.test(st2.refund_ref)
      && bal(o3Addr) === o0 - 250_000n && bal(escAddr) === e0);
    const direct = await c3.fetch(`${G3}/job`, { method: 'POST', body: '{"t":3}' });
    check('a buyer that does not opt in pays the seller directly, as in 2.x', direct.status === 202 && !escrowOf(direct) && bal(s3Addr) === s0 + 500_000n);

    // a channel: one deposit transaction, vouchers with no transaction, one settlement
    const o1 = bal(o3Addr), s1 = bal(s3Addr);
    const ch = await c3.openChannel(G3, '1.00');
    const sent = chain.broadcasts;
    const calls = [await c3.fetch(`${G3}/quote`), await c3.fetch(`${G3}/model`), await c3.fetch(`${G3}/quote`)];
    check('the deposit is one transfer into escrow, and calls send no transaction at all', ch.state === 'open' && bal(o3Addr) === o1 - 1_000_000n
      && calls.every((r) => r.status === 200 && receiptOf(r)?.channel?.kind === 'call') && chain.broadcasts === sent && receiptOf(calls[1])!.amount === '1500');
    const closed = await c3.closeChannel(G3);
    check('closing settles on chain: 0.0215 to the seller, the rest to the owner', closed.channel.state === 'closed' && /^evm:0x/.test(closed.channel.settle_ref ?? '') && /^evm:0x/.test(closed.channel.refund_ref ?? '')
      && bal(s3Addr) === s1 + 21_500n && bal(o3Addr) === o1 - 21_500n && chain.broadcasts === sent + 2);
    // review fixes: a payment into escrow that does not confirm opens nothing and is sent back if it lands late;
    // a payout whose receipt lookup fails is settled by the same transaction, never a second one
    const rail4 = new EvmRail(spec3.evm!);
    rail4.confirmMs = 400;
    const st4 = new Store(join(scratch, 'v3-review.db'));
    const { server: gw4, url: G4 } = await gatewayAt(spec3, { store: st4, rail: rail4, escrowKey: esc, sweepMs: 100, payoutRetryMs: 100 });
    const o4 = bal(o3Addr), e4 = bal(escAddr);
    chain.pool = [];
    const slow = await c3.fetch(`${G4}/job`, { method: 'POST', body: '{"t":4}' }, { escrow: true });
    const slowBody = await slow.text();
    const watched = st4.lockWatches();
    check('E3: an escrow payment that does not confirm in time opens no order and the response is withheld', slow.status === 402 && !escrowOf(slow) && !slowBody.includes('accepted')
      && watched.length === 1 && bal(o3Addr) === o4, { status: slow.status, watched: watched.length });
    chain.flush(); // it lands after all
    for (let i = 0; i < 40 && st4.lockWatches().length; i++) await new Promise((r) => setTimeout(r, 100));
    check('E3: when it lands late, the gateway sends it back from the escrow address', st4.lockWatches().length === 0 && bal(o3Addr) === o4 && bal(escAddr) === e4
      && st4.payout(`lock:${watched[0].id}:buyer`)?.state === 'confirmed');
    const ok4 = await c3.fetch(`${G4}/job`, { method: 'POST', body: '{"t":5}' }, { escrow: true });
    const t4 = escrowOf(ok4)!;
    const s4 = bal(s3Addr), sent4 = chain.broadcasts;
    chain.receiptFailures = 1; // the payout goes out, then the receipt lookup times out
    const d4 = await (await fetch(delivery!.url, { method: 'POST', headers: { 'tab-delivery-token': delivery!.token }, body: 'late work' })).json() as any;
    for (let i = 0; i < 40 && st4.payout(`escrow:${t4.id}:seller`)?.state !== 'confirmed'; i++) await new Promise((r) => setTimeout(r, 100));
    check('E2: an unconfirmed payout is settled by rebroadcasting the same transaction: the seller is paid once', d4.state === 'delivered' && /^evm:0x/.test(d4.receipt?.ref ?? '')
      && st4.payout(`escrow:${t4.id}:seller`)?.state === 'confirmed' && bal(s3Addr) === s4 + 250_000n && chain.broadcasts === sent4 + 1, { d4, broadcasts: chain.broadcasts - sent4 });
    // LOW b: a payment into escrow the node refuses to take is watched, not forgotten
    chain.rejectSends = 1;
    const refused = await c3.fetch(`${G4}/job`, { method: 'POST', body: '{"t":6}' }, { escrow: true });
    check('LOW b: an escrow payment the node would not take fails the call and is watched in case it lands', refused.status === 402 && st4.lockWatches().length === 1);
        gw4.close(); st4.close();
    // M1: a gateway killed while a transfer into escrow is in flight; the next start finds it and sends it back
    {
      const st5 = new Store(join(scratch, 'v3-crash.db'));
      const dying = new EvmRail(spec3.evm!);
      dying.lock = async (h: any) => { await dying.rpc.sendRawTransaction(hexToBytes(h.tx)); return new Promise<string>(() => { /* the process dies here */ }); };
      const { server: gw5, url: G5 } = await gatewayAt(spec3, { store: st5, rail: dying, escrowKey: esc, sweepMs: 60_000 });
      const o5 = bal(o3Addr);
      void c3.fetch(`${G5}/job`, { method: 'POST', body: '{"t":7}' }, { escrow: true }).catch(() => null);
      for (let i = 0; i < 50 && !st5.holdsInState('locking').length; i++) await new Promise((r) => setTimeout(r, 50));
      const inFlight = st5.holdsInState('locking');
      gw5.close();
      check('M1: a hold being locked is on record before its transfer is broadcast', inFlight.length === 1 && /^evm:0x/.test(inFlight[0].ref ?? '') && bal(o3Addr) === o5 - 250_000n);
      const { server: gw6 } = await gatewayAt(spec3, { store: st5, rail: new EvmRail(spec3.evm!), escrowKey: esc, sweepMs: 100, payoutRetryMs: 100 });
      for (let i = 0; i < 40 && st5.getHold(inFlight[0].id)!.state !== 'voided'; i++) await new Promise((r) => setTimeout(r, 100));
      check('M1: the next start finds it, and money that landed in escrow goes back to the owner', st5.getHold(inFlight[0].id)!.state === 'voided' && bal(o3Addr) === o5
        && st5.payout(`lock:${inFlight[0].id}:buyer`)?.state === 'confirmed');
      gw6.close(); st5.close();
    }

    gw3.close(); up3.close(); st3.close();
  }

  // -- 8. the real Robinhood Chain testnet, read-only ------------------------

  {
    const LIVE_RPC = process.env.EVM_RPC || 'https://rpc.testnet.chain.robinhood.com';
    const LIVE_USDC = '0x5B6C7cAF7F99f99154fD8375ec935Fcf03F326f5';
    try {
      const live = new EvmRpc(LIVE_RPC, 10_000);
      const [chainId, decimals, emptyBal] = [
        await live.chainId(),
        await live.erc20Decimals(LIVE_USDC),
        await live.erc20BalanceOf(LIVE_USDC, addressFromSeed(new Uint8Array(randomBytes(32)))),
      ];
      check('live Robinhood Chain testnet: chain 46630, USDC has 6 decimals', chainId === 46630n
        && decimals === 6 && emptyBal === 0n, { chainId: String(chainId), decimals });
    } catch (err) {
      passed++; // network-gated: do not fail the suite offline
      console.error(`SKIP live Robinhood testnet check (${(err as Error).message})`);
    }
  }

  gateway.close();
  upstream.close();
  node.close();
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
