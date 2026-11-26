import { useEffect, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Persona = { name: string; chat: string; handle: string };
type Conversation = { chat: string; customer: string; state: string; pending: number };
type Decision = { event_id: string; chat: string; body: string; intent: string; detail: string; created_at: string; trace: string | null;
  reply: string | null; delivery: string | null; attempts: number | null; error: string | null; send_trace: string | null };
type Booking = { id: string; chat: string; slot: string; state: string; revision: number };
type Dashboard = { demo: boolean; customers: Record<string, Persona>; conversations: Conversation[];
  decisions: Decision[]; bookings: Booking[]; processingErrors: {event_id: string; error: string}[] };

const central = 'America/Chicago';
const dateLabel = (date: string) => new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: central }).format(new Date(date));
const timeLabel = (date: string) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', timeZoneName: 'short', timeZone: central }).format(new Date(date));
const quickReplies = ['Book Friday at 10 AM', 'Move my Friday appointment to Monday at 2', 'Yes', 'When is my appointment?', 'Cancel my appointment', 'Can I speak to a person?', 'STOP'];

function Badge({ value }: { value: string }) {
  return <span className={'badge ' + value.replaceAll(' ', '-')}>{value}</span>;
}

function App() {
  const [data, setData] = useState<Dashboard>();
  const [selected, setSelected] = useState('');
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [filter, setFilter] = useState(false);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const abort = new AbortController();
    async function refresh() {
      try {
        const response = await fetch('/api/dashboard', { signal: abort.signal });
        if (!response.ok) throw new Error();
        const snapshot: Dashboard = await response.json();
        if (active) {
          setData(snapshot);
          setLoadError('');
        }
      } catch {
        if (active) setLoadError('Could not refresh the dashboard. Retrying.');
      } finally {
        if (active) timer = setTimeout(refresh, 700);
      }
    }
    void refresh();
    return () => { active = false; abort.abort(); clearTimeout(timer); };
  }, []);

  const inbox = new Map(data?.conversations.map(item => [item.chat, item]) ?? []);
  const personas = Object.entries(data?.customers ?? {});
  const contacts = (data?.conversations ?? []).map(item => ({
    chat: item.chat, name: personas.find(([, person]) => person.chat === item.chat)?.[1].name ?? item.customer,
  }));
  for (const [, person] of personas) if (!inbox.has(person.chat)) contacts.push(person);
  const visible = filter ? contacts.filter(item => inbox.get(item.chat)?.state === 'handoff') : contacts;
  const current = visible.find(item => item.chat === selected) ?? visible[0];
  const conversation = current && inbox.get(current.chat);
  const demoCustomer = personas.find(([, person]) => person.chat === current?.chat);
  const transcript = (data?.decisions ?? []).filter(item => item.chat === current?.chat).reverse();
  const bookings = (data?.bookings ?? []).filter(item => item.chat === current?.chat);
  const status = conversation?.state ?? 'ready';
  const handoffs = (data?.conversations ?? []).filter(item => item.state === 'handoff').length;
  const upcoming = (data?.bookings ?? []).filter(item => item.state === 'booked' && Date.parse(item.slot) > Date.now()).length;

  async function submit(path: string, payload: object) {
    setBusy(true);
    setActionError('');
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      return true;
    } catch {
      setActionError('Could not complete the request. Check the conversation before trying again.');
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (demoCustomer && input.trim() && await submit('/api/demo/message', { customer: demoCustomer[0], text: input })) setInput('');
  }

  return <>
    <header className="masthead">
      <div className="identity"><span className="mark" aria-hidden="true">↗</span><div><div className="brand">Linq Appointment Concierge</div>
        <div className="subtitle">Operator workspace</div></div></div>
      {data && <span className="mode"><span aria-hidden="true" />{data.demo ? 'Local simulator' : 'Linq sandbox'}</span>}
    </header>
    <main>
      <div className="topline"><div><h1>Appointment inbox</h1><p>Review customer texts, bookings and agent decisions.</p></div>
        <div className="stats"><div><strong>{data?.conversations.length ?? '—'}</strong> Conversations</div>
          <div><strong>{data ? upcoming : '—'}</strong> Upcoming</div><div><strong>{data ? handoffs : '—'}</strong> Handoffs</div></div></div>
      {loadError && <p role="alert" className="alert">{loadError}</p>}
      {data?.processingErrors.map(issue => <p className="alert" key={issue.event_id}>{issue.error} · {issue.event_id}</p>)}
      <div className="workspace">
        <aside className="rail">
          <div className="section-label"><h2>Conversations</h2></div>
          <div className="filters"><button className={!filter ? 'filter-on' : ''} onClick={() => setFilter(false)} aria-pressed={!filter}>All</button>
            <button className={filter ? 'filter-on' : ''} onClick={() => setFilter(true)} aria-pressed={filter}>Handoff</button></div>
          {visible.map(item => {
            const latest = data?.decisions.find(decision => decision.chat === item.chat);
            const state = inbox.get(item.chat)?.state;
            return <button key={item.chat} onClick={() => { setSelected(item.chat); setInput(''); setActionError(''); }}
              className={'contact ' + (item.chat === current?.chat ? 'chosen' : '')} aria-pressed={item.chat === current?.chat}>
              <span className="avatar" aria-hidden="true">{item.name.startsWith('+') ? '#' : item.name.split(' ').map(word => word[0]).slice(0, 2).join('')}</span>
              <span className="contact-text"><strong>{item.name}</strong><small>{latest?.body || (data?.demo ? 'Demo customer' : 'No text yet')}</small></span>
              {state === 'handoff' && <span className="attention" aria-label="Needs handoff" />}
            </button>;
          })}
          {data && !visible.length && <p className="muted rail-empty">{filter ? 'No handoffs waiting.' : 'No conversations yet.'}</p>}
        </aside>
        <section className="thread" aria-label="Conversation">
          {current ? <>
            <header className="thread-head"><div><h2>{current.name}</h2><p>{conversation?.customer ?? demoCustomer?.[1].handle}</p></div><Badge value={status} /></header>
            <div className="transcript" aria-label="Message history">
              {!transcript.length && <div className="empty"><span className="empty-icon" aria-hidden="true">···</span>
                <h3>No messages yet</h3><p>{data?.demo ? 'Send a customer text below to start a conversation.' : 'Incoming texts will appear here.'}</p></div>}
              {transcript.map(item => <article key={item.event_id} className="exchange">
                <div className="message incoming"><div className="message-meta">{current.name} · {timeLabel(item.created_at)}</div>
                  <p>{item.body || 'Attachment without text'}</p></div>
                {item.reply && <div className="message outgoing"><div className="message-meta">Concierge <Badge value={item.delivery ?? 'queued'} /></div>
                  <p>{item.reply}</p>{item.error && <small className="error">{item.error} · {item.attempts} attempt(s)</small>}</div>}
                <details className="decision"><summary>{item.intent} · {item.detail}</summary><code>Event {item.event_id}</code>
                  {item.trace && <code>Webhook trace {item.trace}</code>}{item.send_trace && <code>Send trace {item.send_trace}</code>}</details>
              </article>)}
            </div>
            {actionError && <p className="alert" role="alert">{actionError}</p>}
            {demoCustomer && <form className="composer" onSubmit={send}>
              <label htmlFor="message">Simulate a customer text</label>
              <div className="input-row"><input id="message" value={input} onChange={event => setInput(event.target.value)} maxLength={4000}
                placeholder="Type a message…" /><button type="submit" disabled={busy || !input.trim()}>Send text <span aria-hidden="true">↗</span></button></div>
              <div className="quick">{quickReplies.map(reply => <button type="button" key={reply} onClick={() => setInput(reply)}>{reply}</button>)}</div>
            </form>}
          </> : <div className="empty"><h3>{data ? 'No conversation selected' : 'Loading workspace…'}</h3></div>}
        </section>
        <aside className="booking-pane">
          <div className="section-label"><h2>Appointments</h2></div>
          {conversation?.pending === 1 && status === 'active' && <div className="pending">A request is awaiting details or confirmation.</div>}
          {!bookings.length && <p className="muted rail-empty">No appointments for this conversation.</p>}
          {bookings.map(booking => <div className="booking" key={booking.id}>
            <Badge value={booking.state} /><h3>{dateLabel(booking.slot)}</h3><p>{timeLabel(booking.slot)} · 30 min</p>
            <small>Revision {booking.revision}</small></div>)}
          {status === 'handoff' && current && <div className="handoff"><h3>Human handoff</h3>
            <p>Automation is paused. Follow up in your messaging inbox before resuming.</p>
            <button type="button" disabled={busy} onClick={() => void submit('/api/conversations/' + encodeURIComponent(current.chat) + '/resume', {})}>Resume automation</button></div>}
          {status === 'opted out' && <div className="pending">Replies are suppressed until the customer sends START.</div>}
        </aside>
      </div>
    </main>
  </>;
}

createRoot(document.getElementById('root')!).render(<App />);

