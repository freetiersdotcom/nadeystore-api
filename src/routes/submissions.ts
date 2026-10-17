// → src/routes/submissions.ts
// Contact form / lead messages.
//   POST   /v1/submissions        public (pk_ or sk_ key) — spam-protected
//   GET    /v1/submissions        admin — list (?status=new|handled)
//   GET    /v1/submissions/count  admin — number of unread ("new") messages
//   PATCH  /v1/submissions/:id    admin — set status / note
//   DELETE /v1/submissions/:id    admin
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { getEmailProvider } from '../lib/email/index';
import { verifyTurnstile } from '../lib/turnstile';

const app = new OpenAPIHono<HonoEnv>();
app.use('*', authMiddleware);

// ── Schemas ────────────────────────────────────────────────────────────────
const Form = z.enum(['contact', 'lead', 'service_request']);

const CreateBody = z.object({
  form: Form.default('contact'),
  name: z.string().trim().max(120).optional(),
  email: z.string().trim().email().max(200).optional().or(z.literal('')),
  phone: z.string().trim().max(40).optional(),
  subject: z.string().trim().max(200).optional(),
  message: z.string().trim().min(2).max(4000),
  locale: z.enum(['fr', 'en']).optional(),
  page: z.string().max(300).optional(),
  // UTM / click ids captured by the frontstore (window.snAttribution())
  source: z.record(z.string(), z.string().max(300)).optional(),
  // Spam protection
  website: z.string().optional(), // honeypot: real visitors leave it empty
  turnstile_token: z.string().max(4096).optional(),
});

const SubmissionResponse = z.object({
  id: z.string(),
  form: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  subject: z.string().nullable(),
  message: z.string(),
  locale: z.string().nullable(),
  page: z.string().nullable(),
  source: z.record(z.string(), z.string()).nullable(),
  status: z.enum(['new', 'handled']),
  note: z.string().nullable(),
  created_at: z.string(),
  handled_at: z.string().nullable(),
});

const IdParam = z.object({ id: z.string() });

function format(row: any) {
  let source: Record<string, string> | null = null;
  try {
    source = row.source ? JSON.parse(row.source) : null;
  } catch {
    source = null;
  }
  return {
    id: row.id,
    form: row.form,
    name: row.name ?? null,
    email: row.email ?? null,
    phone: row.phone ?? null,
    subject: row.subject ?? null,
    message: row.message,
    locale: row.locale ?? null,
    page: row.page ?? null,
    source,
    status: row.status,
    note: row.note ?? null,
    created_at: row.created_at,
    handled_at: row.handled_at ?? null,
  };
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!);

// ── POST / (public) ────────────────────────────────────────────────────────
const createSubmission = createRoute({
  method: 'post',
  path: '/',
  tags: ['Submissions'],
  summary: 'Send a contact / lead message',
  request: { body: { content: { 'application/json': { schema: CreateBody } } } },
  responses: {
    201: {
      content: { 'application/json': { schema: z.object({ ok: z.literal(true) }) } },
      description: 'Received',
    },
  },
});

const MAX_PER_IP_PER_HOUR = 5;

app.openapi(createSubmission, async (c) => {
  const body = c.req.valid('json');

  // 1. Honeypot — pretend success so bots learn nothing, store nothing.
  if (body.website && body.website.trim() !== '') return c.json({ ok: true as const }, 201);

  // 2. Need a way to answer.
  if (!body.email && !body.phone) {
    throw ApiError.invalidRequest('Please provide an email address or a phone/WhatsApp number.');
  }

  const ip = c.req.header('CF-Connecting-IP') || '';

  // 3. Turnstile (skipped when TURNSTILE_SECRET is not configured).
  const secret = (c.env as any).TURNSTILE_SECRET as string | undefined;
  if (secret) {
    const ok = await verifyTurnstile(secret, body.turnstile_token, ip);
    if (!ok) throw new ApiError('captcha_failed', 400, 'Spam check failed. Please try again.');
  }

  const db = getDb(c.var.db);

  // 4. Per-visitor limit, kept in the database (the in-memory limiter is shared by
  //    every visitor through the public key and resets per Worker instance).
  const ipHash = ip ? await sha256Hex(`${ip}|${c.env.STORE_NAME ?? ''}`) : null;
  if (ipHash) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const [{ n } = { n: 0 }] = await db.query<{ n: number }>(
      `SELECT COUNT(*) AS n FROM submissions WHERE ip_hash = ? AND created_at > ?`,
      [ipHash, since]
    );
    if (n >= MAX_PER_IP_PER_HOUR) {
      throw new ApiError('rate_limit_exceeded', 429, 'Too many messages. Please try again later.');
    }
  }

  const id = uuid();
  const createdAt = now();
  await db.run(
    `INSERT INTO submissions
       (id, form, name, email, phone, subject, message, locale, page, source, status, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?)`,
    [
      id,
      body.form,
      body.name || null,
      body.email || null,
      body.phone || null,
      body.subject || null,
      body.message,
      body.locale ?? null,
      body.page ?? null,
      body.source && Object.keys(body.source).length ? JSON.stringify(body.source) : null,
      ipHash,
      createdAt,
    ]
  );

  // 5. Optional email notification — never blocks or fails the request.
  c.executionCtx.waitUntil(notify(c.env, db, { id, ...body }).catch((e) => console.error('[submissions] notify failed', e)));

  return c.json({ ok: true as const }, 201);
});

