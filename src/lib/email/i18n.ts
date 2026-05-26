// ============================================================
// src/lib/email/i18n.ts
//
// Translation dictionary for order confirmation emails.
// Locale is passed explicitly from createOrderFromCart()
// via OrderConfirmationData.locale (e.g. 'fr-FR', 'en-US').
//
// We normalize to a two-character base locale for key lookup:
//   'fr-FR' → 'fr'
//   'en-US' → 'en'
//   'fr'    → 'fr'   (already short)
//
// Usage inside template.ts:
//   import { et } from './i18n';
//   et('section.downloads', data.locale)  // → 'Vos téléchargements'
// ============================================================

export type EmailLocale = 'fr' | 'en';

/**
 * Normalize any locale string to a two-character base.
 * Falls back to 'fr' (the store's primary language).
 */
export function normalizeLocale(locale: string | undefined): EmailLocale {
  if (!locale) return 'fr';
  const base = locale.slice(0, 2).toLowerCase();
  return base === 'en' ? 'en' : 'fr';
}

/**
 * Email translation helper.
 * Returns the string for the given locale, falling back to 'fr'.
 */
export function et(key: EmailTranslationKey, locale: string | undefined): string {
  const l = normalizeLocale(locale);
  return (emailTranslations[l]?.[key] ?? emailTranslations['fr'][key] ?? key) as string;
}

export type EmailTranslationKey = keyof typeof emailTranslations.en;

export const emailTranslations = {
  en: {
    // ── Document ─────────────────────────────────────────────
    'doc.title':              'Order Confirmation',

    // ── Header greeting ───────────────────────────────────────
    'header.confirmed':       'Order confirmed ✓',
    'header.thanks':          'thanks for your order!',  // prefixed with customer email in template
    'header.orderLabel':      'Order',
	'header.hi': 			  'Hi',

    // ── Downloads section ─────────────────────────────────────
    'section.downloads':      'Your Downloads',
    'downloads.expiry':       'Links expire in 7 days and can be used up to 5 times each.',
    'downloads.button':       'Download',

    // ── Shipping section ──────────────────────────────────────
    'section.shipping':       'Shipping Address',

    // ── Order summary section ─────────────────────────────────
    'section.summary':        'Order Summary',
    'summary.col.item':       'Item',
    'summary.col.qty':        'Qty',
    'summary.col.price':      'Price',
    'summary.badge.digital':  'Digital',

    // ── Totals ────────────────────────────────────────────────
    'totals.subtotal':        'Subtotal',
    'totals.discount':        'Discount',
    'totals.shipping':        'Shipping',
    'totals.shipping.free':   'Free',
    'totals.tax':             'Tax',
    'totals.total':           'Total',

    // ── Footer ────────────────────────────────────────────────
    'footer.questions':       'Questions? Reply to this email or contact us at',
    'footer.downloads.expiry': 'Your download links expire in 7 days.',

    // ── Plain text fallback ───────────────────────────────────
    'text.title':             'Order Confirmation',
	'text.orderLabel':        'Order',
    'text.thanks':            'thanks for your order!',
    'text.items':             '--- Items ---',
    'text.totals':            '--- Totals ---',
    'text.subtotal':          'Subtotal:',
    'text.discount':          'Discount',
    'text.shipping':          'Shipping:',
    'text.shipping.free':     'Free',
    'text.tax':               'Tax:',
    'text.total':             'Total:',
    'text.download':          'Download:',
    'text.downloads.expiry':  'Download links expire in 7 days and can be used up to 5 times.',
  },

  fr: {
    // ── Document ─────────────────────────────────────────────
    'doc.title':              'Confirmation de commande',

    // ── Header greeting ───────────────────────────────────────
    'header.confirmed':       'Commande confirmée ✓',
    'header.thanks':          'merci pour votre commande !',
    'header.orderLabel':      'Commande',
	'header.hi': 			  'Bonjour',

    // ── Downloads section ─────────────────────────────────────
    'section.downloads':      'Vos téléchargements',
    'downloads.expiry':       'Les liens expirent dans 7 jours et peuvent être utilisés jusqu\'à 5 fois chacun.',
    'downloads.button':       'Télécharger',

    // ── Shipping section ──────────────────────────────────────
    'section.shipping':       'Adresse de livraison',

    // ── Order summary section ─────────────────────────────────
    'section.summary':        'Récapitulatif de commande',
    'summary.col.item':       'Article',
    'summary.col.qty':        'Qté',
    'summary.col.price':      'Prix',
    'summary.badge.digital':  'Numérique',

    // ── Totals ────────────────────────────────────────────────
    'totals.subtotal':        'Sous-total',
    'totals.discount':        'Réduction',
    'totals.shipping':        'Livraison',
    'totals.shipping.free':   'Gratuite',
    'totals.tax':             'Taxes',
    'totals.total':           'Total',

    // ── Footer ────────────────────────────────────────────────
    'footer.questions':       'Des questions ? Répondez à cet email ou contactez-nous à',
    'footer.downloads.expiry': 'Vos liens de téléchargement expirent dans 7 jours.',

    // ── Plain text fallback ───────────────────────────────────
    'text.title':             'Confirmation de commande',
	'text.orderLabel':        'Commande',
    'text.thanks':            'merci pour votre commande !',
    'text.items':             '--- Articles ---',
    'text.totals':            '--- Totaux ---',
    'text.subtotal':          'Sous-total :',
    'text.discount':          'Réduction',
    'text.shipping':          'Livraison :',
    'text.shipping.free':     'Gratuite',
    'text.tax':               'Taxes :',
    'text.total':             'Total :',
    'text.download':          'Télécharger :',
    'text.downloads.expiry':  'Les liens de téléchargement expirent dans 7 jours et peuvent être utilisés jusqu\'à 5 fois.',
  },
} as const;
