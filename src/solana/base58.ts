// Base58 (Bitcoin alphabet), hand-rolled on BigInt.

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function b58encode(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out || '1'.repeat(bytes.length) || '';
}

export function b58decode(s: string): Uint8Array {
  let n = 0n;
  for (const c of s) {
    const v = INDEX.get(c);
    if (v === undefined) throw new Error(`bad base58 character: ${c}`);
    n = n * 58n + BigInt(v);
  }
  const out: number[] = [];
  while (n > 0n) {
    out.unshift(Number(n % 256n));
    n /= 256n;
  }
  for (const c of s) {
    if (c !== '1') break;
    out.unshift(0);
  }
  return new Uint8Array(out);
}

export function b58decode32(s: string): Uint8Array {
  const b = b58decode(s);
  if (b.length !== 32) throw new Error(`not a 32-byte base58 value: ${s}`);
  return b;
}
