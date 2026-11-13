// Low-code alerts for voucher plans. A voucher is a digital product, so the core low-stock module (physical stock) never sees it;
// here "stock" is the number of unsold codes. One message when a plan crosses its threshold, one more if it runs out,
// and again only after you have loaded more. Reuses the same push notification and e-mail provider as the rest of the shop.
import type { Database } from '../../db';
import { now } from '../../types';
import { pushAdmins } from '../../lib/push';
import { getEmailProvider } from '../../lib/email/index';

export type AlertSettings = { default_threshold: number; emails: string; push: number };
export type PlanLevel = { sku: string; product_title: string | null; variant_title: string | null; available: number; waiting: number; threshold: number; muted: number; level: 'ok' | 'low' | 'out'; alerted: boolean };

export async function getAlertSettings(db: Database): Promise<AlertSettings> {
  const [s] = await db.query<AlertSettings>(`SELECT default_threshold, emails, push FROM voucher_alert_settings WHERE id = 1`);
  return s ?? { default_threshold: 10, emails: '', push: 1 };
}
export const parseEmails = (s: string) => [...new Set(s.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))];
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const label = (r: PlanLevel) => `${r.product_title ?? r.sku}${r.variant_title && r.variant_title !== 'Default' ? ' — ' + r.variant_title : ''}`;

export async function planLevels(db: Database, st?: AlertSettings): Promise<PlanLevel[]> {
  const set = st ?? (await getAlertSettings(db));
  const rows = await db.query<any>(
    `SELECT p.sku, pr.title AS product_title, v.title AS variant_title, l.threshold, COALESCE(l.muted, 0) AS muted, s.level AS state,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.sku = p.sku AND c.status = 'available') AS available,
            (SELECT COUNT(*) FROM voucher_codes c WHERE c.sku = p.sku) AS loaded,
            COALESCE((SELECT SUM(oi.qty - (SELECT COUNT(*) FROM voucher_codes c WHERE c.order_item_id = oi.id)) FROM order_items oi JOIN orders o ON o.id = oi.order_id
                       WHERE oi.sku = p.sku AND o.status NOT IN ('canceled', 'refunded') AND COALESCE(o.amount_paid_cents, 0) >= o.total_cents AND o.total_cents > 0), 0) AS waiting
       FROM voucher_plans p LEFT JOIN variants v ON v.sku = p.sku LEFT JOIN products pr ON pr.id = v.product_id
       LEFT JOIN voucher_low l ON l.sku = p.sku LEFT JOIN voucher_low_state s ON s.sku = p.sku ORDER BY pr.title, v.title`);
  return rows.map((r: any) => {
    const threshold = r.threshold ?? set.default_threshold; const available = Number(r.available); const waiting = Number(r.waiting);
    // A plan that never had a code is just being set up: no alarm until codes were loaded or a paid order is waiting.
    const setup = Number(r.loaded) === 0 && waiting === 0;
    const level: PlanLevel['level'] = setup ? 'ok' : available <= 0 ? 'out' : available <= threshold ? 'low' : 'ok';
    return { sku: r.sku, product_title: r.product_title, variant_title: r.variant_title, available, waiting, threshold, muted: Number(r.muted), level, alerted: !!r.state };
  });
}

function digest(rows: PlanLevel[], storeName: string) {
  const out = rows.filter((r) => r.level === 'out').length;
  const subject = out ? `${storeName} — vouchers : ${out} épuisé(s), ${rows.length - out} bientôt épuisé(s) / vouchers: ${out} out, ${rows.length - out} running low` : `${storeName} — vouchers bientôt épuisés / vouchers running low`;
  const line = (r: PlanLevel) => `${label(r)}: ${r.available} code(s) restants/left (seuil/threshold ${r.threshold})${r.level === 'out' ? ' ÉPUISÉ/OUT' : ''}${r.waiting ? ` — ${r.waiting} commande(s) payée(s) en attente / paid order(s) waiting` : ''}`;
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><p><b>Vouchers WiFi</b> — chargez de nouveaux codes / load more codes</p><ul>${rows.map((r) => `<li>${esc(line(r))}</li>`).join('')}</ul></div>`;
  return { subject, html, text: rows.map((r) => `- ${line(r)}`).join('\n') };
}

/** Announce plans that have just crossed their threshold. Idempotent. */
export async function runVoucherCheck(db: Database, storeName = 'Your Store'): Promise<{ announced: number }> {
  const st = await getAlertSettings(db); const rows = await planLevels(db, st); const fresh: PlanLevel[] = [];
  for (const r of rows) {
    if (r.level === 'ok' || r.muted) { if (r.alerted) await db.run(`DELETE FROM voucher_low_state WHERE sku = ?`, [r.sku]); continue; }   // restocked (or muted): re-arm
    const [s] = await db.query<{ level: string }>(`SELECT level FROM voucher_low_state WHERE sku = ?`, [r.sku]);
    if (!s || (s.level === 'low' && r.level === 'out')) fresh.push(r);
  }
  if (!fresh.length) return { announced: 0 };
  for (const r of fresh) await db.run(`INSERT INTO voucher_low_state (sku, level, alerted_at) VALUES (?, ?, ?) ON CONFLICT(sku) DO UPDATE SET level = excluded.level, alerted_at = excluded.alerted_at`, [r.sku, r.level, now()]);
  if (st.push) { try { await pushAdmins(db, { kind: 'stock', count: fresh.length, first: `${label(fresh[0])} (${fresh[0].available})` }); } catch (e) { console.error('[vouchers] push failed', e); } }
  const to = parseEmails(st.emails);
  if (to.length) {
    try {
      const provider = await getEmailProvider(db);
      if (provider) { const m = digest(fresh, storeName); for (const addr of to) await provider.send({ to: addr, subject: m.subject, html: m.html, text: m.text }); }
    } catch (e) { console.error('[vouchers] e-mail failed', e); }
  }
  return { announced: fresh.length };
}
