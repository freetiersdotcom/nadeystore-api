// → src/routes/modules.ts
//   GET /v1/modules        every module in this build with its on/off state (any signed-in person: the admin menu needs it)
//   PUT /v1/modules/:id    { enabled: boolean }   settings.manage
import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../db';
import { authMiddleware } from '../middleware/auth';
import { audit } from '../auth/service';
import { ApiError, type HonoEnv } from '../types';
import { MODULES, getModule, readState, setEnabled } from '../modules/registry';
import { isSuperRole } from '../auth/permissions';

const app = new Hono<HonoEnv>();
app.use('*', authMiddleware);

app.get('/', async (c) => {
  const db = getDb(c.var.db);
  const { enabled } = await readState(db);
  const role = c.get('auth').user?.role;
  return c.json({
    items: MODULES.map((m) => {
      const lvl = !role || isSuperRole(role) ? 'write' : (m.access as Record<string, string | undefined>)[role];
      return { id: m.id, name: m.name, description: m.description, version: m.version, enabled: enabled.includes(m.id), access: lvl ?? null };
    }),
  });
});

app.put('/:id', async (c) => {
  const m = getModule(c.req.param('id'));
  if (!m) throw ApiError.notFound('Unknown module');
  const body = z.object({ enabled: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!body.success) throw ApiError.invalidRequest('Body must be { "enabled": true | false }');
  const db = getDb(c.var.db);
  await setEnabled(db, m, body.data.enabled);
  const a = c.get('auth');
  await audit(db, { action: body.data.enabled ? 'module.enabled' : 'module.disabled', actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', target: m.id, ip: c.req.header('CF-Connecting-IP') ?? null });
  return c.json({ id: m.id, enabled: body.data.enabled });
});

export { app as moduleAdmin };
