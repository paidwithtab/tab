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

8,638 routes across 484 services are live on `pay.paidwithtab.com` today, between $0.001 and $0.02 a call. The same routes are served for test USDC at `testnet.paidwithtab.com` and for USDG at `mainnet.paidwithtab.com`. Search them all at [paidwithtab.com/catalog](https://paidwithtab.com/catalog), or from an agent with the `tab_search` tool. This is what they cover as of 2026-10-22.

| Area | What is in it | Routes |
| --- | --- | --- |
| Chains and crypto | Block explorer APIs for 42 chains including Robinhood Chain, JSON-RPC for 70 networks, Bitcoin and Liquid, market data from 20 exchanges, DefiLlama | about 3,100 |
| Reference | Wikipedia in 48 languages, Wiktionary, Wikiquote, Wikisource, Wikivoyage, Wikidata and its SPARQL endpoint, Open Library, Internet Archive, museum collections | about 1,950 |
| Science and health | GBIF, OBIS, WoRMS, Ensembl, UniProt, RCSB PDB, PubChem, ChEMBL, Reactome, OLS, NCBI, PubMed, Crossref, DataCite, Europe PMC, openFDA, RxNorm, clinical trials, NOAA space weather, JPL small bodies | about 1,250 |
| Developer tooling | npm, PyPI, crates.io, RubyGems, Packagist, NuGet, Maven, Go, Docker Hub, Hex, pub.dev, Homebrew, CRAN, deps.dev, OSV, GitLab, Codeberg, Linux package indexes, release calendars | about 640 |
| Internet infrastructure | RDAP for 55 registries and the regional internet registries, RIPEstat, RIPE Atlas, DNS over HTTPS, IP geolocation, cloud IP ranges, breach data | about 370 |
| Government and economics | US Treasury Fiscal Data, USAspending, Federal Register, SEC EDGAR, ECB, World Bank, IMF, Eurostat, UK and French open data | about 420 |
| Weather, earth and places | US National Weather Service, aviation weather, Canadian weather, USGS water and earthquakes, UK floods and carbon intensity, geocoding, postcodes, holidays, time zones | about 380 |
| Social, media and games | Bluesky, eight Mastodon servers, Hacker News, TVmaze, iTunes, lichess, chess.com, football leagues | about 480 |
| Paid providers | Tavily search and extract, DeepL translation, Deepgram speech, Jina Reader | 6 |

Every route was called once with a real sample before it was listed. Services whose provider asks for a request ceiling carry `rate_limit_per_minute` in the discovery document, and the gateway answers 429 before charging when a call would go over it.

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
