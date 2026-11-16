import { buildDemoSnapshot } from './demoSeed';
import { browserKV, LocalRepo } from './localRepo';
import type { Repo } from './repo';
import { SupabaseRepo } from './supabaseRepo';

/** Supabase when configured (production); otherwise the in-browser demo league. */
export async function createRepo(): Promise<Repo> {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (url && key) return new SupabaseRepo(url, key);
  const seed = await buildDemoSnapshot();
  return new LocalRepo(browserKV(), () => seed);
}
