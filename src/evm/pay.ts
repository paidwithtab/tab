// The ERC-20 payment transaction both sides build from the same inputs: the
// agent to sign it, the gateway to know exactly what to expect. Type-2 tx,
// transferFrom(owner -> seller payout) with the agent as approved spender.

import { microToBaseUnits, type Challenge } from '../protocol.js';
import type { KeyPair } from '../keys.js';
import { scalarFromSeed } from './secp256k1.js';
import { erc20, signTx, hexToBig, bytesToHex, type Eip1559Tx } from './tx.js';

export function buildPaymentTx(chal: Challenge, evmOwner: string, nonce: bigint): Eip1559Tx {
  const info = chal.evm;
  if (!info) throw new Error('challenge has no evm info');
  return {
    chainId: BigInt(info.chain_id),
    nonce,
    maxPriorityFeePerGas: hexToBig(info.max_priority_fee_per_gas),
    maxFeePerGas: hexToBig(info.max_fee_per_gas),
    gasLimit: BigInt(info.gas_limit),
    to: info.token.toLowerCase(),
    value: 0n,
    // wire amounts are micro units; the token may have any decimals
    data: erc20.transferFrom(
      evmOwner.toLowerCase(),
      info.recipient.toLowerCase(),
      microToBaseUnits(BigInt(chal.amount), info.decimals),
    ),
  };
}

/** Agent side: build and sign with the secp256k1 key derived from the agent seed. */
export function buildSignedPaymentTxEvm(
  chal: Challenge,
  evmOwner: string,
  agent: KeyPair,
  nonce: bigint,
): string {
  const tx = buildPaymentTx(chal, evmOwner, nonce);
  const scalar = scalarFromSeed(new Uint8Array(Buffer.from(agent.privateKey, 'base64url')));
  return bytesToHex(signTx(tx, scalar).raw);
}
