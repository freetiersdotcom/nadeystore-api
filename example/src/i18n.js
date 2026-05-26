// ============================================================
// src/i18n.js
//
// Frontstore translation module — vanilla JS, no framework.
//
// LOCALE DETECTION & PERSISTENCE
//   Locale is stored in localStorage under 'locale'.
//   Falls back to 'fr' (primary market).
//   To switch locale: call setLocale('en') — reloads the page.
//
// USAGE
//   import { t, setLocale, getLocale } from './i18n.js';
//
//   // Static string:
//   btn.textContent = t('cart.addToCart');
//
//   // Interpolated string — use plain concatenation or template literals:
//   el.textContent = t('index.noFilteredProducts').replace('{filter}', activeFilter);
//
// LOCALE TOGGLE (example button in HTML):
//   <button id="lang-toggle"></button>
//
//   import { t, setLocale, getLocale } from './i18n.js';
//   const btn = document.getElementById('lang-toggle');
//   btn.textContent = getLocale() === 'fr' ? 'English' : 'Français';
//   btn.addEventListener('click', () =>
//     setLocale(getLocale() === 'fr' ? 'en' : 'fr')
//   );
// ============================================================

const LOCALE_KEY = 'locale';
const SUPPORTED_LOCALES = ['fr', 'en'];
const DEFAULT_LOCALE = 'fr'; // primary market

// ── Public API ────────────────────────────────────────────────

/**
 * Get the active locale ('fr' | 'en').
 */
export function getLocale() {
  const stored = localStorage.getItem(LOCALE_KEY);
  return SUPPORTED_LOCALES.includes(stored) ? stored : DEFAULT_LOCALE;
}

/**
 * Set the locale and reload the page so all strings refresh.
 * This is the simplest pattern for a vanilla JS storefront —
 * no reactive re-render needed.
 */
export function setLocale(locale) {
  if (!SUPPORTED_LOCALES.includes(locale)) return;
  localStorage.setItem(LOCALE_KEY, locale);
  window.location.reload();
}

/**
 * Translate a key.
 * Falls back to the default locale, then to the key itself.
 *
 * @param {TranslationKey} key
 * @returns {string}
 */
export function t(key) {
  const locale = getLocale();
  return (
    translations[locale]?.[key] ??
    translations[DEFAULT_LOCALE][key] ??
    key
  );
}

// ── Dictionary ────────────────────────────────────────────────

/** @typedef {keyof typeof translations.en} TranslationKey */

