// The page a person sees at a gateway's root: what it is, what it takes, what it sells, how to pay.
// Agents and API clients get the same facts as JSON from /.well-known/tab; this is only for browsers.

interface HomeRoute { method: string; path: string; price: string; description?: string }
interface HomeService { name: string; prefix: string; description?: string; routes: HomeRoute[] }
interface HomeDoc {
  realm: string;
  rail: string;
  rail_info?: Record<string, unknown> | null;
  currency?: string;
  x402?: unknown;
  faucet?: string;
  services: HomeService[];
}

const CHAINS: Record<number, string> = { 4663: 'Robinhood Chain', 46630: 'Robinhood Chain testnet' };
const SHOWN = 60;

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** What this gateway takes, in words: the token and the chain, or tab credits. */
export function payWith(doc: HomeDoc): string {
  if (doc.rail !== 'evm') return 'tab credits';
  const id = Number(doc.rail_info?.chain_id);
  const chain = CHAINS[id] ?? `chain ${id}`;
  const cur = doc.currency || 'USD';
  const token = cur !== 'USD' ? cur : id === 4663 ? 'USDG' : id === 46630 ? 'test USDC' : 'a dollar stablecoin';
  return `${token} on ${chain}`;
}

export function homePage(doc: HomeDoc, origin: string): string {
  const routes = doc.services.flatMap((s) => s.routes.map((r) => ({ ...r, path: (s.prefix || '') + (r.path === '/' && s.prefix ? '' : r.path), service: s })));
  const priced = routes.filter((r) => r.price !== '0');
  const unit = doc.currency && doc.currency !== 'USD' ? ` ${esc(doc.currency)}` : '';
  const price = (p: string) => (p === '0' ? 'free' : doc.currency && doc.currency !== 'USD' ? `${esc(p)}${unit}` : `$${esc(p)}`);
  const takes = payWith(doc);
  const sample = priced[0];
  const explorer = typeof doc.rail_info?.explorer === 'string' ? doc.rail_info.explorer : null;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(doc.realm)}: a tab gateway</title>
<meta name="description" content="A tab gateway. Agents pay per request in ${esc(takes)}, and every paid call returns a signed receipt.">
<style>
  :root { --bg:#05080c; --surface:#0b1118; --line:rgba(255,255,255,.1); --fg:#f2f4f7; --fg2:#b4bcc8; --dim:#8a94a6; --accent:#9cc3ff; --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace; color-scheme:dark; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:960px; margin:0 auto; padding:0 20px 60px; }
  nav { display:flex; justify-content:space-between; align-items:center; padding:24px 0; }
  .brand { font-weight:700; letter-spacing:-.03em; font-size:22px; } .brand span { font:500 11px var(--mono); letter-spacing:.24em; color:var(--dim); margin-left:10px; text-transform:uppercase; }
  nav a { color:var(--fg2); font:500 12px var(--mono); letter-spacing:.14em; text-transform:uppercase; text-decoration:none; }
  header { padding:48px 0 36px; border-bottom:1px solid var(--line); }
  .e { font:500 12px var(--mono); letter-spacing:.24em; text-transform:uppercase; color:var(--dim); margin-bottom:16px; }
  h1 { margin:0; font-size:clamp(30px,6vw,54px); letter-spacing:-.035em; line-height:1.08; font-weight:600; word-break:break-word; }
  .lede { color:var(--fg2); font-size:18px; max-width:40em; margin:18px 0 0; }
  .facts { display:flex; flex-wrap:wrap; gap:10px; margin-top:26px; }
  .facts span { border:1px solid var(--line); border-radius:999px; padding:7px 14px; font-size:14px; color:var(--fg2); } .facts b { color:var(--fg); font-weight:500; }
  section { padding:36px 0; border-bottom:1px solid var(--line); }
  h2 { font:500 12px var(--mono); letter-spacing:.24em; text-transform:uppercase; color:var(--dim); margin:0 0 18px; }
  table { width:100%; border-collapse:collapse; font-size:14.5px; table-layout:fixed; } td { padding:10px 8px; border-top:1px solid var(--line); vertical-align:top; }
  td.m { font:500 12px var(--mono); color:var(--accent); white-space:nowrap; width:64px; } td.p { font-family:var(--mono); white-space:nowrap; text-align:right; width:120px; }
  td .path { font-family:var(--mono); word-break:break-all; } td .d { color:var(--dim); font-size:13.5px; overflow-wrap:anywhere; }
  pre { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:16px 18px; overflow-x:auto; font:13.5px/1.6 var(--mono); color:#dfe6ef; margin:0; }
  p { margin:0 0 12px; } a { color:var(--accent); } .dim { color:var(--dim); }
  @media (max-width:640px) { td .d { display:none; } td.p { width:90px; } header { padding:28px 0; } }
</style></head>
<body><div class="wrap">
  <nav><div class="brand">tab<span>gateway</span></div><a href="https://paidwithtab.com/catalog">Catalog</a></nav>
  <header>
    <div class="e">A tab gateway</div>
    <h1>${esc(doc.realm)}</h1>
    <p class="lede">Agents pay here per request, in ${esc(takes)}. Each call is checked against a budget its owner signed, and every paid call comes back with a receipt this gateway signs.</p>
    <div class="facts"><span>Takes <b>${esc(takes)}</b></span><span><b>${priced.length}</b> priced route${priced.length === 1 ? '' : 's'}</span>${doc.x402 ? '<span>Also takes <b>x402</b></span>' : ''}${doc.faucet ? `<span>New wallets get <b>${price(doc.faucet)}</b> to start</span>` : ''}</div>
  </header>
  <section>
    <h2>Routes</h2>
    ${routes.length ? `<table>${routes.slice(0, SHOWN).map((r) => `<tr><td class="m">${esc(r.method)}</td><td><div class="path">${esc(r.path)}</div>${r.description || r.service.description ? `<div class="d">${esc(r.description || r.service.description)}</div>` : ''}</td><td class="p">${price(r.price)}</td></tr>`).join('')}</table>
    ${routes.length > SHOWN ? `<p class="dim" style="margin-top:14px">Showing ${SHOWN} of ${routes.length}. <a href="https://paidwithtab.com/catalog">Search them all in the catalog</a>, or read <a href="/.well-known/tab">/.well-known/tab</a>.</p>` : ''}` : '<p class="dim">No routes yet.</p>'}
  </section>
  <section>
    <h2>How to pay</h2>
    <p class="dim">Any agent with a tab wallet and a mandate from its owner:</p>
<pre>npx paidwithtab fetch ${esc(sample ? `${sample.method !== 'GET' ? `-X ${sample.method} ` : ''}${origin}${sample.path.replace(/:([a-z_]+)/gi, '<$1>')}` : origin)}</pre>
    <p class="dim" style="margin-top:14px">Machine-readable terms: <a href="/.well-known/tab">/.well-known/tab</a>${explorer ? `. Settlements are public on the <a href="${esc(explorer)}">explorer</a>` : ''}. Run your own gateway: <a href="https://paidwithtab.com">paidwithtab.com</a></p>
  </section>
</div></body></html>`;
}
