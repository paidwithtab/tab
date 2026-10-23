// Outbound HTTP for anything a stranger can point us at: gateway origins, http agents,
// URLs an agent asks for. guardedFetch has the signature of fetch, resolves the host
// itself, refuses any address that is not global unicast (checked at connect time, so
// DNS rebinding between a check and the fetch cannot slip past), never follows
// redirects (a 3xx comes back as the response), and caps the body and the time.

import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128], ['::1', 128], ['::', 96], // unspecified, loopback, IPv4-compatible
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23], ['2001:db8::', 32],
  ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, bits, 'ipv6');

/** True only for a global unicast address. IPv4-mapped IPv6 is judged as the IPv4 it carries. */
export function isPublicAddress(address: string): boolean {
  let a = address.replace(/^\[|\]$/g, '').toLowerCase();
  const kind = isIP(a);
  if (kind === 0) return false;
  if (kind === 6) {
    // ::ffff:a.b.c.d and ::ffff:xxxx:yyyy are IPv4 in disguise
    const m = /^(?:0{0,4}:){0,5}:?ffff:(.+)$/.exec(a);
    if (m) {
      const tail = m[1];
      if (isIP(tail) === 4) a = tail;
      else {
        const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(tail);
        if (!hex) return false;
        const n = (parseInt(hex[1], 16) << 16) | parseInt(hex[2], 16);
        a = [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.');
      }
      return !blocked.check(a, 'ipv4');
    }
    return !blocked.check(a, 'ipv6');
  }
  return !blocked.check(a, 'ipv4');
}

export class EgressRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EgressRefused';
  }
}

export interface GuardOptions {
  timeoutMs?: number; // default 30 s
  maxBytes?: number; // response body cap, default 16 MB
}

/**
 * A fetch that only talks to public addresses and never follows redirects. Bodies may
 * be strings or bytes. Errors (refused address, timeout, oversize body) reject like
 * a network error would.
 */
export function guardedFetch(opts: GuardOptions = {}): typeof fetch {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  return (async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new EgressRefused(`refused: ${url.protocol} URLs`);
    if (url.username || url.password) throw new EgressRefused('refused: credentials in the URL');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) && !isPublicAddress(host)) throw new EgressRefused(`refused: ${host} is not a public address`);
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    delete headers.host;
    delete headers['accept-encoding']; // bodies come back as sent; nothing here decompresses
    const body = init.body == null ? undefined
      : typeof init.body === 'string' ? Buffer.from(init.body)
      : init.body instanceof Uint8Array ? Buffer.from(init.body)
      : null;
    if (body === null) throw new TypeError('guardedFetch takes string or byte bodies');
    if (body) headers['content-length'] = String(body.length);
    // every address the name resolves to must be public, and the socket connects to one of those
    const lookup = (hostname: string, o: object, cb: (err: Error | null, address: string | LookupAddress[], family?: number) => void) => {
      dnsLookup(hostname, { all: true }, (err, addrs) => {
        if (err) return cb(err, '');
        const bad = addrs.find((x) => !isPublicAddress(x.address));
        if (bad || addrs.length === 0) return cb(new EgressRefused(`refused: ${hostname} resolves to ${bad?.address ?? 'nothing'}, which is not public`), '');
        if ((o as { all?: boolean }).all) return cb(null, addrs);
        cb(null, addrs[0].address, addrs[0].family);
      });
    };
    const signals = [AbortSignal.timeout(timeoutMs), ...(init.signal ? [init.signal] : [])];
    const signal = AbortSignal.any(signals);
    return new Promise<Response>((resolve, reject) => {
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
        method: (init.method ?? 'GET').toUpperCase(), headers, lookup: lookup as never, signal,
      }, (res: IncomingMessage) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) { req.destroy(new EgressRefused(`response exceeds ${maxBytes} bytes`)); return; }
          chunks.push(c);
        });
        res.on('error', reject);
        res.on('end', () => {
          const h = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (v === undefined) continue;
            for (const one of Array.isArray(v) ? v : [v]) h.append(k, one);
          }
          const status = res.statusCode ?? 502;
          const nullBody = status === 204 || status === 304 || status < 200;
          resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status: status < 200 ? 502 : status, headers: h }));
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }) as typeof fetch;
}
