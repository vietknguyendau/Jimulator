import { useApp } from '../app';
import { eventSessions, PhaseBadge, playerName, pos, pts, Section, SessionLine, teamPlayers } from '../components';
import { eventPhase } from '../lib/eventPhase';
import { seasonStandings, teamStandings } from '../lib/standings';
import { entryName, formatName, usesSeasonTeams } from '../lib/formats';
import { teamName } from '../lib/schedule';
import { leagueToday } from '../lib/time';
import type { EventSession, LeagueEvent, Snapshot } from '../lib/types';

export function Dashboard() {
  const { snap } = useApp();
  const events = snap.events.filter((e) => e.season_year === snap.settings.season_year).sort((a, b) => a.event_number - b.event_number);
  const standings = seasonStandings(snap.players, events, snap.results);
  const published = events.filter((e) => e.status === 'published').length;
  const today = leagueToday();
  const next =
    events.find((e) => e.status !== 'published' && eventSessions(snap, e).some((s) => s.status !== 'resolved' && s.session_date >= today)) ??
    events.find((e) => e.status !== 'published');
  const leader = standings[0];

  return (
    <div className="stack">
      <section className="hero">
        <h1 className="sr-only">JIMULATOR Golf Simulator League — Five events. One champion.</h1>
        <img
          className="hero-logo"
          src="/logo.jpg"
          width={1024}
          height={572}
          alt="JIMULATOR Golf Simulator League — 5 Event Championship. Five events, one champion."
        />
        <p className="eyebrow hero-season">Season {snap.settings.season_year} · {published} of 5 events official</p>
        <div className="progress" aria-label={`${published} of 5 events complete`}>
          {events.map((e) => (
            <a key={e.id} href={`#/events/${e.event_number}`} className={`pip pip-${eventPhase(e, snap.sessions).kind}`}>
              <span>{e.event_number}</span>
            </a>
          ))}
        </div>
        {leader && leader.points > 0 && (
          <p className="hero-leader">
            <span className="eyebrow">Leading</span> {leader.player.name} · <span className="led">{pts(leader.points)}</span> pts
          </p>
        )}
      </section>

      {next && <NextUp e={next} />}

      <Section title="Championship standings" kicker="Cumulative points · all 5 events count">
        <div className="table-wrap">
          <table className="board">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Player</th>
                <th scope="col" className="num">Pts</th>
                <th scope="col" className="num" title="1st-place finishes">1st</th>
                <th scope="col" className="num" title="2nd-place finishes">2nd</th>
                <th scope="col" className="num" title="3rd-place finishes">3rd</th>
                <th scope="col" className="num" title="Cumulative net score">Net</th>
              </tr>
            </thead>
            <tbody>
              {standings.map((r) => (
                <tr key={r.player.id}>
                  <td className="rank">{r.tied ? 'T' : ''}{r.rank}</td>
                  <td>
                    {r.player.name}
                    {r.playoff && <span className="note"> playoff for title</span>}
                    {r.decidedBy && <span className="note" title={`Tiebreaker: ${r.decidedBy}`}> tb</span>}
                  </td>
                  <td className="num led">{pts(r.points)}</td>
                  <td className="num">{r.firsts}</td>
                  <td className="num">{r.seconds}</td>
                  <td className="num">{r.thirds}</td>
                  <td className="num muted">{r.eventsPlayed ? r.cumulativeNet : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine">
          Ties go to most 1st-place finishes, then 2nds, then 3rds, then lowest cumulative net, then a sudden-death playoff.
          Only official results count.
        </p>
      </Section>
      <TeamStandings />
    </div>
  );
}

function TeamStandings() {
  const { snap } = useApp();
  const season = snap.settings.season_year;
  const teams = snap.teams.filter((t) => t.season_year === season);
  const events = snap.events.filter((e) => e.season_year === season);
  if (!teams.length || !events.some((e) => e.format !== 'individual' && usesSeasonTeams(e))) return null;
  const rows = teamStandings(teams, events, snap.results);
  return (
    <Section title="Season teams" kicker="Points from 2-person team events · each teammate also earns them">
      <div className="table-wrap">
        <table className="board">
          <thead>
            <tr><th scope="col">Team</th><th scope="col">Players</th><th scope="col" className="num">Pts</th><th scope="col" className="num">Wins</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.team.id}>
                <td>{teamName(r.team)}</td>
                <td className="muted">{playerName(snap, r.team.player_a)} & {playerName(snap, r.team.player_b)}</td>
                <td className="num led">{pts(r.points)}</td>
                <td className="num">{r.firsts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** "Jim, Austin" for individual; "Jim & Tony, Austin & Bryan" (team names) for a scramble session. */
function groupLabel(snap: Snapshot, e: LeagueEvent, s: EventSession): string {
  const group = snap.assignments.filter((a) => a.session_id === s.id);
  if (!group.length) return 'Group not set';
  if (e.format !== 'individual' && usesSeasonTeams(e)) {
    const ids = new Set(group.map((a) => a.player_id));
    const ts = snap.teams.filter((t) => t.season_year === e.season_year && (ids.has(t.player_a) || ids.has(t.player_b)));
    if (ts.length) return ts.map(teamName).join(e.format === 'match_play' ? ' vs ' : ', ');
  }
  if (e.format === 'match_play' && e.match_type === 'singles' && group.every((a) => a.match_slot)) {
    return ([1, 2] as const)
      .map((slot) => group.filter((a) => a.match_slot === slot).map((a) => playerName(snap, a.player_id)).join(' vs '))
      .filter(Boolean)
      .join(' · ');
  }
  return group.map((a) => playerName(snap, a.player_id)).join(', ');
}

function NextUp({ e }: { e: LeagueEvent }) {
  const { snap } = useApp();
  const ss = eventSessions(snap, e);
  const phase = eventPhase(e, snap.sessions);
  return (
    <Section kicker={`Event ${e.event_number} of 5`} title={e.name} actions={<PhaseBadge phase={phase} />}>
      <div className="next-grid">
        <div>
          {ss.length ? ss.map((s) => <div key={s.id}><SessionLine s={s} /></div>) : <p className="muted">Dates to be announced.</p>}
          {e.course_name && <p className="muted">{e.course_name} · {e.tees} tees</p>}
          {e.format !== 'individual' && <span className="format-tag">{formatName(e)}</span>}
        </div>
        <a className="btn" href={`#/events/${e.event_number}`}>Event details</a>
      </div>
      {phase.kind === 'day2_pending' && (
        <p className="pending-note">Day 1 is in the books. Scores stay private until Day 2 is played and official results are published.</p>
      )}
    </Section>
  );
}

export function Schedule() {
  const { snap } = useApp();
  const events = snap.events.filter((e) => e.season_year === snap.settings.season_year).sort((a, b) => a.event_number - b.event_number);
  return (
    <div className="stack">
      <header className="page-head">
        <p className="eyebrow">Season {snap.settings.season_year}</p>
        <h1>Schedule</h1>
        <p className="muted">Up to four players per day on the simulator. Eight-player events run over two consecutive days. All times Central.</p>
      </header>
      {events.map((e) => {
        const ss = eventSessions(snap, e);
        return (
          <a key={e.id} href={`#/events/${e.event_number}`} className="card card-link">
            <div className="card-head">
              <div>
                <p className="eyebrow">Event {e.event_number}{e.format !== 'individual' ? ` · ${formatName(e)}` : ''}</p>
                <h2>{e.name}</h2>
              </div>
              <PhaseBadge phase={eventPhase(e, snap.sessions)} />
            </div>
            <div className="sched-sessions">
              {ss.length === 0 && <p className="muted">Dates to be announced.</p>}
              {ss.map((s) => (
                <div key={s.id} className="sched-session">
                  <SessionLine s={s} />
                  <p className="muted small">{groupLabel(snap, e, s)}</p>
                </div>
              ))}
            </div>
            {e.course_name && <p className="muted small">{e.course_name} · {e.tees} tees</p>}
          </a>
        );
      })}
    </div>
  );
}

export function EventPage({ n }: { n: number }) {
  const { snap } = useApp();
  const e = snap.events.find((x) => x.season_year === snap.settings.season_year && x.event_number === n);
  if (!e) return <p>Event not found.</p>;
  const ss = eventSessions(snap, e);
  const phase = eventPhase(e, snap.sessions);
  const results = snap.results.filter((r) => r.event_id === e.id).sort((a, b) => (a.position ?? 99) - (b.position ?? 99));
  const sim = e.sim_settings;

  return (
    <div className="stack">
      <header className="page-head">
        <p className="eyebrow">Event {e.event_number} of 5{e.format !== 'individual' ? ` · ${formatName(e)}` : ''}</p>
        <h1>{e.name}</h1>
        <PhaseBadge phase={phase} />
      </header>

      {phase.kind === 'day2_pending' && (
        <div className="pending-banner" role="status">
          <strong>Day 2 pending.</strong> Day 1 is complete. Scores stay private until Day 2 is played and the commissioner publishes official results.
        </div>
      )}
      {phase.kind === 'awaiting_results' && (
        <div className="pending-banner" role="status"><strong>All rounds are in.</strong> Official results are coming soon.</div>
      )}

      {phase.kind === 'official' && e.format === 'match_play' && <MatchResults e={e} />}
      {phase.kind === 'official' && e.format !== 'individual' && e.format !== 'match_play' && <TeamResults e={e} />}
      {phase.kind === 'official' && e.format === 'individual' && (
        <Section title="Official results" kicker="One combined leaderboard · lowest net wins">
          <div className="table-wrap">
            <table className="board">
              <thead>
                <tr>
                  <th scope="col">Pos</th><th scope="col">Player</th><th scope="col" className="hide-sm">Day</th>
                  <th scope="col" className="num">Gross</th><th scope="col" className="num hide-sm">Hcp</th>
                  <th scope="col" className="num">Net</th><th scope="col" className="num">Pts</th>
                </tr>
              </thead>
              <tbody>
                {results.map((r) => (
                  <tr key={r.player_id} className={r.status !== 'completed' ? 'dim' : ''}>
                    <td className="rank">{r.status === 'completed' ? pos(r.position, r.tied) : r.status === 'dnf' ? 'DNF' : 'DNA'}</td>
                    <td>{playerName(snap, r.player_id)}</td>
                    <td className="hide-sm">{r.session_number}</td>
                    <td className="num">{r.gross ?? '—'}</td>
                    <td className="num hide-sm">{r.strokes ?? '—'}</td>
                    <td className="num led">{r.net ?? '—'}</td>
                    <td className="num led">{pts(r.points)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine">Tied players split the points for the positions they share. DNF = did not finish 9 holes; DNA = did not attend. Both receive zero points.</p>
        </Section>
      )}

      <Section title="Schedule & groups" kicker="All times Central">
        {ss.length === 0 && <p className="muted">Dates to be announced.</p>}
        <div className="groups">
          {e.format !== 'individual' && usesSeasonTeams(e) && ss.map((s) => <TeamGroup key={s.id} e={e} s={s} />)}
          {!(e.format !== 'individual' && usesSeasonTeams(e)) && ss.map((s) => {
            const group = snap.assignments.filter((a) => a.session_id === s.id);
            return (
              <div key={s.id} className="group">
                <SessionLine s={s} />
                <ul>
                  {group.map((a) => (
                    <li key={a.id}>
                      <span>{playerName(snap, a.player_id)}</span>
                      <span className="muted small">{strokesNote(snap, e, a)}</span>
                    </li>
                  ))}
                  {group.length === 0 && <li className="muted">Group not set</li>}
                </ul>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Course & simulator" kicker="Same for every session">
        {e.course_name ? (
          <dl className="facts">
            <dt>Course</dt><dd>{e.course_name}</dd>
            <dt>Tees</dt><dd>{e.tees}</dd>
            {e.par9 != null && (<><dt>9-hole par / rating / slope</dt><dd>{e.par9} / {e.course_rating9} / {e.slope9}</dd></>)}
            {sim.green_speed && (<><dt>Green speed</dt><dd>{sim.green_speed}</dd></>)}
            {sim.fairway_firmness && (<><dt>Fairways</dt><dd>{sim.fairway_firmness}</dd></>)}
            {sim.wind && (<><dt>Wind</dt><dd>{sim.wind}</dd></>)}
            {sim.putting && (<><dt>Putting</dt><dd>{sim.putting}</dd></>)}
            {sim.mulligans && (<><dt>Mulligans</dt><dd>{sim.mulligans}</dd></>)}
          </dl>
        ) : (
          <p className="muted">Course to be announced.</p>
        )}
        {e.status !== 'draft' && <p className="fine">Setup locked and handicaps confirmed.</p>}
      </Section>
    </div>
  );
}

/** What a player's strokes mean in this event's format, for the public groups list. */
function strokesNote(snap: Snapshot, e: LeagueEvent, a: { player_id: string; strokes: number | null; match_slot: 1 | 2 | null }): string {
  if (e.format === 'individual') return a.strokes != null ? `${a.strokes} strokes` : '';
  const m = snap.entryMembers.find((x) => x.player_id === a.player_id && snap.entries.some((y) => y.id === x.entry_id && y.event_id === e.id));
  const slot = e.format === 'match_play' && e.match_type === 'singles' && a.match_slot ? `Match ${a.match_slot}` : '';
  const strokes = m?.playing_handicap != null ? `${m.playing_handicap} strokes` : '';
  return [slot, strokes].filter(Boolean).join(' · ');
}

function TeamGroup({ e, s }: { e: LeagueEvent; s: EventSession }) {
  const { snap } = useApp();
  const ids = new Set(snap.assignments.filter((a) => a.session_id === s.id).map((a) => a.player_id));
  const teams = snap.teams.filter((t) => t.season_year === e.season_year && (ids.has(t.player_a) || ids.has(t.player_b)));
  return (
    <div className="group">
      <SessionLine s={s} />
      <ul>
        {teams.map((t) => {
          const et = snap.entries.find((x) => x.event_id === e.id && x.team_id === t.id);
          return (
            <li key={t.id}>
              <span>
                <strong>{teamName(t)}</strong>
                {teamPlayers(snap, t) && <><br /><span className="team-players">{teamPlayers(snap, t)}</span></>}
              </span>
              {et?.strokes != null && <span className="muted small">{et.strokes} team strokes</span>}
            </li>
          );
        })}
        {teams.length === 0 && <li className="muted">Teams not set</li>}
      </ul>
    </div>
  );
}

function TeamResults({ e }: { e: LeagueEvent }) {
  const { snap } = useApp();
  const byEntry = new Map<string, (typeof snap.results)[number]>();
  for (const r of snap.results) if (r.event_id === e.id && r.entry_id) byEntry.set(r.entry_id, r);
  const rows = [...byEntry.entries()].sort((a, b) => (a[1].position ?? 99) - (b[1].position ?? 99));
  const members = (entryId: string) => snap.results.filter((r) => r.event_id === e.id && r.entry_id === entryId).map((r) => r.player_id);
  return (
    <Section title="Official results" kicker={`${formatName(e)} · one combined team leaderboard · lowest net wins`}>
      <div className="table-wrap">
        <table className="board">
          <thead>
            <tr>
              <th scope="col">Pos</th><th scope="col">Team</th><th scope="col" className="hide-sm">Day</th>
              <th scope="col" className="num">Gross</th><th scope="col" className="num hide-sm">Hcp</th>
              <th scope="col" className="num">Net</th><th scope="col" className="num">Pts each</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([eid, r]) => {
              const en = snap.entries.find((x) => x.id === eid);
              const ids = members(eid);
              const t = r.team_id ? snap.teams.find((x) => x.id === r.team_id) : undefined;
              const sub = t ? teamPlayers(snap, t) : ids.map((pid) => playerName(snap, pid)).join(', ');
              return (
                <tr key={eid} className={r.status !== 'completed' ? 'dim' : ''}>
                  <td className="rank">{r.status === 'completed' ? pos(r.position, r.tied) : r.status === 'dnf' ? 'DNF' : 'DNA'}</td>
                  <td>
                    {en ? entryName(snap, en, ids) : t ? teamName(t) : 'Team'}
                    {sub && <span className="team-players"><br />{sub}</span>}
                  </td>
                  <td className="hide-sm">{r.session_number}</td>
                  <td className="num">{r.gross ?? '—'}</td>
                  <td className="num hide-sm">{r.strokes ?? '—'}</td>
                  <td className="num led">{r.net ?? '—'}</td>
                  <td className="num led">{pts(r.points)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="fine">Each finishing team covers as many places as it has players, and every teammate earns the average of those places' points toward the individual championship. Tied teams share their combined places.</p>
    </Section>
  );
}

function MatchResults({ e }: { e: LeagueEvent }) {
  const { snap } = useApp();
  const mine = snap.results.filter((r) => r.event_id === e.id).sort((a, b) => a.session_number - b.session_number || b.points - a.points);
  return (
    <Section title="Official results" kicker={formatName(e)}>
      <div className="table-wrap">
        <table className="board">
          <thead>
            <tr>
              <th scope="col">Player</th><th scope="col" className="hide-sm">Day</th><th scope="col">Match</th>
              <th scope="col" className="num hide-sm">Net</th><th scope="col" className="num">Pts</th>
            </tr>
          </thead>
          <tbody>
            {mine.map((r) => (
              <tr key={r.player_id} className={r.points === 0 ? 'dim' : ''}>
                <td>{playerName(snap, r.player_id)}</td>
                <td className="hide-sm">{r.session_number}</td>
                <td>{r.detail}</td>
                <td className="num hide-sm">{r.net ?? '—'}</td>
                <td className="num led">{pts(r.points)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="fine">Net is each player's own 9-hole net after match strokes. Match points are set by the commissioner.</p>
    </Section>
  );
}

export function Rules() {
  return (
    <article className="stack rules">
      <header className="page-head">
        <p className="eyebrow">Official rules</p>
        <h1>5 Event Championship</h1>
      </header>
      <Section title="League format">
        <ul>
          <li>8-player maximum. 5 events during the season. One simulator.</li>
          <li>Each player plays 9 holes per event.</li>
          <li><strong>Up to four players per day.</strong> Each event has one or two sessions; a session is one group of up to four players on the simulator.</li>
          <li>When 8 players attend, four play on Day 1 and four play on the following calendar day (Central time).</li>
          <li>If only 4 players attend, all 4 compete together in one session.</li>
          <li>Each player plays in one session per event. The commissioner sets each session's date and start time and assigns the groups.</li>
          <li>All players compete on one combined leaderboard. Highest cumulative points after 5 events wins the championship.</li>
        </ul>
      </Section>
      <Section title="Points system">
        <div className="points-tables">
          <table className="board compact">
            <caption>8-player event</caption>
            <thead><tr><th scope="col">Finish</th><th scope="col" className="num">Points</th></tr></thead>
            <tbody>{[16, 13, 11, 9, 7, 5, 3, 1].map((p, i) => <tr key={i}><td>{i + 1}</td><td className="num led">{p}</td></tr>)}</tbody>
          </table>
          <table className="board compact">
            <caption>4-player event</caption>
            <thead><tr><th scope="col">Finish</th><th scope="col" className="num">Points</th></tr></thead>
            <tbody>{[12, 9, 6, 3].map((p, i) => <tr key={i}><td>{i + 1}</td><td className="num led">{p}</td></tr>)}</tbody>
          </table>
        </div>
        <ul>
          <li>Players who do not attend receive zero points.</li>
          <li>The points table is chosen from the total field across both days. Whether the field counts everyone who started or only those who finished is set by the commissioner.</li>
          <li>The rules only define 4- and 8-player events. Any other field size is held until the commissioner resolves how to score it.</li>
        </ul>
      </Section>
      <Section title="Handicap system">
        <ul>
          <li>Use each player's official GHIN Handicap Index when available.</li>
          <li>Convert to the simulator course's 9-hole Course Handicap: (Index ÷ 2) × (9-hole Slope ÷ 113) + (9-hole Course Rating − 9-hole Par).</li>
          <li>Apply an 80% handicap allowance and round the resulting strokes to the nearest whole number.</li>
          <li>Net score determines finishing position.</li>
          <li>Handicap calculations are confirmed, and the event setup is locked, before the first session starts.</li>
        </ul>
        <p className="example">Example: a player shoots 42 gross and receives 4 handicap strokes. Their net score is 38.</p>
      </Section>
      <Section title="Event scoring">
        <ul>
          <li>Both sessions play the same course and tees with the same simulator settings.</li>
          <li>Scores from both days combine into one overall leaderboard. Lowest net score wins.</li>
          <li>Tied positions split the points for those positions, including ties between players from different days. The next player skips the shared positions (for example, a tie for 1st is followed by 3rd).</li>
          <li>Players must complete all 9 holes to receive points.</li>
          <li>After Day 1 the schedule shows "Day 2 pending." Scores stay private until official results are published.</li>
          <li>An event becomes official once every scheduled session is complete and every player is marked completed, did not finish, or did not attend. Points are awarded once for the whole event.</li>
        </ul>
      </Section>
      <Section title="Team and match play formats">
        <p className="muted">The commissioner picks a format for each event when setting it up. Handicaps follow the World Handicap System recommended allowances and are confirmed before the first session.</p>
        <ul>
          <li><strong>Teams.</strong> 2-person formats use the season teams, set at the start of the season; both teammates play the same day, two teams per session. 4-person formats make each day's group of four a team.</li>
          <li><strong>Scramble</strong> (2 or 4): everyone hits, the team plays the best shot, one team score. Team strokes: 2-person 35% of the lower course handicap + 15% of the higher; 4-person 25% / 20% / 15% / 10%, lowest first.</li>
          <li><strong>Alternate shot</strong> (2): partners alternate shots with one ball. Team strokes: 50% of the combined course handicaps.</li>
          <li><strong>Shamble</strong> (2 or 4): everyone plays from the best drive, then their own ball. <strong>Best ball</strong> (2 or 4): everyone plays their own ball. In both, the best net score(s) on each hole count; strokes fall on the hardest holes by the course card's stroke index. Allowance: 2-person 85% (100% if both count); 4-person 75% for best 1, 85% for best 2, 100% for best 3.</li>
          <li><strong>Match play</strong>: singles (1 vs 1) or 2 vs 2 best ball, within a session. The lowest handicap in the match plays off zero; the others get the difference (100% singles, 90% 2 vs 2), one stroke per hole on the hardest holes. A win and a halve earn the points the commissioner sets; a loss earns zero. A side that doesn't finish loses the match by forfeit.</li>
          <li><strong>Team points.</strong> Teams are ranked on one combined leaderboard by net. Each finishing team covers as many places as it has players, and every teammate earns the average of those places' points (for example, in an 8-player 2-person event: 14.5, 10, 6, 2). Tied teams share their combined places.</li>
        </ul>
      </Section>
      <Section title="Five-event championship">
        <ul>
          <li>All 5 events count. No dropped scores. No-shows receive zero points.</li>
          <li>Points accumulate throughout the season. Highest cumulative points wins the championship.</li>
        </ul>
      </Section>
      <Section title="Tiebreakers">
        <ol>
          <li>Most 1st-place finishes</li>
          <li>Most 2nd-place finishes</li>
          <li>Most 3rd-place finishes</li>
          <li>Lowest cumulative net score</li>
          <li>Sudden-death playoff if necessary</li>
        </ol>
      </Section>
      <p className="tagline">Compete, earn points, improve your game, and fight for the JIMULATOR League Championship!</p>
    </article>
  );
}
