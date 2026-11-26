import LinqAPIV3 from '@linqapp/sdk';
import express, { type ErrorRequestHandler } from 'express';
import { resolve } from 'node:path';
import { createServer as createVite } from 'vite';
import { makeApp } from './app.js';
import { remoteClassifier, simulate } from './classifier.js';
import { demoSecret } from './events.js';
import { linqSender, mockSend } from './messaging.js';
import { openStore } from './store.js';
import { log, makeWorker } from './worker.js';

const env = process.env;
const mode = env.MESSAGING_MODE || 'demo';
if (mode !== 'demo' && mode !== 'linq-sandbox') throw new Error('Unknown MESSAGING_MODE');
const demo = mode === 'demo';
const e164 = /^\+[1-9]\d{7,14}$/;
const allowlist = new Set((env.LINQ_TEST_RECIPIENTS ?? '').split(',').map(value => value.trim()).filter(Boolean));
const line = env.LINQ_TEST_LINE ?? '';
if (!demo && (env.APPROVE_LINQ_SANDBOX_SEND !== 'yes' || !env.LINQ_API_V3_API_KEY ||
    !/^whsec_[A-Za-z0-9+/]+=*$/.test(env.LINQ_WEBHOOK_SECRET ?? '') || !e164.test(line) ||
    !allowlist.size || [...allowlist].some(handle => !e164.test(handle) || handle === line))) {
  throw new Error('Linq sandbox mode requires explicit approval, test credentials, a test line, and an E.164 recipient allowlist');
}
const aiMode = env.INTENT_MODE || 'local';
if (aiMode !== 'local' && aiMode !== 'openai') throw new Error('Unknown INTENT_MODE');
if (aiMode === 'openai' && (env.APPROVE_REMOTE_LLM !== 'yes' || !env.OPENAI_API_KEY || !env.OPENAI_MODEL)) {
  throw new Error('OpenAI mode requires explicit approval, API key, and model');
}
const port = Number(env.PORT || '3000');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT');

const client = new LinqAPIV3({
  apiKey: demo ? 'local-fixture-only' : env.LINQ_API_V3_API_KEY!,
  webhookSecret: demo ? demoSecret : env.LINQ_WEBHOOK_SECRET!,
  baseURL: 'https://api.linqapp.com/api/partner',
  maxRetries: 0,
  timeout: 5000,
});
const db = openStore(env.DB_PATH || (demo ? 'data/demo.sqlite' : 'data/linq-sandbox.sqlite'));
const classify = aiMode === 'openai' ? remoteClassifier(env.OPENAI_API_KEY!, env.OPENAI_MODEL!, () => log('classifier_fallback')) : simulate;
const worker = makeWorker(db, classify, demo ? mockSend : linqSender(client, allowlist));
const app = makeApp({
  db, verifier: client, demo, report: log,
  permitted: message => demo || (message.line === line && allowlist.has(message.customer)),
});
app.use(['/api', '/webhooks'], (_req, res) => { res.sendStatus(404); });

const production = process.argv.includes('--production');
const vite = production ? null : await createVite({
  server: { middlewareMode: true, hmr: false },
  appType: 'spa',
});
if (vite) app.use(vite.middlewares);
else app.use(express.static(resolve('dist')));

const errors: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) { next(error); return; }
  const status = [400, 413, 415].includes(error.status) ? Number(error.status) : 503;
  log('request_error', { status });
  res.status(status).json({ error: status === 503 ? 'Temporarily unavailable' : 'Invalid request' });
};
app.use(errors);

let task: Promise<void> = Promise.resolve();
let ticking = false;
const timer = setInterval(() => {
  if (ticking) return;
  ticking = true;
  task = worker().catch(() => log('worker_error')).finally(() => { ticking = false; });
}, 200);
const server = app.listen(port, '127.0.0.1', () => log('listening', { url: 'http://127.0.0.1:' + port, mode, aiMode }));
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  server.close();
  await task;
  await vite?.close();
  db.close();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