async function notify(env: HonoEnv['Bindings'], db: ReturnType<typeof getDb>, s: z.infer<typeof CreateBody> & { id: string }) {
  let to = (env as any).CONTACT_NOTIFY_EMAIL as string | undefined;
  if (!to) {
    const [row] = await db.query<{ value: string }>(`SELECT value FROM config WHERE key = 'contact' LIMIT 1`);
    try {
      to = row ? (JSON.parse(row.value).notify_email as string | undefined) : undefined;
    } catch {
      to = undefined;
    }
  }
  if (!to) return; // admin-only mode

  const provider = await getEmailProvider(db);
  if (!provider) return;

  const store = env.STORE_NAME ?? 'Boutique';
  const who = s.name || s.email || s.phone || '—';
  const lines = [
    ['Nom', s.name], ['E-mail', s.email], ['Téléphone / WhatsApp', s.phone],
    ['Sujet', s.subject], ['Langue', s.locale], ['Page', s.page],
  ].filter(([, v]) => v) as [string, string][];
  const src = s.source ? Object.entries(s.source).map(([k, v]) => `${k}=${v}`).join(' · ') : '';

  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px">
    <h2 style="margin:0 0 12px">Nouveau message — ${esc(store)}</h2>
    <table style="border-collapse:collapse;margin-bottom:12px">
      ${lines.map(([k, v]) => `<tr><td style="padding:2px 12px 2px 0;color:#666">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}
    </table>
    <div style="white-space:pre-wrap;border-left:3px solid #0F6B4B;padding:4px 12px">${esc(s.message)}</div>
    ${src ? `<p style="color:#888;font-size:12px;margin-top:12px">Source : ${esc(src)}</p>` : ''}
    <p style="color:#888;font-size:12px">Répondez directement à cet e-mail, ou ouvrez « Messages » dans l'administration.</p>
  </div>`;
  const text = `${lines.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\n${s.message}${src ? `\n\nSource: ${src}` : ''}`;

  await provider.send({
    to,
    subject: `Nouveau message de ${who}${s.subject ? ` — ${s.subject}` : ''}`,
    html,
    text,
    reply_to: s.email || undefined,
  });
}

// ── GET /count (admin) ─────────────────────────────────────────────────────
const countRoute = createRoute({
  method: 'get',
  path: '/count',
  tags: ['Submissions'],
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  responses: {
    200: { content: { 'application/json': { schema: z.object({ new: z.number() }) } }, description: 'Unread count' },
  },
});
app.openapi(countRoute, async (c) => {
  const db = getDb(c.var.db);
  const [row] = await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM submissions WHERE status = 'new'`);
  return c.json({ new: row?.n ?? 0 }, 200);
});

// ── GET / (admin) ──────────────────────────────────────────────────────────
const listRoute = createRoute({
  method: 'get',
  path: '/',
  tags: ['Submissions'],
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    query: z.object({
      status: z.enum(['new', 'handled']).optional(),
      limit: z.string().optional(),
      cursor: z.string().optional(),
    }),
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ items: z.array(SubmissionResponse), has_more: z.boolean(), next_cursor: z.string().nullable() }),
        },
      },
      description: 'Messages, newest first',
    },
  },
});
app.openapi(listRoute, async (c) => {
  const { status, limit: limitStr, cursor } = c.req.valid('query');
  const limit = Math.min(parseInt(limitStr || '50'), 100);
  const db = getDb(c.var.db);

  let sql = `SELECT * FROM submissions WHERE 1=1`;
  const params: unknown[] = [];
  if (status) { sql += ` AND status = ?`; params.push(status); }
  if (cursor) { sql += ` AND created_at < ?`; params.push(cursor); }
  sql += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit + 1);

  const rows = await db.query<any>(sql, params);
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  return c.json(
    { items: rows.map(format), has_more: hasMore, next_cursor: hasMore ? rows[rows.length - 1].created_at : null },
    200
  );
});

// ── PATCH /:id (admin) ─────────────────────────────────────────────────────
const patchRoute = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Submissions'],
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: IdParam,
    body: {
      content: {
        'application/json': {
          schema: z.object({ status: z.enum(['new', 'handled']).optional(), note: z.string().max(2000).nullable().optional() }),
        },
      },
    },
  },
  responses: {
    200: { content: { 'application/json': { schema: SubmissionResponse } }, description: 'Updated' },
  },
});
app.openapi(patchRoute, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);

  const [existing] = await db.query<any>(`SELECT * FROM submissions WHERE id = ?`, [id]);
  if (!existing) throw ApiError.notFound('Message not found');

  const sets: string[] = [];
  const params: unknown[] = [];
  if (body.status) {
    sets.push('status = ?');
    params.push(body.status);
    sets.push('handled_at = ?');
    params.push(body.status === 'handled' ? now() : null);
  }
  if (body.note !== undefined) {
    sets.push('note = ?');
    params.push(body.note);
  }
  if (sets.length) await db.run(`UPDATE submissions SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);

  const [row] = await db.query<any>(`SELECT * FROM submissions WHERE id = ?`, [id]);
  return c.json(format(row), 200);
});

// ── DELETE /:id (admin) ────────────────────────────────────────────────────
const deleteRoute = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Submissions'],
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: IdParam },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ deleted: z.literal(true) }) } }, description: 'Deleted' },
  },
});
app.openapi(deleteRoute, async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb(c.var.db);
  const res = await db.run(`DELETE FROM submissions WHERE id = ?`, [id]);
  if (!res.changes) throw ApiError.notFound('Message not found');
  return c.json({ deleted: true as const }, 200);
});

export { app as submissions };
