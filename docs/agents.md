# Configure an agent

Pointing an agent at tab is two decisions. What the agent may spend, which is the mandate. And how the agent reaches the client, which depends on what the agent is built with. This page covers both for the common cases. [buyers.md](buyers.md) is the longer guide to keys and funding; [quickstart.md](quickstart.md) gets you starter credits in one command.

## The limits live in the mandate, not in the agent

```sh
npx paidwithtab init --budget 5.00 --max-per-call 0.02 --days 30
```

`init` writes three files to `~/.tab`: an owner key, an agent key, and a mandate signed by the owner. The flags set the mandate's numbers. For an allow list, or for a second agent, sign a mandate by hand:

```sh
npx paidwithtab key new --out ~/.tab/agent-research.json
npx paidwithtab mandate issue --owner ~/.tab/owner.json --agent ~/.tab/agent-research.json \
  --budget 5.00 --window day --max-per-call 0.02 \
  --allow pay.paidwithtab.com --allow api.someseller.com \
  --days 30 --out ~/.tab/mandate-research.json
```

Read that back as a sentence: *this agent may spend up to $5.00 per UTC day, at most $0.02 per call, only at these two sellers, for 30 days.* The gateway enforces every clause on every request.

The agent gets its own key and its mandate. It never gets the owner key, so it cannot change its limits. One key and one mandate per agent is the pattern for running several:

```
research agent    $5/day,   max $0.02/call, allow pay.paidwithtab.com
coding agent      $25/day,  max $0.10/call, allow mainnet.paidwithtab.com
scraper           $1/day,   max $0.005/call, allow *
```

Budgets are per mandate, so one agent exhausting its tab never touches another's. To stop an agent, let its mandate expire or, on chain, revoke its allowance in one transaction (`tab evm revoke`).

| Flag | Meaning |
| --- | --- |
| `--budget 5.00` | Total the agent may spend in the window, in USD |
| `--window total\|day` | Whether the budget covers the mandate's lifetime or each UTC day |
| `--max-per-call 0.02` | Ceiling on any single request |
| `--allow realm` | Which gateways may be paid, by realm name, with globs. Repeatable. No flag means any |
| `--days 30` | When the mandate stops working |

## Claude Code

The package ships an MCP server. With the files `init` wrote in `~/.tab`, there is nothing to configure:

```sh
claude mcp add --scope user tab -- npx -y paidwithtab mcp
```

To use other keys, or to add a tighter client-side cap on top of the mandate, set environment variables:

```sh
claude mcp add --scope user tab \
  -e TAB_AGENT=$HOME/.tab/agent-research.json \
  -e TAB_MANDATE=$HOME/.tab/mandate-research.json \
  -e TAB_MAX_PER_CALL=0.01 \
  -e TAB_CATALOG=https://paidwithtab.com \
  -- npx -y paidwithtab mcp
```

| Variable | Default | What it does |
| --- | --- | --- |
| `TAB_AGENT` | `~/.tab/agent.json` | The agent key |
| `TAB_MANDATE` | `~/.tab/mandate.json` | The mandate the agent carries |
| `TAB_MAX_PER_CALL` | none | A second per-call ceiling, checked by the client before signing |
| `TAB_CATALOG` | `https://paidwithtab.com` | Where `tab_search` looks for routes |
| `TAB_CURRENCY` | `USD` | The one currency the agent may pay in. A gateway that charges in its own token names it in every 402; anything else is refused before signing |
| `TAB_HOME` | `~/.tab` | Where `init`, `fetch` and `mcp` look for the default files |

