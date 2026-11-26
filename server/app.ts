import express, { type Request } from 'express';
import LinqAPIV3 from '@linqapp/sdk';
import { z } from 'zod';
import { demoCustomers, inboundFixture, parseEvent, signedFixture, type Message } from './events.js';
import type { Store } from './store.js';
import { enqueue, type Logger } from './worker.js';

type AppOptions = {
  db: Store;
  verifier: LinqAPIV3;
  demo: boolean;
  report: Logger;
  permitted: (message: Message) => boolean;
};

export function makeApp({ db, verifier, demo, report, permitted }: AppOptions) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(req.get('host') ?? '')) {
      res.sendStatus(403);
      return;
    }
    next();
  });

  function accept(raw: string, headers: Request['headers'], source: Message['source']) {
    let payload: unknown;
    try {
      const signatureHeaders = {
        'webhook-id': headers['webhook-id'],
        'webhook-signature': headers['webhook-signature'],
        'webhook-timestamp': headers['webhook-timestamp'],
      };
      if (Object.values(signatureHeaders).some(value => typeof value !== 'string')) return { status: 401 };
      payload = verifier.webhooks.unwrap(raw, { headers: Object.fromEntries(Object.entries(signatureHeaders)
        .flatMap(([name, value]) => typeof value === 'string' ? [[name, value]] : [])) });
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 401;
      report('webhook_rejected', { status });
      return { status };
    }
    let event;
    try {
      event = parseEvent(payload, source);
      if (event && event.id !== headers['webhook-id']) return { status: 400 };
    } catch {
      report('webhook_rejected', { status: 400 });
      return { status: 400 };
    }
    if (!event || (event.kind === 'inbound' && !permitted(event))) return { status: 200, ignored: true };
    const duplicate = !enqueue(db, event);
    report('webhook_received', { correlationId: event.id, linqTraceId: event.trace, duplicate });
    return { status: 200, duplicate, correlationId: event.id };
  }

  app.post('/webhooks/linq', express.raw({ type: 'application/json', limit: '256kb', inflate: false }), (req, res) => {
    if (!Buffer.isBuffer(req.body)) {
      res.sendStatus(415);
      return;
    }
    let raw: string;
    try {
      raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(req.body);
    } catch {
      res.sendStatus(400);
      return;
    }
    const result = accept(raw, req.headers, demo ? 'demo' : 'linq');
    if (result.correlationId) res.setHeader('x-correlation-id', result.correlationId);
    res.status(result.status).json(result);
  });

  app.use('/api', (req, res, next) => {
    const origin = req.get('origin');
    if (origin && origin !== 'http://' + req.get('host')) {
      res.sendStatus(403);
      return;
    }
    res.setHeader('cache-control', 'no-store');
    next();
  });
  app.use('/api', express.json({ limit: '16kb' }));
  app.get('/api/dashboard', (_req, res) => {
    const conversations = db.prepare(`
      SELECT chat, customer, touched_at, CASE WHEN customer IN (SELECT customer FROM opt_outs)
        THEN 'opted out' ELSE state END AS state, draft IS NOT NULL AS pending
      FROM conversations ORDER BY touched_at DESC LIMIT 100
    `).all();
    const decisions = db.prepare(`
      SELECT d.*, o.body AS reply, o.state AS delivery, o.attempts, o.error, o.trace AS send_trace,
        o.provider_id FROM decisions d LEFT JOIN outbox o ON o.event_id = d.event_id
      ORDER BY d.rowid DESC LIMIT 300
    `).all();
    const bookings = db.prepare('SELECT * FROM appointments ORDER BY slot DESC LIMIT 100').all();
    const processingErrors = db.prepare("SELECT event_id, error FROM inbox WHERE state = 'failed' ORDER BY sequence DESC LIMIT 20").all();
    res.json({ demo, customers: demo ? demoCustomers : {}, conversations, decisions, bookings, processingErrors });
  });
  app.post('/api/demo/message', (req, res) => {
    if (!demo) { res.sendStatus(404); return; }
    const parsed = z.object({ customer: z.enum(['maya', 'jordan']), text: z.string().trim().min(1).max(4000) }).safeParse(req.body);
    if (!parsed.success) { res.sendStatus(400); return; }
    const event = inboundFixture(parsed.data.customer, parsed.data.text);
    const raw = JSON.stringify(event, null, 2);
    const result = accept(raw, signedFixture(raw, event.event_id), 'demo');
    res.status(result.status === 200 ? 202 : result.status).json(result);
  });
  app.post('/api/conversations/:chat/resume', (req, res) => {
    // Require JSON so cross-origin HTML form posts cannot alter state.
    if (!req.is('application/json')) { res.sendStatus(415); return; }
    const changed = db.prepare("UPDATE conversations SET state = 'active', draft = NULL WHERE chat = ? AND state = 'handoff'")
      .run(req.params.chat);
    res.sendStatus(changed.changes ? 204 : 409);
  });
  return app;
}

