-- Enable RLS on jobs (currently disabled; service role bypasses RLS regardless)
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "jobs_anon_read"
  ON jobs FOR SELECT TO anon USING (true);

ALTER TABLE instances ENABLE ROW LEVEL SECURITY;

CREATE POLICY "instances_anon_read"
  ON instances FOR SELECT TO anon USING (true);

ALTER TABLE ringba_calls ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ringba_calls_anon_read"
  ON ringba_calls FOR SELECT TO anon USING (true);

ALTER TABLE lp_leads ENABLE ROW LEVEL SECURITY;

CREATE POLICY "lp_leads_anon_read"
  ON lp_leads FOR SELECT TO anon USING (true);
