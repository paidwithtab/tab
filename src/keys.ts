// Ed25519 keys on top of node:crypto, nothing else.
// A key file is {"publicKey": "...", "privateKey": "..."} with both values the
// raw 32 bytes, base64url. A wallet id IS the public key. The same 32 bytes in
// base58 are the Solana address.

import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface KeyPair {
  publicKey: string; // base64url, raw 32 bytes
  privateKey: string; // base64url, raw 32 bytes (seed)
}

export function newKeyPair(): KeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pubJwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const privJwk = privateKey.export({ format: 'jwk' }) as { d: string };
  return { publicKey: pubJwk.x, privateKey: privJwk.d };
}

export function publicKeyObject(publicKey: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: publicKey }, format: 'jwk' });
}

export function privateKeyObject(pair: KeyPair): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: pair.publicKey, d: pair.privateKey },
    format: 'jwk',
  });
}

/** Sign raw bytes; returns the 64-byte signature, base64url. */
export function signBytes(pair: KeyPair, data: Uint8Array): string {
  return cryptoSign(null, data, privateKeyObject(pair)).toString('base64url');
}

/** Verify a base64url signature over raw bytes. Never throws. */
export function verifyBytes(publicKey: string, data: Uint8Array, signature: string): boolean {
  try {
    return cryptoVerify(null, data, publicKeyObject(publicKey), Buffer.from(signature, 'base64url'));
  } catch {
    return false;
  }
}

export function pubBytes(publicKey: string): Uint8Array {
  const b = Buffer.from(publicKey, 'base64url');
  if (b.length !== 32) throw new Error(`public key is not 32 bytes: ${publicKey}`);
  return new Uint8Array(b);
}

export function pubFromBytes(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function saveKey(path: string, pair: KeyPair): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(pair, null, 2) + '\n', { mode: 0o600 });
}

export function loadKey(path: string): KeyPair {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  if (typeof raw.publicKey !== 'string' || typeof raw.privateKey !== 'string') {
    throw new Error(`${path} is not a key file`);
  }
  return { publicKey: raw.publicKey, privateKey: raw.privateKey };
}

/** Anywhere a <pub|file> is accepted: a path ending in .json is read as a key file. */
export function resolvePublicKey(arg: string): string {
  if (arg.endsWith('.json')) return loadKey(arg).publicKey;
  return arg;
}
