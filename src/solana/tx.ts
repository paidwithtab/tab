// Legacy Solana transactions: message compilation, shortvec, sign, (de)serialize.
// Deterministic on purpose — the gateway rebuilds the exact message from the
// challenge and compares byte-for-byte with what the agent sent.

import type { Instruction } from './instructions.js';
import { b58encode, b58decode32 } from './base58.js';

export function shortvecEncode(n: number): Uint8Array {
  const out: number[] = [];
  let v = n;
  for (;;) {
    let b = v & 0x7f;
    v >>= 7;
    if (v === 0) {
      out.push(b);
      return new Uint8Array(out);
    }
    out.push(b | 0x80);
  }
}

export function shortvecDecode(bytes: Uint8Array, offset: number): [number, number] {
  let v = 0;
  let shift = 0;
  let o = offset;
  for (;;) {
    const b = bytes[o++];
    v |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [v, o];
    shift += 7;
  }
}

export interface CompiledMessage {
  bytes: Uint8Array;
  accounts: string[]; // base58, in message order
  numRequiredSignatures: number;
}

/**
 * Compile a legacy message. Account order: fee payer first, then writable
 * signers, readonly signers, writable non-signers, readonly non-signers,
 * each class in first-appearance order. Program ids are readonly non-signers.
 */
export function compileMessage(
  feePayer: Uint8Array,
  recentBlockhash58: string,
  instructions: Instruction[],
): CompiledMessage {
  interface Meta { key: Uint8Array; b58: string; isSigner: boolean; isWritable: boolean }
  const metas: Meta[] = [];
  const index = new Map<string, Meta>();
  const add = (key: Uint8Array, isSigner: boolean, isWritable: boolean) => {
    const b58 = b58encode(key);
    const existing = index.get(b58);
    if (existing) {
      existing.isSigner ||= isSigner;
      existing.isWritable ||= isWritable;
    } else {
      const m = { key, b58, isSigner, isWritable };
      index.set(b58, m);
      metas.push(m);
    }
  };
  add(feePayer, true, true);
  for (const ix of instructions) {
    for (const k of ix.keys) add(k.pubkey, k.isSigner, k.isWritable);
    add(ix.programId, false, false);
  }
  const feePayer58 = b58encode(feePayer);
  const rest = metas.filter((m) => m.b58 !== feePayer58);
  const ordered = [
    metas[0],
    ...rest.filter((m) => m.isSigner && m.isWritable),
    ...rest.filter((m) => m.isSigner && !m.isWritable),
    ...rest.filter((m) => !m.isSigner && m.isWritable),
    ...rest.filter((m) => !m.isSigner && !m.isWritable),
  ];
  const pos = new Map(ordered.map((m, i) => [m.b58, i]));
  const numRequiredSignatures = ordered.filter((m) => m.isSigner).length;
  const numReadonlySigned = ordered.filter((m) => m.isSigner && !m.isWritable).length;
  const numReadonlyUnsigned = ordered.filter((m) => !m.isSigner && !m.isWritable).length;

  const parts: Uint8Array[] = [
    Uint8Array.of(numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned),
    shortvecEncode(ordered.length),
    ...ordered.map((m) => m.key),
    b58decode32(recentBlockhash58),
    shortvecEncode(instructions.length),
  ];
  for (const ix of instructions) {
    parts.push(Uint8Array.of(pos.get(b58encode(ix.programId))!));
    parts.push(shortvecEncode(ix.keys.length));
    parts.push(new Uint8Array(ix.keys.map((k) => pos.get(b58encode(k.pubkey))!)));
    parts.push(shortvecEncode(ix.data.length));
    parts.push(ix.data);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const bytes = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return { bytes, accounts: ordered.map((m) => m.b58), numRequiredSignatures };
}

export interface WireTransaction {
  signatures: Uint8Array[]; // 64 bytes each; all-zero = missing
  message: Uint8Array;
}

export function serializeTransaction(tx: WireTransaction): Uint8Array {
  const parts = [shortvecEncode(tx.signatures.length), ...tx.signatures, tx.message];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function deserializeTransaction(bytes: Uint8Array): WireTransaction {
  const [n, afterLen] = shortvecDecode(bytes, 0);
  const signatures: Uint8Array[] = [];
  let o = afterLen;
  for (let i = 0; i < n; i++) {
    signatures.push(bytes.slice(o, o + 64));
    o += 64;
  }
  return { signatures, message: bytes.slice(o) };
}

/** The base58 account list of a serialized message (to locate signer slots). */
export function messageAccounts(message: Uint8Array): { accounts: string[]; numRequiredSignatures: number } {
  const numRequiredSignatures = message[0];
  const [count, afterLen] = shortvecDecode(message, 3);
  const accounts: string[] = [];
  for (let i = 0; i < count; i++) {
    accounts.push(b58encode(message.slice(afterLen + i * 32, afterLen + (i + 1) * 32)));
  }
  return { accounts, numRequiredSignatures };
}

export function isZeroSignature(sig: Uint8Array): boolean {
  return sig.every((b) => b === 0);
}
