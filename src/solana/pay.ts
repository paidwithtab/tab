// The payment transaction both sides build from the same inputs: the agent to
// sign it, the gateway to know exactly what bytes to expect. Legacy tx, Token
// program only, 6-decimal mints, memo = challenge id.

import type { Challenge } from '../protocol.js';
import { pubBytes, signBytes, type KeyPair } from '../keys.js';
import { b58encode, b58decode32 } from './base58.js';
import { ata } from './pda.js';
import { setComputeUnitLimit, createAtaIdempotent, transferChecked, memo } from './instructions.js';
import { compileMessage, serializeTransaction, type CompiledMessage } from './tx.js';

export const PAYMENT_COMPUTE_LIMIT = 100_000;

/**
 * The canonical payment message for a challenge:
 *   1. compute budget: SetComputeUnitLimit
 *   2. create the recipient's ATA if missing (idempotent, fee payer pays rent)
 *   3. TransferChecked from the owner's ATA, agent as delegate authority
 *   4. memo carrying the challenge id
 * Signers: fee payer (slot 0), agent (slot 1).
 */
export function buildPaymentMessage(
  chal: Challenge,
  ownerPub: string, // wallet id, base64url
  agentPub: string, // wallet id, base64url
): CompiledMessage {
  const info = chal.solana;
  if (!info) throw new Error('challenge has no solana info');
  const mint = b58decode32(info.mint);
  const feePayer = b58decode32(info.fee_payer);
  const owner = pubBytes(ownerPub);
  const agent = pubBytes(agentPub);
  const recipient = pubBytes(chal.recipient);
  const ownerAta = ata(owner, mint);
  const recipientAta = ata(recipient, mint);
  const amount = BigInt(chal.amount); // micro-USD == base units for 6-decimal mints
  return compileMessage(feePayer, info.recent_blockhash, [
    setComputeUnitLimit(PAYMENT_COMPUTE_LIMIT),
    createAtaIdempotent(feePayer, recipientAta, recipient, mint),
    transferChecked(ownerAta, mint, recipientAta, agent, amount, info.decimals),
    memo(chal.id),
  ]);
}

/** Agent side: build, sign slot 1, leave the fee payer slot zeroed. Returns base64. */
export function buildSignedPaymentTx(chal: Challenge, ownerPub: string, agent: KeyPair): string {
  const compiled = buildPaymentMessage(chal, ownerPub, agent.publicKey);
  const agent58 = b58encode(pubBytes(agent.publicKey));
  const slot = compiled.accounts.indexOf(agent58);
  if (slot < 0 || slot >= compiled.numRequiredSignatures) {
    throw new Error('agent is not a signer of the payment transaction');
  }
  const signatures = Array.from({ length: compiled.numRequiredSignatures }, () => new Uint8Array(64));
  signatures[slot] = new Uint8Array(Buffer.from(signBytes(agent, compiled.bytes), 'base64url'));
  return Buffer.from(serializeTransaction({ signatures, message: compiled.bytes })).toString('base64');
}
