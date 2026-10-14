// src/lib/email/serviceNotice.ts
// Confirmation-email block for orders that contain a service (coaching,
// consultation…). Self-contained on purpose: it has its own two-language
// dictionary so it does not depend on the keys in i18n.ts.
//
// Wire-up in template.ts (3 small edits, see README):
//   import { renderServiceBlock, serviceBadge, serviceText } from './serviceNotice';
//   product_type: 'physical' | 'digital' | 'service';          // TemplateOrderItem
//   ${hasService ? renderServiceBlock(data.items, data.locale) : ''}   // after the downloads block

type Item = { title: string; product_type: string };

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

export function renderServiceBlock(items: Item[], locale?: string): string {
  const services = items.filter((i) => i.product_type === 'service');
  if (services.length === 0) return '';
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

export function serviceText(items: Item[], locale?: string): string {
  return items.some((i) => i.product_type === 'service') ? copy[lang(locale)].text : '';
}
