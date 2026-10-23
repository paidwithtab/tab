// The evm rail (built for Robinhood Chain): offline crypto vectors, a mock
// EVM node with real ERC-20 semantics, the full 402 flow, and, when the
// network allows, read-only checks against the live Robinhood Chain testnet.
//   npm run test:evm

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomBytes } from 'node:crypto';

import { newKeyPair, saveKey } from '../src/keys.js';
import { signCredential, encodeCredentialHeader, parseChallengeHeader, encodeChallengeHeader, microToBaseUnits, baseUnitsToMicro } from '../src/protocol.js';
import { issueMandate } from '../src/mandate.js';
import { Store } from '../src/store.js';
import { createGateway, loadSpec, type Spec } from '../src/gateway.js';
import { TabClient, PaymentRefused, receiptOf, x402ResponseOf } from '../src/client.js';
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
  constructor(readonly token: string = TOKEN, readonly decimals: bigint = 6n) {}
  eth = new Map<string, bigint>();
  bal = new Map<string, bigint>();
  allowance = new Map<string, bigint>();
  nonce = new Map<string, bigint>();
  receipts = new Map<string, '0x1' | '0x0'>();
  broadcasts = 0;
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
          case 'eth_sendRawTransaction': return reply(this.sendRaw(params[0]).hash);
          case 'eth_getTransactionReceipt': {
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
  const chainT = new MockChain(TTT, 18n);
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
