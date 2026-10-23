// EIP-1559 (type 2) transactions and the slice of ABI encoding an ERC-20
// payment needs. Deterministic on purpose: the gateway rebuilds the expected
// transaction from the challenge and compares field by field.

import { keccak256 } from './keccak.js';
import { rlpEncode, rlpDecode, type RlpItem } from './rlp.js';
import { sign, recover, pubToAddress, bigToBytes, bytesToBig, N, type Signature } from './secp256k1.js';

// -- hex helpers ------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  if (h.length % 2) throw new Error(`odd-length hex: ${hex}`);
  return new Uint8Array(Buffer.from(h, 'hex'));
}

export function bytesToHex(b: Uint8Array): string {
  return '0x' + Buffer.from(b).toString('hex');
}

export function bigToHex(n: bigint): string {
  return '0x' + n.toString(16);
}

export function hexToBig(hex: string): bigint {
  return BigInt(hex);
}

/** Minimal big-endian bytes for RLP integers (0 -> empty). */
export function bigToMinimal(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

export function isAddress(s: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(s);
}

// -- ABI: just enough for ERC-20 --------------------------------------------

export function selector(signature: string): Uint8Array {
  return keccak256(new Uint8Array(Buffer.from(signature, 'ascii'))).slice(0, 4);
}

function abiAddress(addr: string): Uint8Array {
  const out = new Uint8Array(32);
  out.set(hexToBytes(addr), 12);
  return out;
}

function abiUint(n: bigint): Uint8Array {
  return bigToBytes(n, 32);
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

export const erc20 = {
  transferFrom: (from: string, to: string, amount: bigint): Uint8Array =>
    cat(selector('transferFrom(address,address,uint256)'), abiAddress(from), abiAddress(to), abiUint(amount)),
  approve: (spender: string, amount: bigint): Uint8Array =>
    cat(selector('approve(address,uint256)'), abiAddress(spender), abiUint(amount)),
  balanceOf: (owner: string): Uint8Array =>
    cat(selector('balanceOf(address)'), abiAddress(owner)),
  allowance: (owner: string, spender: string): Uint8Array =>
    cat(selector('allowance(address,address)'), abiAddress(owner), abiAddress(spender)),
  decimals: (): Uint8Array => selector('decimals()'),
};

// -- the transaction ---------------------------------------------------------

export interface Eip1559Tx {
  chainId: bigint;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string; // 0x address
  value: bigint;
  data: Uint8Array;
}

function txFields(tx: Eip1559Tx): RlpItem[] {
  return [
    bigToMinimal(tx.chainId),
    bigToMinimal(tx.nonce),
    bigToMinimal(tx.maxPriorityFeePerGas),
    bigToMinimal(tx.maxFeePerGas),
    bigToMinimal(tx.gasLimit),
    hexToBytes(tx.to),
    bigToMinimal(tx.value),
    tx.data,
    [], // accessList
  ];
}

/** The digest the sender signs: keccak(0x02 || rlp(fields)). */
export function signingDigest(tx: Eip1559Tx): Uint8Array {
  const payload = rlpEncode(txFields(tx));
  return keccak256(cat(Uint8Array.of(0x02), payload));
}

/** Sign and serialize to raw bytes (0x02 || rlp([...fields, yParity, r, s])). */
export function signTx(tx: Eip1559Tx, privateScalar: bigint): { raw: Uint8Array; hash: string; sig: Signature } {
  const sig = sign(signingDigest(tx), privateScalar);
  const raw = cat(
    Uint8Array.of(0x02),
    rlpEncode([
      ...txFields(tx),
      bigToMinimal(BigInt(sig.yParity)),
      bigToMinimal(sig.r),
      bigToMinimal(sig.s),
    ]),
  );
  return { raw, hash: bytesToHex(keccak256(raw)), sig };
}

export interface ParsedTx extends Eip1559Tx {
  sig: Signature;
  from: string; // recovered sender, lowercase 0x
  hash: string; // keccak of the raw bytes, 0x hex
}

/** Parse a raw type-2 transaction and recover its sender. Throws on anything off. */
export function parseTx(raw: Uint8Array): ParsedTx {
  if (raw[0] !== 0x02) throw new Error('not a type-2 transaction');
  const decoded = rlpDecode(raw.slice(1));
  if (!Array.isArray(decoded) || decoded.length !== 12) throw new Error('bad transaction shape');
  const f = decoded as Uint8Array[];
  for (const i of [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11]) {
    if (!(f[i] instanceof Uint8Array)) throw new Error('transaction field is a list, not a byte string');
  }
  const accessList = decoded[8];
  if (!Array.isArray(accessList) || accessList.length !== 0) throw new Error('access lists are not supported');
  const tx: Eip1559Tx = {
    chainId: bytesToBig(f[0]),
    nonce: bytesToBig(f[1]),
    maxPriorityFeePerGas: bytesToBig(f[2]),
    maxFeePerGas: bytesToBig(f[3]),
    gasLimit: bytesToBig(f[4]),
    to: bytesToHex(f[5]),
    value: bytesToBig(f[6]),
    data: f[7],
  };
  if (f[5].length !== 20) throw new Error('bad to address');
  const yParityB = bytesToBig(f[9]);
  if (yParityB !== 0n && yParityB !== 1n) throw new Error('bad yParity');
  const sig: Signature = { r: bytesToBig(f[10]), s: bytesToBig(f[11]), yParity: Number(yParityB) as 0 | 1 };
  // nodes refuse high-s signatures (EIP-2), and a signed payment must have exactly one encoding:
  // any other form of the same fields would pass every check here, carry a different hash, and
  // fail at broadcast after the call was served
  if (sig.s > N / 2n) throw new Error('high-s signature');
  const canonical = cat(Uint8Array.of(0x02), rlpEncode([...txFields(tx), bigToMinimal(yParityB), bigToMinimal(sig.r), bigToMinimal(sig.s)]));
  if (canonical.length !== raw.length || canonical.some((b, i) => b !== raw[i])) throw new Error('non-canonical transaction encoding');
  const from = pubToAddress(recover(signingDigest(tx), sig));
  return { ...tx, sig, from, hash: bytesToHex(keccak256(raw)) };
}
