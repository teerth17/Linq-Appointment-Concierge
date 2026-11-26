import * as chrono from 'chrono-node';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import type { Store } from './store.js';

export const zone = 'America/Chicago';
export const hours = 'Monday through Friday, 9 AM to 5 PM Central';
export type Appointment = { id: string; chat: string; slot: string; state: string; revision: number };
export type Change = { action: 'book' | 'reschedule' | 'cancel'; slot?: string; current?: Appointment };

export function formatSlot(slot: string) {
  return DateTime.fromISO(slot).setZone(zone).toFormat("ccc, LLL d 'at' h:mm a ZZZZ");
}

export function parseSlot(text: string, reference: number, now: number, inferBusinessHalfDay = false):
  { slot: string } | { question: string } {
  const local = DateTime.fromMillis(reference, { zone });
  const dates = chrono.parse(text, { instant: new Date(reference), timezone: local.offset }, { forwardDate: true });
  const candidate = dates[0]?.start;
  if (dates.length !== 1 || dates[0].end || (!candidate?.isCertain('day') && !candidate?.isCertain('weekday')) || !candidate?.isCertain('hour') ||
      /\b(or|either|between)\b/i.test(text)) {
    return { question: 'Please give me one day and time, for example Monday at 2 PM.' };
  }

  const hour = candidate.get('hour')!;
  const rawClock = dates[0].text;
  const hasZone = candidate.isCertain('timezoneOffset');
  if (hasZone && !/\b(?:CST|CDT)\b/i.test(rawClock)) {
    return { question: 'Please give the appointment time in Central time.' };
  }

  const isExplicitClock = /\b(?:[01]?\d|2[0-3]):[0-5]\d\b|\b(?:noon|midnight)\b/i.test(rawClock);
  let localHour = hour;
  if (!candidate.isCertain('meridiem') && (hour === 0 || (hour >= 1 && hour <= 12)) &&
      !isExplicitClock) {
    const possible = [hour % 12, hour % 12 + 12].filter(value => value >= 9 && value < 17);
    if (!inferBusinessHalfDay || possible.length !== 1) return { question: 'Did you mean AM or PM? Please include the day and time.' };
    [localHour] = possible;
  } else if (!candidate.isCertain('meridiem') && hour >= 1 && hour <= 12 && isExplicitClock &&
      !/\b(?:0\d:|noon|midnight)/i.test(rawClock)) {
    return { question: 'Did you mean AM or PM? Please include the day and time.' };
  }

  const slot = DateTime.fromObject({
    year: candidate.get('year')!, month: candidate.get('month')!, day: candidate.get('day')!,
    hour: localHour, minute: candidate.get('minute') ?? 0,
  }, { zone });
  if (hasZone && candidate.get('timezoneOffset') !== slot.offset) {
    return { question: 'The time zone does not match Central time on that date. Please give a Central local time.' };
  }
  if (!slot.isValid || slot.toMillis() <= now || slot.toMillis() > now + 90 * 86400_000) {
    return { question: 'Please pick a future appointment within the next 90 days.' };
  }
  if (slot.weekday > 5 || localHour < 9 || localHour >= 17 || ![0, 30].includes(slot.minute)) {
    return { question: 'We have 30-minute appointments ' + hours + ', on the hour or half hour.' };
  }
  return { slot: slot.toUTC().toISO()! };
}

export function appointmentTools(db: Store, chat: string, now: number) {
  function status() {
    return db.prepare("SELECT * FROM appointments WHERE chat = ? AND state = 'booked' AND slot > ? ORDER BY slot")
      .all(chat, new Date(now).toISOString()) as unknown as Appointment[];
  }

  function available(slot: string) {
    return Date.parse(slot) > now && !db.prepare("SELECT 1 FROM appointments WHERE slot = ? AND state = 'booked'").get(slot);
  }

  // Called only inside the transaction that consumes explicit confirmation and writes the reply.
  function apply(change: Change) {
    if (change.action === 'book') {
      if (!change.slot || !available(change.slot) || status().length) return false;
      db.prepare('INSERT INTO appointments(id, chat, slot) VALUES (?, ?, ?)').run(randomUUID(), chat, change.slot);
      return true;
    }
    const current = change.current;
    if (!current || !status().some(row => row.id === current.id && row.revision === current.revision)) return false;
    if (change.action === 'cancel') {
      return db.prepare("UPDATE appointments SET state = 'cancelled', revision = revision + 1 WHERE id = ? AND chat = ? AND revision = ?")
        .run(current.id, chat, current.revision).changes === 1;
    }
    if (!change.slot || !available(change.slot)) return false;
    return db.prepare('UPDATE appointments SET slot = ?, revision = revision + 1 WHERE id = ? AND chat = ? AND revision = ?')
      .run(change.slot, current.id, chat, current.revision).changes === 1;
  }

  return { status, available, apply };
}

