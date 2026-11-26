import { appointmentTools, formatSlot, hours, parseSlot, type Change } from './appointments.js';
import type { Intent } from './classifier.js';
import type { Message } from './events.js';
import type { Store } from './store.js';

type Draft = { stage: 'details'; action: 'book' | 'reschedule' | 'availability' } |
  { stage: 'confirm'; change: Change; expires: number; askedAt: number; proposal: string };
type Conversation = { customer: string; state: string; draft: string | null };
export type Decision = { intent: string; detail: string; reply?: string };

const stop = /^(stop(?:all)?|unsubscribe|end|quit|opt[ -]?out|revoke|stop texting me|do not (?:text|contact) me|remove me from your list)[.!\s]*$/i;
const start = /^(start|unstop)[.!\s]*$/i;
const yes = /^(yes(?:,? please)?|confirm|go ahead)[.!\s]*$/i;
const no = /^(no(?: thanks)?|never mind|nevermind)[.!\s]*$/i;

export const isConversationControl = (text: string) => [stop, start, yes, no].some(pattern => pattern.test(text));

export function decide(db: Store, message: Message, classified: Intent, now: number): Decision {
  const { chat, customer, text } = message;
  db.prepare('INSERT INTO conversations(chat, customer, touched_at) VALUES (?, ?, ?) ON CONFLICT(chat) DO NOTHING')
    .run(chat, customer, message.createdAt);
  const conversation = db.prepare('SELECT customer, state, draft FROM conversations WHERE chat = ?').get(chat) as Conversation;
  if (conversation.customer !== customer) return { intent: 'identity mismatch', detail: 'Chat participant changed' };
  db.prepare('UPDATE conversations SET touched_at = max(touched_at, ?) WHERE chat = ?').run(message.createdAt, chat);
  const save = (draft: Draft | null) => db.prepare('UPDATE conversations SET draft = ? WHERE chat = ?')
    .run(draft ? JSON.stringify(draft) : null, chat);
  const draft = conversation.draft ? JSON.parse(conversation.draft) as Draft : null;
  const answer = (intent: string, detail: string, reply?: string): Decision => ({ intent, detail, reply });
  const optedOut = db.prepare('SELECT 1 FROM opt_outs WHERE customer = ?').get(customer);
  if (stop.test(text)) {
    db.prepare('INSERT OR IGNORE INTO opt_outs(customer) VALUES (?)').run(customer);
    db.prepare('UPDATE conversations SET draft = NULL WHERE customer = ?').run(customer);
    db.prepare("UPDATE outbox SET state = 'suppressed', error = 'Customer opted out' WHERE customer = ? AND state = 'queued'")
      .run(customer);
    return answer('opt out', 'Automation and pending replies suppressed');
  }
  if (start.test(text) && optedOut) {
    db.prepare('DELETE FROM opt_outs WHERE customer = ?').run(customer);
    return answer('opt in', 'Customer opted back in', conversation.state === 'active' ? 'You’re opted back in. How can I help with your appointment?' : undefined);
  }
  if (optedOut) return answer('opt out', 'Customer is opted out');
  if (conversation.state === 'handoff') return answer('human', 'Awaiting an operator');
  if (classified === 'human') {
    db.prepare("UPDATE conversations SET state = 'handoff', draft = NULL WHERE chat = ?").run(chat);
    db.prepare("UPDATE outbox SET state = 'suppressed', error = 'Human handoff' WHERE chat = ? AND state = 'queued'").run(chat);
    return answer('human', 'Automation paused for the front desk', 'I’ve flagged this for the front desk. A team member can follow up here.');
  }

  const tools = appointmentTools(db, chat, now);
  if (yes.test(text)) {
    if (draft?.stage !== 'confirm') return answer('confirm', 'No pending proposal', 'There’s no change awaiting confirmation. What would you like to do?');
    if (Date.parse(message.createdAt) < draft.askedAt) return answer('confirm', 'Confirmation predates proposal');
    if (draft.expires <= now) {
      save(null);
      return answer('confirm', 'Proposal expired', 'That offer expired. Please ask for the appointment again.');
    }
    const delivery = db.prepare('SELECT state FROM outbox WHERE event_id = ?').get(draft.proposal)?.state;
    if (!['simulated', 'accepted', 'sent', 'delivered', 'read'].includes(String(delivery))) {
      save(null);
      return answer('confirm', 'Proposal was not sent', 'Please ask for the appointment again so I can send you a fresh offer.');
    }
    save(null);
    const change = draft.change;
    if (!tools.apply(change)) return answer(change.action, 'Availability or booking changed during confirmation',
      'That change is no longer available. Your booking is unchanged. Please ask for another time or check your booking.');
    const replies = { book: 'Booked for ', reschedule: 'Your appointment was moved to ', cancel: 'Cancelled your appointment for ' };
    return answer(change.action, 'Confirmed and committed', replies[change.action] + formatSlot(change.slot ?? change.current!.slot) + '.');
  }
  if (no.test(text)) {
    save(null);
    return answer('decline', 'Pending change cleared', 'Okay, your booking is unchanged.');
  }
  if (!text) return answer('other', 'No supported text part', 'Please send your appointment request as a text message.');
  if (classified === 'hours') return answer('hours', 'Provided business hours', 'We’re open ' + hours + '.');

  const appointments = tools.status();
  const current = appointments[0];
  if (classified === 'status') {
    return answer('status', 'Looked up upcoming bookings', current ?
      'Your upcoming appointment' + (appointments.length > 1 ? 's: ' : ' is ') + appointments.map(a => formatSlot(a.slot)).join(', ') + '.' :
      'You don’t have an upcoming appointment. I can help you book one.');
  }
  const intent = classified === 'other' && draft?.stage === 'details' ? draft.action : classified;
  if (intent === 'other') return answer('other', 'Unclear request', 'I can help book, move or cancel an appointment, check your booking, or get the front desk.');
  if ((intent === 'reschedule' || intent === 'cancel') && appointments.length !== 1) {
    save(null);
    return answer(intent, 'Requires exactly one existing booking', current ?
      'I found more than one appointment. Please ask for the front desk to help choose the right one.' :
      'I couldn’t find an upcoming appointment for this conversation.');
  }
  if (intent === 'book' && current) {
    save(null);
    return answer(intent, 'Existing booking found', 'You already have an appointment on ' + formatSlot(current.slot) + '. Would you like to move it?');
  }

  let change: Change;
  if (intent === 'cancel') {
    change = { action: intent, current };
  } else if (intent === 'book' || intent === 'reschedule' || intent === 'availability') {
    const target = intent === 'reschedule' ? text.split(/\bto\s+(?=(?:next\s+)?(?:mon|tue|wed|thu|fri|sat|sun|tomorrow|today|\d))/i).at(-1)! : text;
    const parsed = parseSlot(target, Date.parse(message.createdAt), now, intent === 'reschedule' && target !== text);
    if ('question' in parsed) {
      save({ stage: 'details', action: intent });
      return answer(intent, 'Requested a specific business slot', parsed.question);
    }
    const slot = parsed.slot;
    if (!tools.available(slot)) {
      save({ stage: 'details', action: intent });
      return answer(intent, 'Slot unavailable', formatSlot(slot) + ' is unavailable. Is there another time that works?');
    }
    if (intent === 'availability') {
      return answer(intent, 'Slot available', formatSlot(slot) + ' is available. To book it, text “book” and the date and time.');
    }
    change = { action: intent, slot, current: intent === 'reschedule' ? current : undefined };
  } else {
    return answer('other', 'Unclear request');
  }
  const slotLabel = formatSlot(change.slot ?? current.slot);
  const prompt = change.action === 'cancel' ? 'Cancel your appointment for ' + slotLabel + '?' :
    change.action === 'reschedule' ? 'Move your appointment from ' + formatSlot(current.slot) + ' to ' + slotLabel + '?' :
    'Book your appointment for ' + slotLabel + '?';
  save({ stage: 'confirm', change, expires: now + 15 * 60_000, askedAt: now, proposal: message.id });
  return answer(change.action, 'Awaiting explicit confirmation', prompt + ' Reply YES to confirm or NO to keep things as they are.');
}

