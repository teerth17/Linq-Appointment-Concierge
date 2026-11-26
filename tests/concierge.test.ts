import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import LinqAPIV3 from '@linqapp/sdk';
import { makeApp } from '../server/app.js';
import { parseSlot } from '../server/appointments.js';
import { remoteClassifier, simulate } from '../server/classifier.js';
import { demoCustomers, demoSecret, inboundFixture, parseEvent, signedFixture } from '../server/events.js';
import { linqSender, mockSend, SendFailure, type Outbound } from '../server/messaging.js';
import { openStore, type Store } from '../server/store.js';
import { enqueue, makeWorker } from '../server/worker.js';

const wednesday = Date.parse('2026-11-25T16:00:00Z');
const quiet = () => {};
type Customer = keyof typeof demoCustomers;
type Fixture = ReturnType<typeof inboundFixture>;

describe('signed webhook to operator dashboard', () => {
  let db: Store;
  let now: number;
  let server: Server;
  let url: string;
  let tick: ReturnType<typeof makeWorker>;
  const clock = () => now;
  const client = new LinqAPIV3({ apiKey: 'test-only', webhookSecret: demoSecret, fetch: async () => {
    throw new Error('Unexpected external fetch');
  } });

  beforeEach(async () => {
    now = wednesday;
    db = openStore(':memory:');
    tick = makeWorker(db, simulate, mockSend, quiet, clock);
    server = makeApp({ db, verifier: client, demo: true, report: quiet, permitted: () => true }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (typeof address !== 'object' || !address) throw new Error('Unable to start fixture server');
    url = 'http://127.0.0.1:' + address.port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    db.close();
  });

  function fixture(customer: Customer, text: string) {
    const event = inboundFixture(customer, text);
    event.created_at = new Date(++now).toISOString();
    return event;
  }

  async function post<T extends {event_id: string}>(event: T, options: { tamper?: boolean; stale?: boolean } = {}) {
    const raw = JSON.stringify(event, null, 2);
    const headers = signedFixture(raw, event.event_id, options.stale ? Date.now() - 360_000 : Date.now());
    return fetch(url + '/webhooks/linq', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
      body: options.tamper ? raw + ' ' : raw });
  }

  async function send(customer: Customer, message: string) {
    const response = await post(fixture(customer, message));
    expect(response.status).toBe(200);
    await tick();
    return db.prepare('SELECT * FROM decisions LEFT JOIN outbox USING(event_id) ORDER BY decisions.rowid DESC LIMIT 1').get();
  }
  const booking = () => db.prepare('SELECT * FROM appointments').get();

  it('rejects tampered and replayed signatures before storing any event', async () => {
    const event = fixture('maya', 'Book Friday at 10 AM');
    expect((await post(event, { tamper: true })).status).toBe(401);
    expect((await post(event, { stale: true })).status).toBe(401);
    expect(db.prepare('SELECT * FROM inbox').all()).toHaveLength(0);
  });

  it('rejects validly signed malformed or unsupported-version payloads', async () => {
    const event = fixture('maya', 'Book Friday at 10 AM');
    expect((await post({ ...event, data: {} })).status).toBe(400);
    expect((await post({ ...event, webhook_version: '2025-01-01' })).status).toBe(400);
  });

  it('acknowledges before processing and deduplicates by event and inbound message ID', async () => {
    const event = fixture('maya', 'Book Friday at 10 AM');
    const responses = await Promise.all([post(event), post(event), post({ ...event, event_id: randomUUID() })]);
    const replies = await Promise.all(responses.map(response => response.json()));
    expect(replies.filter(reply => !reply.duplicate)).toHaveLength(1);
    expect(db.prepare('SELECT * FROM decisions').all()).toHaveLength(0);
    await tick();
    expect(db.prepare('SELECT * FROM outbox').all()).toHaveLength(1);
  });

  it('books, answers status, reschedules, and cancels only after explicit confirmation', async () => {
    const proposal = await send('maya', 'Book Friday at 10 AM');
    expect(proposal?.state).toBe('simulated');
    expect(booking()).toBeUndefined();
    await send('maya', 'Yes');
    expect(booking()).toMatchObject({ revision: 1, slot: '2026-11-27T16:00:00.000Z' });
    expect((await send('maya', 'When is my appointment?'))?.detail).toBe('Looked up upcoming bookings');
    await send('maya', 'Can I move my Friday appointment to Monday at 2?');
    expect(booking()?.revision).toBe(1);
    const confirmation = fixture('maya', 'Yes!');
    await post(confirmation);
    await post(confirmation);
    await tick();
    expect(booking()).toMatchObject({ revision: 2, slot: '2026-11-30T20:00:00.000Z' });
    await send('maya', 'Cancel my appointment');
    expect(booking()?.state).toBe('booked');
    await send('maya', 'Yes');
    expect(booking()).toMatchObject({ revision: 3, state: 'cancelled' });
    const dashboard = await (await fetch(url + '/api/dashboard')).json();
    expect(dashboard.bookings).toHaveLength(1);
    expect(dashboard.decisions).toHaveLength(7);
  });

  it('asks for clarification on alternative dates and accepts a follow-up with one clear date', async () => {
    const ambiguous = await send('maya', 'Book Friday or Monday at 2 PM');
    expect(ambiguous?.detail).toBe('Requested a specific business slot');
    expect((await send('maya', 'Monday at 2'))?.detail).toBe('Requested a specific business slot');
    expect((await send('maya', 'Monday at 2 PM'))?.detail).toBe('Awaiting explicit confirmation');
    expect(booking()).toBeUndefined();
  });

  it('declines and expires proposals safely', async () => {
    await send('maya', 'Book Friday at 10 AM');
    await send('maya', 'No thanks');
    expect((await send('maya', 'Yes'))?.detail).toBe('No pending proposal');
    await send('maya', 'Book Friday at 10 AM');
    now += 16 * 60_000;
    expect((await send('maya', 'Yes'))?.detail).toBe('Proposal expired');
    expect(booking()).toBeUndefined();
  });

  it('accepts concurrent confirmation requests for a slot and commits only one booking', async () => {
    await send('maya', 'Book Friday at 10 AM');
    await send('jordan', 'Book Friday at 10 AM');
    await Promise.all([post(fixture('maya', 'Yes')), post(fixture('jordan', 'Yes'))]);
    await Promise.all([tick(), tick()]);
    await tick();
    expect(db.prepare('SELECT * FROM appointments').all()).toHaveLength(1);
    expect(db.prepare("SELECT * FROM decisions WHERE detail = 'Availability or booking changed during confirmation'").all()).toHaveLength(1);
  });

  it('suppresses queued replies after STOP and pauses on handoff until the operator resumes', async () => {
    await post(fixture('maya', 'Book Friday at 10 AM'));
    await post(fixture('maya', 'STOP'));
    await tick();
    expect(db.prepare('SELECT state FROM outbox').get()?.state).toBe('suppressed');
    expect((await send('maya', 'Yes'))?.detail).toBe('Customer is opted out');
    await send('maya', 'START');
    await send('maya', 'Can I speak to a person?');
    expect((await send('maya', 'Book Friday at 10 AM'))?.detail).toBe('Awaiting an operator');
    const resumed = await fetch(url + '/api/conversations/' + demoCustomers.maya.chat + '/resume', {
      method: 'POST', headers: {'content-type':'application/json'}, body: '{}',
    });
    expect(resumed.status).toBe(204);
    expect((await send('maya', 'Book Friday at 10 AM'))?.detail).toBe('Awaiting explicit confirmation');
  });

  it('reconciles delivery receipts that arrive before a send response and surfaces failed delivery', async () => {
    const event = fixture('maya', 'What are your hours?');
    const sentID = 'provider-id';
    const receipt = (type: string, data: object) => ({ api_version: 'v3', webhook_version: '2026-02-03',
      event_id: randomUUID(), event_type: type, trace_id: 'receipt-trace', created_at: new Date(++now).toISOString(), data });
    const sender = vi.fn(async () => ({ id: sentID, state: 'accepted' as const, trace: 'send-trace' }));
    const run = makeWorker(db, simulate, sender, quiet, clock);
    await post(receipt('message.failed', { chat_id: event.data.chat.id, message_id: sentID, code: 4006 }));
    await post(event);
    await run();
    expect(db.prepare('SELECT state, error, trace FROM outbox').get())
      .toMatchObject({ state: 'failed', error: 'Linq code 4006', trace: 'receipt-trace' });
    await post(receipt('message.delivered', { chat: { id: event.data.chat.id }, id: sentID, direction: 'outbound' }));
    await post(receipt('message.sent', { chat: { id: event.data.chat.id }, id: sentID, direction: 'outbound' }));
    await run();
    expect(db.prepare('SELECT state FROM outbox').get()?.state).toBe('delivered');
  });

  it('retries Linq API failures and timeouts with the same persisted confirmation idempotency key', async () => {
    const requests: { path: string; body: { message: { idempotency_key: string } } }[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      requests.push({ path: String(input), body: JSON.parse(String(init?.body)) });
      if (requests.length === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '3', 'x-trace-id': 'limited' } });
      if (requests.length === 2) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Fixture timeout', 'AbortError')), { once: true });
        });
      }
      return Response.json({ chat_id: demoCustomers.maya.chat, message: { id: 'accepted-id' } }, { headers: {'x-trace-id':'success-trace'} });
    });
    const sdk = new LinqAPIV3({ apiKey: 'fixture', maxRetries: 0, timeout: 100, fetch: fetcher });
    const actualAdapter = linqSender(sdk, new Set([demoCustomers.maya.handle]));
    const worker = makeWorker(db, simulate, job => actualAdapter({ ...job, source: 'linq' }), quiet, clock);
    await send('maya', 'Book Friday at 10 AM');
    await post(fixture('maya', 'Yes'));
    await worker();
    expect(db.prepare("SELECT state, attempts, trace FROM outbox WHERE state = 'queued'").get())
      .toMatchObject({ state: 'queued', attempts: 1, trace: 'limited' });
    now += 2999;
    await worker();
    expect(requests).toHaveLength(1);
    now += 1;
    await worker();
    expect(requests).toHaveLength(2);
    now += 2000;
    await worker();
    expect(requests).toHaveLength(3);
    expect(requests[0].path).toBe('https://api.linqapp.com/api/partner/v3/chats/' + demoCustomers.maya.chat + '/messages');
    expect(new Set(requests.map(item => item.body.message.idempotency_key)).size).toBe(1);
    expect(db.prepare("SELECT state, attempts, trace FROM outbox WHERE state = 'accepted'").get())
      .toMatchObject({ state: 'accepted', attempts: 3, trace: 'success-trace' });
    expect(booking()?.revision).toBe(1);
  });

  it('marks terminal failures and refuses non-allowlisted test recipients before fetch', async () => {
    const fetcher = vi.fn<typeof fetch>();
    const sdk = new LinqAPIV3({ apiKey: 'fixture', fetch: fetcher });
    const sender = linqSender(sdk, new Set());
    const worker = makeWorker(db, simulate, sender, quiet, clock);
    await post(fixture('maya', 'What are your hours?'));
    await worker();
    expect(fetcher).not.toHaveBeenCalled();
    expect(db.prepare('SELECT state, attempts FROM outbox').get()).toMatchObject({ state: 'failed', attempts: 1 });
  });

  it('reopens the inbox and resumes a queued send without repeating appointment writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'concierge-vitest-'));
    const dbPath = join(dir, 'app.sqlite');
    let file = openStore(dbPath);
    try {
      const event: Fixture = fixture('maya', 'Book Friday at 10 AM');
      const parsed = parseEvent(event, 'demo')!;
      expect(enqueue(file, parsed)).toBe(true);
      await makeWorker(file, simulate, async () => { throw new SendFailure('offline', true); }, quiet, clock)();
      file.close();
      file = openStore(dbPath);
      expect(enqueue(file, parsed)).toBe(false);
      expect(file.prepare('SELECT COUNT(*) AS total FROM decisions').get()?.total).toBe(1);
      now += 1000;
      const retried = vi.fn(mockSend);
      await makeWorker(file, simulate, retried, quiet, clock)();
      expect(retried).toHaveBeenCalledTimes(1);
      expect(file.prepare('SELECT attempts, state FROM outbox').get()).toMatchObject({ attempts: 2, state: 'simulated' });
    } finally {
      file.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

it('normalizes Central time across daylight saving and rejects vague requests', () => {
  const beforeDST = Date.parse('2026-03-06T20:00:00Z');
  expect(parseSlot('Monday at 2 PM', beforeDST, beforeDST)).toEqual({ slot: '2026-03-09T19:00:00.000Z' });
  expect(parseSlot('sometime next week', beforeDST, beforeDST)).toHaveProperty('question');
});

it('validates remote tool output and falls back on provider errors without calling the network', async () => {
  const toolCall = Response.json({ choices: [{ message: { tool_calls: [{ function: {
    name: 'classify', arguments: '{"intent":"human"}',
  } }] } }] });
  const fallback = vi.fn();
  const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(toolCall).mockResolvedValueOnce(new Response('', { status: 503 }));
  const classify = remoteClassifier('fixture', 'fixture-model', fallback, fetcher);
  expect(await classify('Could I speak with the team?')).toBe('human');
  expect(await classify('Book Friday at 10 AM')).toBe('book');
  expect(fallback).toHaveBeenCalledTimes(1);
});

