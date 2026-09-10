// SPL / system / memo / compute-budget instruction encoding. Only what tab uses.

import {
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  ATA_PROGRAM,
  MEMO_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
} from './pda.js';

export interface AccountMeta {
  pubkey: Uint8Array; // raw 32 bytes
  isSigner: boolean;
  isWritable: boolean;
}

export interface Instruction {
  programId: Uint8Array;
  keys: AccountMeta[];
  data: Uint8Array;
}

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function u64le(n: bigint): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, n, true);
  return b;
}

function cat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function setComputeUnitLimit(units: number): Instruction {
  return { programId: COMPUTE_BUDGET_PROGRAM, keys: [], data: cat(Uint8Array.of(2), u32le(units)) };
}

export function createAtaIdempotent(
  payer: Uint8Array,
  ataAddr: Uint8Array,
  owner: Uint8Array,
  mint: Uint8Array,
): Instruction {
  return {
    programId: ATA_PROGRAM,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ataAddr, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
    data: Uint8Array.of(1), // CreateIdempotent
  };
}

export function transferChecked(
  source: Uint8Array,
  mint: Uint8Array,
  destination: Uint8Array,
  authority: Uint8Array,
  amount: bigint,
  decimals: number,
): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: cat(Uint8Array.of(12), u64le(amount), Uint8Array.of(decimals)),
  };
}

export function approveChecked(
  source: Uint8Array,
  mint: Uint8Array,
  delegate: Uint8Array,
  owner: Uint8Array,
  amount: bigint,
  decimals: number,
): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: delegate, isSigner: false, isWritable: false },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: cat(Uint8Array.of(13), u64le(amount), Uint8Array.of(decimals)),
  };
}

export function revoke(source: Uint8Array, owner: Uint8Array): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Uint8Array.of(5),
  };
}

export function mintTo(
  mint: Uint8Array,
  destination: Uint8Array,
  authority: Uint8Array,
  amount: bigint,
): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data: cat(Uint8Array.of(7), u64le(amount)),
  };
}

export function initializeMint2(
  mint: Uint8Array,
  decimals: number,
  mintAuthority: Uint8Array,
): Instruction {
  return {
    programId: TOKEN_PROGRAM,
    keys: [{ pubkey: mint, isSigner: false, isWritable: true }],
    data: cat(Uint8Array.of(20, decimals), mintAuthority, Uint8Array.of(0)), // no freeze authority
  };
}

export function systemCreateAccount(
  from: Uint8Array,
  newAccount: Uint8Array,
  lamports: bigint,
  space: bigint,
  owner: Uint8Array,
): Instruction {
  return {
    programId: SYSTEM_PROGRAM,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: newAccount, isSigner: true, isWritable: true },
    ],
    data: cat(u32le(0), u64le(lamports), u64le(space), owner),
  };
}

export function memo(text: string): Instruction {
  return { programId: MEMO_PROGRAM, keys: [], data: new Uint8Array(Buffer.from(text, 'utf8')) };
}
