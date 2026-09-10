// Program-derived addresses without any Solana library: SHA-256 plus an
// ed25519 "is this point on the curve" check done with BigInt field math.

import { createHash } from 'node:crypto';
import { b58decode32 } from './base58.js';

export const SYSTEM_PROGRAM = b58decode32('11111111111111111111111111111111');
export const TOKEN_PROGRAM = b58decode32('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ATA_PROGRAM = b58decode32('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const MEMO_PROGRAM = b58decode32('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
export const COMPUTE_BUDGET_PROGRAM = b58decode32('ComputeBudget111111111111111111111111111111');

const P = 2n ** 255n - 19n;
// d = -121665/121666 mod p
const D = (((-121665n % P) + P) % P) * modInverse(121666n, P) % P;
const SQRT_M1 = modPow(2n, (P - 1n) / 4n, P);

function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let r = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % mod;
    base = (base * base) % mod;
    exp >>= 1n;
  }
  return r;
}

function modInverse(a: bigint, mod: bigint): bigint {
  return modPow(((a % mod) + mod) % mod, mod - 2n, mod);
}

/** Can these 32 bytes be decompressed into a point on the ed25519 curve? */
export function onCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const signX = (bytes[31] >> 7) & 1;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P; // y^2 - 1
  const v = (D * y2 + 1n) % P; // d*y^2 + 1
  // RFC 8032 recovery: x = (u/v)^((p+3)/8) computed as u v^3 (u v^7)^((p-5)/8)
  const uv3 = (u * modPow(v, 3n, P)) % P;
  const uv7 = (u * modPow(v, 7n, P)) % P;
  let x = (uv3 * modPow(uv7, (P - 5n) / 8n, P)) % P;
  const vx2 = (v * x * x) % P;
  if (vx2 !== u) {
    if (vx2 !== (P - u) % P) return false;
    x = (x * SQRT_M1) % P;
  }
  if (x === 0n && signX === 1) return false;
  return true;
}

export function findProgramAddress(
  seeds: Uint8Array[],
  programId: Uint8Array,
): [Uint8Array, number] {
  for (let bump = 255; bump >= 0; bump--) {
    const h = createHash('sha256');
    for (const s of seeds) h.update(s);
    h.update(Uint8Array.of(bump));
    h.update(programId);
    h.update(Buffer.from('ProgramDerivedAddress'));
    const candidate = new Uint8Array(h.digest());
    if (!onCurve(candidate)) return [candidate, bump];
  }
  throw new Error('unable to find a program address');
}

/** The associated token account of `owner` for `mint`. All inputs raw 32 bytes. */
export function ata(owner: Uint8Array, mint: Uint8Array): Uint8Array {
  return findProgramAddress([owner, TOKEN_PROGRAM, mint], ATA_PROGRAM)[0];
}
