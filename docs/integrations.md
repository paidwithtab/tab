# tab in every agent tool

tab is an MCP server, so any tool that speaks MCP can use it. One command writes it into the tool's own config; the server sets itself up on first launch (keys, a $1.00 a day mandate, and $1.00 of starter credits on the public gateway).

## One command per tool

| Tool | Command | What it changes |
| --- | --- | --- |
| Claude Code | `claude mcp add --scope user tab -- npx -y paidwithtab mcp` | Claude Code's user config |
| Cursor | `npx -y paidwithtab setup cursor` | `~/.cursor/mcp.json` |
| Windsurf | `npx -y paidwithtab setup windsurf` | `~/.codeium/windsurf/mcp_config.json` |
| VS Code | `npx -y paidwithtab setup vscode` | your user `mcp.json` (`servers.tab`, stdio) |
| Codex | `npx -y paidwithtab setup codex` | `~/.codex/config.toml` (`[mcp_servers.tab]`) |

`tab setup <tool> --print` shows the file it would write and changes nothing. An existing config keeps every other server; the old file is saved next to it as `.before-tab`. A JSON config with comments is left alone, and the command tells you to add the entry by hand. `--github` runs the server from the GitHub repository instead of npm.

By hand, the entry is the same everywhere:

```json
{ "mcpServers": { "tab": { "command": "npx", "args": ["-y", "paidwithtab", "mcp"] } } }
```

VS Code calls the key `servers` and wants `"type": "stdio"` in the entry. Codex:

```toml
[mcp_servers.tab]
command = "npx"
args = ["-y", "paidwithtab", "mcp"]
```

## What the agent gets

`tab_search` (tab gateways and x402 sellers, ranked working and cheap first), `tab_fetch` (pays within the mandate, keeps a proof, answers repeated GETs from the cache), `tab_estimate` (prices a plan before spending), `tab_cost` (what it spent, by task), `tab_limits`, `tab_balance`, `tab_discover`, and for 3.0 features `tab_escrow` and `tab_channel`.

Environment the server reads, all optional: `TAB_TASK` (what the agent works on; otherwise the git repository and branch), `TAB_CACHE_TTL` (seconds, or `off`), `TAB_PROOFS` (folder, or `off`), `TAB_MAX_PER_CALL`, `TAB_CATALOG`, `TAB_CURRENCY`.

## Agent frameworks

Frameworks that take MCP servers run the same command as a stdio server.

**OpenAI Agents SDK (Python)**

```python
from agents import Agent, Runner
from agents.mcp import MCPServerStdio

async with MCPServerStdio(params={"command": "npx", "args": ["-y", "paidwithtab", "mcp"]}) as tab:
    agent = Agent(name="researcher", instructions="Use tab_search to find a paid API, then tab_fetch it.", mcp_servers=[tab])
    result = await Runner.run(agent, "What is the weather in Lisbon tomorrow?")
```

**Vercel AI SDK (TypeScript)**, as of AI SDK 4.2 and 5; newer releases may move the MCP client to its own package, so check its MCP page if an import is missing.

```ts
import { experimental_createMCPClient as createMCPClient, generateText } from 'ai';
import { Experimental_StdioMCPTransport as StdioMCPTransport } from 'ai/mcp-stdio';

const tab = await createMCPClient({ transport: new StdioMCPTransport({ command: 'npx', args: ['-y', 'paidwithtab', 'mcp'] }) });
const { text } = await generateText({ model, tools: await tab.tools(), maxSteps: 5, prompt: 'Find a paid weather API with tab_search and fetch tomorrow in Lisbon.' });
await tab.close();
```

**LangChain (Python, langchain-mcp-adapters)**

```python
from langchain_mcp_adapters.client import MultiServerMCPClient

client = MultiServerMCPClient({"tab": {"command": "npx", "args": ["-y", "paidwithtab", "mcp"], "transport": "stdio"}})
tools = await client.get_tools()
```

**Without MCP.** In TypeScript, `TabClient` from `paidwithtab` is a `fetch` that pays (docs/buyers.md, step 4), and `createTabTools` returns the same tools as plain functions with JSON Schemas, for any model API.

## Spending limits for each tool

Each tool shares the keys in `~/.tab` unless you point it elsewhere with `TAB_AGENT` and `TAB_MANDATE`. To give a tool its own budget, its own routes or its own hours, issue it a mandate:

```sh
npx paidwithtab key new --out ~/.tab/cursor-agent.json
npx paidwithtab mandate issue --owner ~/.tab/owner.json --agent ~/.tab/cursor-agent.json \
  --budget 0.50 --window day --paths "/search*" --paths "/wikipedia/*" --hours "mon-fri 9-18" --out ~/.tab/cursor-mandate.json
```

Then set `TAB_AGENT` and `TAB_MANDATE` in that tool's entry (`"env": {...}` in JSON, `env = {...}` in Codex). Gateways and the client both refuse anything outside the routes and hours, and `tab cost --by task` shows what each tool and branch spent.
