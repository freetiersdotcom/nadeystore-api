// → src/routes/backup.ts
//   GET  /v1/backup                list the stored daily backups (private R2 bucket BACKUPS)
//   POST /v1/backup/run            write a backup to R2 now
//   GET  /v1/backup/download       download a fresh copy of everything (gzip NDJSON)
//   GET  /v1/backup/files/:name    download one stored backup
// Owner / agency only (settings.manage). Restoring is POST /v1/setup/restore, for a fresh deployment.
import { Hono } from 'hono';
import { getDb } from '../db';
import { authMiddleware, requirePermission } from '../middleware/auth';
import { audit } from '../auth/service';
import { ApiError, type HonoEnv } from '../types';
import { buildBackup, gzip, runBackup } from '../lib/backup';

const app = new Hono<HonoEnv>();
app.use('*', authMiddleware, requirePermission('settings.manage'));

const who = (c: any) => {
  const a = c.get('auth');
  return { actor_user_id: a.user?.id ?? null, actor: a.user?.email ?? 'api-key', ip: c.req.header('CF-Connecting-IP') ?? null };
};

app.get('/', async (c) => {
  const bucket = c.env.BACKUPS;
  if (!bucket) return c.json({ configured: false, backups: [] });
  const listed = await bucket.list({ prefix: 'backups/' });
  const backups = listed.objects
    .map((o) => ({ name: o.key.replace('backups/', ''), size: o.size, uploaded: o.uploaded.toISOString() }))
    .sort((a, b) => b.name.localeCompare(a.name));
  return c.json({ configured: true, backups });
});

app.post('/run', async (c) => {
  const db = getDb(c.var.db);
  const r = await runBackup(c.env, db);
  if (!r) throw ApiError.conflict('No BACKUPS bucket is bound to this Worker. Add the r2 binding, or use the download instead.');
  await audit(db, { action: 'backup.run', ...who(c), meta: { key: r.key, rows: r.rows } });
  return c.json({ ...r });
});

app.get('/download', async (c) => {
  const db = getDb(c.var.db);
  const { text, rows } = await buildBackup(db);
  await audit(db, { action: 'backup.download', ...who(c), meta: { rows } });
  const name = `backup-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.ndjson.gz`;
  // c.body (not a bare Response) so the CORS headers set earlier by the middleware are kept.
  return c.body(await gzip(text), 200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
});

app.get('/files/:name', async (c) => {
  const name = c.req.param('name');
  if (!/^\d{4}-\d{2}-\d{2}\.ndjson\.gz$/.test(name)) throw ApiError.notFound('Backup not found');
  const obj = await c.env.BACKUPS?.get(`backups/${name}`);
  if (!obj) throw ApiError.notFound('Backup not found');
  await audit(getDb(c.var.db), { action: 'backup.download', ...who(c), target: name });
  return c.body(await obj.arrayBuffer(), 200, { 'Content-Type': 'application/gzip', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store' });
});

export { app as backupRoutes };
