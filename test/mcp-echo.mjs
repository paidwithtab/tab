// A tiny stdio MCP server for test/v31.ts: "shout" upper-cases its text, "fail" reports a tool error.
import { createInterface } from 'node:readline';

const tools = [
  { name: 'shout', description: 'Upper-case some text', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'fail', description: 'Always reports an error', inputSchema: { type: 'object', properties: {} } },
];
const out = (m) => process.stdout.write(JSON.stringify(m) + '\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  if (m.method === 'initialize') return out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } });
  if (m.method === 'tools/list') return out({ jsonrpc: '2.0', id: m.id, result: { tools } });
  if (m.method === 'tools/call') {
    if (m.params?.name === 'shout') return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params.arguments?.text ?? '').toUpperCase() }] } });
    if (m.params?.name === 'fail') return out({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'nope' }], isError: true } });
    return out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: 'unknown tool' } });
  }
  out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
});
