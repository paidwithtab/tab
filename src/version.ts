// The installed package's version, read from package.json: two levels up from dist/src, one from src in a checkout.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_VERSION: string = (() => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const p of [join(here, '..', 'package.json'), join(here, '..', '..', 'package.json')]) {
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8')) as { name?: string; version?: string };
      if (pkg.name === 'paidwithtab' && pkg.version) return pkg.version;
    } catch { /* try the next */ }
  }
  return '0';
})();

/** 3.3: what tab's own clients send as User-Agent, so a gateway can tell its own clients from scanners. */
export function tabUserAgent(surface = process.env.TAB_SURFACE || 'sdk'): string {
  return `tab/${PACKAGE_VERSION} (${surface.replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'sdk'})`;
}

/**
 * 3.3: makes every fetch in this process name tab in its User-Agent unless the request sets one.
 * The command line calls it once, so `tab init`, `tab mcp` and the rest identify themselves.
 */
export function nameFetches(surface: string): void {
  const g = globalThis as { fetch: typeof fetch; __tabNamed?: boolean };
  if (g.__tabNamed) return;
  g.__tabNamed = true;
  const base = g.fetch;
  const ua = tabUserAgent(surface);
  g.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    if (url instanceof Request) return base(url, init);
    const headers = new Headers(init?.headers);
    if (!headers.has('user-agent')) headers.set('user-agent', ua);
    return base(url, { ...init, headers });
  }) as typeof fetch;
}
