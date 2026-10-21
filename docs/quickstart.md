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

123 routes across 59 services are live on `pay.paidwithtab.com` today, between $0.001 and $0.02 a call. The same routes are served for test USDC at `testnet.paidwithtab.com` and for USDG at `mainnet.paidwithtab.com`. The live list, with every route's path and price, is [paidwithtab.com/catalog](https://paidwithtab.com/catalog); this table is the services as of 2026-10-21.

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
| `/chain` | Robinhood Chain mainnet explorer reads: addresses, balances, transactions and tokens (Blockscout) | 0.001, 0.002 |
| `/rpc` | Robinhood Chain mainnet JSON-RPC (chain id 4663): any read method | 0.002 |
| `/eth` | Ethereum mainnet JSON-RPC (PublicNode): balances, blocks, eth_call, logs | 0.002 |
| `/bitcoin` | Bitcoin mainnet: fee estimates, addresses, transactions, blocks (mempool.space) | 0.001 |
| `/edgar` | SEC EDGAR company data: filing history and XBRL financial facts by CIK | 0.002, 0.005 |
| `/edgar-search` | SEC EDGAR full-text search across filings since 2001 | 0.005 |
| `/rdap` | Domain registration data for .com and .net: registrar, creation and expiry dates, status, nameservers (Verisign RDAP) | 0.002 |
| `/dns` | DNS over HTTPS: any record type for any name (Google Public DNS). Email verification starts here: MX, SPF and DMARC | 0.001 |
| `/binance` | Binance spot market data: prices, 24h stats, candles, order book | 0.001 |
| `/kraken` | Kraken spot market data: tickers, candles, order book, recent trades | 0.001 |
| `/coinpaprika` | Crypto market data for thousands of coins: tickers, coin profiles, search (Coinpaprika) | 0.001, 0.002 |
| `/defillama` | DeFi data: TVL by chain and protocol, protocol profiles (DefiLlama) | 0.001, 0.002 |
| `/bluesky` | Bluesky public data: post search, profiles, author feeds, people search | 0.001, 0.002, 0.003 |
| `/trials` | Clinical trials registered at ClinicalTrials.gov: search and study records | 0.002 |
| `/fda` | US FDA data: drug labels and adverse events, food and device recalls (openFDA) | 0.002 |
| `/europepmc` | Europe PMC: 40 million life science abstracts and full texts | 0.002 |
| `/cve` | CVE records from the US National Vulnerability Database | 0.002 |
| `/osv` | Known vulnerabilities for open source packages (OSV, Google) | 0.001, 0.002 |
| `/npm` | npm registry: package metadata and search | 0.001 |
| `/pypi` | PyPI: package metadata and release files | 0.001 |
| `/endoflife` | Release and end-of-life dates for 300+ products (endoflife.date) | 0.001 |
| `/ecb` | European Central Bank statistics: exchange rates, interest rates, inflation, money supply | 0.001 |
| `/worldbank` | World Bank development indicators for every country: GDP, population, inflation, 16,000 series | 0.001 |
| `/flights` | Live aircraft positions from ADS-B receivers worldwide (adsb.lol) | 0.002 |
| `/holidays` | Public holidays for 100+ countries (Nager.Date) | 0.001 |
| `/time` | Current time and time zone data (timeapi.io) | 0.001 |
| `/ip` | IP geolocation: city, country, ASN, time zone, currency (ipapi.co) | 0.001 |
| `/pageviews` | Wikipedia page view counts, a public attention signal for any topic (Wikimedia) | 0.001 |
| `/openverse` | Openly licensed images and audio with license metadata (Openverse) | 0.002 |
| `/tides` | US tides, water levels and predictions at NOAA stations | 0.001 |
| `/food` | Food products by barcode: ingredients, nutrition, Nutri-Score (Open Food Facts) | 0.001 |
| `/gutenberg` | 75,000 public domain books from Project Gutenberg: search and download links (Gutendex) | 0.001 |
| `/words` | Words by meaning, sound, spelling and context: synonyms, rhymes, completions (Datamuse) | 0.001 |
| `/postcodes` | Postal codes to places for 60 countries (Zippopotam) | 0.001 |
| `/pwned` | Has a password appeared in a breach, checked by k-anonymity (Have I Been Pwned) | 0.001 |
| `/zenodo` | Research datasets, software and papers with DOIs (Zenodo, CERN) | 0.001, 0.002 |

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
