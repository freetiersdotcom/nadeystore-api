import type { Database } from '../db';
import type { ModuleDef } from './types';
import { registerModuleAccess } from '../auth/permissions';
import { quotes } from './quotes';

/** Every module that exists in this build. Add yours here. */
export const MODULES: ModuleDef[] = [quotes];
for (const m of MODULES) registerModuleAccess(m.id, m.access);

export const getModule = (id: string) => MODULES.find((m) => m.id === id);

type State = { enabled: string[]; versions: Record<string, number> };

export async function readState(db: Database): Promise<State> {
  const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'modules'`);
  try {
    const v = row?.value ? JSON.parse(row.value) : {};
    return { enabled: Array.isArray(v.enabled) ? v.enabled.filter((x: unknown) => typeof x === 'string') : [], versions: v.versions && typeof v.versions === 'object' ? v.versions : {} };
  } catch { return { enabled: [], versions: {} }; }
}

async function writeState(db: Database, s: State) {
  await db.run(`INSERT INTO config (key, value) VALUES ('modules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, [JSON.stringify(s)]);
}

/** Run the module's migrations if its stored version is behind. Safe to call on every request. */
export async function ensureInstalled(db: Database, m: ModuleDef, state?: State): Promise<void> {
  const s = state ?? await readState(db);
  if ((s.versions[m.id] ?? 0) >= m.version) return;
  for (const sql of m.migrate) await db.run(sql);
  s.versions[m.id] = m.version;
  await writeState(db, s);
}

export async function isEnabled(db: Database, id: string): Promise<boolean> {
  return (await readState(db)).enabled.includes(id);
}

/** Switch a module on (creating its tables) or off (data is kept, routes close). */
export async function setEnabled(db: Database, m: ModuleDef, enabled: boolean): Promise<void> {
  const s = await readState(db);
  const on = new Set(s.enabled);
  if (enabled) { on.add(m.id); await ensureInstalled(db, m, s); } else on.delete(m.id);
  s.enabled = [...on].sort();
  await writeState(db, s);
}
