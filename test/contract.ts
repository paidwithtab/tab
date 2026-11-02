// contracts/TabChannel.sol on a real EVM (ganache, in-process chain id 46630), driven
// by tab's own transaction signing and the voucher code in src/evm/channel.ts:
// open, cumulative vouchers, the payee's close, replay, forged and oversized
// vouchers, a unilateral close the payee answers inside the dispute window, one it
// does not, and an expired channel. The compiled artifacts are in contracts/*.json.
//   GANACHE=/path/to/ganache/dist/node/cli.js npm run test:contract
// Without ganache it says so and passes nothing; it is not part of the default run.

import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { readFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { createServer } from 'node:net';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

import { newKeyPair, saveKey } from '../src/keys.js';
import { addressFromSeed, scalarFromSeed } from '../src/evm/secp256k1.js';
import { EvmRpc, EvmRevert } from '../src/evm/rpc.js';
import { signTx, erc20, bytesToHex, hexToBytes, selector } from '../src/evm/tx.js';
import { rlpEncode } from '../src/evm/rlp.js';
import { keccak256 } from '../src/evm/keccak.js';
import { bigToMinimal } from '../src/evm/tx.js';
import { channelId, signChannelVoucher, channelVoucherSigner, voucherDigest, tabChannel, decodeChannel } from '../src/evm/channel.js';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, extra?: unknown): void {
  if (cond) passed++;
  else {
    failed++;
    console.error(`FAIL ${name}${extra !== undefined ? ` :: ${JSON.stringify(extra)}` : ''}`);
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAIN_ID = 46630;

function findGanache(): string | null {
  if (process.env.GANACHE && existsSync(process.env.GANACHE)) return process.env.GANACHE;
  const local = join(root, 'node_modules', 'ganache', 'dist', 'node', 'cli.js');
  return existsSync(local) ? local : null;
}

const freePort = (): Promise<number> => new Promise((resolve) => {
  const s = createServer();
  s.listen(0, () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); });
});

