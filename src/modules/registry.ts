import type { Database } from '../db';
import type { ModuleDef, ScheduledCtx } from './types';
import { registerModuleAccess } from '../auth/permissions';
import { quotes } from './quotes';
import { affiliates } from './affiliates';
import { vouchers } from './vouchers';
import { recovery } from './recovery';
import { lowstock } from './lowstock';
import { ads } from './ads';
import { subs } from './subs';
import { milestones } from './milestones';

/** Every module that exists in this build. Add yours here. */
export const MODULES: ModuleDef[] = [quotes, affiliates, vouchers, recovery, lowstock, ads, subs, milestones];
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

/** Tell the enabled modules that an order was just created or paid. Never throws, never blocks a payment for long. */
export async function runOrderPaidHooks(db: Database): Promise<void> {
  try {
    const s = await readState(db);
    for (const id of s.enabled) {
      const m = getModule(id);
      if (!m?.hooks?.orderPaid) continue;
      try { await ensureInstalled(db, m, s); await m.hooks.orderPaid(db); } catch (e) { console.error(`[modules] ${id} orderPaid hook failed`, e); }
    }
  } catch (e) { console.error('[modules] hooks failed', e); }
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

/** The 15-minute cron: lets enabled modules do their periodic work (runs before expired carts are cleaned up). Never throws. */
export async function runScheduledHooks(db: Database, ctx: ScheduledCtx): Promise<void> {
  try {
    const s = await readState(db);
    for (const id of s.enabled) {
      const m = getModule(id); if (!m?.hooks?.scheduled) continue;
      try { await ensureInstalled(db, m, s); await m.hooks.scheduled(db, ctx); } catch (e) { console.error(`[modules] ${id} scheduled hook failed`, e); }
    }
  } catch (e) { console.error('[modules] scheduled hooks failed', e); }
}
