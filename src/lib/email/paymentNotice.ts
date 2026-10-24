// src/lib/email/paymentNotice.ts
// Confirmation-email wording for orders paid on delivery / in person (COD).
// Self-contained (own FR/EN dictionary), same pattern as serviceNotice.ts.
//
// Wire-up in template.ts (see README):
//   import { codTitle, renderCodBlock, codText } from './paymentNotice';
//   payment_method?: 'online' | 'cod';                       // OrderConfirmationData

function lang(locale?: string): 'fr' | 'en' {
  return (locale ?? 'fr').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'fr';
}

const copy = {
  fr: {
    heading: 'Commande reçue ✓',
    title: 'Paiement à la livraison',
    body: (amount: string) =>
      `Vous réglerez <strong style="color:#111;">${amount}</strong> directement à la réception de votre commande (espèces ou selon les modalités convenues avec notre équipe). Nous vous contacterons pour organiser la livraison.`,
    text: (amount: string) =>
      `Paiement à la livraison : vous réglerez ${amount} à la réception de votre commande. Nous vous contacterons pour organiser la livraison.`,
  },
  en: {
    heading: 'Order received ✓',
    title: 'Payment on delivery',
    body: (amount: string) =>
      `You will pay <strong style="color:#111;">${amount}</strong> when your order is delivered (cash, or as agreed with our team). We will contact you to arrange delivery.`,
    text: (amount: string) =>
      `Payment on delivery: you will pay ${amount} when your order is delivered. We will contact you to arrange delivery.`,
  },
} as const;

/** Replaces the "Order confirmed ✓" heading for COD orders. */
export function codTitle(locale?: string): string {
  return copy[lang(locale)].heading;
}

/** `amount` is already formatted (e.g. "12 500 FCFA"). */
export function renderCodBlock(amount: string, locale?: string): string {
  const c = copy[lang(locale)];
  return `
    <tr>
      <td style="padding: 0 0 32px 0;">
        <div style="background:#fff8e6;border:1px solid #f1d98a;border-radius:6px;padding:16px 18px;">
          <h3 style="margin: 0 0 8px 0; font-size: 14px; font-weight: 600; color: #111; text-transform: uppercase; letter-spacing: 0.05em;">${c.title}</h3>
          <p style="margin: 0; font-size: 14px; color: #555; line-height: 1.6;">${c.body(amount)}</p>
        </div>
      </td>
    </tr>`;
}

export function codText(amount: string, locale?: string): string {
  return copy[lang(locale)].text(amount);
}
