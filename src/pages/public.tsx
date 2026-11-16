import { useApp } from '../app';
import { eventSessions, PhaseBadge, playerName, pos, pts, Section, SessionLine } from '../components';
import { eventPhase } from '../lib/eventPhase';
import { seasonStandings } from '../lib/standings';
import { leagueToday } from '../lib/time';
import type { LeagueEvent } from '../lib/types';

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
    </div>
  );
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
                <p className="eyebrow">Event {e.event_number}</p>
                <h2>{e.name}</h2>
              </div>
              <PhaseBadge phase={eventPhase(e, snap.sessions)} />
            </div>
            <div className="sched-sessions">
              {ss.length === 0 && <p className="muted">Dates to be announced.</p>}
              {ss.map((s) => {
                const group = snap.assignments.filter((a) => a.session_id === s.id);
                return (
                  <div key={s.id} className="sched-session">
                    <SessionLine s={s} />
                    <p className="muted small">{group.length ? group.map((a) => playerName(snap, a.player_id)).join(', ') : 'Group not set'}</p>
                  </div>
                );
              })}
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
        <p className="eyebrow">Event {e.event_number} of 5</p>
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

      {phase.kind === 'official' && (
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
          {ss.map((s) => {
            const group = snap.assignments.filter((a) => a.session_id === s.id);
            return (
              <div key={s.id} className="group">
                <SessionLine s={s} />
                <ul>
                  {group.map((a) => (
                    <li key={a.id}>
                      <span>{playerName(snap, a.player_id)}</span>
                      {a.strokes != null && <span className="muted small">{a.strokes} strokes</span>}
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
