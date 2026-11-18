// 3.3: for sellers. A gateway can require your API to sign every paid answer with your own key, so
// a buyer's receipt proves what you sent, not only what the gateway relayed. Set `seller_key` on
// the service in your spec (or `tab sell --sign` for a hosted listing), and answer paid calls with:
//
//   import { loadKey, resultSignatureHeaders } from 'paidwithtab/seller';
//   const key = loadKey('seller.json');
//   const body = JSON.stringify(result);
//   res.writeHead(200, { 'content-type': 'application/json', ...resultSignatureHeaders(key, 'pay.example.com', req.headers, 200, body) });
//   res.end(body);
//
// The gateway names each paid call in the Tab-Hold request header; the signature covers your
// gateway's realm, that id, the status and the SHA-256 of the body bytes (before any content
// encoding). An answer without a valid signature is not charged.

import type { KeyPair } from './keys.js';
import { signSellerResult, SELLER_SIGNATURE_HEADER } from './protocol.js';

export { loadKey, newKeyPair, saveKey } from './keys.js';
export { signSellerResult, sellerResultMessage, verifySellerSignature, SELLER_SIGNATURE_HEADER, type SellerSignature } from './protocol.js';

/**
 * The response header to add to a paid answer: { 'tab-seller-signature': ... }, or {} when the
 * request carries no Tab-Hold (an unpaid call, or one that did not come through the gateway).
 */
export function resultSignatureHeaders(
  key: KeyPair,
  realm: string,
  requestHeaders: Record<string, string | string[] | undefined> | Headers,
  status: number,
  body: string | Uint8Array,
): Record<string, string> {
  const raw = requestHeaders instanceof Headers ? requestHeaders.get('tab-hold') : requestHeaders['tab-hold'];
  const hold = Array.isArray(raw) ? raw[0] : raw;
  if (!hold) return {};
  return { [SELLER_SIGNATURE_HEADER]: signSellerResult(key, { realm, hold, status, body }) };
}
