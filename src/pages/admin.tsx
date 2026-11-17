import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../app';
import { eventSessions, PhaseBadge, playerName, pos, pts, Section, SessionLine } from '../components';
import { DEMO_COMMISSIONER } from '../data/localRepo';
import { eventPhase } from '../lib/eventPhase';
import { ratingComplete, strokesReceived } from '../lib/handicap';
import { buildLeaderboard, grossOf, holesPlayed } from '../lib/leaderboard';
import { countField } from '../lib/points';
import { lockProblems, MAX_PER_SESSION } from '../lib/schedule';
import { addDays, formatSessionDate, formatStartTime, leagueInstant } from '../lib/time';
import type { EventSession, LeagueEvent, Player, ResultStatus, SimSettings } from '../lib/types';
import { entriesFor } from '../data/localRepo';

// ---------------------------------------------------------------------------
export function AdminHome() {
  const { commissioner } = useApp();
  return commissioner ? <AdminDashboard /> : <SignIn />;
}

function SignIn() {
  const { repo, act } = useApp();
  const demo = repo.mode === 'demo';
  const [email, setEmail] = useState(demo ? DEMO_COMMISSIONER.email : '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack narrow">
      <header className="page-head">
        <p className="eyebrow">Commissioner</p>
        <h1>Sign in</h1>
      </header>
      <form
        className="card form"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await act(() => repo.signIn(email, password), 'Signed in.');
          setBusy(false);
        }}
      >
        <label>Email<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="fine">Only the league commissioner signs in. Players don't need an account.{demo && ` Demo login: ${DEMO_COMMISSIONER.email} / ${DEMO_COMMISSIONER.password}`}</p>
      </form>
    </div>
  );
}

function AdminDashboard() {
  const { snap, repo, act, email } = useApp();
  const events = snap.events.filter((e) => e.season_year === snap.settings.season_year).sort((a, b) => a.event_number - b.event_number);
  return (
    <div className="stack">
      <header className="page-head row">
        <div>
          <p className="eyebrow">Commissioner · {email}</p>
          <h1>League office</h1>
        </div>
        <button className="btn" onClick={() => act(() => repo.signOut(), 'Signed out. Saved scores stay saved.')}>Sign out</button>
      </header>

      <Section title="Events" kicker={`Season ${snap.settings.season_year}`}>
        <ul className="admin-events">
          {events.map((e) => (
            <li key={e.id}>
              <a href={`#/admin/events/${e.event_number}`}>
                <span className="ev-num">{e.event_number}</span>
                <span className="ev-body">
                  <strong>{e.name}</strong>
                  <span className="muted small">
                    {eventSessions(snap, e).map((s) => `Day ${s.session_number} ${formatSessionDate(s.session_date)}`).join(' · ') || 'No sessions yet'}
                  </span>
                </span>
                <PhaseBadge phase={eventPhase(e, snap.sessions)} />
              </a>
            </li>
          ))}
        </ul>
      </Section>

      <Players />
      <Settings />
      {repo.mode === 'demo' && (
        <Section title="Demo data">
          <button
            className="btn btn-danger"
            onClick={() => {
              if (confirm('Reset the demo league to its starting data?')) {
                (repo as unknown as { resetDemo(): void }).resetDemo();
                void act(async () => {}, 'Demo reset.');
              }
            }}
          >
            Reset demo league
          </button>
        </Section>
      )}
    </div>
  );
}

function Settings() {
  const { snap, repo, act } = useApp();
  return (
    <Section title="Field-size rule" kicker="Commissioner-approved">
      <p className="muted">Which players count toward the field size when choosing the 4- or 8-player points table?</p>
      <div className="radio-row">
        {(['starters', 'finishers'] as const).map((b) => (
          <label key={b} className="radio">
            <input
              type="radio"
              name="basis"
              checked={snap.settings.field_size_basis === b}
              onChange={() => act(() => repo.updateSettings({ field_size_basis: b }), 'Field-size rule saved.')}
            />
            {b === 'starters' ? 'Starters — everyone who teed off (finishers + DNF)' : 'Finishers — only players who completed 9 holes'}
          </label>
        ))}
      </div>
      <p className="fine">No-shows never count. Field sizes other than 4 or 8 can't be published until you decide how to score them.</p>
    </Section>
  );
}

