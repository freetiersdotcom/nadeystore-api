// src/lib/email/serviceNotice.ts
// Confirmation-email block for orders that contain a service (coaching,
// consultation…). Self-contained on purpose: it has its own two-language
// dictionary so it does not depend on the keys in i18n.ts.
//
// Wire-up in template.ts (3 small edits, see README):
//   import { renderServiceBlock, serviceBadge, serviceText } from './serviceNotice';
//   product_type: 'physical' | 'digital' | 'service';          // TemplateOrderItem
//   ${hasService ? renderServiceBlock(data.items, data.locale) : ''}   // after the downloads block

import { formatWhen, calendarUrl } from './apptNotice';

type Item = { title: string; product_type: string };
type Appt = { title: string; starts_at: string; ends_at: string; tz: string; customer_tz?: string | null };

const copy = {
  fr: {
    badge: 'Prestation',
    title: 'Votre prestation',
    body: 'Nous vous contacterons rapidement pour convenir ensemble de la date et des modalités de votre séance. Une question en attendant ? Répondez simplement à cet e-mail ou contactez-nous.',
    text: 'Votre prestation : nous vous contacterons rapidement pour convenir de la date et des modalités.',
  },
  en: {
    badge: 'Service',
    title: 'Your service',
    body: 'We will contact you shortly to agree on the date and arrangements for your session. A question in the meantime? Simply reply to this email or get in touch.',
    text: 'Your service: we will contact you shortly to agree on the date and arrangements.',
  },
} as const;

function lang(locale?: string): 'fr' | 'en' {
  return (locale ?? 'fr').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'fr';
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function serviceBadge(locale?: string): string {
  return copy[lang(locale)].badge;
}

const booked = {
  fr: { title: 'Votre rendez-vous', body: 'Votre séance est confirmée. Un rappel vous sera envoyé avant la date.', cal: 'Ajouter à mon agenda' },
  en: { title: 'Your appointment', body: 'Your session is confirmed. We will send you a reminder beforehand.', cal: 'Add to my calendar' },
} as const;

export function renderServiceBlock(items: Item[], locale?: string, appts?: Appt[]): string {
  const services = items.filter((i) => i.product_type === 'service');
  if (services.length === 0) return '';
  if (appts && appts.length > 0) {
    const b = booked[lang(locale)];
    const rows = appts.map((a) => `<li style="margin: 0 0 8px 0;"><strong>${esc(a.title)}</strong><br>${esc(formatWhen(a.starts_at, a.tz, a.customer_tz, locale))}<br>
      <a href="${esc(calendarUrl(a.title, a.starts_at, a.ends_at))}" style="color:#111;font-size:13px;">${b.cal}</a></li>`).join('');
    return `
    <tr>
      <td style="padding: 0 0 32px 0;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #111; text-transform: uppercase; letter-spacing: 0.05em;">
          ${b.title}
        </h3>
        <ul style="margin: 0 0 12px 0; padding-left: 18px; font-size: 14px; color: #111;">${rows}</ul>
        <p style="margin: 0; font-size: 14px; color: #666;">${b.body}</p>
      </td>
    </tr>`;
  }
  const c = copy[lang(locale)];
  const list = services.map((i) => `<li style="margin: 0 0 4px 0;">${esc(i.title)}</li>`).join('');
  return `
    <tr>
      <td style="padding: 0 0 32px 0;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #111; text-transform: uppercase; letter-spacing: 0.05em;">
          ${c.title}
        </h3>
        <ul style="margin: 0 0 12px 0; padding-left: 18px; font-size: 14px; color: #111;">${list}</ul>
        <p style="margin: 0; font-size: 14px; color: #666;">${c.body}</p>
      </td>
    </tr>`;
}

export function serviceText(items: Item[], locale?: string, appts?: Appt[]): string {
  if (appts && appts.length > 0) {
    return appts.map((a) => `${a.title}: ${formatWhen(a.starts_at, a.tz, a.customer_tz, locale)}`).join('\n');
  }
  return items.some((i) => i.product_type === 'service') ? copy[lang(locale)].text : '';
}
