// secp256k1 ECDSA for Ethereum: deterministic RFC 6979 signatures over a
// keccak digest, low-s normalization (EIP-2), a recovery id, and ecrecover.
// Hand-written on BigInt (Jacobian coordinates); public-key derivation is
// cross-checked against OpenSSL's implementation in test/evm.ts.

import { createHmac, createECDH } from 'node:crypto';
import { keccak256 } from './keccak.js';

export const P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
export const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

const mod = (a: bigint, m: bigint): bigint => ((a % m) + m) % m;

function modPow(base: bigint, exp: bigint, m: bigint): bigint {
  let r = 1n;
  base = mod(base, m);
  while (exp > 0n) {
    if (exp & 1n) r = (r * base) % m;
    base = (base * base) % m;
    exp >>= 1n;
  }
  return r;
}

const inv = (a: bigint, m: bigint): bigint => modPow(a, m - 2n, m);

// Jacobian point: [X, Y, Z]; affine x = X/Z^2, y = Y/Z^3. Z=0 is infinity.
type Jac = [bigint, bigint, bigint];
const INF: Jac = [0n, 1n, 0n];

function jDouble([X, Y, Z]: Jac): Jac {
  if (Z === 0n || Y === 0n) return INF;
  const A = mod(X * X, P);
  const B = mod(Y * Y, P);
  const C = mod(B * B, P);
  const D = mod(2n * (mod((X + B) * (X + B), P) - A - C), P);
  const E = mod(3n * A, P);
  const F = mod(E * E, P);
  const X3 = mod(F - 2n * D, P);
  const Y3 = mod(E * (D - X3) - 8n * C, P);
  const Z3 = mod(2n * Y * Z, P);
  return [X3, Y3, Z3];
}

function jAdd(p1: Jac, p2: Jac): Jac {
  if (p1[2] === 0n) return p2;
  if (p2[2] === 0n) return p1;
  const [X1, Y1, Z1] = p1;
  const [X2, Y2, Z2] = p2;
  const Z1Z1 = mod(Z1 * Z1, P);
  const Z2Z2 = mod(Z2 * Z2, P);
  const U1 = mod(X1 * Z2Z2, P);
  const U2 = mod(X2 * Z1Z1, P);
  const S1 = mod(Y1 * Z2 * Z2Z2, P);
  const S2 = mod(Y2 * Z1 * Z1Z1, P);
  const H = mod(U2 - U1, P);
  const R = mod(S2 - S1, P);
  if (H === 0n) return R === 0n ? jDouble(p1) : INF;
  const HH = mod(H * H, P);
  const HHH = mod(H * HH, P);
  const V = mod(U1 * HH, P);
  const X3 = mod(R * R - HHH - 2n * V, P);
  const Y3 = mod(R * (V - X3) - S1 * HHH, P);
  const Z3 = mod(H * Z1 * Z2, P);
  return [X3, Y3, Z3];
}

function jMul(point: Jac, k: bigint): Jac {
  let result = INF;
  let addend = point;
  while (k > 0n) {
    if (k & 1n) result = jAdd(result, addend);
    addend = jDouble(addend);
    k >>= 1n;
  }
  return result;
}

function toAffine([X, Y, Z]: Jac): { x: bigint; y: bigint } {
  if (Z === 0n) throw new Error('point at infinity');
  const zi = inv(Z, P);
  const zi2 = mod(zi * zi, P);
  return { x: mod(X * zi2, P), y: mod(Y * zi2 * zi, P) };
}

const G: Jac = [GX, GY, 1n];

// -- helpers ----------------------------------------------------------------

