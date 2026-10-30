// Send one transaction from a tab key's EVM account: the CLI's fund/approve commands and the
// company server's on-chain authorization both go through here.

import type { KeyPair } from '../keys.js';
import type { EvmRpc } from './rpc.js';
import { addressFromSeed, scalarFromSeed } from './secp256k1.js';
import { signTx } from './tx.js';

export const evmScalar = (pair: Pick<KeyPair, 'privateKey'>) => scalarFromSeed(new Uint8Array(Buffer.from(pair.privateKey, 'base64url')));
export const evmAddressOfKey = (pair: Pick<KeyPair, 'privateKey'>) => addressFromSeed(new Uint8Array(Buffer.from(pair.privateKey, 'base64url')));

/** Sign, broadcast and wait for one EIP-1559 transaction; returns its hash. */
export async function evmSend(rpc: EvmRpc, from: Pick<KeyPair, 'privateKey'>, to: string, value: bigint, data: Uint8Array): Promise<string> {
  const gasPrice = await rpc.gasPrice();
  const tip = await rpc.maxPriorityFeePerGas();
  const tx = {
    chainId: await rpc.chainId(),
    nonce: await rpc.transactionCount(evmAddressOfKey(from)),
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