async function main(): Promise<void> {
  const ganache = findGanache();
  if (!ganache) {
    console.log('skipped: no ganache. Run with GANACHE=/path/to/ganache/dist/node/cli.js (npm i ganache@7.9.2 anywhere outside the repo)');
    console.log('\n0 passed, 0 failed (skipped)');
    return;
  }
  const keys = { payer: newKeyPair(), payee: newKeyPair(), signer: newKeyPair(), stranger: newKeyPair() };
  const seed = (k: { privateKey: string }) => new Uint8Array(Buffer.from(k.privateKey, 'base64url'));
  const addr = Object.fromEntries(Object.entries(keys).map(([n, k]) => [n, addressFromSeed(seed(k))])) as Record<keyof typeof keys, string>;
  const scalar = (k: { privateKey: string }) => scalarFromSeed(seed(k));
  const port = await freePort();
  const accounts = Object.values(keys).flatMap((k) => ['--wallet.accounts', `0x${scalar(k).toString(16).padStart(64, '0')},0x${(10n ** 20n).toString(16)}`]);
  const proc: ChildProcess = spawn(process.execPath, [ganache, '--chain.chainId', String(CHAIN_ID), '--server.port', String(port), '--logging.quiet', ...accounts], { stdio: 'ignore' });
  const rpc = new EvmRpc(`http://127.0.0.1:${port}`, 10_000);
  for (let i = 0; i < 100; i++) { try { await rpc.chainId(); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
  try {
    check('a real EVM on chain 46630', (await rpc.chainId()) === BigInt(CHAIN_ID));

    const send = async (from: { privateKey: string }, to: string, data: Uint8Array, gas = 400_000n): Promise<string> => {
      const tip = 10n ** 9n;
      const { raw, hash } = signTx({ chainId: BigInt(CHAIN_ID), nonce: await rpc.transactionCount(addressFromSeed(seed(from))), maxPriorityFeePerGas: tip, maxFeePerGas: (await rpc.gasPrice()) * 2n + tip, gasLimit: gas, to, value: 0n, data }, scalar(from));
      await rpc.sendRawTransaction(raw);
      await rpc.waitForReceipt(hash);
      return hash;
    };
    const deploy = async (from: { privateKey: string }, artifact: string): Promise<string> => {
      const { bytecode } = JSON.parse(readFileSync(join(root, artifact), 'utf8')) as { bytecode: string };
      const sender = addressFromSeed(seed(from));
      const nonce = await rpc.transactionCount(sender);
      await send(from, '0x', hexToBytes(bytecode), 3_000_000n);
      return bytesToHex(keccak256(rlpEncode([hexToBytes(sender), bigToMinimal(nonce)])).slice(12));
    };
    const reverts = async (from: string, to: string, data: Uint8Array, why: RegExp): Promise<boolean> => {
      try { await rpc.ethCall(to, data, from); return false; } catch (e) { return e instanceof EvmRevert ? why.test((e as Error).message) || why.source === '.' : false; }
    };
    const bal = async (who: string) => rpc.erc20BalanceOf(token, who);
    const increaseTime = async (s: number) => { await rpc.call('evm_increaseTime', [s]); await rpc.call('evm_mine', []); };
    const now = async () => BigInt((await rpc.call('eth_getBlockByNumber', ['latest', false])).timestamp);

    const token = await deploy(keys.payer, 'contracts/test/TestToken.json');
    const channel = await deploy(keys.payer, 'contracts/TabChannel.json');
    const c = { chainId: CHAIN_ID, address: channel };
    check('TabChannel and a test token deploy', (await rpc.call('eth_getCode', [channel, 'latest'])).length > 100);
    await send(keys.payer, token, new Uint8Array([...selector('mint(address,uint256)'), ...erc20.transfer(addr.payer, 10_000_000n).slice(4)]));
    await send(keys.payer, token, erc20.approve(channel, 10_000_000n));

    // the TypeScript digest is the contract's
    const probeId = channelId(addr.payer, '0x' + '11'.repeat(32));
    const onChainDigest = await rpc.ethCall(channel, new Uint8Array([...selector('voucherDigest(bytes32,uint256)'), ...hexToBytes(probeId), ...hexToBytes('0x' + (123n).toString(16).padStart(64, '0'))]));
    check('the voucher digest in TypeScript matches the contract', onChainDigest.toLowerCase() === bytesToHex(voucherDigest(c, probeId, 123n)));

    const open = async (deposit: bigint, ttl: bigint, window: number) => {
      const salt = '0x' + randomBytes(32).toString('hex');
      await send(keys.payer, channel, tabChannel.open(salt, addr.payee, addr.signer, token, deposit, (await now()) + ttl, window));
      return channelId(addr.payer, salt);
    };

    // 1. open, two cumulative vouchers, the payee closes with the higher one
    const p0 = await bal(addr.payer);
    const id = await open(1_000_000n, 3600n, 120);
    const ch = decodeChannel(await rpc.ethCall(channel, tabChannel.channels(id)));
    check('opening moves the deposit into the contract', ch.payer === addr.payer && ch.signer === addr.signer && ch.deposit === 1_000_000n && (await bal(channel)) === 1_000_000n && (await bal(addr.payer)) === p0 - 1_000_000n);
    const v30 = signChannelVoucher(c, id, 300_000n, scalar(keys.signer));
    const v45 = signChannelVoucher(c, id, 450_000n, scalar(keys.signer));
    check('vouchers recover to the signer', channelVoucherSigner(c, id, 450_000n, v45) === addr.signer);
    check('only the payee can close with a voucher', await reverts(addr.stranger, channel, tabChannel.close(id, 450_000n, v45), /only the payee/));
    check('a voucher above the deposit is refused', await reverts(addr.payee, channel, tabChannel.close(id, 2_000_000n, signChannelVoucher(c, id, 2_000_000n, scalar(keys.signer))), /above deposit/));
    check('a voucher signed by anyone else is refused', await reverts(addr.payee, channel, tabChannel.close(id, 450_000n, signChannelVoucher(c, id, 450_000n, scalar(keys.stranger))), /bad voucher/));
    check('a voucher for another amount is refused', await reverts(addr.payee, channel, tabChannel.close(id, 500_000n, v45), /bad voucher/));
    await send(keys.payee, channel, tabChannel.close(id, 450_000n, v45));
    check('the payee closes once: paid the voucher, the payer gets the rest', (await bal(addr.payee)) === 450_000n && (await bal(addr.payer)) === p0 - 450_000n && (await bal(channel)) === 0n);
    check('a closed channel cannot be closed again with an older voucher', await reverts(addr.payee, channel, tabChannel.close(id, 300_000n, v30), /no channel/));
    // reopening under the same payer and salt would bring the closed channel's vouchers back to life
    const reuseSalt = '0x' + '42'.repeat(32);
    await send(keys.payer, channel, tabChannel.open(reuseSalt, addr.payee, addr.signer, token, 100_000n, (await now()) + 3600n, 120));
    const reuseId = channelId(addr.payer, reuseSalt);
    await send(keys.payee, channel, tabChannel.close(reuseId, 50_000n, signChannelVoucher(c, reuseId, 50_000n, scalar(keys.signer))));
    check('a channel id is good once: reopening it with the same salt is refused', await reverts(addr.payer, channel, tabChannel.open(reuseSalt, addr.payee, addr.signer, token, 100_000n, (await now()) + 3600n, 120), /channel id used/));

    // 2. the payer starts a unilateral close; the payee answers inside the window
    const id2 = await open(500_000n, 3600n, 120);
    const v2 = signChannelVoucher(c, id2, 200_000n, scalar(keys.signer));
    check('a stranger cannot start a close', await reverts(addr.stranger, channel, tabChannel.startClose(id2), /only the payer/));
    await send(keys.payer, channel, tabChannel.startClose(id2));
    check('finalize waits out the dispute window', await reverts(addr.payer, channel, tabChannel.finalize(id2), /dispute window/));
    await send(keys.payee, channel, tabChannel.close(id2, 200_000n, v2));
    check('inside the window the payee still closes with its best voucher', (await bal(addr.payee)) === 700_000n);

    // 3. the payee never answers: after the window the payer takes the deposit back
    const id3 = await open(300_000n, 3600n, 120);
    const before3 = await bal(addr.payer);
    await send(keys.signer, channel, tabChannel.startClose(id3));
    await increaseTime(121);
    await send(keys.stranger, channel, tabChannel.finalize(id3));
    check('after the window anyone finalizes and the payer is refunded in full', (await bal(addr.payer)) === before3 + 300_000n);

    // 4. an expired channel lapses without anyone starting a close
    const id4 = await open(100_000n, 60n, 60);
    check('a live channel cannot be finalized', await reverts(addr.payer, channel, tabChannel.finalize(id4), /dispute window/));
    const before4 = await bal(addr.payer);
    await increaseTime(130);
    await send(keys.payer, channel, tabChannel.finalize(id4));
    check('past expiry plus the window the deposit goes back', (await bal(addr.payer)) === before4 + 100_000n);

    // 5. top up
    const id5 = await open(100_000n, 3600n, 60);
    await send(keys.payer, channel, tabChannel.topUp(id5, 50_000n));
    check('a top up raises the deposit', decodeChannel(await rpc.ethCall(channel, tabChannel.channels(id5))).deposit === 150_000n);

    // 6. the CLI deploys it, as an operator would on the testnet
    const dir = mkdtempSync(join(process.env.SCRATCH ?? tmpdir(), 'tab-contract-'));
    saveKey(join(dir, 'deployer.json'), keys.stranger);
    const { stdout } = await promisify(execFile)(process.execPath, ['--no-warnings=ExperimentalWarning', '--import', 'tsx', 'src/cli.ts', 'evm', 'deploy-channel', '--from', join(dir, 'deployer.json'), '--rpc', `http://127.0.0.1:${port}`], { cwd: root, encoding: 'utf8' });
    const out = JSON.parse(stdout) as { chain_id: number; contract: string };
    check('tab evm deploy-channel deploys the contract', out.chain_id === CHAIN_ID && (await rpc.call('eth_getCode', [out.contract.toLowerCase(), 'latest'])).length > 100);
    rmSync(dir, { recursive: true, force: true });
  } finally {
    proc.kill('SIGKILL');
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  console.log(`\n${passed} passed, ${failed + 1} failed (crashed)`);
  process.exit(1);
});
