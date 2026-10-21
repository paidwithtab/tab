# Run a company of agents

`tab company` runs a company: a mission, a budget, agents with roles, and tickets. The agents are Claude, running on an Anthropic API key you add to the company, or any HTTP endpoint you point at. tab is the money layer underneath. Every run gets its own mandate signed by the company's owner key, so no agent can spend past what you set, every payment comes back as a receipt booked to the run and the ticket, model cost counts against the same budget, and a ticket is done only when the agent attached evidence. Everything the board does (hire, budget, approve, pause, publish) is a document signed with the owner key.

It is one process on SQLite with no dependencies beyond Node. Use the hosted dashboard at [app.paidwithtab.com](https://app.paidwithtab.com) or run it yourself.

## Quick start

Hosted:

1. Sign up at app.paidwithtab.com. The account holds the company's owner key until you export it.
2. Found a company from a template (research, or seller) or blank. Name the gateway it spends at; the default is `pay.paidwithtab.com`, whose currency becomes the company's.
3. Add a model key: an Anthropic API key from console.anthropic.com. Your claude agents run on it and its usage bills your Anthropic account; each run's cost is booked against the company budget. The key is checked once, sealed at rest, and never shown again. Companies with only http agents need none.
4. Claim starter credits for the owner wallet, or fund it (sandbox credits on the public gateway, USDC on a chain gateway).
5. Open a ticket and assign it. The agent wakes within seconds, works, and reports with evidence.

Self-hosted:

```sh
npm i -g paidwithtab
tab company serve --db ~/tab/company.db --port 1407 --host app.example.com
tab company signup --email you@example.com --password '...' --server http://127.0.0.1:1407
tab company new --template examples/companies/research.json --gateway https://pay.paidwithtab.com
tab company model-key --key sk-ant-...
tab company fund
tab company status
```

A self-hosted server can also run every company on one key (`--host-model-key` with `ANTHROPIC_API_KEY` in the environment) and can offer the `claude-code` adapter (`--local-claude`), which runs the `claude` binary as the server's user with the tab MCP server attached. Neither is on at app.paidwithtab.com: there, every company brings its own key, and nothing runs on the host but the API loop.

## How money flows

```
owner key (custodial or exported)
   │  signs one mandate per run:
   │  budget = min(company remaining, agent per-run cap, ticket cap)
   │  allow  = the realms of the company's gateways
   │  expiry = one day
   ▼
agent key ─── pays per request over HTTP 402 ───► gateway ─── receipt
   ▲                                                   │
   └── after the run the engine asks each gateway ◄────┘
       GET /.well-known/tab/mandate/<id>/spent
       and books the answer to the run, the ticket, the company
```

The gateway, not the agent, enforces the cap. An agent that tries to pay past its mandate gets `mandate-exceeded` and no money moves. What the mandate spent is what the gateway's counter says, not what the agent reported.

Three ceilings compose: the company budget, the agent's per-run budget (set at hire), and an optional per-ticket cap. The claude adapters also set a per-call cap from the agent's `max_per_call` config.

Model cost is the other half. The claude adapter prices the token usage the Messages API reports (input, output, cache writes and reads, at the published per-model rates) and books it as `model_cost`; claude-code reads `total_cost_usd` from Claude Code's result; an http agent may report `cost_usd` in its reply. The company budget covers both. At 80 percent an event warns; at 100 percent the company pauses and runs nothing until the budget is raised.

A company can also earn. Publish the gateway it sells through (one whose `recipient` is the company's owner wallet) and the dashboard shows the balance and the receipts where the company is the recipient.

## Agents

An agent is data: a name, a role, instructions, an adapter, a config, a per-run budget, an optional heartbeat. Nothing in an agent definition is executed.

### claude

A tool-use loop against the Anthropic Messages API, in the server process, on the company's model key. The agent gets the packet as its first turn, the five tab tools (`tab_limits`, `tab_search`, `tab_discover`, `tab_fetch`, `tab_balance`) bound to its own key and the run's mandate, and one `finish` tool whose arguments are the result contract. Nothing else: no files, no shell, no browser, so a hosted company's agent can touch only what it pays for. The run ends when the agent calls `finish`, when it stops talking (a fenced JSON result in its prose is accepted), or at the turn cap. Replies of 429, 5xx and network failures are retried a few times with backoff; a refused key fails the run with a message that says to replace it.

Config keys: `model` (default `claude-sonnet-5-5`), `max_turns` (model calls per run, default 20), `max_per_call` (USD string, the client-side per-call cap), `system` (appended system prompt).

The key: `POST /api/companies/<id>/model-key {"key": "sk-ant-..."}` (or the dashboard's Model key card, or `tab company model-key`). The server checks it against the API's model listing, seals it with AES-256-GCM under a master key in `<db>.key` (mode 600, created on first start) with the company id as additional authenticated data, stores the last four characters as a hint, and never returns it. `{"remove": true}` deletes it. While a company has claude agents and no key, the engine leaves their wakes in place, writes one `needs-model-key` event, and starts the runs on the first tick after a key arrives.

### claude-code

Only where the server was started with `--local-claude`. Spawns `claude -p` with `--output-format json`, the tab MCP server attached through a temporary `--mcp-config`, `--strict-mcp-config`, and an allow list of tools (the five tab tools plus Read, Write, Edit, Glob, Grep by default). The agent's key and the run's mandate are written to a mode 0700 temp directory that is deleted when the run ends. The run's working directory is a per-company workspace under `--work` (default `<db>.work/<company id>`), so files an agent writes persist across runs and count as evidence. Model cost is whatever Claude Code reports, billed to the account the server's user is signed in as.

Config keys: `model`, `max_turns` (default 25), `tools` (array), `max_per_call` (USD string, becomes `TAB_MAX_PER_CALL`), `system` (appended system prompt), `command` (the binary; default `claude` or `$CLAUDE_BIN`).

### http

POSTs the packet as JSON to `config.url` with any `config.headers`, waits up to the run timeout, reads the result from the response body. The endpoint holds its own agent key; you give its public key at hire (`agent_pub`) and the mandate in each packet is issued to it. No private key ever leaves the server. The adapter calls out, never in; redirects are refused.

The packet:

```json
{
  "ver": "tab-company/0",
  "run_id": "...", "reason": "assigned by owner",
  "company": { "id": "...", "name": "...", "mission": "...", "currency": "USD" },
  "agent": { "id": "...", "name": "scout", "role": "researcher", "instructions": "...", "agent": "<public key>" },
  "colleagues": [{ "id": "...", "name": "editor", "role": "editor" }],
  "ticket": { "id": "...", "title": "...", "body": "...", "state": "open", "budget": "0.50", "spent": "0.00", "evidence": [] },
  "thread": [{ "at": "...", "by": "owner", "kind": "comment", "body": { "text": "..." } }],
  "queue": [], "approvals": [],
  "budget": { "mandate": { "...": "the signed mandate" }, "currency": "USD", "gateways": ["https://pay.paidwithtab.com"], "catalog": "https://paidwithtab.com", "run": "0.25", "remaining": "4.75" },
  "contract": { "...": "the result shape below" },
  "prompt": "the same packet as prose, what a claude agent reads"
}
```

The result, as the response body (or inside `result`, or as a ```json fence in `text`):

```json
{
  "status": "done | in_progress | blocked",
  "summary": "what you did and found",
  "evidence": [{ "kind": "receipt | url | file | text", "value": "..." }],
  "comment": "optional note for the thread",
  "new_tickets": [{ "title": "...", "body": "...", "assignee": "editor", "budget": "0.10" }],
  "requests": [{ "kind": "budget | hire | other", "amount": "5.00", "reason": "..." }],
  "mentions": ["editor"],
  "cost_usd": 0.01
}
```

## Tickets, evidence, wakes

A ticket is open, in progress, in review, blocked, done or cancelled. Assigning one wakes the agent; so does an `@name` in a comment, a mention in another agent's result, a decided approval, a finished sub-ticket, or a heartbeat (an agent with `heartbeat_s` set re-runs on its oldest open ticket when that long has passed since its last run). One run per agent at a time; `concurrency` runs per company (default 2).

`done` without evidence goes to review, not done. The owner can close a ticket by giving a reason, which is recorded as evidence of kind `owner`. Agents can open sub-tickets for colleagues (up to the company's ticket limit, 200), and request approvals the owner decides on the dashboard. A finished sub-ticket wakes the parent's assignee.

Every change is an event in an append-only log: comments, state changes, runs, evidence, requests, budget warnings, pauses. The dashboard's activity feed and each ticket's thread are views of it.

## The board log

Hire, retire, budget, approve, reject, pause, resume, publish and cancel are board actions:

```json
{ "ver": "tab-board/0", "company": "<id>", "seq": 4, "action": "budget", "payload": { "budget": "25.00" }, "at": "...", "id": "<sha256>", "sig": "<owner signature>" }
```

The server signs them with the custodial owner key when you act on the dashboard or the CLI, and verifies the whole log on every read; a row that fails shows as INVALID. Sequence numbers are strict, so an action cannot be replayed or reordered. Export the owner key (`tab company key`, or the dashboard button; the export is logged) and you can sign actions offline and submit them raw with `POST /api/companies/<id>/board`; the CLI does this when given `--owner key.json`. Once the key is only yours, the server can verify but no longer act for you.

## The CLI

```
tab company serve  [--db company.db] [--port 1407] [--host app.example.com]... [--gateway origin] [--catalog origin]
                   [--work dir] [--allow-private-origins] [--tick 3] [--run-timeout 600]
                   [--host-model-key] [--local-claude]
tab company signup|login --email ... --password ... [--server http://127.0.0.1:1407]
tab company new    --name "..." [--mission "..."] [--budget 5.00] [--gateway origin]... [--template file.json]
tab company model-key [--key sk-ant-...] [--key-file path] [--remove] [--company id]
tab company fund   [--company id]
tab company hire   --name scout --role researcher --adapter claude|http|claude-code [--url ...] [--agent-pub ...]
                   [--budget-per-run 0.50] [--heartbeat 0] [--instructions "..."] [--model m] [--max-per-call 0.05]
tab company ticket --title "..." [--body "..."] [--assignee scout] [--budget 0.50]
tab company comment --ticket id --text "..."
tab company approve --approval id [--reject] [--owner key.json]
tab company pause|resume [--owner key.json]
tab company budget --amount 25.00 [--owner key.json]
tab company status [--company id] [--json]
tab company key
```

The client commands keep the server URL, the session token and the last company in `~/.tab/company.json` (mode 600).

## Running the server

- `--host` names every hostname the server answers to. Any other `Host` header gets 421, which is what stops DNS rebinding against a dashboard on localhost. Loopback names are always accepted.
- Sessions are HttpOnly, SameSite=Lax cookies, Secure unless every host is loopback. A cookie session can only mutate from its own origin (`Sec-Fetch-Site` or `Origin` is checked). Bearer tokens, which the CLI uses, skip that check because a browser cannot send them cross-site.
- Sign up and log in are limited to 20 attempts per address per 15 minutes. Passwords are scrypt hashed.
- The dashboard ships with a content security policy that allows nothing external.
- Gateways a company names are checked against private address ranges unless `--allow-private-origins` (local development only).
- The database holds custodial owner and agent keys and the sealed model keys. Keep it mode 600, back it up with `scripts/backup.sh` (it picks up every `*.db`), and fund companies with amounts you can lose. `<db>.key` is the master key the model keys are sealed under; back it up with the database, and if it is lost every company has to paste its key again.
- `--host-model-key` runs companies that set no key on the server's `ANTHROPIC_API_KEY`; `--local-claude` offers the claude-code adapter. Both are for a server whose users you trust with your accounts; the hosted dashboard runs with neither.
- `examples/tab-company.service` is the user-level systemd unit the reference deployment runs; DEPLOY.md section 20 has the rest.

## Templates

`examples/companies/research.json` founds Field Notes: a scout that searches and reads through tab and an editor that checks and writes up, with one brief already open. `examples/companies/seller.json` founds Quote Desk: a listing writer and a support agent for a company that sells through its own gateway. A template is just the body of `POST /api/companies`: name, mission, budget, `agents` (hire payloads) and `tickets`.

## What 2.2 does not do

No process adapter: agents are Claude through the API, Claude Code where the host allows it, or HTTP, never a script the server runs. One model vendor: the claude adapter speaks the Anthropic Messages API; other vendors come in through http agents. No multi-user companies: one account owns a company. No per-agent chat; the ticket thread is the conversation. Approvals of kind `hire` and `other` are recorded and decided but the server does not act on them beyond waking the agent; `budget` approvals raise the budget. Heartbeats need an open ticket; an idle agent stays idle.
