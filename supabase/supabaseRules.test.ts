// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { migratedDb } from './testDb';

let pg: PGlite;
beforeAll(async () => {
  pg = await migratedDb();
});
afterAll(() => pg.close());

/** UPDATE … SET … and DELETE FROM … statements whose own level (outside brackets) has no WHERE. */
export function unqualifiedWrites(source: string): string[] {
  const sql = source.replace(/--[^\n]*/g, '');
  const found: string[] = [];
  const start = /\b(update\s+[\w."]+\s+(?:\w+\s+)?set\b|delete\s+from\s+[\w."]+)/gi;
  for (let m = start.exec(sql); m; m = start.exec(sql)) {
    let depth = 0;
    let top = '';
    for (let i = m.index; i < sql.length; i++) {
      const c = sql[i];
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (c === ';' && depth === 0) break;
      if (depth === 0) top += c;
    }
    if (!/\bwhere\b/i.test(top)) found.push(top.replace(/\s+/g, ' ').trim());
  }
  return found;
}

describe('rules a real Supabase project enforces that PGlite does not', () => {
  it('finds a write without WHERE', () => {
    expect(unqualifiedWrites('update t set a = (select 1 from u where x); delete from t where true;')).toHaveLength(1);
  });

  // Supabase loads pg-safeupdate for API calls: an UPDATE or DELETE without WHERE fails ("UPDATE requires a WHERE clause").
  it('every function names the rows it updates or deletes', async () => {
    const { rows } = await pg.query<{ name: string; src: string }>(
      `select p.proname as name, p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
    );
    const offenders = rows.flatMap(({ name, src }) => unqualifiedWrites(src).map((statement) => `${name}: ${statement}`));
    expect(offenders).toEqual([]);
  });
});
