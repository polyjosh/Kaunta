// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { buildSeedSql } from './seedSql';

const path = new URL('./seed.sql', import.meta.url);

it('supabase/seed.sql matches the handoff seed (run `npm run seed:sql` to regenerate)', async () => {
  const sql = await buildSeedSql();
  if (import.meta.env.MODE === 'update-seed') writeFileSync(path, sql);
  expect(readFileSync(path, 'utf8')).toBe(sql);
  expect(sql).not.toMatch(/"demo_pin"|2580/); // PINs only as hashes
});
