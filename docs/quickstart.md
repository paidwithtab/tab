# Quickstart

## The one-minute version

```sh
npx paidwithtab init
```

That writes an owner key, an agent key and a signed mandate to `~/.tab` ($1.00 per day, $0.05 per call) and claims $1.00 of starter credits on the public gateway, `pay.paidwithtab.com`, which fronts real APIs: web search, translation, speech to text, web page reading, Wikipedia, weather, exchange rates. Then:

```sh
npx paidwithtab fetch "https://pay.paidwithtab.com/weather/forecast?latitude=38.72&longitude=-9.14&current=temperature_2m"
claude mcp add --scope user tab -- npx -y paidwithtab mcp
```

The second line gives Claude Code the five tab tools. Ask it to look something up and it will search [paidwithtab.com/catalog](https://paidwithtab.com/catalog), pay, and show you the receipt. Running `init` again is safe: it keeps your keys and tells you the credits were already claimed.

## What the starter credits buy

40 routes across 23 services are live on `pay.paidwithtab.com` today, between $0.001 and $0.02 a call. The same routes are served for test USDC at `testnet.paidwithtab.com` and for USDG at `mainnet.paidwithtab.com`. The live list, with every route's path and price, is [paidwithtab.com/catalog](https://paidwithtab.com/catalog); this table is the services as of 2026-10-12.

| Prefix | What | Price per call |
| --- | --- | --- |
| `/read` | Read any web page as clean text or markdown (Jina Reader) | 0.003 |
| `/wikipedia` | English Wikipedia: article summaries and search | 0.001 |
| `/weather` | Weather forecasts for any coordinates (Open-Meteo) | 0.001 |
| `/fx` | Currency exchange rates from the European Central Bank (Frankfurter) | 0.001 |
| `/search` | Web search built for agents: ranked results with content snippets and an optional answer (Tavily) | 0.01 |
| `/translate` | Translation between 30+ languages (DeepL) | 0.02 |
| `/speech` | Speech to text and text to speech (Deepgram) | 0.02 |
| `/geocode` | Place names to coordinates, worldwide (Open-Meteo geocoding) | 0.001 |
| `/airquality` | Air quality for any coordinates: PM2.5, PM10, ozone, pollen, European and US AQI (Open-Meteo) | 0.001 |
| `/marine` | Marine forecasts: wave height, swell, sea temperature (Open-Meteo) | 0.001 |
| `/arxiv` | Search arXiv preprints: physics, maths, computer science, more (returns Atom XML) | 0.002 |
| `/hn` | Hacker News search and items (Algolia) | 0.001 |
| `/books` | Books and authors from Open Library | 0.001 |
| `/wikidata` | Wikidata: entity search and structured facts about anything | 0.001 |
| `/osm` | Geocoding and reverse geocoding from OpenStreetMap (Nominatim). Low volume only | 0.002 |
| `/crossref` | Scholarly metadata for 150 million works, by DOI or text (Crossref) | 0.002 |
| `/pubmed` | PubMed: biomedical literature search and summaries (NCBI E-utilities) | 0.002 |
| `/quakes` | Earthquakes worldwide, real time (USGS) | 0.001 |
| `/stackexchange` | Stack Overflow and the Stack Exchange network: questions and answers | 0.001 |
| `/crypto` | Crypto prices and market data (CoinGecko public API) | 0.001 |
| `/github` | GitHub public data: repository search and metadata (unauthenticated, rate limited) | 0.001, 0.002 |
| `/openalex` | OpenAlex: 250 million scholarly works, authors and institutions | 0.001, 0.002 |
| `/extract` | Extract the content of one or more URLs, cleaned for agents (Tavily) | 0.01 |

Three paid calls, as pasted:

```sh
npx paidwithtab fetch -X POST -d '{"query":"HTTP 402 payment required","max_results":3}' https://pay.paidwithtab.com/search
npx paidwithtab fetch -X POST -d '{"text":["Let agents pay for what they use."],"target_lang":"JA"}' https://pay.paidwithtab.com/translate
npx paidwithtab fetch -X POST -d '{"url":"https://dpgr.am/spacewalk.wav"}' "https://pay.paidwithtab.com/speech/listen?model=nova-3&smart_format=true"
```

## The whole stack on your machine

Everything below runs locally with sandbox money. No chain, no faucet, no accounts. When it clicks, [sellers.md](sellers.md) puts tab in front of a real API and [buyers.md](buyers.md) funds a real agent on Robinhood Chain.

## 1. Run the sandbox

```sh
git clone https://github.com/paidwithtab/tab && cd tab
npm install
npm run demo
```

The demo starts three processes and prints their addresses:

| Process | Where | What |
| --- | --- | --- |
| demo API | :4101 | the thing being sold: quotes, echo, a route that always fails |
| gateway | :1402 | prices the API's routes and enforces payment |
| catalog + site | :1403 | search, one-click buying, live receipts |

It also creates `keys/` (an owner, two agents, a seller) and mints $5.00 of sandbox money to the owner. Running it again reuses everything; it is safe to ctrl-C and restart.

## 2. See a price tag

```sh
curl -i http://127.0.0.1:1402/quote
```

```
HTTP/1.1 402 Payment Required
WWW-Authenticate: Tab challenge="eyJ2ZXIiOiJ0YWIvMCIs..."
```

That header is the whole storefront: a signed challenge naming the price ($0.01), the seller, the exact resource, and an expiry. Nothing was proxied; unpaid requests never reach the API.

## 3. Pay for it

```sh
npm run cli -- fetch \
  --agent keys/agent-claude.json \
  --mandate keys/mandate-claude.json \
  http://127.0.0.1:1402/quote
```

```
[...] paid 0.01 (ledger:PSIPesjjvD_0qygj)
{"quote":"Talk is cheap. Show me the code. ...","payer":"FIoxEpi..."}
```

What just happened: the client hit the 402, checked the price against the mandate's caps, signed a credential binding that one challenge to that one request, retried, and got the response plus a receipt. The seller's balance went up by exactly $0.01:

```sh
npm run cli -- balance --wallet keys/seller.json --db tab.db
```

## 4. Watch an agent shop

Open **http://127.0.0.1:1403/catalog**. Search finds routes across every announced gateway, cheapest first. The Buy button spends a real (sandbox) mandate held by the catalog's try-it agent, and the receipt feed updates live.

## 5. Let Claude Code spend

The repo ships `.mcp.json` preconfigured for the demo keys. Open Claude Code in this directory and ask it to find and buy a quote; it gets five tools (`tab_limits`, `tab_search`, `tab_discover`, `tab_fetch`, `tab_balance`) and a $1.00/day mandate capped at $0.05 per call. It cannot exceed either number, and it never sees the owner key.

## 6. Break something, on purpose

Try to overspend:

```sh
for i in $(seq 1 200); do
  npm run -s cli -- fetch --agent keys/agent-claude.json \
    --mandate keys/mandate-claude.json http://127.0.0.1:1402/quote > /dev/null
done
```

Somewhere past the mandate's daily budget the calls flip to `402 mandate-exceeded` and stay there until the next UTC day. That refusal is the product.

## Where to next

- Price your own API and get paid: [sellers.md](sellers.md)
- Fund a real agent with USDG on Robinhood Chain: [buyers.md](buyers.md)
- Configure a particular agent: Claude Code, Cursor, Codex, your own code, Python: [agents.md](agents.md)
- The wire format and verification rules: [SPEC.md](../SPEC.md)
- Production deployment, TLS, systemd: [DEPLOY.md](../DEPLOY.md)
