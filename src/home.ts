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
  about?: string;
  services: HomeService[];
}

const CHAINS: Record<number, string> = { 4663: 'Robinhood Chain', 46630: 'Robinhood Chain testnet' };
const TESTNETS = new Set([46630]);
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
  const token = doc.rail === 'evm' && typeof doc.rail_info?.token === 'string' ? doc.rail_info.token : null;
  const testnet = doc.rail === 'evm' ? TESTNETS.has(Number(doc.rail_info?.chain_id)) : false;
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  // a testnet token gateway with a faucet leads with the faucet: claim, then spend it here
  const faucetPage = testnet && !!doc.faucet && !!token;
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
  .test { margin-top:4px; border:1px solid rgba(255,196,99,.35); background:rgba(255,196,99,.08); color:#ffd894; border-radius:12px; padding:10px 16px; font-size:14px; }
  .about p { color:var(--fg2); font-size:17px; max-width:44em; } .facts span a { color:var(--fg); }
  @media (max-width:640px) { td .d { display:none; } td.p { width:90px; } header { padding:28px 0; } }
</style></head>
<body><div class="wrap">
  <nav><div class="brand">tab<span>gateway</span></div><a href="https://paidwithtab.com/catalog">Catalog</a></nav>
  ${testnet ? '<div class="test">Testnet. Nothing paid here is real money.</div>' : ''}
  ${faucetPage ? faucetSections(doc, price(doc.faucet!), token!, explorer, faucetSample(routes, origin)) : `<header>
    <div class="e">A tab gateway${testnet ? ' on a testnet' : ''}</div>
    <h1>${esc(doc.realm)}</h1>
    <p class="lede">Agents pay here per request, in ${esc(takes)}. Each call is checked against a budget its owner signed, and every paid call comes back with a receipt this gateway signs.</p>
    <div class="facts"><span>Takes <b>${esc(takes)}</b></span><span><b>${priced.length}</b> priced route${priced.length === 1 ? '' : 's'}</span>${doc.x402 ? '<span>Also takes <b>x402</b></span>' : ''}${doc.faucet ? `<span>New wallets get <b>${price(doc.faucet)}</b> to start</span>` : ''}${token ? `<span>Token <b>${explorer ? `<a href="${esc(explorer)}/token/${esc(token)}">${esc(short(token))}</a>` : esc(short(token))}</b>${doc.rail_info?.decimals !== undefined ? `, ${esc(doc.rail_info.decimals)} decimals` : ''}</span>` : ''}</div>
  </header>
  ${doc.about ? `<section class="about"><h2>About this gateway</h2>${doc.about.split(/\n\s*\n/).map((p) => `<p>${esc(p.trim())}</p>`).join('')}</section>` : ''}`}
  <section>
    <h2>${faucetPage ? `What ${esc(doc.currency)} buys here` : 'Routes'}</h2>
    ${routes.length ? `<table>${routes.slice(0, faucetPage ? 12 : SHOWN).map((r) => `<tr><td class="m">${esc(r.method)}</td><td><div class="path">${esc(r.path)}</div>${r.description || r.service.description ? `<div class="d">${esc(r.description || r.service.description)}</div>` : ''}</td><td class="p">${price(r.price)}</td></tr>`).join('')}</table>
    ${routes.length > (faucetPage ? 12 : SHOWN) ? `<p class="dim" style="margin-top:14px">Showing ${faucetPage ? 12 : SHOWN} of ${routes.length}. <a href="https://paidwithtab.com/catalog">Search them all in the catalog</a>, or read <a href="/.well-known/tab">/.well-known/tab</a>.</p>` : ''}` : '<p class="dim">No routes yet.</p>'}
  </section>
  ${faucetPage ? '' : `<section>
    <h2>How to pay</h2>
    <p class="dim">Any agent with a tab wallet and a mandate from its owner:</p>
<pre>npx paidwithtab fetch ${esc(sample ? `${sample.method !== 'GET' ? `-X ${sample.method} ` : ''}${origin}${sample.path.replace(/:([a-z_]+)/gi, '<$1>')}` : origin)}</pre>
    <p class="dim" style="margin-top:14px">Machine-readable terms: <a href="/.well-known/tab">/.well-known/tab</a>${explorer ? `. Settlements are public on the <a href="${esc(explorer)}">explorer</a>` : ''}. Run your own gateway: <a href="https://paidwithtab.com">paidwithtab.com</a></p>
  </section>`}
</div>${faucetPage ? FAUCET_STYLE : ''}</body></html>`;
}

/** A GET call that works as typed: the Wikipedia summary of HTTP 402 when the gateway has it, else its first GET route without parameters. */
function faucetSample(routes: Array<{ method: string; path: string; price: string }>, origin: string): string {
  if (routes.some((r) => r.method === 'GET' && r.path === '/wikipedia/api/rest_v1/page/summary/:title')) return `${origin}/wikipedia/api/rest_v1/page/summary/HTTP_402`;
  const plain = routes.find((r) => r.method === 'GET' && r.price !== '0' && !r.path.includes(':'));
  return origin + (plain?.path ?? '/');
}

const RPC: Record<number, string> = { 46630: 'https://rpc.testnet.chain.robinhood.com' };

/** The faucet page: what the token is, a claim form, the four steps to a paid call, and the network to add. */
function faucetSections(doc: HomeDoc, amount: string, token: string, explorer: string | null, sampleUrl: string): string {
  const cur = esc(doc.currency);
  const chainId = Number(doc.rail_info?.chain_id);
  const realm = esc(doc.realm);
  const cmd = (c: string) => `<pre>${c}</pre>`;
  const net = { chainId: '0x' + chainId.toString(16), chainName: CHAINS[chainId], rpcUrls: [RPC[chainId]], nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, blockExplorerUrls: explorer ? [explorer] : [] };
  const asset = { type: 'ERC20', options: { address: token, symbol: doc.currency, decimals: Number(doc.rail_info?.decimals ?? 18) } };
  return `<header class="fh">
    <div class="e">${esc(CHAINS[chainId])} faucet</div>
    <h1>Free ${cur} test tokens</h1>
    <p class="lede">${cur} is a test token with no value. Claim ${amount} and use it to pay for real APIs here: an agent spends it under limits you sign, and every call comes back with a receipt.</p>
    <div class="card">
      <form id="claim"><input name="wallet" placeholder="Your wallet address, 0x..." autocomplete="off" spellcheck="false" required pattern="0x[0-9a-fA-F]{40}" aria-label="Wallet address"><button class="go">Claim ${amount}</button></form>
      <div class="row"><span id="claim-note" class="dim">One claim per wallet. Each claim also sends a little testnet ETH for gas.</span><button type="button" class="link" id="use-wallet" hidden>Use my browser wallet</button></div>
      <div id="claim-out" aria-live="polite"></div>
    </div>
  </header>
  <section>
    <h2>Make a paid call in four steps</h2>
    <ol class="steps">
      <li><b>Make two keys.</b> The owner holds the tokens and signs the limits. The agent spends. <span class="dim">Needs Node.js 22.13 or newer.</span>
${cmd(`npx paidwithtab key new --out owner.json
npx paidwithtab key new --out agent.json
npx paidwithtab evm address owner.json
npx paidwithtab evm address agent.json`)}</li>
      <li><b>Claim for both addresses</b> with the form above. The owner gets ${amount} to spend, and both get gas: the owner signs one approval, and the agent sends its own payments.</li>
      <li><b>Let the agent spend.</b> The owner approves an allowance on chain and signs a mandate: at most 10 ${cur} a day, 0.05 per call, only at this gateway.
${cmd(`npx paidwithtab evm approve --owner owner.json --agent agent.json --amount 10 \\
  --token ${esc(token)}
npx paidwithtab mandate issue --owner owner.json --agent agent.json --budget 10 --window day \\
  --max-per-call 0.05 --allow ${realm} --days 30 --out mandate.json`)}</li>
      <li><b>Make a paid call.</b> The gateway answers 402 with a price, the agent pays it on chain, and the response comes back with a signed receipt.
${cmd(`npx paidwithtab fetch --agent agent.json --mandate mandate.json --currency ${cur} \\
  ${esc(sampleUrl)}`)}
<pre class="out">paid 0.001 ${cur} (evm:0x2732…f9d2), receipt verified
{"type":"standard","title":"List of HTTP status codes", ...}</pre></li>
    </ol>
    <p class="dim" style="margin-top:22px">To let Claude Code spend it instead: <code>claude mcp add tab -e TAB_AGENT=$PWD/agent.json -e TAB_MANDATE=$PWD/mandate.json -e TAB_CURRENCY=${cur} -- npx -y paidwithtab mcp</code></p>
  </section>
  <section>
    <h2>Network</h2>
    <dl class="kv">
      <dt>Network</dt><dd>${esc(CHAINS[chainId])}, chain id ${chainId}</dd>
      <dt>RPC</dt><dd class="mono">${esc(RPC[chainId] ?? '')}</dd>
      <dt>Token</dt><dd class="mono">${explorer ? `<a href="${esc(explorer)}/token/${esc(token)}">${esc(token)}</a>` : esc(token)}, ${esc(doc.rail_info?.decimals ?? 18)} decimals</dd>
      ${explorer ? `<dt>Explorer</dt><dd><a href="${esc(explorer)}">${esc(explorer.replace(/^https:\/\//, ''))}</a></dd>` : ''}
      <dt>Terms</dt><dd><a href="/.well-known/tab">/.well-known/tab</a></dd>
    </dl>
    <p class="wallet-btns" hidden><button type="button" class="link" id="add-net">Add the network to your wallet</button> <button type="button" class="link" id="add-token">Add ${cur} to your wallet</button></p>
  </section>
  <script>
  (() => {
    const f = document.getElementById('claim'), out = document.getElementById('claim-out'), note = document.getElementById('claim-note');
    const explorer = ${JSON.stringify(explorer)}, eth = window.ethereum, net = ${JSON.stringify(net)}, asset = ${JSON.stringify(asset)};
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => '&#' + c.charCodeAt(0) + ';');
    const say = (html, cls) => { out.innerHTML = html; out.className = cls || ''; };
    fetch('/.well-known/tab/faucet').then((r) => r.json()).then((s) => {
      const parts = [];
      if (typeof s.claimed === 'number') parts.push(s.claimed.toLocaleString() + ' wallet' + (s.claimed === 1 ? '' : 's') + ' claimed so far');
      if (s.claims_left === 0) { parts.push('the faucet is out of gas right now, check back soon'); f.querySelector('button').disabled = true; }
      if (parts.length) note.textContent = 'One claim per wallet. ' + parts.join('. ').replace(/^./, (c) => c.toUpperCase()) + '.';
    }).catch(() => {});
    if (eth) {
      const use = document.getElementById('use-wallet'); use.hidden = false;
      use.onclick = async () => { try { const [a] = await eth.request({ method: 'eth_requestAccounts' }); if (a) f.wallet.value = a; } catch {} };
      document.querySelector('.wallet-btns').hidden = false;
      document.getElementById('add-net').onclick = () => eth.request({ method: 'wallet_addEthereumChain', params: [net] }).catch(() => {});
      document.getElementById('add-token').onclick = () => eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: net.chainId }] }).catch(() => eth.request({ method: 'wallet_addEthereumChain', params: [net] })).then(() => eth.request({ method: 'wallet_watchAsset', params: asset })).catch(() => {});
    }
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const b = f.querySelector('button'); b.disabled = true;
      say('<span class="spin"></span>Sending. This takes a few seconds while the transactions confirm.');
      try {
        const r = await fetch('/.well-known/tab/faucet', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ wallet: f.wallet.value.trim() }) });
        const j = await r.json();
        if (!r.ok) say(esc(j.error || 'The faucet could not send right now.'), 'err');
        else if (j.already_claimed) say('This wallet already claimed. Each wallet gets one claim.', 'err');
        else {
          const link = (t) => explorer ? '<a href="' + esc(explorer) + '/tx/' + esc(t.hash) + '" target="_blank" rel="noopener">' + (t.kind === 'gas' ? 'gas' : esc(t.kind)) + ' transaction</a>' : '';
          say('<b>Sent ' + esc(j.credited) + ' ' + esc(j.currency) + (j.gas !== '0' ? ' and ' + esc(j.gas) + ' ETH' : '') + '</b> to ' + esc(j.wallet.slice(0, 6) + '…' + j.wallet.slice(-4)) + '. ' + (j.txs || []).map(link).filter(Boolean).join(' · '), 'ok');
          f.wallet.value = '';
        }
      } catch { say('The faucet could not be reached. Try again in a moment.', 'err'); }
      b.disabled = false;
    });
  })();
  </script>`;
}

const FAUCET_STYLE = `<style>
  .fh { padding:40px 0 44px; }
  .card { margin-top:30px; background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:18px; max-width:680px; }
  #claim { display:flex; gap:10px; flex-wrap:wrap; }
  #claim input { flex:1 1 300px; min-width:0; background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:14px; color:var(--fg); font:15px var(--mono); }
  #claim input:focus { outline:none; border-color:var(--accent); }
  .go { background:var(--fg); color:var(--bg); border:0; border-radius:10px; padding:14px 22px; font:600 15px/1 Inter,ui-sans-serif,system-ui,sans-serif; cursor:pointer; white-space:nowrap; } .go:disabled { opacity:.5; cursor:default; }
  .row { display:flex; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-top:12px; font-size:14px; }
  .link { background:none; border:0; padding:0; color:var(--accent); font:inherit; font-size:14px; cursor:pointer; }
  #claim-out { margin-top:12px; font-size:15px; overflow-wrap:anywhere; } #claim-out:empty { display:none; }
  #claim-out.ok { color:#9be3b0; } #claim-out.ok b { color:#c6f5d3; } #claim-out.err { color:#ff9b9b; } #claim-out a { color:inherit; }
  .spin { display:inline-block; width:12px; height:12px; margin-right:8px; border:2px solid var(--dim); border-top-color:transparent; border-radius:50%; animation:sp .8s linear infinite; vertical-align:-1px; } @keyframes sp { to { transform:rotate(360deg); } }
  .steps { margin:0; padding:0; list-style:none; counter-reset:s; display:grid; grid-template-columns:minmax(0,1fr); gap:26px; }
  .steps li { min-width:0; } .steps pre { max-width:100%; }
  .steps li { counter-increment:s; position:relative; padding-left:44px; color:var(--fg2); }
  .steps li::before { content:counter(s); position:absolute; left:0; top:0; width:28px; height:28px; border-radius:50%; border:1px solid var(--line); display:grid; place-items:center; font:500 13px var(--mono); color:var(--fg); }
  .steps b { color:var(--fg); font-weight:500; } .steps pre { margin-top:10px; } pre.out { color:#9be3b0; border-style:dashed; }
  code { font:13px var(--mono); background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:2px 6px; overflow-wrap:anywhere; }
  .kv { display:grid; grid-template-columns:110px 1fr; gap:8px 16px; margin:0; font-size:14.5px; } .kv dt { color:var(--dim); } .kv dd { margin:0; overflow-wrap:anywhere; } .mono { font-family:var(--mono); font-size:13.5px; }
  @media (max-width:640px) { .steps li { padding-left:38px; } .kv { grid-template-columns:1fr; gap:2px; } .kv dd { margin-bottom:8px; } }
</style>`;
