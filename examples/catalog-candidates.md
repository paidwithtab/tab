# Catalog candidates: real pay-per-request APIs to front with tab

Working reference (pricing verified ~Sep 2026; re-check before you price a route). Each of these is a metered, API-key API you can wrap with a tab gateway: the gateway holds your provider key, injects it upstream via `upstream_headers`, prices the route, and settles USDC per call. The buyer never sees your key.

"Suggested tab price" = provider cost plus a small margin so the gateway is profitable. Adjust to taste.

## How auth decides fit

- **Header auth (marked ✅)**: the clean fit. tab injects the key as a request header and strips the buyer's own `Authorization`, so the key never leaks. Start here.
- **Query-param auth (marked ⚠️)**: the key goes in the URL, which tab's header injection does not cover. Doable with a one-file shim in front, or pick a header-auth alternative.

## Clean fits (header auth) — build these first

| Service | Category | Endpoint | Auth header | Provider cost | Suggested tab price |
| --- | --- | --- | --- | --- | --- |
| Tavily | Search | `POST api.tavily.com/search` | `Authorization: Bearer` | ~$0.008 / search | $0.01 |
| Exa | Search | `POST api.exa.ai/search` | `x-api-key` | ~$0.007 / search | $0.01 |
| Serper | Search (Google) | `POST google.serper.dev/search` | `X-API-KEY` | ~$0.001 / search | $0.005 |
| Jina Reader | Read / scrape a URL | `GET r.jina.ai/<url>` | `Authorization: Bearer` (optional) | ~$0.05 / 1M tokens (≈ free per read) | $0.003 / read |
| Firecrawl | Scrape to markdown | `POST api.firecrawl.dev/v1/scrape` | `Authorization: Bearer` | ~$0.001–0.003 / page | $0.005 / page |
| Perplexity Sonar | Answer + live web | `POST api.perplexity.ai/chat/completions` | `Authorization: Bearer` | ~$0.005–0.02 / query | $0.02 / query* |
| OpenRouter | LLM (300+ models) | `POST openrouter.ai/api/v1/chat/completions` | `Authorization: Bearer` | passthrough per token | per-token markup or flat/call* |
| Deepgram | Speech to text | `POST api.deepgram.com/v1/listen` | `Authorization: Token` | ~$0.0043 / min (batch) | $0.01 / min |
| AssemblyAI | Speech to text | `POST api.assemblyai.com/v2/transcript` | `Authorization: <key>` | ~$0.006 / min | $0.012 / min |
| ElevenLabs | Text to speech | `POST api.elevenlabs.io/v1/text-to-speech/<voice>` | `xi-api-key` | $0.05–0.10 / 1k chars | $0.15 / 1k chars |
| Mathpix | OCR (math, tables, PDF) | `POST api.mathpix.com/v3/text` | `app_id` + `app_key` headers | $0.002 / image, $0.005 / page | $0.005 / image |
| fal.ai | Image generation | `POST fal.run/<model>` | `Authorization: Key` | $0.003–0.05 / image (Flux) | $0.06 / image |
| Stability AI | Image generation | `POST api.stability.ai/v2beta/stable-image/generate/core` | `Authorization: Bearer` | ~$0.03 / image | $0.05 / image |
| Replicate | Run any model | `POST api.replicate.com/v1/predictions` | `Authorization: Bearer` | per-second (varies) | per run + margin |
| DeepL | Translation | `POST api.deepl.com/v2/translate` | `Authorization: DeepL-Auth-Key` | ~$5.49–27.50 / 1M chars | $0.03 / 1k chars |
| CoinGecko | Crypto prices | `GET pro-api.coingecko.com/api/v3/...` | `x-cg-pro-api-key` | per-call tiers | $0.002 / call |

\* Token- and minute-priced APIs bill by size, so a flat per-call tab price is an approximation: price above your expected average, or cap the request/response size in the gateway.

## Query-param auth (need a small shim) — ⚠️

| Service | Category | Endpoint | Auth | Provider cost | Suggested tab price |
| --- | --- | --- | --- | --- | --- |
| SerpApi | Google/Bing SERP | `GET serpapi.com/search` | `?api_key` | ~$0.025 / search | $0.03 |
| ScrapingBee | Scrape (JS, proxies) | `GET app.scrapingbee.com/api/v1` | `?api_key` | ~$0.002–0.005 / request | $0.008 |
| OpenWeather | Weather + forecast | `GET api.openweathermap.org/data/3.0/onecall` | `?appid` | ~$0.0015 / call | $0.003 |
| Alpha Vantage | Market data | `GET www.alphavantage.co/query` | `?apikey` | free + paid | $0.005 |
| WolframAlpha | Computational answers | `GET api.wolframalpha.com/v2/query` | `?appid` | per query | $0.01 |
| NewsAPI | News search | `GET newsapi.org/v2/everything` | `?apiKey` (also `X-Api-Key` header) | per call | $0.005 |
| Polygon.io (Massive) | Stocks/crypto/forex | `GET api.polygon.io/...` | `?apiKey` or Bearer | monthly plan, not per-call | (flat-rate source) |

## More candidates by category (pricing model known; verify exact rate before pricing)

- **Search**: Brave Search API ✅, Linkup ✅, You.com ✅
- **Scraping**: ScraperAPI ⚠️, Zyte, Bright Data, Diffbot ⚠️
- **LLM inference (per token)**: Groq ✅, Together ✅, Fireworks ✅, DeepInfra ✅
- **Speech**: Cartesia ✅ (TTS), Speechmatics (STT)
- **Vision / OCR**: OCR.space ⚠️, Clarifai, Google Vision
- **Image / video**: Ideogram ✅, Recraft ✅, Luma, Runway
- **Data / finance**: Twelve Data ⚠️, Financial Modeling Prep ⚠️, Finnhub
- **Weather / geo**: WeatherAPI.com ⚠️, Geoapify ⚠️, Mapbox ✅
- **News / knowledge**: GNews ⚠️, Currents

## The honest caveats

1. **Reseller ToS.** Charging third parties for calls to a provider's API can conflict with that provider's terms. Fine for your own agents or a closed demo; for a public paid catalog, check each provider's ToS for redistribution/reselling clauses before listing.
2. **Subscription-only providers (Polygon/Massive, SerpApi)** bill a flat monthly rate, not per call, so your margin math is "monthly cost / expected calls," not "cost per call + margin."
3. **Token/minute/char pricing** varies per request; cap sizes in the gateway or price with headroom.

## To actually add one

1. Sign up with the provider, get an API key.
2. Write a `spec.json`: `realm`, `recipient`, the `evm` block, one service with `upstream` = the provider base URL, `upstream_headers` injecting your key, one route at the suggested price.
3. `tab serve --spec spec.json --announce https://catalog...` and it is live in the catalog.

Ask tab to generate the spec.json for whichever you pick.
