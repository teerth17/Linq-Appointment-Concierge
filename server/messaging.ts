import LinqAPIV3 from '@linqapp/sdk';
import { createHash } from 'node:crypto';

export type Outbound = { event_id: string; chat: string; customer: string; key: string; body: string; source: string; attempts: number };
export type SendResult = { state: 'accepted' | 'simulated'; id: string; trace: string | null };
export type Transport = (job: Outbound) => Promise<SendResult>;

export class SendFailure extends Error {
  constructor(label: string, readonly retryable: boolean, readonly trace: string | null = null,
    readonly waitMs: number = 0) { super(label); }
}

export const mockSend: Transport = async job => ({
  state: 'simulated', id: 'local-' + createHash('sha256').update(job.key).digest('hex').slice(0, 24), trace: null,
});

export function linqSender(client: LinqAPIV3, allowlist: ReadonlySet<string>): Transport {
  return async job => {
    if (job.source !== 'linq' || !allowlist.has(job.customer)) throw new SendFailure('Recipient outside test allowlist', false);
    try {
      const { data, response } = await client.chats.messages.send(job.chat, {
        message: { parts: [{ type: 'text', value: job.body }], idempotency_key: job.key },
      }).withResponse();
      const trace = response.headers.get('x-trace-id');
      if (typeof data?.message?.id !== 'string' || !data.message.id) {
        throw new SendFailure('Linq response missing message ID', true, trace);
      }
      return { state: 'accepted', id: data.message.id, trace };
    } catch (error) {
      if (error instanceof LinqAPIV3.APIError) {
        const status = error.status;
        const retryable = status == null || [408, 429].includes(status) || status >= 500;
        const retryAfter = error.headers?.get('retry-after');
        const wait = retryAfter ? /^\d+(\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now() : 0;
        throw new SendFailure(status ? 'Linq HTTP ' + status : 'Linq network error or timeout', retryable,
          error.headers?.get('x-trace-id') ?? null, Number.isFinite(wait) ? Math.max(0, wait) : 0);
      }
      throw error;
    }
  };
}