Claude gets five tools: `tab_search` (find routes by keyword and maximum price), `tab_discover` (read a gateway's own price list), `tab_fetch` (pay and return the response plus the receipt), `tab_balance`, and `tab_limits` (what the mandate allows). The model can read the limits but cannot raise any of them.

To share the server with everyone who clones a project instead of every project of your own, use `--scope project` and the entry goes into that project's `.mcp.json`.

## Cursor, Codex, Windsurf, Claude Desktop, any MCP host

The same server, as JSON. Every MCP host takes this shape; only the file it lives in differs.

```json
{
  "mcpServers": {
    "tab": {
      "command": "npx",
      "args": ["-y", "paidwithtab", "mcp"],
      "env": {
        "TAB_AGENT": "/home/you/.tab/agent.json",
        "TAB_MANDATE": "/home/you/.tab/mandate.json",
        "TAB_MAX_PER_CALL": "0.05"
      }
    }
  }
}
```

| Host | Where the JSON goes |
| --- | --- |
| Cursor | `.cursor/mcp.json` in the project, or `~/.cursor/mcp.json` for every project |
| Windsurf | `~/.codeium/windsurf/mcp_config.json` |
| Claude Desktop | `claude_desktop_config.json` in the app's config directory |
| Codex | `~/.codex/config.toml`, as an `[mcp_servers.tab]` table with the same `command`, `args` and `env` keys |
| Claude Code | `.mcp.json` in the project, or `claude mcp add` as above |

Use absolute paths in `env`. Hosts start the server from their own working directory, and `~` is not expanded.

## Your own code in TypeScript or JavaScript

```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { TabClient, receiptOf, PaymentRefused } from 'paidwithtab/client';

const home = `${homedir()}/.tab`;
const client = new TabClient({
  agent: JSON.parse(readFileSync(`${home}/agent.json`, 'utf8')),
  mandate: JSON.parse(readFileSync(`${home}/mandate.json`, 'utf8')),
  maxPerCallUsd: '0.02',
  // currency: 'TTT',  // only if the agent should pay a gateway that charges in that token; default USD
  // your own veto, called with the price in micro-USD before anything is signed
  onChallenge: (challenge, req) => Number(req.amount) <= 20_000,
});

try {
  const res = await client.fetch('https://pay.paidwithtab.com/fx/latest?base=USD');
  console.log(await res.json(), receiptOf(res));
} catch (e) {
  if (e instanceof PaymentRefused) console.log('declined:', e.reason);
  else throw e;
}
```

`client.fetch` has the signature of `fetch`. On a 402 it checks the price against the mandate and your cap, signs a credential binding that exact request, retries once, and returns the response. `receiptOf` reads the receipt, or null if the route was free or the call was voided. `PaymentRefused` is thrown before any money moves.

Receipts are signed. `await client.verify(url, res, body, init)` takes the bytes you read from the response (read them with `arrayBuffer()` and decode yourself, since a body can only be read once) and the `init` you sent, and returns `{ ok: true }` only when the receipt was signed by the `receipt_key` the gateway publishes in `/.well-known/tab`, names your mandate, commits to the request you sent, and hashes to exactly the body you got. Anything else returns `{ ok: false, reason }`. `tab fetch` and the MCP `tab_fetch` tool run this check on every paid call and report `receipt_verified`.

### As a tool in an agent framework

Give the framework a tool whose implementation calls `client.fetch`. The model never sees a key; it sees a function that fetches URLs and reports what they cost. Two sketches:

**Vercel AI SDK**

```ts
import { tool } from 'ai';
import { z } from 'zod';

const paidFetch = tool({
  description: 'Fetch a URL from the tab catalog, paying for it within the agent\'s limits.',
  inputSchema: z.object({ url: z.string().url(), body: z.string().optional() }),
  execute: async ({ url, body }) => {
    const res = await client.fetch(url, body ? { method: 'POST', body } : undefined);
    return { status: res.status, body: await res.text(), receipt: receiptOf(res) };
  },
});
```

**LangChain**

```ts
import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const paidFetch = tool(
  async ({ url, body }) => {
    const res = await client.fetch(url, body ? { method: 'POST', body } : undefined);
    return JSON.stringify({ status: res.status, body: await res.text(), receipt: receiptOf(res) });
  },
  {
    name: 'paid_fetch',
    description: 'Fetch a URL from the tab catalog, paying for it within the agent\'s limits.',
    schema: z.object({ url: z.string(), body: z.string().optional() }),
  },
);
```

Pair either with a search step against `https://paidwithtab.com/v1/search?q=...` so the model can find routes and their prices before it pays. The catalog's search endpoint is free and needs no key.

## Python and everything else

There is no Python package yet. Two options today:

**Shell out to the CLI.** The receipt goes to stderr and the response body to stdout, so a subprocess gets clean JSON:

```python
import json, subprocess

def paid_fetch(url, body=None, max_per_call="0.02"):
    cmd = ["npx", "-y", "paidwithtab", "fetch", "--max-per-call", max_per_call]
    if body is not None:
        cmd += ["-X", "POST", "-d", json.dumps(body)]
    p = subprocess.run(cmd + [url], capture_output=True, text=True)
    if p.returncode == 2:
        raise RuntimeError(p.stderr.strip())        # refused before paying
    return p.returncode, json.loads(p.stdout or "null"), p.stderr.strip()

code, data, receipt = paid_fetch("https://pay.paidwithtab.com/fx/latest?base=USD")
```

Exit codes: 0 paid and served, 1 the API answered non-2xx and nothing was charged, 2 the client refused before paying. The CLI reads `~/.tab` or `TAB_AGENT` and `TAB_MANDATE` from the environment, so the Python process needs no key handling of its own.

**Implement the protocol.** A credential is a small JSON object signed with the agent key. [SPEC.md](../SPEC.md) has the fields and the verification rules; the TypeScript client in `src/client.ts` is about a hundred lines and is the reference.

## Where the keys live

| Where the agent runs | Agent key and mandate | Owner key |
| --- | --- | --- |
| Your laptop | `~/.tab`, as `init` wrote them | `~/.tab` is fine for sandbox money. For real funds, a password manager |
| A server or container | Mounted as secrets, paths in `TAB_AGENT` and `TAB_MANDATE` | Never on the server. Sign mandates elsewhere and ship only the mandate |
| Someone else's agent | Issue them a key and mandate of their own | Yours stays with you |

The mandate is not a secret, but it grants spending, so treat the file with respect. If an agent key leaks, the damage ceiling is the mandate's remaining budget, and on chain at most the token allowance. Rotate by issuing a new agent key and mandate and, on chain, revoking the old allowance:

```sh
npx paidwithtab evm revoke --owner owner.json --agent old-agent.json --token <0x token>
```

## Checking what an agent can do

```sh
npx paidwithtab fetch --max-per-call 0.0001 "https://pay.paidwithtab.com/weather/forecast?latitude=35.68&longitude=139.69&current=temperature_2m"
```

```
refused: price 0.001 exceeds the client cap 0.0001
```

Exit code 2, nothing paid. From Claude Code, ask for the agent's limits and it calls `tab_limits`, which reads the mandate back as budget, window, per-call cap, allowed sellers and expiry.
