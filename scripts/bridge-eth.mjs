// Deposit ETH from the owner on Ethereum mainnet into Robinhood Chain mainnet through the
// canonical bridge (the Delayed Inbox). Gas for the owner and agent on Robinhood Chain.
//   node scripts/bridge-eth.mjs [amountEth]      default 0.0019
// The Inbox address is from docs.robinhood.com/chain/cross-chain-messaging and was verified on chain:
// inbox.bridge() -> 0xDf87...64b3, bridge.rollup() -> 0x23A1...2D94, rollup.chainId() -> 4663.
import { loadKey } from '../dist/src/keys.js';
import { addressFromSeed, scalarFromSeed } from '../dist/src/evm/secp256k1.js';
import { EvmRpc } from '../dist/src/evm/rpc.js';
import { signTx, hexToBytes } from '../dist/src/evm/tx.js';

const INBOX = '0x1a07cc4bd17e0118bdb54d70990d2158abad7a2d';
const L1 = process.env.L1_RPC || 'https://ethereum-rpc.publicnode.com';
const L2 = 'https://rpc.mainnet.chain.robinhood.com';
const amountEth = process.argv[2] || '0.0019';
const value = BigInt(Math.round(Number(amountEth) * 1e6)) * 1_000_000_000_000n;

const rpc = new EvmRpc(L1);
const key = loadKey(new URL('../keys/mainnet-owner.json', import.meta.url).pathname);
const seed = new Uint8Array(Buffer.from(key.privateKey, 'base64url'));
const addr = addressFromSeed(seed);
const scalar = scalarFromSeed(seed);

const chainId = await rpc.chainId();
if (chainId !== 1n) throw new Error('L1 rpc is not ethereum mainnet: chain ' + chainId);
const gasPrice = await rpc.gasPrice();
const tip = await rpc.maxPriorityFeePerGas();
const tx = {
  chainId,
  nonce: await rpc.transactionCount(addr),
  maxPriorityFeePerGas: tip,
  maxFeePerGas: gasPrice * 2n + tip,
  gasLimit: 150_000n,
  to: INBOX,
  value,
  data: hexToBytes('0x439370b1'), // depositEth()
};
const bal = await rpc.balance(addr);
const maxFee = tx.maxFeePerGas * tx.gasLimit;
console.log(`owner ${addr}`);
console.log(`L1 balance ${Number(bal) / 1e18} ETH, depositing ${Number(value) / 1e18} ETH, max fee ${Number(maxFee) / 1e18} ETH`);
if (bal < value + maxFee) throw new Error('balance too low for the deposit plus the max fee; pass a smaller amount');

const { raw } = signTx(tx, scalar);
const hash = await rpc.sendRawTransaction(raw);
console.log('L1 tx:', hash);
console.log('https://etherscan.io/tx/' + hash);
await rpc.waitForReceipt(hash, 300_000);
console.log('L1 confirmed. Waiting for the credit on Robinhood Chain (usually a few minutes)...');

const l2 = new EvmRpc(L2);
const before = await l2.balance(addr);
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 15_000));
  const now = await l2.balance(addr);
  if (now > before) {
    console.log(`arrived: ${Number(now) / 1e18} ETH on Robinhood Chain mainnet`);
    process.exit(0);
  }
  process.stdout.write('.');
}
console.log('\nnot credited after 15 minutes; check the address on https://robinhoodchain.blockscout.com');
