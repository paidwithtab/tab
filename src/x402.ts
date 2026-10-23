// x402 (version 2, `exact` scheme, EIP-3009 transfers on EVM): the payment standard
// Coinbase started and Cloudflare, Visa and Mastercard build on. tab speaks it both ways:
// a tab gateway on the evm rail also answers an x402 buyer (src/gateway.ts), and a tab
// client pays an x402 site within its owner's mandate (src/client.ts). This file is the
// wire format and the EIP-712 signing both sides share.
//
// Wire (HTTP transport): 402 with PAYMENT-REQUIRED (base64 JSON PaymentRequired); the retry
// carries PAYMENT-SIGNATURE (base64 JSON PaymentPayload); a paid response carries
// PAYMENT-RESPONSE (base64 JSON SettlementResponse). Version 1 put the requirements in the
// 402 body and the payment in X-PAYMENT; clients still read those.

import { keccak256 } from './evm/keccak.js';
import { sign, recover, pubToAddress, bytesToBig, bigToBytes, N, type Signature } from './evm/secp256k1.js';
import { hexToBytes, bytesToHex, selector, isAddress } from './evm/tx.js';

export const X402_VERSION = 2;

export interface X402Requirements {
  scheme: string; // "exact"
  network: string; // CAIP-2, "eip155:4663"
  amount: string; // atomic token units
  asset: string; // token contract
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: { name?: string; version?: string; assetTransferMethod?: string; [k: string]: unknown };
}

export interface X402Resource {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
}

export interface X402PaymentRequired {
  x402Version: number;
  error?: string;
  resource: X402Resource;
  accepts: X402Requirements[];
  extensions?: Record<string, unknown>;
}

export interface X402Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string; // 0x + 32 bytes
}

export interface X402PaymentPayload {
  x402Version: number;
  resource?: X402Resource;
  accepted: X402Requirements;
  payload: { signature: string; authorization: X402Authorization };
  extensions?: Record<string, unknown>;
}

export interface X402SettlementResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  transaction: string;
  network: string;
  amount?: string;
}

export const encodeX402 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64');

export function decodeX402<T>(header: string | null | undefined): T | null {
  if (!header) return null;
  try {
    const v = JSON.parse(Buffer.from(header.trim(), 'base64').toString('utf8'));
    return v && typeof v === 'object' ? (v as T) : null;
  } catch {
    return null;
  }
}

/** CAIP-2 for an EVM chain id, and back. */
export const evmNetwork = (chainId: number | bigint): string => `eip155:${chainId}`;
export function chainIdOf(network: string): number | null {
  const m = /^eip155:(\d{1,12})$/.exec(network);
  if (m) return Number(m[1]);
  // version 1 named networks
  return ({ base: 8453, 'base-sepolia': 84532 } as Record<string, number>)[network] ?? null;
}

// -- EIP-712 for EIP-3009 TransferWithAuthorization ------------------------------------------

const utf8 = new TextEncoder();
const cat = (...p: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(p.reduce((n, x) => n + x.length, 0));
  let i = 0;
  for (const x of p) { out.set(x, i); i += x.length; }
  return out;
};
const word = (v: bigint | string): Uint8Array => bigToBytes(typeof v === 'bigint' ? v : BigInt(v), 32);
const DOMAIN_TYPEHASH = keccak256(utf8.encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const TWA_TYPEHASH = keccak256(utf8.encode('TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)'));

export interface TokenDomain {
  name: string;
  version: string;
  chainId: number;
  token: string; // verifyingContract
}

/** The digest an EIP-3009 authorization signs. */
export function authorizationDigest(d: TokenDomain, a: X402Authorization): Uint8Array {
  const domain = keccak256(cat(DOMAIN_TYPEHASH, keccak256(utf8.encode(d.name)), keccak256(utf8.encode(d.version)), word(BigInt(d.chainId)), word(d.token)));
  const struct = keccak256(cat(TWA_TYPEHASH, word(a.from), word(a.to), word(a.value), word(a.validAfter), word(a.validBefore), hexToBytes(a.nonce)));
  return keccak256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** Sign as the token holder; 65 bytes r || s || v (v = 27 or 28), low s. */
export function signAuthorization(d: TokenDomain, a: X402Authorization, holderScalar: bigint): string {
  const sig = sign(authorizationDigest(d, a), holderScalar);
  return bytesToHex(cat(bigToBytes(sig.r, 32), bigToBytes(sig.s, 32), Uint8Array.of(27 + sig.yParity)));
}

export function splitSignature(signature: string): Signature & { v: number } {
  const b = hexToBytes(signature);
  if (b.length !== 65) throw new Error('signature must be 65 bytes');
  const v = b[64] < 27 ? b[64] + 27 : b[64];
  if (v !== 27 && v !== 28) throw new Error('bad signature v');
  const s = bytesToBig(b.slice(32, 64));
  if (s > N / 2n) throw new Error('high-s signature');
  return { r: bytesToBig(b.slice(0, 32)), s, yParity: (v - 27) as 0 | 1, v };
}

/** The address that signed an authorization, or null. */
export function authorizationSigner(d: TokenDomain, a: X402Authorization, signature: string): string | null {
  try {
    return pubToAddress(recover(authorizationDigest(d, a), splitSignature(signature)));
  } catch {
    return null;
  }
}

/** transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, v, r, s) calldata. */
export function transferWithAuthorizationData(a: X402Authorization, signature: string): Uint8Array {
  const s = splitSignature(signature);
  return cat(
    selector('transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)'),
    word(a.from), word(a.to), word(a.value), word(a.validAfter), word(a.validBefore), hexToBytes(a.nonce),
    word(BigInt(s.v)), bigToBytes(s.r, 32), bigToBytes(s.s, 32),
  );
}

/** Structural checks on an authorization from the wire. Returns an x402 error code, or null. */
export function authorizationShapeError(a: unknown): string | null {
  const x = a as X402Authorization;
  if (!x || typeof x !== 'object') return 'invalid_payload';
  if (!isAddress(String(x.from)) || !isAddress(String(x.to))) return 'invalid_payload';
  for (const k of ['value', 'validAfter', 'validBefore'] as const) if (!/^\d{1,78}$/.test(String(x[k]))) return 'invalid_payload';
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(x.nonce))) return 'invalid_payload';
  return null;
}
