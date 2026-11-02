// The TabChannel contract (contracts/TabChannel.sol) from TypeScript: calldata for
// open, close, startClose and finalize, the channel id, and the EIP-712 voucher a
// channel's signer gives the payee. Kept beside the contract so the two cannot
// drift: test/contract.ts runs both against a real EVM.

import { keccak256 } from './keccak.js';
import { sign, bigToBytes, bytesToBig, pubToAddress, recover } from './secp256k1.js';
import { selector, hexToBytes, bytesToHex } from './tx.js';
import { splitSignature } from '../x402.js';

const utf8 = new TextEncoder();
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const word = (v: bigint | string): Uint8Array => bigToBytes(typeof v === 'bigint' ? v : BigInt(v), 32);

const DOMAIN_TYPEHASH = keccak256(utf8.encode('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
const VOUCHER_TYPEHASH = keccak256(utf8.encode('Voucher(bytes32 channel,uint256 amount)'));

export interface ChannelContract {
  chainId: number;
  address: string; // the deployed TabChannel
}

/** keccak256(abi.encodePacked(payer, salt)), as the contract computes it. */
export function channelId(payer: string, salt: string): string {
  return bytesToHex(keccak256(cat(hexToBytes(payer), hexToBytes(salt))));
}

export function voucherDigest(c: ChannelContract, id: string, amount: bigint): Uint8Array {
  const domain = keccak256(cat(DOMAIN_TYPEHASH, keccak256(utf8.encode('TabChannel')), keccak256(utf8.encode('1')), word(BigInt(c.chainId)), word(c.address)));
  const struct = keccak256(cat(VOUCHER_TYPEHASH, hexToBytes(id), word(amount)));
  return keccak256(cat(Uint8Array.of(0x19, 0x01), domain, struct));
}

/** The signer's cumulative voucher: 65 bytes r || s || v, low s. */
export function signChannelVoucher(c: ChannelContract, id: string, amount: bigint, signerScalar: bigint): string {
  const sig = sign(voucherDigest(c, id, amount), signerScalar);
  return bytesToHex(cat(bigToBytes(sig.r, 32), bigToBytes(sig.s, 32), Uint8Array.of(27 + sig.yParity)));
}

export function channelVoucherSigner(c: ChannelContract, id: string, amount: bigint, signature: string): string | null {
  try { return pubToAddress(recover(voucherDigest(c, id, amount), splitSignature(signature))); } catch { return null; }
}

export const tabChannel = {
  open: (salt: string, payee: string, signer: string, token: string, deposit: bigint, expiresAt: bigint, disputeWindow: number): Uint8Array =>
    cat(selector('open(bytes32,address,address,address,uint128,uint64,uint32)'), hexToBytes(salt), word(payee), word(signer), word(token), word(deposit), word(expiresAt), word(BigInt(disputeWindow))),
  close: (id: string, amount: bigint, signature: string): Uint8Array => {
    const s = splitSignature(signature);
    return cat(selector('close(bytes32,uint256,uint8,bytes32,bytes32)'), hexToBytes(id), word(amount), word(BigInt(s.v)), bigToBytes(s.r, 32), bigToBytes(s.s, 32));
  },
  topUp: (id: string, amount: bigint): Uint8Array => cat(selector('topUp(bytes32,uint128)'), hexToBytes(id), word(amount)),
  startClose: (id: string): Uint8Array => cat(selector('startClose(bytes32)'), hexToBytes(id)),
  finalize: (id: string): Uint8Array => cat(selector('finalize(bytes32)'), hexToBytes(id)),
  channels: (id: string): Uint8Array => cat(selector('channels(bytes32)'), hexToBytes(id)),
};

/** Decode the channels(id) getter: zero payer means no such channel. */
export function decodeChannel(ret: string): { payer: string; payee: string; signer: string; token: string; deposit: bigint; expiresAt: bigint; disputeWindow: number; closeStartedAt: bigint } {
  const b = hexToBytes(ret);
  const w = (i: number) => b.slice(32 * i, 32 * (i + 1));
  const addr = (i: number) => bytesToHex(w(i).slice(12));
  return { payer: addr(0), payee: addr(1), signer: addr(2), token: addr(3), deposit: bytesToBig(w(4)), expiresAt: bytesToBig(w(5)), disputeWindow: Number(bytesToBig(w(6))), closeStartedAt: bytesToBig(w(7)) };
}
