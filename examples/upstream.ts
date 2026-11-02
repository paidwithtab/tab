// The demo API being sold: quotes, echo, secret, translate, boom, free, and since 3.0 an essay
// delivered later (pay on delivery) and a metered completion (per token, for channels).
// It knows nothing about payments; it just sees ordinary HTTP (plus the
// Tab-Payer / Tab-Owner / Tab-Hold attribution headers the gateway adds).

import { createServer, type Server } from 'node:http';

const QUOTES = [
  'The best way to predict the future is to invent it. — Alan Kay',
  'Simplicity is prerequisite for reliability. — Edsger Dijkstra',
  'Programs must be written for people to read. — Harold Abelson',
  'Premature optimization is the root of all evil. — Donald Knuth',
  'Talk is cheap. Show me the code. — Linus Torvalds',
];

export function createUpstream(premiumKey = process.env.PREMIUM_KEY || 'demo-key'): Server {
  return createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString('utf8');
    const json = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };

    if (req.method === 'GET' && u.pathname === '/quote') {
      return json(200, { quote: QUOTES[Math.floor(Math.random() * QUOTES.length)], payer: req.headers['tab-payer'] ?? null });
    }
    if (req.method === 'POST' && u.pathname === '/echo') {
      return json(200, { echo: body, headers: { 'tab-payer': req.headers['tab-payer'] ?? null, 'tab-hold': req.headers['tab-hold'] ?? null, authorization: req.headers.authorization ?? null } });
    }
    if (req.method === 'GET' && u.pathname === '/secret') {
      if (req.headers['x-api-key'] !== premiumKey) return json(401, { error: 'bad or missing X-Api-Key' });
      return json(200, { secret: 'the gateway injected the API key; the buyer never saw it' });
    }
    if (req.method === 'POST' && u.pathname === '/translate') {
      let text = '';
      try { text = String(JSON.parse(body || '{}').text ?? ''); } catch { /* ignore */ }
      return json(200, { translated: text.toUpperCase() || '(nothing to translate)' });
    }
    if (req.method === 'GET' && u.pathname === '/boom') {
      return json(500, { error: 'this route always fails, on purpose' });
    }
    // 3.0, pay on delivery: accept now, deliver a few seconds later to the URL the gateway sent
    if (req.method === 'POST' && u.pathname === '/essay') {
      const deliver = req.headers['tab-deliver'];
      const token = req.headers['tab-delivery-token'];
      let topic = 'payments for agents';
      try { topic = String(JSON.parse(body || '{}').topic ?? topic); } catch { /* ignore */ }
      if (typeof deliver === 'string' && typeof token === 'string') {
        setTimeout(() => {
          void fetch(deliver, { method: 'POST', headers: { 'tab-delivery-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ essay: `A short essay on ${topic}: it was paid for on delivery.` }) }).catch(() => {});
        }, Number(process.env.ESSAY_DELAY_MS ?? 4000));
        return json(202, { accepted: true, deliver_in_s: Number(process.env.ESSAY_DELAY_MS ?? 4000) / 1000 });
      }
      return json(200, { essay: `A short essay on ${topic}.` });
    }
    // 3.0, metered: report the units used, and a channel buyer pays per unit
    if (req.method === 'GET' && u.pathname === '/complete') {
      const tokens = Math.max(1, Math.min(100_000, Number(u.searchParams.get('tokens')) || 500));
      res.writeHead(200, { 'content-type': 'application/json', 'tab-units': String(tokens) });
      return res.end(JSON.stringify({ completion: 'lorem '.repeat(Math.min(tokens, 50)).trim(), tokens }));
    }
    if (req.method === 'GET' && u.pathname === '/free') {
      return json(200, { hello: 'this route is free', query: u.search });
    }
    json(404, { error: `upstream has no ${req.method} ${u.pathname}` });
  });
}

// started directly (npm run upstream)
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.UPSTREAM_PORT ?? 4101);
  createUpstream().listen(port, () => {
    console.error(`[${new Date().toISOString()}] example upstream listening on :${port}`);
  });
}