export function bytesToBig(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

export function bigToBytes(n: bigint, len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  return out;
}

/** Map a 32-byte seed (a tab key file's private key) to a valid scalar. */
export function scalarFromSeed(seed: Uint8Array): bigint {
  return (bytesToBig(seed) % (N - 1n)) + 1n;
}

/** Uncompressed public key (64 bytes, x||y) for a private scalar, via OpenSSL. */
export function publicKey(d: bigint): Uint8Array {
  const ecdh = createECDH('secp256k1');
  ecdh.setPrivateKey(Buffer.from(bigToBytes(d, 32)));
  return new Uint8Array(ecdh.getPublicKey().subarray(1)); // strip the 0x04 prefix
}

/** Same derivation done with our own point math (used to cross-check OpenSSL). */
export function publicKeyOwnMath(d: bigint): Uint8Array {
  const { x, y } = toAffine(jMul(G, d));
  const out = new Uint8Array(64);
  out.set(bigToBytes(x, 32), 0);
  out.set(bigToBytes(y, 32), 32);
  return out;
}

/** Ethereum address (lowercase 0x hex) of a public key. */
export function pubToAddress(pub64: Uint8Array): string {
  return '0x' + Buffer.from(keccak256(pub64).slice(12)).toString('hex');
}

export function addressFromSeed(seed: Uint8Array): string {
  return pubToAddress(publicKey(scalarFromSeed(seed)));
}

/** EIP-55 checksum casing, for display. */
export function checksumAddress(addr: string): string {
  const lower = addr.toLowerCase().replace(/^0x/, '');
  const hash = Buffer.from(keccak256(new Uint8Array(Buffer.from(lower, 'ascii')))).toString('hex');
  let out = '0x';
  for (let i = 0; i < lower.length; i++) {
    out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  }
  return out;
}

// -- RFC 6979 deterministic nonce -------------------------------------------

function rfc6979k(d: bigint, digest: Uint8Array): bigint {
  const x = Buffer.from(bigToBytes(d, 32));
  const h1 = Buffer.from(digest);
  let V = Buffer.alloc(32, 0x01);
  let K = Buffer.alloc(32, 0x00);
  K = createHmac('sha256', K).update(Buffer.concat([V, Buffer.from([0x00]), x, h1])).digest();
  V = createHmac('sha256', K).update(V).digest();
  K = createHmac('sha256', K).update(Buffer.concat([V, Buffer.from([0x01]), x, h1])).digest();
  V = createHmac('sha256', K).update(V).digest();
  for (;;) {
    V = createHmac('sha256', K).update(V).digest();
    const k = bytesToBig(new Uint8Array(V));
    if (k >= 1n && k < N) return k;
    K = createHmac('sha256', K).update(Buffer.concat([V, Buffer.from([0x00])])).digest();
    V = createHmac('sha256', K).update(V).digest();
  }
}

// -- sign / verify / recover ------------------------------------------------

export interface Signature {
  r: bigint;
  s: bigint;
  yParity: 0 | 1;
}

/** Sign a 32-byte digest. Deterministic (RFC 6979), low-s (EIP-2). */
export function sign(digest: Uint8Array, d: bigint): Signature {
  const z = bytesToBig(digest);
  for (let attempt = 0; ; attempt++) {
    const k = attempt === 0
      ? rfc6979k(d, digest)
      : rfc6979k(d, keccak256(Uint8Array.from([...digest, attempt]))); // vanishingly rare
    const R = toAffine(jMul(G, k));
    const r = mod(R.x, N);
    if (r === 0n) continue;
    let s = mod(inv(k, N) * mod(z + r * d, N), N);
    if (s === 0n) continue;
    let yParity: 0 | 1 = (R.y & 1n) === 1n ? 1 : 0;
    if (s > N / 2n) {
      s = N - s;
      yParity = yParity === 1 ? 0 : 1;
    }
    return { r, s, yParity };
  }
}

export function verify(digest: Uint8Array, sig: { r: bigint; s: bigint }, pub64: Uint8Array): boolean {
  const { r, s } = sig;
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
  const z = bytesToBig(digest);
  const Q: Jac = [bytesToBig(pub64.slice(0, 32)), bytesToBig(pub64.slice(32)), 1n];
  const w = inv(s, N);
  const point = jAdd(jMul(G, mod(z * w, N)), jMul(Q, mod(r * w, N)));
  if (point[2] === 0n) return false;
  return mod(toAffine(point).x, N) === r;
}

/** Recover the signer's public key (64 bytes) from a digest and signature. */
export function recover(digest: Uint8Array, sig: Signature): Uint8Array {
  const { r, s, yParity } = sig;
  if (r <= 0n || r >= N || s <= 0n || s >= N) throw new Error('signature out of range');
  const x = r; // the r+N branch is astronomically rare and unused by our own signer
  const y2 = mod(x * x * x + 7n, P);
  let y = modPow(y2, (P + 1n) / 4n, P);
  if (mod(y * y, P) !== y2) throw new Error('invalid signature (no curve point)');
  if ((y & 1n) !== BigInt(yParity)) y = P - y;
  const R: Jac = [x, y, 1n];
  const z = bytesToBig(digest);
  const rInv = inv(r, N);
  // Q = r^-1 (s*R - z*G)
  const sR = jMul(R, s);
  const zG = jMul(G, mod(z, N));
  const minusZG: Jac = [zG[0], mod(-zG[1], P), zG[2]];
  const Q = toAffine(jMul(jAdd(sR, minusZG), rInv));
  const out = new Uint8Array(64);
  out.set(bigToBytes(Q.x, 32), 0);
  out.set(bigToBytes(Q.y, 32), 32);
  return out;
}