const translations = {
  en: {
    // ── Common / Navigation ───────────────────────────────────
    'nav.shop':             'Shop',
    'nav.viewCart':         'View cart',

    // ── index.html — Hero ─────────────────────────────────────
    'index.hero.title':     'Our Products',
    'index.hero.subtitle':  'Physical goods and digital downloads — shipped worldwide.',

    // ── index.html — Filter tabs ──────────────────────────────
    'index.filter.all':     'All',
    'index.filter.physical':'Physical',
    'index.filter.digital': 'Digital',

    // ── index.html — Product grid ─────────────────────────────
    'index.loading':        'Loading products...',
    'index.error.title':    'Failed to load products',
    'index.error.subtitle': 'Make sure the Merchant API is running',
    'index.noProducts':     'No products available yet.',
    // Interpolated: replace {filter} with the active filter label
    'index.noFilteredProducts': 'No {filter} products found.',

    // ── index.html — Product card ─────────────────────────────
    'card.badge.digital':   'Digital',
    'card.badge.options':   'options',       // replace {n} with count
    'card.tag.digital':     '⚡ Instant download',
    'card.tag.physical':    'Physical · shipping required',
    'card.addToCart':       'Add to Cart',
    'card.adding':          'Adding...',
    'card.added':           'Added ✓',
    'card.error':           'Error — retry',

    // ── index.html — Email modal ──────────────────────────────
    'modal.title':          'Almost there',
    'modal.subtitle':       'Enter your email to start your cart. We\'ll send your order confirmation here.',
    'modal.placeholder':    'you@example.com',
    'modal.error':          'Please enter a valid email address.',
    'modal.cancel':         'Cancel',
    'modal.confirm':        'Continue',

    // ── index.html — Cart toast ───────────────────────────────
    'toast.addedToCart':    'Added to cart',

    // ── cart.html — Page ──────────────────────────────────────
    'cart.title':           'Your Cart',

    // ── cart.html — Empty state ───────────────────────────────
    'cart.empty.title':     'Your cart is empty',
    'cart.empty.subtitle':  'Add some items to get started.',
    'cart.empty.cta':       'Continue Shopping',

    // ── cart.html — Line items ────────────────────────────────
    'cart.item.digital':    'Digital',
    'cart.item.qty':        'Qty:',        // used for digital items (non-editable qty)
    'cart.item.remove':     'Remove',

    // ── cart.html — Shipping address ──────────────────────────
    'cart.shipping.heading':  'Shipping address',
    'cart.shipping.name':     'Full name *',
    'cart.shipping.name.ph':  'Jane Dupont',
    'cart.shipping.line1':    'Address line 1 *',
    'cart.shipping.line1.ph': '123 Rue de la Paix',
    'cart.shipping.line2':    'Address line 2',
    'cart.shipping.line2.ph': 'Apt, building, etc.',
    'cart.shipping.city':     'City *',
    'cart.shipping.city.ph':  'Cotonou',
    'cart.shipping.state':    'State / Province',
    'cart.shipping.state.ph': 'Littoral',
    'cart.shipping.postal':   'Postal code',
    'cart.shipping.postal.ph':'01 BP 000',
    'cart.shipping.country':  'Country *',
    'cart.shipping.country.ph':'BJ',

    // ── cart.html — Order summary ─────────────────────────────
    'cart.summary.title':   'Order Summary',
    'cart.summary.subtotal':'Subtotal',
    'cart.summary.total':   'Total',

    // ── cart.html — Discount code ─────────────────────────────
    'cart.discount.placeholder':  'Discount code',
    'cart.discount.apply':        'Apply',
    'cart.discount.applying':     'Applying...',
    // Interpolated: replace {code} with the applied code
    'cart.discount.applied':      'Code "{code}" applied!',
    'cart.discount.invalid':      'Invalid discount code',

    // ── cart.html — Checkout button ───────────────────────────
    'cart.checkout.cta':          'Proceed to Payment',
    'cart.checkout.processing':   'Processing...',
    'cart.checkout.error':        'Checkout failed. Please try again.',
    'cart.checkout.needShipping': 'Please complete your shipping address before continuing.',
    'cart.checkout.secure':       'Secure checkout',
    'cart.checkout.via.fedapay':  'Secure checkout via FedaPay',
    'cart.checkout.via.stripe':   'Secure checkout via Stripe',
    'cart.checkout.ssl':          '🔒 SSL encrypted',

    // ── downloads.html ────────────────────────────────────────
    'dl.loading':           'Validating your download link...',
    'dl.error.title':       'Link unavailable',
    'dl.back':              '← Back to shop',
    'dl.product.fallback':  'Your file',
    'dl.remaining':         'Downloads remaining',
    'dl.expires':           'Link expires',
    'dl.cta':               'Download file',
    'dl.notice':            'Keep this link safe. It is personal and will expire after the allowed number of downloads.',

    // ── downloads.html — Error messages ───────────────────────
    'dl.err.notFound':      'This download link is invalid or has already expired.',
    'dl.err.limitReached':  'This download link has been used the maximum number of times. Please contact support to request a new link.',
    'dl.err.expired':       'This download link has expired. Please contact support to request a new link.',
    'dl.err.noToken':       'No download token found in this link. Please check your email.',
    'dl.err.generic':       'Something went wrong. Please try again or contact support.',

    // ── success.html ──────────────────────────────────────────
    'success.heading':            'Order Confirmed!',
    'success.message':            'Thank you for your purchase. We\'ve sent a confirmation email with your order details.',
    'success.processing.heading': 'Payment processing',
    'success.processing.message': 'We\'re confirming your payment. You\'ll receive an email once it\'s complete.',
    'success.digital.title':      'Your download is on its way',
    'success.digital.message':    'Check your email for your download link. It will arrive within a few minutes and is valid for 7 days.',
    'success.ref.label':          'Transaction reference',
    'success.cta':                'Continue Shopping',
    'success.help':               'Need help? Contact us and reference your transaction ID.',
  },

  fr: {
    // ── Common / Navigation ───────────────────────────────────
    'nav.shop':             'Boutique',
    'nav.viewCart':         'Voir le panier',

    // ── index.html — Hero ─────────────────────────────────────
    'index.hero.title':     'Nos produits',
    'index.hero.subtitle':  'Produits physiques et téléchargements numériques — livraison dans le monde entier.',

    // ── index.html — Filter tabs ──────────────────────────────
    'index.filter.all':     'Tous',
    'index.filter.physical':'Physique',
    'index.filter.digital': 'Numérique',

    // ── index.html — Product grid ─────────────────────────────
    'index.loading':        'Chargement des produits...',
    'index.error.title':    'Impossible de charger les produits',
    'index.error.subtitle': 'Vérifiez que l\'API Merchant est en cours d\'exécution',
    'index.noProducts':     'Aucun produit disponible pour le moment.',
    'index.noFilteredProducts': 'Aucun produit {filter} trouvé.',

    // ── index.html — Product card ─────────────────────────────
    'card.badge.digital':   'Numérique',
    'card.badge.options':   'options',
    'card.tag.digital':     '⚡ Téléchargement instantané',
    'card.tag.physical':    'Physique · livraison requise',
    'card.addToCart':       'Ajouter au panier',
    'card.adding':          'Ajout en cours...',
    'card.added':           'Ajouté ✓',
    'card.error':           'Erreur — réessayer',

    // ── index.html — Email modal ──────────────────────────────
    'modal.title':          'Presque prêt',
    'modal.subtitle':       'Entrez votre email pour démarrer votre panier. Votre confirmation de commande vous y sera envoyée.',
    'modal.placeholder':    'vous@exemple.com',
    'modal.error':          'Veuillez entrer une adresse email valide.',
    'modal.cancel':         'Annuler',
    'modal.confirm':        'Continuer',

    // ── index.html — Cart toast ───────────────────────────────
    'toast.addedToCart':    'Ajouté au panier',

    // ── cart.html — Page ──────────────────────────────────────
    'cart.title':           'Votre panier',

    // ── cart.html — Empty state ───────────────────────────────
    'cart.empty.title':     'Votre panier est vide',
    'cart.empty.subtitle':  'Ajoutez des articles pour commencer.',
    'cart.empty.cta':       'Continuer mes achats',

    // ── cart.html — Line items ────────────────────────────────
    'cart.item.digital':    'Numérique',
    'cart.item.qty':        'Qté :',
    'cart.item.remove':     'Supprimer',

    // ── cart.html — Shipping address ──────────────────────────
    'cart.shipping.heading':  'Adresse de livraison',
    'cart.shipping.name':     'Nom complet *',
    'cart.shipping.name.ph':  'Jean Dupont',
    'cart.shipping.line1':    'Adresse ligne 1 *',
    'cart.shipping.line1.ph': '123 Rue de la Paix',
    'cart.shipping.line2':    'Adresse ligne 2',
    'cart.shipping.line2.ph': 'Apt, bâtiment, etc.',
    'cart.shipping.city':     'Ville *',
    'cart.shipping.city.ph':  'Cotonou',
    'cart.shipping.state':    'État / Province',
    'cart.shipping.state.ph': 'Littoral',
    'cart.shipping.postal':   'Code postal',
    'cart.shipping.postal.ph':'01 BP 000',
    'cart.shipping.country':  'Pays *',
    'cart.shipping.country.ph':'BJ',

    // ── cart.html — Order summary ─────────────────────────────
    'cart.summary.title':   'Récapitulatif de commande',
    'cart.summary.subtotal':'Sous-total',
    'cart.summary.total':   'Total',

    // ── cart.html — Discount code ─────────────────────────────
    'cart.discount.placeholder':  'Code de réduction',
    'cart.discount.apply':        'Appliquer',
    'cart.discount.applying':     'Application...',
    'cart.discount.applied':      'Code « {code} » appliqué !',
    'cart.discount.invalid':      'Code de réduction invalide',

    // ── cart.html — Checkout button ───────────────────────────
    'cart.checkout.cta':          'Procéder au paiement',
    'cart.checkout.processing':   'Traitement en cours...',
    'cart.checkout.error':        'Échec du paiement. Veuillez réessayer.',
    'cart.checkout.needShipping': 'Veuillez compléter votre adresse de livraison avant de continuer.',
    'cart.checkout.secure':       'Paiement sécurisé',
    'cart.checkout.via.fedapay':  'Paiement sécurisé via FedaPay',
    'cart.checkout.via.stripe':   'Paiement sécurisé via Stripe',
    'cart.checkout.ssl':          '🔒 Chiffrement SSL',

    // ── downloads.html ────────────────────────────────────────
    'dl.loading':           'Validation de votre lien de téléchargement...',
    'dl.error.title':       'Lien indisponible',
    'dl.back':              '← Retour à la boutique',
    'dl.product.fallback':  'Votre fichier',
    'dl.remaining':         'Téléchargements restants',
    'dl.expires':           'Lien expire le',
    'dl.cta':               'Télécharger le fichier',
    'dl.notice':            'Conservez ce lien précieusement. Il est personnel et expirera après le nombre de téléchargements autorisé.',

    // ── downloads.html — Error messages ───────────────────────
    'dl.err.notFound':      'Ce lien de téléchargement est invalide ou a déjà expiré.',
    'dl.err.limitReached':  'Ce lien de téléchargement a été utilisé le nombre maximum de fois. Veuillez contacter le support pour en obtenir un nouveau.',
    'dl.err.expired':       'Ce lien de téléchargement a expiré. Veuillez contacter le support pour en obtenir un nouveau.',
    'dl.err.noToken':       'Aucun jeton de téléchargement trouvé dans ce lien. Veuillez vérifier votre email.',
    'dl.err.generic':       'Une erreur est survenue. Veuillez réessayer ou contacter le support.',

    // ── success.html ──────────────────────────────────────────
    'success.heading':            'Commande confirmée !',
    'success.message':            'Merci pour votre achat. Nous vous avons envoyé un email de confirmation avec les détails de votre commande.',
    'success.processing.heading': 'Paiement en cours',
    'success.processing.message': 'Nous confirmons votre paiement. Vous recevrez un email dès que c\'est fait.',
    'success.digital.title':      'Votre téléchargement est en route',
    'success.digital.message':    'Consultez votre email pour votre lien de téléchargement. Il arrivera dans quelques minutes et est valable 7 jours.',
    'success.ref.label':          'Référence de transaction',
    'success.cta':                'Continuer mes achats',
    'success.help':               'Besoin d\'aide ? Contactez-nous en indiquant votre identifiant de transaction.',
  },
};
