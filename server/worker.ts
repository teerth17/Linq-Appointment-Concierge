import { createHash } from 'node:crypto';
import { decide, isConversationControl } from './agent.js';
import type { Classifier } from './classifier.js';
import type { Event, Receipt } from './events.js';
import { SendFailure, type Outbound, type Transport } from './messaging.js';
import { transaction, type Store } from './store.js';

export type Logger = (event: string, fields?: Record<string, unknown>) => void;
export const log: Logger = (event, fields = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));

export function enqueue(db: Store, event: Event) {
  return db.prepare('INSERT OR IGNORE INTO inbox(event_id, message_id, payload) VALUES (?, ?, ?)')
    .run(event.id, event.kind === 'inbound' ? event.messageId : null, JSON.stringify(event)).changes === 1;
}

function reconcile(db: Store, chat: string, id: string) {
  const receipt = db.prepare(`
    SELECT state, trace, error FROM receipts WHERE provider_id = ? AND chat = ?
    ORDER BY CASE state WHEN 'read' THEN 4 WHEN 'delivered' THEN 3 WHEN 'failed' THEN 2 ELSE 1 END DESC,
      occurred DESC LIMIT 1
  `).get(id, chat);
  if (receipt) db.prepare('UPDATE outbox SET state = ?, trace = coalesce(?, trace), error = ? WHERE chat = ? AND provider_id = ?')
    .run(receipt.state, receipt.trace, receipt.error, chat, id);
}

function recordReceipt(db: Store, receipt: Receipt) {
  db.prepare('INSERT INTO receipts VALUES (?, ?, ?, ?, ?, ?, ?)').run(receipt.id, receipt.messageId,
    receipt.chat, receipt.state, receipt.createdAt, receipt.trace, receipt.error);
  reconcile(db, receipt.chat, receipt.messageId);
}

export function makeWorker(db: Store, classify: Classifier, send: Transport, report: Logger = log, clock = Date.now) {
  let running = false;

  async function processEvent(event: Event) {
    // Skip external classification for conversation controls and suppressed automation.
    const localControl = event.kind === 'inbound' && (
      isConversationControl(event.text) ||
      db.prepare("SELECT 1 FROM conversations WHERE chat = ? AND state = 'handoff'").get(event.chat) ||
      db.prepare('SELECT 1 FROM opt_outs WHERE customer = ?').get(event.customer)
    );
    const intent = event.kind === 'inbound' && event.text && !localControl ? await classify(event.text) : 'other';
    transaction(db, () => {
      if (db.prepare('SELECT state FROM inbox WHERE event_id = ?').get(event.id)?.state !== 'queued') return;
      if (event.kind === 'receipt') {
        recordReceipt(db, event);
      } else {
        const decision = decide(db, event, intent, clock());
        db.prepare('INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(event.id, event.chat, event.text, decision.intent, decision.detail, event.trace, event.createdAt);
        if (decision.reply) {
          const key = 'concierge-' + createHash('sha256').update(event.messageId).digest('hex').slice(0, 40);
          db.prepare('INSERT INTO outbox(event_id, chat, customer, body, key, source) VALUES (?, ?, ?, ?, ?, ?)')
            .run(event.id, event.chat, event.customer, decision.reply, key, event.source);
        }
      }
      db.prepare("UPDATE inbox SET state = 'processed' WHERE event_id = ?").run(event.id);
    });
    report('inbox_processed', { correlationId: event.id, linqTraceId: event.trace, kind: event.kind });
  }

  async function processOutbound(job: Outbound) {
    try {
      const result = await send(job);
      transaction(db, () => {
        db.prepare("UPDATE outbox SET state = ?, attempts = attempts + 1, provider_id = ?, trace = ?, error = NULL WHERE event_id = ? AND state = 'queued'")
          .run(result.state, result.id, result.trace, job.event_id);
        reconcile(db, job.chat, result.id);
      });
      report('outbox_completed', { correlationId: job.event_id, linqTraceId: result.trace, state: result.state });
    } catch (error) {
      const issue = error instanceof SendFailure ? error : new SendFailure('Unexpected send failure', true);
      const attempts = job.attempts + 1;
      const state = issue.retryable && attempts < 4 ? 'queued' : 'failed';
      const delay = Math.max(issue.waitMs, 1000 * 2 ** (attempts - 1));
      db.prepare("UPDATE outbox SET state = ?, attempts = ?, due = ?, trace = ?, error = ? WHERE event_id = ? AND state = 'queued'")
        .run(state, attempts, clock() + delay, issue.trace, issue.message, job.event_id);
      report('outbox_error', { correlationId: job.event_id, linqTraceId: issue.trace, state, attempts, error: issue.message });
    }
  }

  return async function tick() {
    if (running) return;
    running = true;
    try {
      for (let count = 0; count < 32; count++) {
        const row = db.prepare("SELECT payload FROM inbox WHERE state = 'queued' ORDER BY sequence LIMIT 1").get();
        if (!row) break;
        const event = JSON.parse(String(row.payload)) as Event;
        try {
          await processEvent(event);
        } catch (error) {
          // Storage errors leave the event queued for the next tick.
          if (error instanceof Error && ('errcode' in error || error.message.includes('database is locked'))) throw error;
          db.prepare("UPDATE inbox SET state = 'failed', error = 'Unexpected processing failure' WHERE event_id = ?").run(event.id);
          report('inbox_error', { correlationId: event.id, linqTraceId: event.trace });
        }
      }
      // Drain pending inbound controls before handing more messages to a transport.
      if (db.prepare("SELECT 1 FROM inbox WHERE state = 'queued' LIMIT 1").get()) return;
      const job = db.prepare(`
        SELECT * FROM outbox AS job WHERE state = 'queued' AND due <= ?
          AND NOT EXISTS (SELECT 1 FROM outbox earlier WHERE earlier.chat = job.chat
            AND earlier.state = 'queued' AND earlier.rowid < job.rowid)
        ORDER BY rowid LIMIT 1
      `).get(clock()) as Outbound | undefined;
      if (job) await processOutbound(job);
    } finally {
      running = false;
    }
  };
}

