// src/lib/email/planNotice.ts
// Wording for deposit / installment emails (FR + EN). Self-contained, like paymentNotice.ts.
//   - renderDepositBlock / depositTitle / depositText : used inside the order confirmation (template.ts)
//   - renderPlanEmail                                 : stand-alone emails (payment received, reminder, canceled)

function lang(locale?: string): 'fr' | 'en' {
  return (locale ?? 'fr').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'fr';
}

import { isZeroDecimal } from '../currency';

export function fmtMoney(cents: number, currency: string, locale?: string): string {
  const cur = (currency || 'XOF').toUpperCase();
  const zero = isZeroDecimal(cur);
  return new Intl.NumberFormat(lang(locale) === 'en' ? 'en-US' : 'fr-FR', {
    style: 'currency', currency: cur,
    minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2,
  }).format(zero ? cents : cents / 100);
}

export function fmtDate(iso: string | null | undefined, locale?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(lang(locale) === 'en' ? 'en-GB' : 'fr-FR', { dateStyle: 'long' }).format(d);
}

/** Customer-facing page where the balance is paid (the storefront pages /fr/paiement and /en/payment). */
export function payUrl(base: string, locale: string | null | undefined, token: string): string {
  const en = lang(locale ?? undefined) === 'en';
  return `${base.replace(/\/$/, '')}/${en ? 'en/payment' : 'fr/paiement'}/?token=${token}`;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ── Order confirmation (deposit orders) ─────────────────────────────────────

export interface PlanBlock {
  paid: string;            // formatted, e.g. "5 000 F CFA"
  balance: string;         // formatted
  due: string | null;      // formatted date
  pay_url: string | null;
}

const confirm = {
  fr: {
    heading: 'Acompte reçu ✓',
    title: 'Paiement en plusieurs fois',
    body: (p: PlanBlock) =>
      `Nous avons bien reçu votre acompte de <strong style="color:#111;">${p.paid}</strong>. Il reste <strong style="color:#111;">${p.balance}</strong> à régler${p.due ? ` avant le <strong style="color:#111;">${p.due}</strong>` : ''}. Vos articles sont réservés.`,
    link: 'Payer le solde en ligne',
    text: (p: PlanBlock) =>
      `Acompte reçu : ${p.paid}. Reste à payer : ${p.balance}${p.due ? ` avant le ${p.due}` : ''}. Vos articles sont réservés.${p.pay_url ? `\nPayer le solde : ${p.pay_url}` : ''}`,
  },
  en: {
    heading: 'Deposit received ✓',
    title: 'Payment in installments',
    body: (p: PlanBlock) =>
      `We received your deposit of <strong style="color:#111;">${p.paid}</strong>. <strong style="color:#111;">${p.balance}</strong> remains to be paid${p.due ? ` by <strong style="color:#111;">${p.due}</strong>` : ''}. Your items are reserved.`,
    link: 'Pay the balance online',
    text: (p: PlanBlock) =>
      `Deposit received: ${p.paid}. Remaining: ${p.balance}${p.due ? ` by ${p.due}` : ''}. Your items are reserved.${p.pay_url ? `\nPay the balance: ${p.pay_url}` : ''}`,
  },
} as const;

export function depositTitle(locale?: string): string {
  return confirm[lang(locale)].heading;
}

export function renderDepositBlock(p: PlanBlock, locale?: string): string {
  const c = confirm[lang(locale)];
  const button = p.pay_url
    ? `<p style="margin:14px 0 0 0;"><a href="${esc(p.pay_url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;padding:10px 18px;border-radius:6px;">${c.link}</a></p>`
    : '';
  return `
    <tr>
      <td style="padding: 0 0 32px 0;">
        <div style="background:#eef6ff;border:1px solid #b9d7f5;border-radius:6px;padding:16px 18px;">
          <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #111; text-transform: uppercase; letter-spacing: 0.05em;">${c.title}</h3>
          <p style="margin: 0; font-size: 14px; color: #555; line-height: 1.6;">${c.body(p)}</p>
          ${button}
        </div>
      </td>
    </tr>`;
}

export function depositText(p: PlanBlock, locale?: string): string {
  return confirm[lang(locale)].text(p);
}

// ── Stand-alone emails ───────────────────────────────────────────────────────

export type PlanEmailKind = 'payment' | 'paid' | 'reminder' | 'overdue' | 'canceled';

export interface PlanEmailData {
  store_name: string;
  order_number: string;
  received?: string;       // formatted amount just received
  total: string;
  paid: string;
  balance: string;
  due: string | null;      // formatted date
  pay_url: string | null;
}

const mail = {
  fr: {
    payment: { subject: (n: string) => `Paiement reçu — ${n}`, h: 'Paiement reçu ✓',
      p: (d: PlanEmailData) => `Nous avons bien reçu votre paiement de <strong>${d.received}</strong>. Il reste <strong>${d.balance}</strong> à régler${d.due ? ` avant le ${d.due}` : ''}.` },
    paid: { subject: (n: string) => `Commande entièrement réglée — ${n}`, h: 'Merci, votre commande est entièrement réglée ✓',
      p: (d: PlanEmailData) => `Nous avons bien reçu votre dernier paiement${d.received ? ` de <strong>${d.received}</strong>` : ''}. Le total de <strong>${d.total}</strong> est réglé.` },
    reminder: { subject: (n: string) => `Rappel : solde à régler — ${n}`, h: 'Rappel de paiement',
      p: (d: PlanEmailData) => `Il vous reste <strong>${d.balance}</strong> à régler sur votre commande${d.due ? ` avant le <strong>${d.due}</strong>` : ''}. Vos articles restent réservés d'ici là.` },
    overdue: { subject: (n: string) => `Solde en retard — ${n}`, h: 'Votre solde est en retard',
      p: (d: PlanEmailData) => `Le solde de <strong>${d.balance}</strong> de votre commande devait être réglé${d.due ? ` le ${d.due}` : ''}. Merci de le régler rapidement pour conserver votre réservation.` },
    canceled: { subject: (n: string) => `Commande annulée — ${n}`, h: 'Votre commande a été annulée',
      p: (d: PlanEmailData) => `Le solde de <strong>${d.balance}</strong> n'a pas été reçu dans le délai prévu${d.due ? ` (${d.due})` : ''}, votre commande a donc été annulée et vos articles remis en vente. Contactez-nous au sujet de votre acompte de ${d.paid}.` },
    order: 'Commande', paidLabel: 'Déjà payé', balLabel: 'Reste à payer', pay: 'Payer le solde en ligne', bye: 'Cordialement',
  },
  en: {
    payment: { subject: (n: string) => `Payment received — ${n}`, h: 'Payment received ✓',
      p: (d: PlanEmailData) => `We received your payment of <strong>${d.received}</strong>. <strong>${d.balance}</strong> remains to be paid${d.due ? ` by ${d.due}` : ''}.` },
    paid: { subject: (n: string) => `Order fully paid — ${n}`, h: 'Thank you, your order is fully paid ✓',
      p: (d: PlanEmailData) => `We received your final payment${d.received ? ` of <strong>${d.received}</strong>` : ''}. The total of <strong>${d.total}</strong> is settled.` },
    reminder: { subject: (n: string) => `Reminder: balance due — ${n}`, h: 'Payment reminder',
      p: (d: PlanEmailData) => `You still have <strong>${d.balance}</strong> to pay on your order${d.due ? ` by <strong>${d.due}</strong>` : ''}. Your items stay reserved until then.` },
    overdue: { subject: (n: string) => `Balance overdue — ${n}`, h: 'Your balance is overdue',
      p: (d: PlanEmailData) => `The balance of <strong>${d.balance}</strong> on your order was due${d.due ? ` on ${d.due}` : ''}. Please pay it soon to keep your reservation.` },
    canceled: { subject: (n: string) => `Order canceled — ${n}`, h: 'Your order has been canceled',
      p: (d: PlanEmailData) => `The balance of <strong>${d.balance}</strong> was not received in time${d.due ? ` (${d.due})` : ''}, so your order was canceled and the items released. Please contact us about your ${d.paid} deposit.` },
    order: 'Order', paidLabel: 'Already paid', balLabel: 'Remaining', pay: 'Pay the balance online', bye: 'Best regards',
  },
} as const;

export function renderPlanEmail(kind: PlanEmailKind, d: PlanEmailData, locale?: string): { subject: string; html: string; text: string } {
  const m = mail[lang(locale)];
  const k = m[kind];
  const showPay = !!d.pay_url && kind !== 'paid' && kind !== 'canceled';
  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 4px 0;font-size:13px;color:#888;">${esc(d.store_name)}</p>
        <h2 style="margin:0 0 12px 0;font-size:22px;color:#111;">${k.h}</h2>
        <p style="margin:0 0 6px 0;font-size:14px;color:#999;">${m.order} <strong style="color:#111;">${esc(d.order_number)}</strong></p>
        <p style="margin:16px 0;font-size:15px;color:#444;line-height:1.6;">${k.p(d)}</p>
        <table cellpadding="0" cellspacing="0" style="font-size:14px;color:#444;margin:8px 0 20px 0;">
          <tr><td style="padding:3px 24px 3px 0;">${m.paidLabel}</td><td><strong>${d.paid}</strong></td></tr>
          <tr><td style="padding:3px 24px 3px 0;">${m.balLabel}</td><td><strong>${d.balance}</strong></td></tr>
        </table>
        ${showPay ? `<p style="margin:0 0 20px 0;"><a href="${esc(d.pay_url!)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;padding:11px 20px;border-radius:6px;">${m.pay}</a></p>` : ''}
        <p style="margin:24px 0 0 0;font-size:13px;color:#888;">${m.bye},<br>${esc(d.store_name)}</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  const plain = k.p(d).replace(/<[^>]+>/g, '');
  const text = [
    k.h, `${m.order} ${d.order_number}`, '', plain, '',
    `${m.paidLabel}: ${d.paid}`, `${m.balLabel}: ${d.balance}`,
    showPay ? `\n${m.pay}: ${d.pay_url}` : '', '', `${m.bye}, ${d.store_name}`,
  ].join('\n');
  return { subject: k.subject(d.order_number), html, text };
}
