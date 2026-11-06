import type { Database } from '../../db';
import { now } from '../../types';
import { getEmailProvider } from '../../lib/email/index';
import { pushAdmins } from '../../lib/push';

export type Settings = { default_threshold: number; emails: string; push: number };
export type Row = { sku: string; product_title: string; variant_title: string; available: number; on_hand: number; reserved: number; threshold: number; muted: number; supplier_id: string | null; reorder_qty: number | null; level: 'ok' | 'low' | 'out'; alerted: boolean };
type Supplier = { id: string; name: string; phone: string | null; email: string | null };

const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export const parseEmails = (s: string): string[] => [...new Set(s.split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter((x) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(x)))].slice(0, 10);

export async function getSettings(db: Database): Promise<Settings> {
  const [s] = await db.query<Settings>(`SELECT default_threshold, emails, push FROM lowstock_settings WHERE id = 1`); return s;
}

/** Every physical, active variant with its stock level. Digital goods and services have no stock. */
export async function levels(db: Database, st?: Settings): Promise<Row[]> {
  const set = st ?? await getSettings(db);
  const rows = await db.query<Omit<Row, 'level' | 'alerted' | 'threshold'> & { threshold: number | null; state: string | null }>(
    `SELECT v.sku, p.title AS product_title, v.title AS variant_title, COALESCE(i.on_hand, 0) AS on_hand, COALESCE(i.reserved, 0) AS reserved,
            COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0) AS available, li.threshold, COALESCE(li.muted, 0) AS muted, li.supplier_id, li.reorder_qty, ls.level AS state
       FROM variants v JOIN products p ON p.id = v.product_id
       LEFT JOIN inventory i ON i.sku = v.sku LEFT JOIN lowstock_items li ON li.sku = v.sku LEFT JOIN lowstock_state ls ON ls.sku = v.sku
      WHERE v.status = 'active' AND p.status = 'active' AND COALESCE(v.product_type, 'physical') = 'physical'
      ORDER BY (COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0)), p.title`);
  return rows.map((r) => {
    const threshold = r.threshold ?? set.default_threshold;
    const level: Row['level'] = r.available <= 0 ? 'out' : r.available <= threshold ? 'low' : 'ok';
    return { ...r, threshold, level, alerted: !!r.state };
  });
}

const label = (r: Row) => `${r.product_title}${r.variant_title && r.variant_title !== 'Default' ? ' — ' + r.variant_title : ''}`;

export function reorderMessage(r: Row, supplier: Supplier | null, store: string, lang: 'fr' | 'en' = 'fr'): string {
  const qty = r.reorder_qty ?? Math.max(r.threshold * 3, 10);
  return lang === 'en'
    ? `Hello${supplier ? ' ' + supplier.name : ''}, this is ${store}. We would like to reorder ${qty} × ${label(r)}. Could you confirm availability and delivery time? Thank you.`
    : `Bonjour${supplier ? ' ' + supplier.name : ''}, ici ${store}. Nous souhaitons recommander ${qty} × ${label(r)}. Pouvez-vous confirmer la disponibilité et le délai ? Merci.`;
}

/**
 * Announce products that have just crossed their threshold. Idempotent: a product is announced once when it becomes low,
 * once more if it then runs out, and again only after it has been restocked above its threshold.
 */
export async function runCheck(db: Database, storeName = 'Your Store'): Promise<{ announced: number }> {
  const st = await getSettings(db);
  const rows = await levels(db, st);
  const fresh: Row[] = [];
  for (const r of rows) {
    if (r.level === 'ok' || r.muted) {
      if (r.alerted) await db.run(`DELETE FROM lowstock_state WHERE sku = ?`, [r.sku]);   // restocked (or muted): re-arm
      continue;
    }
    const [s] = await db.query<{ level: string }>(`SELECT level FROM lowstock_state WHERE sku = ?`, [r.sku]);
    if (!s || (s.level === 'low' && r.level === 'out')) fresh.push(r);
  }
  if (!fresh.length) return { announced: 0 };
  // Record first: if sending fails we do not retry forever and spam.
  for (const r of fresh) await db.run(`INSERT INTO lowstock_state (sku, level, alerted_at) VALUES (?, ?, ?) ON CONFLICT(sku) DO UPDATE SET level = excluded.level, alerted_at = excluded.alerted_at`, [r.sku, r.level, now()]);

  if (st.push) { try { await pushAdmins(db, { kind: 'stock', count: fresh.length, first: `${label(fresh[0])} (${Math.max(fresh[0].available, 0)})` }); } catch (e) { console.error('[lowstock] push failed', e); } }
  const to = parseEmails(st.emails);
  if (to.length) {
    try {
      const provider = await getEmailProvider(db);
      if (provider) {
        const suppliers = await db.query<Supplier>(`SELECT id, name, phone, email FROM lowstock_suppliers`);
        const sup = new Map(suppliers.map((s) => [s.id, s]));
        const mail = buildDigest(fresh, sup, storeName);
        for (const addr of to) await provider.send({ to: addr, subject: mail.subject, html: mail.html, text: mail.text });
      }
    } catch (e) { console.error('[lowstock] e-mail failed', e); }
  }
  return { announced: fresh.length };
}

export function buildDigest(rows: Row[], sup: Map<string, Supplier>, storeName: string) {
  const out = rows.filter((r) => r.level === 'out').length;
  const subject = out ? `${storeName} — ${out} rupture(s), ${rows.length - out} stock bas` : `${storeName} — ${rows.length} produit(s) en stock bas`;
  const line = (r: Row) => { const s = r.supplier_id ? sup.get(r.supplier_id) : undefined; return { r, s, who: s ? `${s.name}${s.phone ? ' · ' + s.phone : ''}${s.email ? ' · ' + s.email : ''}` : '' }; };
  const items = rows.map(line);
  const html = `<div style="font-family:system-ui,sans-serif;max-width:560px"><p>Stock bas / Low stock</p><table style="width:100%;border-collapse:collapse">${items.map(({ r, who }) => `<tr><td style="padding:6px 8px 6px 0"><b>${esc(label(r))}</b><br><span style="color:#777;font-size:12px">${esc(who)}</span></td><td style="text-align:right;white-space:nowrap;color:${r.level === 'out' ? '#b42318' : '#b54708'}"><b>${Math.max(r.available, 0)}</b> / ${r.threshold}${r.level === 'out' ? ' — rupture / out' : ''}</td></tr>`).join('')}</table></div>`;
  const text = items.map(({ r, who }) => `- ${label(r)}: ${Math.max(r.available, 0)} (seuil/threshold ${r.threshold})${r.level === 'out' ? ' RUPTURE/OUT' : ''}${who ? ' — ' + who : ''}`).join('\n');
  return { subject, html, text };
}
