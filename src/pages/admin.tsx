import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../app';
import { eventSessions, PhaseBadge, playerName, pos, pts, Section, SessionLine, teamPlayers } from '../components';
import { DEMO_COMMISSIONER } from '../data/localRepo';
import { eventPhase } from '../lib/eventPhase';
import { ratingComplete, strokesReceived } from '../lib/handicap';
import {
  allowanceText, computeOutcome, entryName, entrySize, FORMAT_LABEL, formatName, isPerHole, isTeamCard, lockedCourseHandicap,
  planEntries, usesSeasonTeams,
} from '../lib/formats';
import { grossOf, holesPlayed } from '../lib/leaderboard';
import { lockProblems, MAX_PER_SESSION, MAX_TEAMS, teamName, teamOf } from '../lib/schedule';
import { addDays, formatSessionDate, formatStartTime, leagueInstant } from '../lib/time';
import type { EventFormat, EventSession, LeagueEvent, MatchType, Player, ResultStatus, SimSettings, Team } from '../lib/types';

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
      <Teams />
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
  const [win, setWin] = useState(snap.settings.match_win_points?.toString() ?? '');
  const [halve, setHalve] = useState(snap.settings.match_halve_points?.toString() ?? '');
  const toNum = (v: string) => (v.trim() === '' ? null : Number(v));
  const dirty = toNum(win) !== snap.settings.match_win_points || toNum(halve) !== snap.settings.match_halve_points;
  return (
    <>
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
      <Section title="Match play points" kicker="Each player in the match earns these">
        <div className="form pin-form">
          <label>Win<input inputMode="decimal" placeholder="Not set" value={win} onChange={(x) => setWin(x.target.value)} /></label>
          <label>Halve (tie)<input inputMode="decimal" placeholder="Not set" value={halve} onChange={(x) => setHalve(x.target.value)} /></label>
          <button
            className="btn btn-primary"
            disabled={!dirty}
            onClick={() => {
              const w = toNum(win);
              const h = toNum(halve);
              if ((w != null && (!Number.isFinite(w) || w < 0)) || (h != null && (!Number.isFinite(h) || h < 0))) {
                return void act(async () => { throw new Error('Points must be zero or more.'); });
              }
              void act(() => repo.updateSettings({ match_win_points: w, match_halve_points: h }), 'Match play points saved.');
            }}
          >
            Save
          </button>
        </div>
        <p className="fine">A loss earns 0. Match play results can't be published until both values are set.</p>
      </Section>
    </>
  );
}

function Teams() {
  const { snap } = useApp();
  const season = snap.settings.season_year;
  const teams = snap.teams.filter((t) => t.season_year === season);
  const [adding, setAdding] = useState(false);
  const free = snap.players.filter((p) => p.active && !teamOf(snap.teams, season, p.id));
  return (
    <Section
      title="Season teams"
      kicker={`Season ${season} · fixed 2-person teams · ${teams.length} of ${MAX_TEAMS}`}
      actions={teams.length < MAX_TEAMS && !adding ? <button className="btn" onClick={() => setAdding(true)}>Add team</button> : undefined}
    >
      <div className="player-list">
        {teams.map((t) => <TeamRow key={t.id} t={t} />)}
        {adding && <TeamRow onDone={() => setAdding(false)} />}
        {teams.length === 0 && !adding && <p className="muted">No teams yet. Teams are only needed for 2-person team and 2 vs 2 match events.</p>}
      </div>
      {free.length > 0 && teams.length > 0 && <p className="fine">Not on a team: {free.map((p) => p.name).join(', ')}.</p>}
      <p className="fine">Teams stay together all season and are used by every 2-person format (scramble, alternate shot, shamble, best ball, 2 vs 2 match play). Both teammates play the same day. 4-person formats use each day's group of four instead.</p>
    </Section>
  );
}

