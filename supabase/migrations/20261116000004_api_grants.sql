-- Table and function access for the website.
-- Newer Supabase projects don't automatically grant the website's roles (anon =
-- the public, authenticated = signed-in users) access to new tables. Row level
-- security still decides which rows each role can see or change: the public can
-- only read, scores stay private until published, and only the commissioner can write.

grant usage on schema public to anon, authenticated;

grant select on public.league_settings, public.players, public.events, public.points_tables,
  public.event_sessions, public.session_assignments, public.round_scores, public.event_results
  to anon, authenticated;

grant select on public.commissioners to authenticated;

grant insert, update, delete on public.league_settings, public.players, public.events,
  public.event_sessions, public.session_assignments, public.round_scores
  to authenticated;

grant execute on function public.is_commissioner(), public.session_starts_at(public.event_sessions),
  public.nine_hole_course_handicap(numeric, int, numeric, int), public.handicap_strokes(numeric, int, numeric, int)
  to anon, authenticated;
