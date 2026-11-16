import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Repo } from './data/repo';
import type { Snapshot } from './lib/types';

interface AppState {
  repo: Repo;
  snap: Snapshot;
  commissioner: boolean;
  email: string | null;
  reload: () => Promise<void>;
  /** Run a mutation, reload, and surface any rule error as a toast. Resolves true on success. */
  act: (fn: () => Promise<unknown>, success?: string) => Promise<boolean>;
  toast: (msg: string, kind?: 'ok' | 'error') => void;
}

const Ctx = createContext<AppState | null>(null);
export const useApp = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp outside provider');
  return c;
};

export function AppProvider({ repo, children }: { repo: Repo; children: ReactNode }) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [commissioner, setCommissioner] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const [toasts, setToasts] = useState<{ id: number; msg: string; kind: 'ok' | 'error' }[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const toast = useCallback((msg: string, kind: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3000);
  }, []);

  const reload = useCallback(async () => {
    try {
      const [s, c, u] = await Promise.all([repo.load(), repo.isCommissioner(), repo.currentUser()]);
      setSnap(s);
      setCommissioner(c);
      setEmail(u?.email ?? null);
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [repo]);

  useEffect(() => {
    void reload();
    const onFocus = () => void reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [reload]);

  const act = useCallback(
    async (fn: () => Promise<unknown>, success?: string) => {
      try {
        await fn();
        await reload();
        if (success) toast(success);
        return true;
      } catch (e) {
        toast((e as Error).message, 'error');
        await reload();
        return false;
      }
    },
    [reload, toast],
  );

  if (loadError && !snap) {
    return (
      <div className="boot">
        <p className="eyebrow">Couldn't reach the league database</p>
        <p>{loadError}</p>
        <button className="btn" onClick={() => void reload()}>Try again</button>
      </div>
    );
  }
  if (!snap) return <div className="boot"><p className="eyebrow">Warming up the simulator…</p></div>;

  return (
    <Ctx.Provider value={{ repo, snap, commissioner, email, reload, act, toast }}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>{t.msg}</div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

// --- tiny hash router -------------------------------------------------------
export function useRoute(): string[] {
  const parse = () => window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => {
      setRoute(parse());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export const go = (path: string) => {
  window.location.hash = path;
};