function Players() {
  const { snap } = useApp();
  const [adding, setAdding] = useState(false);
  const active = snap.players.filter((p) => p.active).length;
  return (
    <Section title="Players" kicker={`${active} of 8 active`} actions={active < 8 && !adding ? <button className="btn" onClick={() => setAdding(true)}>Add player</button> : undefined}>
      <div className="player-list">
        {snap.players.map((p) => <PlayerRow key={p.id} p={p} />)}
        {adding && <PlayerRow onDone={() => setAdding(false)} />}
      </div>
      <p className="fine">Use the official GHIN Handicap Index when available. Handicaps are captured for each event when you lock it, so update indexes before locking.</p>
    </Section>
  );
}

function PlayerRow({ p, onDone }: { p?: Player; onDone?: () => void }) {
  const { repo, act } = useApp();
  const [name, setName] = useState(p?.name ?? '');
  const [idx, setIdx] = useState(p?.handicap_index != null ? String(p.handicap_index) : '');
  const [ghin, setGhin] = useState(p?.ghin_number ?? '');
  const [source, setSource] = useState(p?.handicap_source ?? 'ghin');
  const dirty = !p || name !== p.name || idx !== (p.handicap_index != null ? String(p.handicap_index) : '') || ghin !== (p.ghin_number ?? '') || source !== p.handicap_source;
  const save = async () => {
    const n = idx.trim() === '' ? null : Number(idx);
    const ok = await act(
      () => repo.savePlayer({ id: p?.id, name: name.trim(), handicap_index: n, ghin_number: ghin.trim() || null, handicap_source: source, active: p?.active ?? true }),
      p ? 'Player saved.' : 'Player added.',
    );
    if (ok) onDone?.();
  };
  return (
    <div className={`player-row ${p && !p.active ? 'dim' : ''}`}>
      <input aria-label="Name" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
      <input aria-label="Handicap index" placeholder="Index" inputMode="decimal" value={idx} onChange={(e) => setIdx(e.target.value)} className="w-index" />
      <select aria-label="Index source" value={source} onChange={(e) => setSource(e.target.value as Player['handicap_source'])}>
        <option value="ghin">GHIN</option>
        <option value="manual">Manual</option>
      </select>
      <input aria-label="GHIN number" placeholder="GHIN #" value={ghin} onChange={(e) => setGhin(e.target.value)} className="w-ghin" />
      <div className="row-actions">
        {dirty && <button className="btn btn-primary" onClick={save}>Save</button>}
        {p && !dirty && (
          <button className="btn btn-quiet" onClick={() => act(() => repo.savePlayer({ ...p, active: !p.active }), p.active ? 'Player deactivated.' : 'Player reactivated.')}>
            {p.active ? 'Deactivate' : 'Reactivate'}
          </button>
        )}
        {!p && <button className="btn btn-quiet" onClick={onDone}>Cancel</button>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
export function AdminEvent({ n }: { n: number }) {
  const { snap, commissioner } = useApp();
  if (!commissioner) return <SignIn />;
  const e = snap.events.find((x) => x.season_year === snap.settings.season_year && x.event_number === n);
  if (!e) return <p>Event not found.</p>;
  const ss = eventSessions(snap, e);
  return (
    <div className="stack">
      <header className="page-head">
        <p className="eyebrow"><a href="#/admin">League office</a> · Event {e.event_number} of 5</p>
        <h1>{e.name}</h1>
        <div className="row gap">
          <PhaseBadge phase={eventPhase(e, snap.sessions)} />
          <a className="btn btn-quiet" href={`#/events/${e.event_number}`}>Public page</a>
        </div>
      </header>
      <Steps e={e} />
      <Setup e={e} />
      <Sessions e={e} sessions={ss} />
      <Groups e={e} sessions={ss} />
      <LockStep e={e} sessions={ss} />
      {e.status !== 'draft' && ss.map((s) => <Scoring key={s.id} e={e} s={s} />)}
      {e.status !== 'draft' && <Finalize e={e} sessions={ss} />}
    </div>
  );
}

function Steps({ e }: { e: LeagueEvent }) {
  const { snap } = useApp();
  const ss = eventSessions(snap, e);
  const steps = [
    { label: 'Setup', done: !!e.course_name && ratingComplete(e) },
    { label: 'Sessions', done: ss.length > 0 },
    { label: 'Groups', done: snap.assignments.some((a) => a.event_id === e.id) },
    { label: 'Lock', done: e.status !== 'draft' },
    { label: 'Scores', done: ss.length > 0 && ss.every((s) => s.status === 'resolved') },
    { label: 'Publish', done: e.status === 'published' },
  ];
  return (
    <ol className="steps">
      {steps.map((s, i) => <li key={s.label} className={s.done ? 'done' : ''}><span>{i + 1}</span>{s.label}</li>)}
    </ol>
  );
}

const SIM_FIELDS: { key: keyof SimSettings; label: string; placeholder: string }[] = [
  { key: 'green_speed', label: 'Green speed', placeholder: 'Stimp 11' },
  { key: 'fairway_firmness', label: 'Fairway firmness', placeholder: 'Medium' },
  { key: 'wind', label: 'Wind', placeholder: 'Calm' },
  { key: 'putting', label: 'Putting', placeholder: 'Full putting, no gimmes' },
  { key: 'mulligans', label: 'Mulligans', placeholder: 'None' },
];

function Setup({ e }: { e: LeagueEvent }) {
  const { repo, act } = useApp();
  const locked = e.status !== 'draft';
  const init = () => ({
    name: e.name, course_name: e.course_name, tees: e.tees,
    par9: e.par9?.toString() ?? '', course_rating9: e.course_rating9?.toString() ?? '', slope9: e.slope9?.toString() ?? '',
    sim: { ...e.sim_settings },
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [e]); // eslint-disable-line react-hooks/exhaustive-deps
  const toNum = (s: string) => (s.trim() === '' ? null : Number(s));
  const save = () =>
    act(
      () =>
        repo.updateEvent(e.id, {
          name: f.name.trim() || e.name,
          ...(locked ? {} : {
            course_name: f.course_name.trim(), tees: f.tees.trim(),
            par9: toNum(f.par9), course_rating9: toNum(f.course_rating9), slope9: toNum(f.slope9), sim_settings: f.sim,
          }),
        }),
      'Event setup saved.',
    );
  return (
    <Section title="Course & simulator" kicker="Step 1 · shared by both sessions">
      {locked && <p className="locked-note">Locked. Course, tees, rating and simulator settings can't change now.</p>}
      <div className="form grid">
        <label className="span2">Event name<input value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} /></label>
        <label className="span2">Simulator course<input disabled={locked} value={f.course_name} onChange={(x) => setF({ ...f, course_name: x.target.value })} placeholder="e.g. Pebble Beach — Front 9" /></label>
        <label>Tees<input disabled={locked} value={f.tees} onChange={(x) => setF({ ...f, tees: x.target.value })} /></label>
        <label>9-hole par<input disabled={locked} inputMode="numeric" value={f.par9} onChange={(x) => setF({ ...f, par9: x.target.value })} /></label>
        <label>9-hole course rating<input disabled={locked} inputMode="decimal" value={f.course_rating9} onChange={(x) => setF({ ...f, course_rating9: x.target.value })} /></label>
        <label>9-hole slope<input disabled={locked} inputMode="numeric" value={f.slope9} onChange={(x) => setF({ ...f, slope9: x.target.value })} /></label>
        {SIM_FIELDS.map((s) => (
          <label key={s.key}>{s.label}
            <input disabled={locked} value={f.sim[s.key]} placeholder={s.placeholder} onChange={(x) => setF({ ...f, sim: { ...f.sim, [s.key]: x.target.value } })} />
          </label>
        ))}
      </div>
      <button className="btn btn-primary" onClick={save}>Save setup</button>
    </Section>
  );
}

function Sessions({ e, sessions }: { e: LeagueEvent; sessions: EventSession[] }) {
  const { repo, act } = useApp();
  const s1 = sessions.find((s) => s.session_number === 1);
  const s2 = sessions.find((s) => s.session_number === 2);
  return (
    <Section title="Sessions" kicker="Step 2 · up to four players per day · Central time">
      <SessionEditor e={e} n={1} s={s1} />
      {s1 && (s2 ? (
        <SessionEditor e={e} n={2} s={s2} />
      ) : e.status === 'draft' ? (
        <button className="btn" onClick={() => act(() => repo.saveSession(e.id, 2, addDays(s1.session_date, 1), s1.start_time), 'Day 2 added.')}>
          Add Day 2 ({formatSessionDate(addDays(s1.session_date, 1))})
        </button>
      ) : null)}
      <p className="fine">Eight players: four on Day 1, four the next day. Four or fewer: one session. Day 2 must be the calendar day after Day 1.</p>
    </Section>
  );
}

function SessionEditor({ e, n, s }: { e: LeagueEvent; n: 1 | 2; s?: EventSession }) {
  const { repo, act } = useApp();
  const [date, setDate] = useState(s?.session_date ?? '');
  const [time, setTime] = useState(s?.start_time ?? '18:30');
  useEffect(() => {
    setDate(s?.session_date ?? '');
    setTime(s?.start_time ?? '18:30');
  }, [s?.session_date, s?.start_time]);
  const published = e.status === 'published';
  const dirty = !s || date !== s.session_date || time !== s.start_time;
  return (
    <div className="session-editor">
      <strong>Day {n}</strong>
      <label>Date<input type="date" value={date} disabled={published} onChange={(x) => setDate(x.target.value)} /></label>
      <label>Start<input type="time" value={time} disabled={published} onChange={(x) => setTime(x.target.value)} /></label>
      {dirty && <button className="btn btn-primary" disabled={!date} onClick={() => act(() => repo.saveSession(e.id, n, date, time), `Day ${n} saved.`)}>Save</button>}
      {s && !dirty && e.status === 'draft' && (
        <button className="btn btn-quiet" onClick={() => act(() => repo.deleteSession(s.id), `Day ${n} removed.`)}>Remove</button>
      )}
      {s?.status === 'resolved' && <span className="badge badge-official">Complete</span>}
    </div>
  );
}

function Groups({ e, sessions }: { e: LeagueEvent; sessions: EventSession[] }) {
  const { snap, repo, act } = useApp();
  const locked = e.status !== 'draft';
  const mine = snap.assignments.filter((a) => a.event_id === e.id);
  const unassigned = snap.players.filter((p) => p.active && !mine.some((a) => a.player_id === p.id));
  if (!sessions.length) {
    return <Section title="Groups" kicker="Step 3"><p className="muted">Schedule Day 1 first.</p></Section>;
  }
  return (
    <Section title="Groups" kicker={`Step 3 · ${mine.length} assigned · one session per player`}>
      {locked && <p className="locked-note">Locked. Unlock before any scores are entered to change groups.</p>}
      <div className="groups">
        {sessions.map((s) => {
          const g = mine.filter((a) => a.session_id === s.id);
          const other = sessions.find((x) => x.id !== s.id);
          return (
            <div key={s.id} className="group">
              <div className="group-head">
                <SessionLine s={s} />
                <span className={`count ${g.length === MAX_PER_SESSION ? 'full' : ''}`}>{g.length}/{MAX_PER_SESSION}</span>
              </div>
              <ul>
                {g.map((a) => (
                  <li key={a.id}>
                    <span>{playerName(snap, a.player_id)}</span>
                    {!locked && (
                      <span className="row-actions">
                        {other && <button className="btn btn-quiet btn-sm" onClick={() => act(() => repo.moveAssignment(a.id, other.id))}>→ Day {other.session_number}</button>}
                        <button className="btn btn-quiet btn-sm" aria-label={`Remove ${playerName(snap, a.player_id)}`} onClick={() => act(() => repo.unassign(a.id))}>✕</button>
                      </span>
                    )}
                  </li>
                ))}
                {g.length === 0 && <li className="muted">Empty</li>}
              </ul>
            </div>
          );
        })}
      </div>
      {!locked && unassigned.length > 0 && (
        <div className="pool">
          <p className="eyebrow">Not assigned</p>
          {unassigned.map((p) => (
            <div key={p.id} className="pool-row">
              <span>{p.name}</span>
              <span className="row-actions">
                {sessions.map((s) => (
                  <button key={s.id} className="btn btn-sm" onClick={() => act(() => repo.assign(e.id, s.id, p.id))}>
                    Day {s.session_number}
                  </button>
                ))}
              </span>
            </div>
          ))}
          <p className="fine">Players left unassigned aren't in this event and get zero points.</p>
        </div>
      )}
    </Section>
  );
}

function LockStep({ e, sessions }: { e: LeagueEvent; sessions: EventSession[] }) {
  const { snap, repo, act } = useApp();
  const mine = snap.assignments.filter((a) => a.event_id === e.id);
  const problems = e.status === 'draft' ? lockProblems(e, snap.sessions, snap.assignments, snap.players) : [];
  const first = sessions[0];
  const start = first ? leagueInstant(first.session_date, first.start_time) : null;
  const late = e.status === 'draft' && start != null && Date.now() >= start.getTime();
  const anyScores = snap.scores.some((r) => mine.some((a) => a.id === r.assignment_id) && (r.status !== 'pending' || r.hole_scores.some((h) => h != null)));
  const rows = mine
    .map((a) => {
      const p = snap.players.find((x) => x.id === a.player_id)!;
      const day = sessions.find((s) => s.id === a.session_id)?.session_number;
      const preview = e.status === 'draft' && p.handicap_index != null && ratingComplete(e) ? strokesReceived(p.handicap_index, e) : null;
      return {
        a, p, day,
        index: e.status === 'draft' ? p.handicap_index : a.index_used,
        ch: e.status === 'draft' ? preview?.courseHandicap ?? null : a.course_handicap,
        strokes: e.status === 'draft' ? preview?.strokes ?? null : a.strokes,
      };
    })
    .sort((x, y) => (x.day ?? 0) - (y.day ?? 0) || x.p.name.localeCompare(y.p.name));

  return (
    <Section title={e.status === 'draft' ? 'Lock setup & confirm handicaps' : 'Handicaps confirmed'} kicker="Step 4 · before the first session starts">
      {start && e.status === 'draft' && (
        <p className={late ? 'warn' : 'muted'}>
          {late ? 'Day 1 has already started. ' : ''}Lock before Day 1 tees off: {formatSessionDate(first!.session_date)} at {formatStartTime(first!.start_time)} Central. Scores can't be entered until the event is locked.
        </p>
      )}
      {rows.length > 0 && (
        <div className="table-wrap">
          <table className="board">
            <thead>
              <tr>
                <th scope="col">Player</th><th scope="col">Day</th><th scope="col" className="num">Index</th>
                <th scope="col" className="num">9-hole CH</th><th scope="col" className="num">80% strokes</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.a.id}>
                  <td>{r.p.name}{r.p.handicap_source === 'manual' && <span className="note"> manual</span>}</td>
                  <td>{r.day}</td>
                  <td className="num">{r.index ?? '—'}</td>
                  <td className="num">{r.ch != null ? r.ch.toFixed(2) : '—'}</td>
                  <td className="num led">{r.strokes ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {e.status === 'draft' ? (
        <>
          {problems.length > 0 && <ul className="problems">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
          <button
            className="btn btn-primary"
            disabled={problems.length > 0}
            onClick={() => {
              if (confirm('Lock the course, tees and simulator settings, and confirm these handicap strokes for every assigned player?')) {
                void act(() => repo.lockEvent(e.id), 'Event locked. Handicaps confirmed.');
              }
            }}
          >
            Lock setup & confirm handicaps
          </button>
        </>
      ) : (
        <p className="fine">
          Confirmed {e.locked_at ? new Date(e.locked_at).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }) : ''} Central.
          {e.status === 'locked' && !anyScores && (
            <> <button className="btn btn-quiet btn-sm" onClick={() => act(() => repo.unlockEvent(e.id), 'Event unlocked.')}>Unlock</button></>
          )}
        </p>
      )}
    </Section>
  );
}

type Row = { holes: (number | null)[]; status: ResultStatus; dirty: boolean };

function Scoring({ e, s }: { e: LeagueEvent; s: EventSession }) {
  const { snap, repo, act, toast } = useApp();
  const group = useMemo(
    () => snap.assignments.filter((a) => a.session_id === s.id).sort((x, y) => playerName(snap, x.player_id).localeCompare(playerName(snap, y.player_id))),
    [snap, s.id],
  );
  const fromServer = () =>
    Object.fromEntries(
      group.map((a) => {
        const sc = snap.scores.find((r) => r.assignment_id === a.id);
        return [a.id, { holes: sc?.hole_scores ?? Array(9).fill(null), status: sc?.status ?? 'pending', dirty: false } as Row];
      }),
    );
  const [rows, setRows] = useState<Record<string, Row>>(fromServer);
  useEffect(() => {
    // Keep unsaved edits; refresh everything else from the database.
    setRows((cur) => {
      const fresh = fromServer();
      for (const k of Object.keys(fresh)) if (cur[k]?.dirty) fresh[k] = cur[k];
      return fresh;
    });
  }, [snap]); // eslint-disable-line react-hooks/exhaustive-deps

  const editable = e.status === 'locked' && s.status === 'scheduled';
  const dirtyIds = Object.keys(rows).filter((k) => rows[k].dirty);

  const setHole = (id: string, i: number, v: string) => {
    setRows((cur) => {
      const r = cur[id];
      const holes = [...r.holes];
      const n = v.trim() === '' ? null : Number(v);
      holes[i] = n != null && Number.isFinite(n) ? Math.trunc(n) : null;
      let status = r.status;
      const played = holesPlayed(holes);
      if (played === 9 && (status === 'pending' || status === 'dnf')) status = 'completed';
      if (played < 9 && status === 'completed') status = 'pending';
      if (played > 0 && status === 'dna') status = 'pending';
      return { ...cur, [id]: { holes, status, dirty: true } };
    });
  };
  const setStatus = (id: string, status: ResultStatus) =>
    setRows((cur) => ({ ...cur, [id]: { ...cur[id], status, holes: status === 'dna' ? Array(9).fill(null) : cur[id].holes, dirty: true } }));

  const saveAll = async (ids = dirtyIds) => {
    if (!ids.length) return true;
    let ok = true;
    for (const id of ids) {
      const r = rows[id];
      try {
        await repo.saveScore(id, r.holes, r.status);
        setRows((cur) => ({ ...cur, [id]: { ...cur[id], dirty: false } }));
      } catch (err) {
        ok = false;
        toast(`${playerName(snap, group.find((a) => a.id === id)!.player_id)}: ${(err as Error).message}`, 'error');
      }
    }
    await act(async () => {}, ok ? `Day ${s.session_number} scores saved.` : undefined);
    return ok;
  };

  return (
    <Section
      title={`Day ${s.session_number} scores`}
      kicker={`Step 5 · ${formatSessionDate(s.session_date)} · private until published`}
      actions={s.status === 'resolved' ? <span className="badge badge-official">Day complete</span> : undefined}
    >
      <div className="table-wrap">
        <table className="scorecard">
          <thead>
            <tr>
              <th scope="col">Player</th>
              {Array.from({ length: 9 }, (_, i) => <th key={i} scope="col" className="num">{i + 1}</th>)}
              <th scope="col" className="num">Gross</th><th scope="col" className="num">Hcp</th><th scope="col" className="num">Net</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {group.map((a) => {
              const r = rows[a.id];
              if (!r) return null;
              const played = holesPlayed(r.holes);
              const gross = played ? grossOf(r.holes) : null;
              return (
                <tr key={a.id} className={r.dirty ? 'unsaved' : ''}>
                  <th scope="row">{playerName(snap, a.player_id)}</th>
                  {r.holes.map((h, i) => (
                    <td key={i}>
                      <input
                        className="hole"
                        inputMode="numeric"
                        aria-label={`${playerName(snap, a.player_id)} hole ${i + 1}`}
                        disabled={!editable || r.status === 'dna'}
                        value={h ?? ''}
                        onChange={(x) => setHole(a.id, i, x.target.value)}
                      />
                    </td>
                  ))}
                  <td className="num">{gross ?? '—'}</td>
                  <td className="num">{a.strokes}</td>
                  <td className="num led">{r.status === 'completed' && gross != null ? gross - (a.strokes ?? 0) : '—'}</td>
                  <td>
                    <select aria-label={`${playerName(snap, a.player_id)} status`} disabled={!editable} value={r.status} onChange={(x) => setStatus(a.id, x.target.value as ResultStatus)}>
                      <option value="pending">In progress</option>
                      <option value="completed" disabled={played < 9}>Completed</option>
                      <option value="dnf">Did not finish</option>
                      <option value="dna">Did not attend</option>
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="row gap">
        {editable && (
          <>
            <button className="btn btn-primary" disabled={!dirtyIds.length} onClick={() => saveAll()}>
              {dirtyIds.length ? `Save scores (${dirtyIds.length})` : 'All scores saved'}
            </button>
            <button
              className="btn"
              onClick={async () => {
                if (!(await saveAll())) return;
                await act(() => repo.resolveSession(s.id), `Day ${s.session_number} marked complete.`);
              }}
            >
              Mark Day {s.session_number} complete
            </button>
          </>
        )}
        {s.status === 'resolved' && e.status === 'locked' && (
          <button className="btn btn-quiet" onClick={() => act(() => repo.reopenSession(s.id), `Day ${s.session_number} reopened.`)}>Reopen Day {s.session_number}</button>
        )}
      </div>
      <p className="fine">Scores save to the league database, so you can sign out after Day 1 and pick up on Day 2. Completed requires all 9 holes.</p>
    </Section>
  );
}

function Finalize({ e, sessions }: { e: LeagueEvent; sessions: EventSession[] }) {
  const { snap, repo, act } = useApp();
  const entries = entriesFor(snap, e.id);
  const lb = buildLeaderboard(entries, snap.settings.field_size_basis);
  const field = countField(entries.map((x) => x.status));
  const openDays = sessions.filter((s) => s.status !== 'resolved');
  const blockers = [
    ...openDays.map((s) => `Mark Day ${s.session_number} complete.`),
    ...(!lb.allResolved ? ['Every player must be marked completed, did not finish, or did not attend.'] : []),
    ...(lb.allResolved && !lb.lookup.ok ? [lb.lookup.reason] : []),
  ];
  return (
    <Section title={e.status === 'published' ? 'Official results' : 'Finalize & publish'} kicker="Step 6 · one combined leaderboard">
      <p className="muted">
        Field: {field.starters} starters, {field.finishers} finishers. Counting {snap.settings.field_size_basis} → {lb.field}-player field
        {lb.lookup.ok ? `, ${lb.field}-player points table.` : '.'}
      </p>
      <div className="table-wrap">
        <table className="board">
          <thead>
            <tr><th scope="col">Pos</th><th scope="col">Player</th><th scope="col">Day</th><th scope="col" className="num">Net</th><th scope="col" className="num">Pts</th></tr>
          </thead>
          <tbody>
            {lb.rows.map((r) => (
              <tr key={r.player_id} className={r.status !== 'completed' ? 'dim' : ''}>
                <td className="rank">{r.status === 'completed' ? pos(r.position, r.tied) : r.status === 'pending' ? '…' : r.status.toUpperCase()}</td>
                <td>{playerName(snap, r.player_id)}</td>
                <td>{r.session_number}</td>
                <td className="num">{r.net ?? '—'}</td>
                <td className="num led">{lb.lookup.ok ? pts(r.points) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {e.status === 'locked' && (
        <>
          {blockers.length > 0 && <ul className="problems">{blockers.map((b) => <li key={b}>{b}</li>)}</ul>}
          <button
            className="btn btn-primary"
            disabled={blockers.length > 0}
            onClick={() => {
              if (confirm('Publish official results? Scores become public and points are added to the standings.')) {
                void act(() => repo.publishEvent(e.id), 'Official results published.');
              }
            }}
          >
            Publish official results
          </button>
        </>
      )}
      {e.status === 'published' && (
        <button
          className="btn btn-quiet"
          onClick={() => {
            if (confirm('Take these results down to correct them? Scores go private again until you republish.')) {
              void act(() => repo.unpublishEvent(e.id), 'Results unpublished.');
            }
          }}
        >
          Unpublish to correct
        </button>
      )}
    </Section>
  );
}
