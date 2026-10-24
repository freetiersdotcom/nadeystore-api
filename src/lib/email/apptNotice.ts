// src/lib/email/apptNotice.ts
// Wording for appointment emails (FR + EN). Self-contained, like planNotice.ts.
//   - formatWhen / calendarUrl : used by the order confirmation block (serviceNotice.ts) too
//   - renderApptEmail          : stand-alone emails (rescheduled, canceled, reminder)

export type ApptEmailKind = 'rescheduled' | 'canceled' | 'reminder';

function lang(locale?: string): 'fr' | 'en' {
  return (locale ?? 'fr').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'fr';
}
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fmt(startIso: string, tz: string, locale?: string): string {
  try {
    return new Intl.DateTimeFormat(lang(locale) === 'en' ? 'en-GB' : 'fr-FR', {
      timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit',
    }).format(new Date(startIso));
  } catch { return startIso; }
}

function tzLabel(tz: string): string { return tz.split('/').pop()!.replace(/_/g, ' '); }

/** "samedi 12 décembre 2026 à 10:00 (heure de Porto-Novo)" — adds the customer's own zone when it differs. */
export function formatWhen(startIso: string, shopTz: string, customerTz: string | null | undefined, locale?: string): string {
  const en = lang(locale) === 'en';
  const main = `${fmt(startIso, shopTz, locale)} (${en ? 'time in' : 'heure de'} ${tzLabel(shopTz)})`;
  if (customerTz && customerTz !== shopTz) {
    try {
      const same = new Date(startIso).toLocaleString('en-US', { timeZone: customerTz }) === new Date(startIso).toLocaleString('en-US', { timeZone: shopTz });
      if (!same) return `${main} — ${fmt(startIso, customerTz, locale)} (${en ? 'your time' : 'votre heure'}, ${tzLabel(customerTz)})`;
    } catch { /* ignore bad tz */ }
  }
  return main;
}

export function calendarUrl(title: string, startIso: string, endIso: string): string {
  const d = (s: string) => new Date(s).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + `&text=${encodeURIComponent(title)}&dates=${d(startIso)}/${d(endIso)}`;
}

export interface ApptEmailData {
  store_name: string; order_number: string; title: string;
  starts_at: string; ends_at: string; tz: string; customer_tz?: string | null; previous_start?: string;
}

const mail = {
  fr: {
    rescheduled: { subject: (n: string) => `Votre séance a été déplacée — ${n}`, h: 'Votre séance a été déplacée',
      p: (d: ApptEmailData, w: string, prev: string | null) => `Votre séance « ${esc(d.title)} » est maintenant fixée au <strong>${w}</strong>.${prev ? ` (Ancien horaire : ${prev}.)` : ''}` },
    canceled: { subject: (n: string) => `Séance annulée — ${n}`, h: 'Votre séance a été annulée',
      p: (d: ApptEmailData, w: string) => `Votre séance « ${esc(d.title)} » prévue le ${w} a été annulée. Nous vous contacterons pour convenir d'une nouvelle date.` },
    reminder: { subject: (n: string) => `Rappel : votre séance approche — ${n}`, h: 'Rappel de votre séance',
      p: (d: ApptEmailData, w: string) => `Nous vous rappelons votre séance « ${esc(d.title)} » le <strong>${w}</strong>.` },
    order: 'Commande', cal: 'Ajouter à mon agenda', bye: 'Cordialement',
  },
  en: {
    rescheduled: { subject: (n: string) => `Your session was moved — ${n}`, h: 'Your session was moved',
      p: (d: ApptEmailData, w: string, prev: string | null) => `Your session “${esc(d.title)}” is now set for <strong>${w}</strong>.${prev ? ` (Previously: ${prev}.)` : ''}` },
    canceled: { subject: (n: string) => `Session canceled — ${n}`, h: 'Your session was canceled',
      p: (d: ApptEmailData, w: string) => `Your session “${esc(d.title)}” on ${w} was canceled. We will contact you to agree on a new date.` },
    reminder: { subject: (n: string) => `Reminder: your session is coming up — ${n}`, h: 'Session reminder',
      p: (d: ApptEmailData, w: string) => `A reminder of your session “${esc(d.title)}” on <strong>${w}</strong>.` },
    order: 'Order', cal: 'Add to my calendar', bye: 'Best regards',
  },
} as const;

export function renderApptEmail(kind: ApptEmailKind, d: ApptEmailData, locale?: string): { subject: string; html: string; text: string } {
  const m = mail[lang(locale)];
  const k = m[kind];
  const when = formatWhen(d.starts_at, d.tz, d.customer_tz, locale);
  const prev = d.previous_start ? formatWhen(d.previous_start, d.tz, d.customer_tz, locale) : null;
  const body = k.p(d, when, prev);
  const showCal = kind !== 'canceled';
  const url = calendarUrl(d.title, d.starts_at, d.ends_at);
  const html = `<!doctype html><html><body style="margin:0;background:#f6f6f6;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="padding:24px 0;"><tr><td align="center">
    <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#fff;border-radius:8px;padding:32px;">
      <tr><td>
        <p style="margin:0 0 4px 0;font-size:13px;color:#888;">${esc(d.store_name)}</p>
        <h2 style="margin:0 0 12px 0;font-size:22px;color:#111;">${k.h}</h2>
        <p style="margin:0 0 6px 0;font-size:14px;color:#999;">${m.order} <strong style="color:#111;">${esc(d.order_number)}</strong></p>
        <p style="margin:16px 0;font-size:15px;color:#444;line-height:1.6;">${body}</p>
        ${showCal ? `<p style="margin:0 0 20px 0;"><a href="${esc(url)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;padding:11px 20px;border-radius:6px;">${m.cal}</a></p>` : ''}
        <p style="margin:24px 0 0 0;font-size:13px;color:#888;">${m.bye},<br>${esc(d.store_name)}</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  const text = [k.h, `${m.order} ${d.order_number}`, '', body.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'),
    showCal ? `\n${m.cal}: ${url}` : '', '', `${m.bye}, ${d.store_name}`].join('\n');
  return { subject: k.subject(d.order_number), html, text };
}
