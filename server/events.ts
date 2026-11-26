import { createHmac, randomUUID } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1).max(160);
const envelope = z.object({
  api_version: z.literal('v3'),
  webhook_version: z.literal('2026-02-03'),
  event_id: id,
  event_type: id,
  created_at: z.iso.datetime(),
  trace_id: id.nullish(),
  data: z.unknown(),
});
const inbound = z.object({
  id,
  direction: z.literal('inbound'),
  chat: z.object({ id, is_group: z.boolean(), owner_handle: z.object({ handle: id }) }),
  sender_handle: z.object({ handle: id, is_me: z.boolean() }),
  parts: z.array(z.object({ type: id, value: z.unknown().optional() })).max(100),
});
const lifecycle = z.object({
  id,
  direction: z.literal('outbound'),
  chat: z.object({ id }),
});
const failure = z.object({ chat_id: id, message_id: id, code: z.number().int() });

type EventBase = { id: string; chat: string; messageId: string; trace: string | null; createdAt: string };
export type Message = EventBase & { kind: 'inbound'; customer: string; line: string; text: string; source: 'demo' | 'linq' };
export type Receipt = EventBase & { kind: 'receipt'; state: 'sent' | 'delivered' | 'read' | 'failed'; error: string | null };
export type Event = Message | Receipt;

export function parseEvent(value: unknown, source: Message['source']): Event | null {
  const event = envelope.parse(value);
  const base = { id: event.event_id, trace: event.trace_id ?? null, createdAt: new Date(event.created_at).toISOString() };
  if (event.event_type === 'message.received') {
    const data = inbound.parse(event.data);
    if (data.chat.is_group || data.sender_handle.is_me) return null;
    const text = data.parts.flatMap(part => part.type === 'text' && typeof part.value === 'string' ? [part.value] : [])
      .join('\n').trim().slice(0, 4000);
    return { ...base, kind: 'inbound', chat: data.chat.id, messageId: data.id, customer: data.sender_handle.handle,
      line: data.chat.owner_handle.handle, text, source };
  }
  if (event.event_type === 'message.failed') {
    const data = failure.parse(event.data);
    return { ...base, kind: 'receipt', chat: data.chat_id, messageId: data.message_id, state: 'failed', error: 'Linq code ' + data.code };
  }
  if (event.event_type === 'message.sent' || event.event_type === 'message.delivered' || event.event_type === 'message.read') {
    const data = lifecycle.parse(event.data);
    const state = event.event_type === 'message.sent' ? 'sent' : event.event_type === 'message.delivered' ? 'delivered' : 'read';
    return { ...base, kind: 'receipt', chat: data.chat.id, messageId: data.id, state, error: null };
  }
  return null;
}

// Public fixture key used by the demo and tests only.
export const demoSecret = 'whsec_' + Buffer.from('appointment-concierge-local-fixture').toString('base64');

export function signedFixture(raw: string, id: string, at = Date.now(), secret = demoSecret) {
  const timestamp = String(Math.floor(at / 1000));
  const digest = createHmac('sha256', Buffer.from(secret.slice(6), 'base64'))
    .update(id + '.' + timestamp + '.' + raw).digest('base64');
  return { 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': 'v1,' + digest };
}

export const demoCustomers = {
  maya: { name: 'Maya Chen', chat: '54a25a9b-ff53-4120-bfb5-61eb2936ff01', handle: '+12025550101' },
  jordan: { name: 'Jordan Lee', chat: '54a25a9b-ff53-4120-bfb5-61eb2936ff02', handle: '+12025550102' },
};
export const demoLine = '+12025550100';

export function inboundFixture(customer: keyof typeof demoCustomers, text: string) {
  const person = demoCustomers[customer];
  return {
    api_version: 'v3', webhook_version: '2026-02-03', event_type: 'message.received',
    event_id: randomUUID(), trace_id: randomUUID().replaceAll('-', ''), created_at: new Date().toISOString(), partner_id: 'local-demo',
    data: {
      id: randomUUID(), direction: 'inbound',
      chat: { id: person.chat, is_group: false, owner_handle: { handle: demoLine } },
      sender_handle: { handle: person.handle, is_me: false }, parts: [{ type: 'text', value: text }],
    },
  };
}

