// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildSeedSql } from './seedSql';

const path = new URL('./seed.sql', import.meta.url);

it('supabase/seed.sql matches the handoff seed (run `npm run seed:sql` to regenerate)', async () => {
  const sql = await buildSeedSql();
  if (import.meta.env.MODE === 'update-seed') writeFileSync(path, sql);
  // Git on Windows (core.autocrlf) may check the file out with CRLF line endings.
  expect(readFileSync(path, 'utf8').replace(/\r\n/g, '\n')).toBe(sql);
  expect(sql).not.toMatch(/"demo_pin"/);
  // A PIN's digits only in pin_code (admins read it; counter phones get the hash).
  expect(sql.match(/2580/g)).toHaveLength(1);
});
