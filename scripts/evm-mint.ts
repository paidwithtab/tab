// One-off helper: mint from an open-mint testnet ERC-20 (e.g. Robinhood testnet
// USDC, or tab's test token), using tab's own evm primitives. Testnet only.
// The amount is in whole tokens; the script reads the token's decimals.
//   npx tsx scripts/evm-mint.ts <key.json> <token 0x> <amount> [rpc]

import { loadKey, pubBytes } from '../src/keys.js';
import { usdToMicro, microToBaseUnits } from '../src/protocol.js';
import { addressFromSeed } from '../src/evm/secp256k1.js';
import { scalarFromSeed } from '../src/evm/secp256k1.js';
import { EvmRpc } from '../src/evm/rpc.js';
import { signTx, hexToBytes, bytesToHex } from '../src/evm/tx.js';
import { keccak256 } from '../src/evm/keccak.js';

function selector(sig: string): string {
  return bytesToHex(keccak256(new Uint8Array(Buffer.from(sig, 'ascii'))).slice(0, 4));
}

async function main() {
  const [keyPath, token, amountUsd, rpcArg] = process.argv.slice(2);
  if (!keyPath || !token || !amountUsd) {
    console.error('usage: evm-mint.ts <key.json> <token 0x> <amountUsd> [rpc]');
    process.exit(1);
  }
  const rpc = new EvmRpc(rpcArg || 'https://rpc.testnet.chain.robinhood.com');
  const key = loadKey(keyPath);
  const seed = new Uint8Array(Buffer.from(key.privateKey, 'base64url'));
  const addr = addressFromSeed(seed);
  const scalar = scalarFromSeed(seed);
  const decimals = await rpc.erc20Decimals(token.toLowerCase());
  const amount = microToBaseUnits(BigInt(usdToMicro(amountUsd)), decimals);

  // mint(address,uint256)
  const data =
    selector('mint(address,uint256)').slice(2) +
    addr.slice(2).padStart(64, '0') +
    amount.toString(16).padStart(64, '0');

  const gasPrice = await rpc.gasPrice();
  const tip = await rpc.maxPriorityFeePerGas();
  const tx = {
    chainId: await rpc.chainId(),
    nonce: await rpc.transactionCount(addr),
    maxPriorityFeePerGas: tip,
    maxFeePerGas: gasPrice * 2n + tip,
    gasLimit: 150_000n,
    to: token.toLowerCase(),
    value: 0n,
    data: hexToBytes('0x' + data),
  };
  const { raw, hash } = signTx(tx, scalar);
  console.log(`minting ${amountUsd} to ${addr} on token ${token} ...`);
  const sent = await rpc.sendRawTransaction(raw);
  console.log('tx:', sent);
  await rpc.waitForReceipt(sent);
  const bal = await rpc.erc20BalanceOf(token, addr);
  console.log('done. balance now:', Number(bal) / 10 ** decimals);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