function TeamRow({ t, onDone }: { t?: Team; onDone?: () => void }) {
  const { snap, repo, act } = useApp();
  const season = snap.settings.season_year;
  const [name, setName] = useState(t?.name ?? '');
  const [a, setA] = useState(t?.player_a ?? '');
  const [b, setB] = useState(t?.player_b ?? '');
  const options = (current: string, other: string) =>
    snap.players.filter((p) => p.active && p.id !== other && (p.id === current || !teamOf(snap.teams.filter((x) => x.id !== t?.id), season, p.id)));
  const dirty = !t || name !== t.name || a !== t.player_a || b !== t.player_b;
  const autoName = (x: string, y: string) => {
    const n = (id: string) => snap.players.find((p) => p.id === id)?.name;
    if (!name.trim() && x && y) setName(`${n(x)} & ${n(y)}`);
  };
  return (
    <div className="team-row">
      <input aria-label="Team name" placeholder="Team name" value={name} onChange={(e) => setName(e.target.value)} />
      <select aria-label="First player" value={a} onChange={(e) => { setA(e.target.value); autoName(e.target.value, b); }}>
        <option value="">Player…</option>
        {options(a, b).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <select aria-label="Second player" value={b} onChange={(e) => { setB(e.target.value); autoName(a, e.target.value); }}>
        <option value="">Player…</option>
        {options(b, a).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <div className="row-actions">
        {dirty && (
          <button
            className="btn btn-primary"
            onClick={async () => {
              const ok = await act(() => repo.saveTeam({ id: t?.id, season_year: season, name: name.trim(), player_a: a, player_b: b }), t ? 'Team saved.' : 'Team added.');
              if (ok) onDone?.();
            }}
          >
            Save
          </button>
        )}
        {t && !dirty && <button className="btn btn-quiet" onClick={() => act(() => repo.deleteTeam(t.id), 'Team removed.')}>Remove</button>}
        {!t && <button className="btn btn-quiet" onClick={onDone}>Cancel</button>}
      </div>
    </div>
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
    name: e.name, format: e.format, team_size: e.team_size, counting_scores: e.counting_scores, match_type: e.match_type,
    hole_si: (e.hole_si ?? Array(9).fill(null)).map((v) => (v == null ? '' : String(v))),
    course_name: e.course_name, tees: e.tees,
    par9: e.par9?.toString() ?? '', course_rating9: e.course_rating9?.toString() ?? '', slope9: e.slope9?.toString() ?? '',
    sim: { ...e.sim_settings },
  });
  const [f, setF] = useState(init);
  useEffect(() => setF(init()), [e]); // eslint-disable-line react-hooks/exhaustive-deps
  const toNum = (s: string) => (s.trim() === '' ? null : Number(s));
  const preview: LeagueEvent = { ...e, format: f.format, team_size: f.team_size, counting_scores: f.counting_scores, match_type: f.match_type };
  const sizeChoice = f.format === 'scramble' || f.format === 'shamble' || f.format === 'best_ball';
  const counting = f.format === 'shamble' || f.format === 'best_ball';
  const maxK = f.team_size === 4 ? 3 : 2;
  const save = () =>
    act(
      () =>
        repo.updateEvent(e.id, {
          name: f.name.trim() || e.name,
          ...(locked ? {} : {
            format: f.format,
            team_size: f.format === 'alt_shot' ? 2 : f.team_size,
            counting_scores: Math.min(f.counting_scores, maxK),
            match_type: f.match_type,
            hole_si: f.hole_si.every((v) => v.trim() === '') ? null : f.hole_si.map(toNum),
            course_name: f.course_name.trim(), tees: f.tees.trim(),
            par9: toNum(f.par9), course_rating9: toNum(f.course_rating9), slope9: toNum(f.slope9), sim_settings: f.sim,
          }),
        }),
      'Event setup saved.',
    );
  return (
    <Section title="Format, course & simulator" kicker="Step 1 · shared by both sessions">
      {locked && <p className="locked-note">Locked. Format, course, tees, rating and simulator settings can't change now.</p>}
      <div className="form grid">
        <label className="span2">Event name<input value={f.name} onChange={(x) => setF({ ...f, name: x.target.value })} /></label>
        <label className="span2">Format
          <select disabled={locked} value={f.format} onChange={(x) => setF({ ...f, format: x.target.value as EventFormat })}>
            {(Object.keys(FORMAT_LABEL) as EventFormat[]).map((k) => <option key={k} value={k}>{FORMAT_LABEL[k]}</option>)}
          </select>
        </label>
        {sizeChoice && (
          <label>Team size
            <select disabled={locked} value={f.team_size} onChange={(x) => setF({ ...f, team_size: Number(x.target.value) as 2 | 4 })}>
              <option value={2}>2-person (season teams)</option>
              <option value={4}>4-person (each day's group)</option>
            </select>
          </label>
        )}
        {counting && (
          <label>Scores that count per hole
            <select disabled={locked} value={Math.min(f.counting_scores, maxK)} onChange={(x) => setF({ ...f, counting_scores: Number(x.target.value) })}>
              {Array.from({ length: maxK }, (_, i) => i + 1).map((k) => <option key={k} value={k}>Best {k}{k === f.team_size ? ' (all)' : ''}</option>)}
            </select>
          </label>
        )}
        {f.format === 'match_play' && (
          <label>Matches
            <select disabled={locked} value={f.match_type} onChange={(x) => setF({ ...f, match_type: x.target.value as MatchType })}>
              <option value="singles">Singles, 1 vs 1</option>
              <option value="fourball">2 vs 2 best ball (season teams)</option>
            </select>
          </label>
        )}
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
      {isPerHole(preview) && (
        <fieldset className="si-row" disabled={locked}>
          <legend>Stroke index for holes 1–9 (the “Handicap” row on the course card)</legend>
          {f.hole_si.map((v, i) => (
            <label key={i}>{i + 1}
              <input
                inputMode="numeric"
                aria-label={`Stroke index hole ${i + 1}`}
                value={v}
                onChange={(x) => setF({ ...f, hole_si: f.hole_si.map((y, j) => (j === i ? x.target.value.replace(/\D/g, '').slice(0, 2) : y)) })}
              />
            </label>
          ))}
        </fieldset>
      )}
      <p className="fine"><strong>{formatName(preview)}.</strong> {formatHelp(preview)} {allowanceText(preview)}</p>
      <button className="btn btn-primary" onClick={save}>Save setup</button>
    </Section>
  );
}

function formatHelp(e: LeagueEvent): string {
  const size = entrySize(e);
  if (e.format === 'individual') return 'Everyone plays their own ball on one combined leaderboard.';
  const who = size === 2 ? 'The season’s 2-person teams play together, both on the same day.' : size === 4 ? 'Each day’s group of four is a team.' : 'You pair players into matches within each day.';
  const how: Record<EventFormat, string> = {
    individual: '',
    scramble: 'Everyone hits, the team picks the best shot each time, one team score per hole.',
    alt_shot: 'Partners alternate shots with one ball, one team score per hole.',
    shamble: 'Everyone plays from the best drive, then their own ball; each player keeps a card.',
    best_ball: 'Everyone plays their own ball and keeps a card.',
    match_play: e.match_type === 'fourball' ? 'Each player keeps a card; the better net score on each hole is the team’s.' : 'Each player keeps a card; lower net score wins the hole.',
  };
  return `${who} ${how[e.format]}`;
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
  if (usesSeasonTeams(e)) return <TeamGroups e={e} sessions={sessions} />;
  return <PlayerGroups e={e} sessions={sessions} />;
}

/** Scramble groups: teams go into a session as a pair, two teams per session. */
function TeamGroups({ e, sessions }: { e: LeagueEvent; sessions: EventSession[] }) {
  const { snap, repo, act } = useApp();
  const locked = e.status !== 'draft';
  const mine = snap.assignments.filter((a) => a.event_id === e.id);
  const teams = snap.teams.filter((t) => t.season_year === e.season_year);
  const sessionOf = (t: Team) => mine.find((a) => a.player_id === t.player_a)?.session_id ?? mine.find((a) => a.player_id === t.player_b)?.session_id;
  const unassigned = teams.filter((t) => !sessionOf(t));
  const loose = mine.filter((a) => !teamOf(snap.teams, e.season_year, a.player_id));
  const removeTeam = (t: Team) =>
    act(async () => {
      for (const a of mine.filter((x) => x.player_id === t.player_a || x.player_id === t.player_b)) await repo.unassign(a.id);
    });
  const moveTeam = (t: Team, to: string) =>
    act(async () => {
      for (const a of mine.filter((x) => x.player_id === t.player_a || x.player_id === t.player_b)) await repo.moveAssignment(a.id, to);
    });
  if (!sessions.length) {
    return <Section title="Teams by day" kicker="Step 3"><p className="muted">Schedule Day 1 first.</p></Section>;
  }
  return (
    <Section title="Teams by day" kicker={`Step 3 · ${formatName(e)} · two teams per session`}>
      {locked && <p className="locked-note">Locked. Unlock before any scores are entered to change groups.</p>}
      {teams.length === 0 && <p className="warn">No season teams yet. Add them under League office → Season teams.</p>}
      <div className="groups">
        {sessions.map((s) => {
          const here = teams.filter((t) => sessionOf(t) === s.id);
          const other = sessions.find((x) => x.id !== s.id);
          const count = mine.filter((a) => a.session_id === s.id).length;
          return (
            <div key={s.id} className="group">
              <div className="group-head">
                <SessionLine s={s} />
                <span className={`count ${count === MAX_PER_SESSION ? 'full' : ''}`}>{count}/{MAX_PER_SESSION}</span>
              </div>
              <ul>
                {here.map((t) => (
                  <li key={t.id}>
                    <span>
                      <strong>{teamName(t)}</strong>
                      {teamPlayers(snap, t) && <><br /><span className="team-players">{teamPlayers(snap, t)}</span></>}
                    </span>
                    {!locked && (
                      <span className="row-actions">
                        {other && <button className="btn btn-quiet btn-sm" onClick={() => moveTeam(t, other.id)}>→ Day {other.session_number}</button>}
                        <button className="btn btn-quiet btn-sm" aria-label={`Remove ${teamName(t)}`} onClick={() => removeTeam(t)}>✕</button>
                      </span>
                    )}
                  </li>
                ))}
                {here.length === 0 && <li className="muted">Empty</li>}
              </ul>
            </div>
          );
        })}
      </div>
      {loose.length > 0 && (
        <div className="warn">
          <p>Not on a team: {loose.map((a) => playerName(snap, a.player_id)).join(', ')}. Add them to a team or remove them from this event.</p>
          {!locked && loose.map((a) => <button key={a.id} className="btn btn-quiet btn-sm" onClick={() => act(() => repo.unassign(a.id))}>Remove {playerName(snap, a.player_id)}</button>)}
        </div>
      )}
      {!locked && unassigned.length > 0 && (
        <div className="pool">
          <p className="eyebrow">Teams not assigned</p>
          {unassigned.map((t) => (
            <div key={t.id} className="pool-row">
              <span>{teamName(t)} {teamPlayers(snap, t) && <span className="team-players">({teamPlayers(snap, t)})</span>}</span>
              <span className="row-actions">
                {sessions.map((s) => (
                  <button key={s.id} className="btn btn-sm" onClick={() => act(() => repo.assignTeam(e.id, s.id, t.id))}>Day {s.session_number}</button>
                ))}
              </span>
            </div>
          ))}
          <p className="fine">Teams left unassigned aren't in this event and their players get zero points.</p>
        </div>
      )}
    </Section>
  );
}

function PlayerGroups({ e, sessions }: { e: LeagueEvent; sessions: EventSession[] }) {
  const { snap, repo, act } = useApp();
  const locked = e.status !== 'draft';
  const singles = e.format === 'match_play' && e.match_type === 'singles';
  const mine = snap.assignments.filter((a) => a.event_id === e.id);
  const unassigned = snap.players.filter((p) => p.active && !mine.some((a) => a.player_id === p.id));
  if (!sessions.length) {
    return <Section title="Groups" kicker="Step 3"><p className="muted">Schedule Day 1 first.</p></Section>;
  }
  return (
    <Section title="Groups" kicker={`Step 3 · ${mine.length} assigned · one session per player`}>
      {locked && <p className="locked-note">Locked. Unlock before any scores are entered to change groups.</p>}
      {entrySize(e) === 4 && <p className="muted">{formatName(e)}: each day's group of four is one team.</p>}
      {singles && <p className="muted">Match play singles: put two players in Match 1 and two in Match 2 for each day.</p>}
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
                    {singles && (
                      <span className="slot-pick" role="group" aria-label={`${playerName(snap, a.player_id)} match`}>
                        {([1, 2] as const).map((slot) => (
                          <button
                            key={slot}
                            className={`btn btn-sm ${a.match_slot === slot ? 'btn-primary' : 'btn-quiet'}`}
                            disabled={locked}
                            aria-pressed={a.match_slot === slot}
                            onClick={() => act(() => repo.setMatchSlot(a.id, slot))}
                          >
                            Match {slot}
                          </button>
                        ))}
                      </span>
                    )}
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
  const problems = e.status === 'draft' ? lockProblems(e, snap.sessions, snap.assignments, snap.players, snap.teams) : [];
  const first = sessions[0];
  const start = first ? leagueInstant(first.session_date, first.start_time) : null;
  const late = e.status === 'draft' && start != null && Date.now() >= start.getTime();
  const touched = (r: { status: ResultStatus; hole_scores: (number | null)[] }) => r.status !== 'pending' || r.hole_scores.some((h) => h != null);
  const anyScores =
    snap.scores.some((r) => mine.some((a) => a.id === r.assignment_id) && touched(r)) ||
    snap.entryScores.some((r) => snap.entries.some((x) => x.id === r.entry_id && x.event_id === e.id) && touched(r));
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
      {e.format !== 'individual' && rows.length > 0 && <EntryHandicaps e={e} />}
      {e.format === 'individual' && rows.length > 0 && (
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

/** Team / match handicaps: a preview before locking, the confirmed numbers after. */
function EntryHandicaps({ e }: { e: LeagueEvent }) {
  const { snap } = useApp();
  const ch = (pid: string) => {
    const p = snap.players.find((x) => x.id === pid);
    return p?.handicap_index != null ? lockedCourseHandicap(p.handicap_index, e) : null;
  };
  const lines =
    e.status === 'draft'
      ? planEntries(e, snap, ch).map((pe) => ({ key: pe.key, session_id: pe.session_id, team_id: pe.team_id, match_slot: pe.match_slot, strokes: pe.strokes, members: pe.members }))
      : snap.entries
          .filter((x) => x.event_id === e.id)
          .map((x) => ({ key: x.id, session_id: x.session_id, team_id: x.team_id, match_slot: x.match_slot, strokes: x.strokes, members: snap.entryMembers.filter((m) => m.entry_id === x.id) }));
  const day = (sid: string) => snap.sessions.find((s) => s.id === sid)?.session_number ?? 0;
  const sorted = [...lines].sort((a, b) => day(a.session_id) - day(b.session_id) || (a.match_slot ?? 0) - (b.match_slot ?? 0));
  const teamCard = isTeamCard(e);
  return (
    <div className="table-wrap">
      <table className="board">
        <thead>
          <tr>
            <th scope="col">{e.format === 'match_play' ? 'Match side' : 'Team'}</th>
            <th scope="col">Day</th>
            <th scope="col">{teamCard ? '9-hole course handicaps' : 'Course handicap → strokes'}</th>
            {teamCard && <th scope="col" className="num">Team strokes</th>}
          </tr>
        </thead>
        <tbody>
          {sorted.map((l) => (
            <tr key={l.key}>
              <td>
                {entryName(snap, l, l.members.map((m) => m.player_id))}
                {e.format === 'match_play' && e.match_type === 'singles' && <span className="note"> match {l.match_slot}</span>}
              </td>
              <td>{day(l.session_id)}</td>
              <td className="muted small">
                {l.members.map((m) => `${playerName(snap, m.player_id)} ${m.course_handicap.toFixed(2)}${teamCard ? '' : ` → ${m.playing_handicap}`}`).join(' · ')}
              </td>
              {teamCard && <td className="num led">{l.strokes ?? '—'}</td>}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine">{allowanceText(e)}</p>
    </div>
  );
}

type Row = { holes: (number | null)[]; status: ResultStatus; dirty: boolean };

/** One scorecard line: a player (individual) or a team (scramble). */
interface CardLine {
  key: string;
  label: string;
  sub?: string;
  strokes: number | null;
  holes: (number | null)[];
  status: ResultStatus;
}

function Scoring({ e, s }: { e: LeagueEvent; s: EventSession }) {
  const { snap, repo } = useApp();
  const teamCard = isTeamCard(e);
  const lines: CardLine[] = useMemo(() => {
    if (teamCard) {
      return snap.entries
        .filter((x) => x.event_id === e.id && x.session_id === s.id)
        .map((x) => {
          const t = snap.teams.find((y) => y.id === x.team_id);
          const members = snap.entryMembers.filter((m) => m.entry_id === x.id).map((m) => m.player_id);
          const sc = snap.entryScores.find((r) => r.entry_id === x.id);
          return {
            key: x.id,
            label: entryName(snap, x, members),
            sub: t ? teamPlayers(snap, t) ?? undefined : members.map((pid) => playerName(snap, pid)).join(', '),
            strokes: x.strokes,
            holes: sc?.hole_scores ?? Array(9).fill(null),
            status: sc?.status ?? 'pending',
          };
        })
        .sort((a, b) => a.label.localeCompare(b.label));
    }
    return snap.assignments
      .filter((a) => a.session_id === s.id)
      .map((a) => {
        const sc = snap.scores.find((r) => r.assignment_id === a.id);
        const member = snap.entryMembers.find((m) => m.player_id === a.player_id && snap.entries.some((x) => x.id === m.entry_id && x.event_id === e.id));
        return {
          key: a.id,
          label: playerName(snap, a.player_id),
          // Per-hole formats: show the strokes this player gets over the 9 holes.
          strokes: e.format === 'individual' ? a.strokes : member?.playing_handicap ?? null,
          holes: sc?.hole_scores ?? Array(9).fill(null),
          status: sc?.status ?? 'pending',
        };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [snap, s.id, e.id, e.format, teamCard]);
  const save = (key: string, holes: (number | null)[], status: ResultStatus) =>
    teamCard ? repo.saveEntryScore(key, holes, status) : repo.saveScore(key, holes, status);
  return <ScoreCard e={e} s={s} lines={lines} save={save} unit={teamCard ? 'team' : 'player'} />;
}

function ScoreCard({
  e, s, lines, save, unit,
}: {
  e: LeagueEvent;
  s: EventSession;
  lines: CardLine[];
  save: (key: string, holes: (number | null)[], status: ResultStatus) => Promise<void>;
  unit: 'player' | 'team';
}) {
  const { snap, repo, act, toast } = useApp();
  const fromServer = () => Object.fromEntries(lines.map((l) => [l.key, { holes: l.holes, status: l.status, dirty: false } as Row]));
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
  const perHole = isPerHole(e);
  const dirtyIds = Object.keys(rows).filter((k) => rows[k].dirty);
  const labelOf = (k: string) => lines.find((l) => l.key === k)?.label ?? '';

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
        await save(id, r.holes, r.status);
        setRows((cur) => ({ ...cur, [id]: { ...cur[id], dirty: false } }));
      } catch (err) {
        ok = false;
        toast(`${labelOf(id)}: ${(err as Error).message}`, 'error');
      }
    }
    await act(async () => {}, ok ? `Day ${s.session_number} scores saved.` : undefined);
    return ok;
  };

  return (
    <Section
      title={`Day ${s.session_number} ${unit === 'team' ? 'team scores' : 'scores'}`}
      kicker={`Step 5 · ${formatSessionDate(s.session_date)} · private until published`}
      actions={s.status === 'resolved' ? <span className="badge badge-official">Day complete</span> : undefined}
    >
      <div className="table-wrap">
        <table className="scorecard">
          <thead>
            <tr>
              <th scope="col">{unit === 'team' ? 'Team' : 'Player'}</th>
              {Array.from({ length: 9 }, (_, i) => <th key={i} scope="col" className="num">{i + 1}</th>)}
              <th scope="col" className="num">Gross</th><th scope="col" className="num">Hcp</th><th scope="col" className="num">Net</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {lines.map((l) => {
              const r = rows[l.key];
              if (!r) return null;
              const played = holesPlayed(r.holes);
              const gross = played ? grossOf(r.holes) : null;
              return (
                <tr key={l.key} className={r.dirty ? 'unsaved' : ''}>
                  <th scope="row">
                    {l.label}
                    {l.sub && <span className="team-players"><br />{l.sub}</span>}
                  </th>
                  {r.holes.map((h, i) => (
                    <td key={i}>
                      <input
                        className="hole"
                        inputMode="numeric"
                        aria-label={`${l.label} hole ${i + 1}`}
                        disabled={!editable || r.status === 'dna'}
                        value={h ?? ''}
                        onChange={(x) => setHole(l.key, i, x.target.value)}
                      />
                    </td>
                  ))}
                  <td className="num">{gross ?? '—'}</td>
                  <td className="num">{l.strokes}</td>
                  <td className="num led">{perHole ? '' : r.status === 'completed' && gross != null ? gross - (l.strokes ?? 0) : '—'}</td>
                  <td>
                    <select aria-label={`${l.label} status`} disabled={!editable} value={r.status} onChange={(x) => setStatus(l.key, x.target.value as ResultStatus)}>
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
      <p className="fine">
        {unit === 'team' ? 'Enter one team score per hole. ' : perHole ? 'Enter each player’s own gross score; strokes are applied hole by hole when results are worked out (Hcp = strokes over 9 holes). ' : ''}Scores save to the league database, so you can sign out after Day 1 and pick up on Day 2. Completed requires all 9 holes.
      </p>
    </Section>
  );
}

function Finalize({ e, sessions }: { e: LeagueEvent; sessions: EventSession[] }) {
  const { snap, repo, act } = useApp();
  const out = computeOutcome(snap, e.id);
  const match = e.format === 'match_play';
  const team = e.format !== 'individual' && !match;
  const label = (key: string, players: string[]) => {
    if (e.format === 'individual') return playerName(snap, key);
    const en = snap.entries.find((x) => x.id === key);
    return en ? entryName(snap, en, players) : '';
  };
  const openDays = sessions.filter((s) => s.status !== 'resolved');
  const blockers = [...openDays.map((s) => `Mark Day ${s.session_number} complete.`), ...out.blockers];
  return (
    <Section title={e.status === 'published' ? 'Official results' : 'Finalize & publish'} kicker={`Step 6 · ${formatName(e)}`}>
      {!match && (
        <p className="muted">
          {out.field}-player field (counting {snap.settings.field_size_basis}).
          {team && ' Each finishing team covers as many places as it has players; every teammate gets the average of those places.'}
        </p>
      )}
      {match ? (
        <ul className="match-list">
          {out.matches.map((m) => {
            const name = (id: string) => label(id, snap.entryMembers.filter((x) => x.entry_id === id).map((x) => x.player_id));
            const verdict = !m.complete ? 'In progress' : m.winner ? `${name(m.winner)} ${m.forfeit ? 'by forfeit' : `${m.margin} up`}` : 'Halved';
            return (
              <li key={`${m.session_number}-${m.match_slot}`}>
                <span className="muted small">Day {m.session_number}{e.match_type === 'singles' ? ` · Match ${m.match_slot}` : ''}</span>
                <strong>{name(m.a)} vs {name(m.b)}</strong>
                <span className="led">{verdict}</span>
              </li>
            );
          })}
          {out.matches.length === 0 && <li className="muted">No matches yet.</li>}
        </ul>
      ) : (
        <div className="table-wrap">
          <table className="board">
            <thead>
              <tr>
                <th scope="col">Pos</th><th scope="col">{team ? 'Team' : 'Player'}</th><th scope="col">Day</th>
                <th scope="col" className="num">Net</th><th scope="col" className="num">{team ? 'Pts each' : 'Pts'}</th>
              </tr>
            </thead>
            <tbody>
              {out.rows.map((r) => (
                <tr key={r.key} className={r.status !== 'completed' ? 'dim' : ''}>
                  <td className="rank">{r.status === 'completed' ? pos(r.position, r.tied) : r.status === 'pending' ? '…' : r.status.toUpperCase()}</td>
                  <td>{label(r.key, r.player_ids)}</td>
                  <td>{r.session_number}</td>
                  <td className="num">{r.net ?? '—'}</td>
                  <td className="num led">{out.blockers.length ? '—' : pts(r.points)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
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
