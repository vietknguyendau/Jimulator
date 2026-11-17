import type { ReactNode } from 'react';
import { useApp } from './app';
import type { EventPhase } from './lib/eventPhase';
import { formatPoints, ordinal } from './lib/leaderboard';
import { formatSessionDate, formatStartTime } from './lib/time';
import type { EventSession, LeagueEvent, Snapshot } from './lib/types';

export function Layout({ route, children }: { route: string[]; children: ReactNode }) {
  const { snap, repo } = useApp();
  const here = route[0] ?? '';
  const link = (to: string, label: string) => (
    <a href={`#/${to}`} className={here === to ? 'active' : ''} aria-current={here === to ? 'page' : undefined}>
      {label}
    </a>
  );
  return (
    <>
      <header className="site-header">
        <a href="#/" className="wordmark" aria-label="JIMULATOR home">
          <img src="/logo-badge.png" alt="" width="40" height="40" className="wm-badge" />
          <span><span className="wm-jim">JIM</span><span className="wm-ulator">ULATOR</span></span>
        </a>
        <nav>
          {link('', 'Home')}
          {link('schedule', 'Schedule')}
          {link('rules', 'Rules')}
          {link('admin', 'Commissioner')}
        </nav>
      </header>
      {repo.mode === 'demo' && (
        <div className="demo-bar">
          Demo league — data lives in this browser. Connect Supabase to go live (see README).
        </div>
      )}
      <main>{children}</main>
      <footer className="site-footer">
        <span>{snap.settings.league_name}</span>
        <span>Season {snap.settings.season_year} · Five events. One champion.</span>
      </footer>
    </>
  );
}

export function PhaseBadge({ phase }: { phase: EventPhase }) {
  return <span className={`badge badge-${phase.kind}`}>{phase.label}</span>;
}

export function SessionLine({ s }: { s: EventSession }) {
  return (
    <span className="session-line">
      <strong>Day {s.session_number}</strong> {formatSessionDate(s.session_date)} · {formatStartTime(s.start_time)}
      {s.status === 'resolved' && <span className="tick" aria-label="complete"> ✓</span>}
    </span>
  );
}

export function eventSessions(snap: Snapshot, e: LeagueEvent) {
  return snap.sessions.filter((s) => s.event_id === e.id).sort((a, b) => a.session_number - b.session_number);
}

export const playerName = (snap: Snapshot, id: string) => snap.players.find((p) => p.id === id)?.name ?? 'Unknown';

export const pos = (p: number | null, tied: boolean) => (p == null ? '—' : `${tied ? 'T' : ''}${ordinal(p)}`);
export const pts = formatPoints;

export function Section({ title, kicker, children, actions }: { title: string; kicker?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <div>
          {kicker && <p className="eyebrow">{kicker}</p>}
          <h2>{title}</h2>
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
