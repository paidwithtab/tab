// 3.2: `tab setup <client>`: put the tab MCP server in an agent tool's config with one command.
// Claude Code gets its own `claude mcp add`; Cursor, Windsurf and VS Code read a JSON file; Codex
// reads TOML. An existing config is kept (a copy is saved next to it) and only the tab entry changes.

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

export const CLIENTS = ['claude', 'cursor', 'windsurf', 'vscode', 'codex'] as const;
export type Client = (typeof CLIENTS)[number];

/** The command an agent tool runs to start tab: the npm package, or the GitHub repository. */
export function serverCommand(source: 'npm' | 'github' = 'npm'): { command: string; args: string[] } {
  return { command: 'npx', args: ['-y', source === 'github' ? 'github:paidwithtab/tab' : 'paidwithtab', 'mcp'] };
}

/** Where each tool keeps its user-wide MCP config. */
export function configPath(client: Exclude<Client, 'claude'>, home = homedir(), os = platform()): string {
  switch (client) {
    case 'cursor': return join(home, '.cursor', 'mcp.json');
    case 'windsurf': return join(home, '.codeium', 'windsurf', 'mcp_config.json');
    case 'codex': return join(home, '.codex', 'config.toml');
    case 'vscode':
      return os === 'darwin' ? join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json')
        : os === 'win32' ? join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'Code', 'User', 'mcp.json')
        : join(home, '.config', 'Code', 'User', 'mcp.json');
  }
}

/** The config file with tab added (or replaced), from what it held before. */
export function withTab(client: Exclude<Client, 'claude'>, before: string | null, env: Record<string, string> = {}, source: 'npm' | 'github' = 'npm'): string {
  const { command, args } = serverCommand(source);
  if (client === 'codex') {
    // TOML: replace our table if it is there, else append it
    const block = `[mcp_servers.tab]\ncommand = "${command}"\nargs = [${args.map((a) => JSON.stringify(a)).join(', ')}]\n${Object.keys(env).length ? `env = { ${Object.entries(env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join(', ')} }\n` : ''}`;
    const text = before ?? '';
    const re = /^\[mcp_servers\.tab\][^\n]*\n(?:(?!\[)[^\n]*\n?)*/m;
    return re.test(text) ? text.replace(re, block) : `${text}${text && !text.endsWith('\n') ? '\n' : ''}${text ? '\n' : ''}${block}`;
  }
  let doc: Record<string, any> = {};
  if (before && before.trim()) {
    try { doc = JSON.parse(before); } catch { throw new Error('the existing config is not plain JSON (comments?); add tab by hand, see docs/integrations.md'); }
  }
  const entry = { ...(client === 'vscode' ? { type: 'stdio' } : {}), command, args, ...(Object.keys(env).length ? { env } : {}) };
  const key = client === 'vscode' ? 'servers' : 'mcpServers';
  doc[key] = { ...(doc[key] ?? {}), tab: entry };
  return JSON.stringify(doc, null, 2) + '\n';
}

export async function setupCommand(rest: string[], io: { log: (m: string) => void; die: (m: string) => never }): Promise<void> {
  const client = rest[0] as Client;
  const print = rest.includes('--print');
  const source = rest.includes('--github') ? 'github' : 'npm';
  if (!CLIENTS.includes(client)) io.die(`usage: tab setup <${CLIENTS.join('|')}> [--print] [--github]\n  writes the tab MCP server into that tool's config (Claude Code: runs claude mcp add)`);
  const { command, args } = serverCommand(source);
  if (client === 'claude') {
    const line = ['claude', 'mcp', 'add', '--scope', 'user', 'tab', '--', command, ...args];
    if (print) { console.log(line.join(' ')); return; }
    try {
      execFileSync(line[0], line.slice(1), { stdio: 'inherit' });
      console.log('tab is in Claude Code. Start a session and ask it to find a paid API with tab_search.');
    } catch {
      console.log(`Claude Code's command did not run here. Run this yourself:\n  ${line.join(' ')}`);
    }
    return;
  }
  const path = configPath(client);
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  let after: string;
  try { after = withTab(client, before, {}, source); } catch (err) { io.die((err as Error).message); }
  if (print) { console.log(`# ${path}\n${after}`); return; }
  mkdirSync(dirname(path), { recursive: true });
  if (before !== null) copyFileSync(path, path + '.before-tab');
  writeFileSync(path, after);
  console.log(`tab added to ${path}${before !== null ? ` (the old file is at ${path}.before-tab)` : ''}.`);
  console.log(`Restart ${({ cursor: 'Cursor', windsurf: 'Windsurf', vscode: 'VS Code', codex: 'Codex' } as Record<string, string>)[client]}; on first launch tab makes its keys, a $1/day budget and claims starter credits.`);
}
