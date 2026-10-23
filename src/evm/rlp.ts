// RLP encoding/decoding: the minimum Ethereum transactions need.

export type RlpItem = Uint8Array | RlpItem[];

export function rlpEncode(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0] < 0x80) return item;
    return cat(lengthPrefix(item.length, 0x80), item);
  }
  const payload = cat(...item.map(rlpEncode));
  return cat(lengthPrefix(payload.length, 0xc0), payload);
}

function lengthPrefix(len: number, offset: number): Uint8Array {
  if (len < 56) return Uint8Array.of(offset + len);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Uint8Array.of(offset + 55 + bytes.length, ...bytes);
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

/** Decode one item starting at `offset`; returns the item and the next offset. */
function decodeAt(data: Uint8Array, offset: number): [RlpItem, number] {
  if (offset >= data.length) throw new Error('rlp: out of bounds');
  const b = data[offset];
  if (b < 0x80) return [data.slice(offset, offset + 1), offset + 1];
  if (b < 0xb8) {
    const len = b - 0x80;
    if (offset + 1 + len > data.length) throw new Error('rlp: string out of bounds');
    if (len === 1 && data[offset + 1] < 0x80) throw new Error('rlp: non-canonical single byte');
    return [data.slice(offset + 1, offset + 1 + len), offset + 1 + len];
  }
  if (b < 0xc0) {
    const lenLen = b - 0xb7;
    let len = 0;
    for (let i = 0; i < lenLen; i++) len = len * 256 + data[offset + 1 + i];
    if (len < 56) throw new Error('rlp: non-canonical length');
    const start = offset + 1 + lenLen;
    if (start + len > data.length) throw new Error('rlp: string out of bounds');
    return [data.slice(start, start + len), start + len];
  }
  let listLen: number;
  let start: number;
  if (b < 0xf8) {
    listLen = b - 0xc0;
    start = offset + 1;
  } else {
    const lenLen = b - 0xf7;
    listLen = 0;
    for (let i = 0; i < lenLen; i++) listLen = listLen * 256 + data[offset + 1 + i];
    if (listLen < 56) throw new Error('rlp: non-canonical length');
    start = offset + 1 + lenLen;
  }
  if (start + listLen > data.length) throw new Error('rlp: list out of bounds');
  const items: RlpItem[] = [];
  let o = start;
  while (o < start + listLen) {
    const [item, next] = decodeAt(data, o);
    items.push(item);
    o = next;
  }
  if (o !== start + listLen) throw new Error('rlp: list length mismatch');
  return [items, o];
}

export function rlpDecode(data: Uint8Array): RlpItem {
  const [item, next] = decodeAt(data, 0);
  if (next !== data.length) throw new Error('rlp: trailing bytes');
  return item;
}
