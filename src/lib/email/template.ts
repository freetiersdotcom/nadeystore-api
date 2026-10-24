import { et, type EmailTranslationKey } from './i18n';
import { renderServiceBlock, serviceBadge, serviceText } from './serviceNotice';
import { codTitle, renderCodBlock, codText } from './paymentNotice';

// ============================================================
// ORDER CONFIRMATION EMAIL TEMPLATE
// ============================================================
//
// Pure TypeScript → HTML string, no external dependencies.
// Adapts automatically:
//   - Physical orders: shows shipping address block
//   - Digital orders: shows download links block
//   - Service orders: shows "we will contact you" block
//   - Mixed orders: shows each relevant section
//   - Discounts: shows discount row only when a discount was applied
//
// Language: every et() call receives the order locale. et() has no
// global state, so forgetting the locale argument silently renders French.

export interface TemplateOrderItem {
  sku: string;
  title: string;
  qty: number;
  unit_price_cents: number;
  /** Determines which block is rendered for this item */
  product_type: 'physical' | 'digital' | 'service';
  /** Plain download token (not hashed) — only set for digital items */
  download_token?: string;
}

export interface TemplateShippingAddress {
  line1: string;
  line2?: string | null;
  city: string;
  state?: string | null;
  postal_code: string;
  country: string;
}

export interface TemplateDiscount {
  code: string;
  amount_cents: number;
}

export interface OrderConfirmationData {
  order_number: string;
  customer_email: string;
  store_name: string;
  items: TemplateOrderItem[];
  subtotal_cents: number;
  discount?: TemplateDiscount | null;
  tax_cents: number;
  shipping_cents: number;
  total_cents: number;
  currency?: string;
  locale?: string; // e.g. 'fr-FR', 'en-US' — defaults to 'fr-FR'
  /** Only present for physical/mixed orders */
  shipping_address?: TemplateShippingAddress | null;
  shipping_name?: string | null;
  /** Base URL for download page, e.g. https://yourstore.com */
  store_base_url: string;
  /** Optional: store contact address for the footer link (mailto). If absent, the store name is shown without a link. */
  store_contact_email?: string | null;
  /** 'cod' = pay on delivery: the email says "order received" and shows the amount due. Default 'online'. */
  payment_method?: 'online' | 'cod';
}

// ============================================================
// HELPERS
// ============================================================

const ZERO_DECIMAL_CURRENCIES = new Set(['XOF', 'GNF', 'JPY', 'KRW', 'VND']);
const DEFAULT_CURRENCY = 'XOF';

/** 'fr-FR' | 'fr' | undefined → 'fr' ; 'en-US' → 'en' */
function baseLang(locale?: string): 'fr' | 'en' {
  return (locale ?? 'fr').slice(0, 2).toLowerCase() === 'en' ? 'en' : 'fr';
}

/** Intl needs a full tag: make 'fr' / 'en' usable. */
function intlLocale(locale?: string): string {
  if (locale && locale.length > 2) return locale;
  return baseLang(locale) === 'en' ? 'en-US' : 'fr-FR';
}

function formatAmount(amount: number, currency = DEFAULT_CURRENCY, locale = 'fr-FR'): string {
  const cur = (currency || DEFAULT_CURRENCY).toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(cur);

  return new Intl.NumberFormat(intlLocale(locale), {
    style:                 'currency',
    currency:              cur,
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
  }).format(isZeroDecimal ? amount : amount / 100);
}

function esc(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Download page path follows the site's URL scheme (/fr/telechargements/, /en/downloads/). */
function downloadUrl(baseUrl: string, token: string, locale?: string): string {
  const path = baseLang(locale) === 'en' ? '/en/downloads/' : '/fr/telechargements/';
  return `${baseUrl.replace(/\/$/, '')}${path}?token=${token}`;
}

// ============================================================
// SECTION RENDERERS
// ============================================================

function renderShippingBlock(data: OrderConfirmationData): string {
  const { shipping_address, shipping_name } = data;
  if (!shipping_address) return '';
  const t = (k: EmailTranslationKey) => et(k, data.locale);

  const lines = [
    shipping_name ? `<strong>${esc(shipping_name)}</strong>` : '',
    esc(shipping_address.line1),
    shipping_address.line2 ? esc(shipping_address.line2) : '',
    `${esc(shipping_address.city)}${shipping_address.state ? ', ' + esc(shipping_address.state) : ''} ${esc(shipping_address.postal_code)}`,
    esc(shipping_address.country),
  ].filter(Boolean).join('<br>');

  return `
    <tr>
      <td style="padding: 0 0 32px 0;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #111; text-transform: uppercase; letter-spacing: 0.05em;">
          ${t('section.shipping')}
        </h3>
        <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #444;">
          ${lines}
        </p>
      </td>
    </tr>`;
}

function renderDownloadsBlock(items: TemplateOrderItem[], baseUrl: string, locale?: string): string {
  const digitalItems = items.filter(i => i.product_type === 'digital' && i.download_token);
  if (digitalItems.length === 0) return '';
  const t = (k: EmailTranslationKey) => et(k, locale);

  const rows = digitalItems.map(item => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size: 14px; color: #111;">${esc(item.title)}</td>
            <td align="right">
              <a href="${esc(downloadUrl(baseUrl, encodeURIComponent(item.download_token!), locale))}"
                 style="display: inline-block; padding: 8px 16px; background: #111; color: #fff;
                        text-decoration: none; font-size: 13px; border-radius: 4px;">
                ${t('downloads.button')}
              </a>
            </td>
          </tr>
        </table>
      </td>
    </tr>`).join('');

  return `
    <tr>
      <td style="padding: 0 0 32px 0;">
        <h3 style="margin: 0 0 12px 0; font-size: 14px; font-weight: 600; color: #111; text-transform: uppercase; letter-spacing: 0.05em;">
          ${t('section.downloads')}
        </h3>
        <p style="margin: 0 0 16px 0; font-size: 14px; color: #666;">
          ${t('downloads.expiry')}
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${rows}
        </table>
      </td>
    </tr>`;
}

function itemBadge(item: TemplateOrderItem, locale?: string): string {
  const label =
    item.product_type === 'digital' ? et('summary.badge.digital', locale)
    : item.product_type === 'service' ? serviceBadge(locale)
    : '';
  if (!label) return '';
  return `<span style="display:inline-block;margin-left:6px;font-size:11px;color:#666;background:#f5f5f5;padding:1px 6px;border-radius:3px;">${esc(label)}</span>`;
}

function renderItemsTable(items: TemplateOrderItem[], currency: string, locale?: string): string {
  const t = (k: EmailTranslationKey) => et(k, locale);
  const rows = items.map(item => `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; color: #111;">
        ${esc(item.title)}
        ${itemBadge(item, locale)}
      </td>
      <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; color: #666; text-align: center;">
        × ${item.qty}
      </td>
      <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; color: #111; text-align: right;">
        ${formatAmount(item.unit_price_cents * item.qty, currency, locale)}
      </td>
    </tr>`).join('');

  return `
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top: 1px solid #f0f0f0;">
      <thead>
        <tr>
          <th style="padding: 10px 0; font-size: 12px; color: #999; font-weight: 500; text-align: left; text-transform: uppercase; letter-spacing: 0.05em;">${t('summary.col.item')}</th>
          <th style="padding: 10px 0; font-size: 12px; color: #999; font-weight: 500; text-align: center; text-transform: uppercase; letter-spacing: 0.05em;">${t('summary.col.qty')}</th>
          <th style="padding: 10px 0; font-size: 12px; color: #999; font-weight: 500; text-align: right; text-transform: uppercase; letter-spacing: 0.05em;">${t('summary.col.price')}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTotals(data: OrderConfirmationData): string {
  const cur = data.currency ?? DEFAULT_CURRENCY;
  const loc = data.locale;
  const t = (k: EmailTranslationKey) => et(k, loc);
  const rows: string[] = [];

  rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666;">${t('totals.subtotal')}</td>
      <td style="padding: 8px 0; font-size: 14px; color: #111; text-align: right;">${formatAmount(data.subtotal_cents, cur, loc)}</td>
    </tr>`);

  if (data.discount && data.discount.amount_cents > 0) {
    rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #22863a;">${t('totals.discount')} (${esc(data.discount.code)})</td>
      <td style="padding: 8px 0; font-size: 14px; color: #22863a; text-align: right;">−${formatAmount(data.discount.amount_cents, cur, loc)}</td>
    </tr>`);
  }

  // Service-only orders have no shipping line at all (no "Free" noise).
  const onlyServices = data.items.length > 0 && data.items.every(i => i.product_type === 'service');
  if (data.shipping_cents > 0) {
    rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666;">${t('totals.shipping')}</td>
      <td style="padding: 8px 0; font-size: 14px; color: #111; text-align: right;">${formatAmount(data.shipping_cents, cur, loc)}</td>
    </tr>`);
  } else if (!onlyServices) {
    rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666;">${t('totals.shipping')}</td>
      <td style="padding: 8px 0; font-size: 14px; color: #111; text-align: right;">${t('totals.shipping.free')}</td>
    </tr>`);
  }

  if (data.tax_cents > 0) {
    rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666;">${t('totals.tax')}</td>
      <td style="padding: 8px 0; font-size: 14px; color: #111; text-align: right;">${formatAmount(data.tax_cents, cur, loc)}</td>
    </tr>`);
  }

  rows.push(`
    <tr style="border-top: 2px solid #111;">
      <td style="padding: 14px 0 0 0; font-size: 16px; font-weight: 700; color: #111;">${t('totals.total')}</td>
      <td style="padding: 14px 0 0 0; font-size: 16px; font-weight: 700; color: #111; text-align: right;">${formatAmount(data.total_cents, cur, loc)}</td>
    </tr>`);

  return `<table width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
}

// ============================================================
// MAIN RENDERER
// ============================================================

export function renderOrderConfirmation(data: OrderConfirmationData): { html: string; text: string } {
  const loc = data.locale;
  const lang = baseLang(loc);
  const t = (k: EmailTranslationKey) => et(k, loc);

  const hasPhysical = data.items.some(i => i.product_type === 'physical');
  const hasDigital = data.items.some(i => i.product_type === 'digital');
  const hasService = data.items.some(i => i.product_type === 'service');
  const cur = data.currency ?? DEFAULT_CURRENCY;
  const isCod = data.payment_method === 'cod';
  const amountDue = formatAmount(data.total_cents, cur, loc);

  const storeLink = data.store_contact_email
    ? `<a href="mailto:${esc(data.store_contact_email)}" style="color: #666;">${esc(data.store_name)}</a>`
    : esc(data.store_name);

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${t('doc.title')} — ${esc(data.order_number)}</title>
</head>
<body style="margin: 0; padding: 0; background: #f5f5f5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background: #f5f5f5; padding: 40px 20px;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%;">

          <!-- Header -->
          <tr>
            <td style="background: #111; padding: 32px 40px; border-radius: 8px 8px 0 0;">
              <h1 style="margin: 0; font-size: 22px; color: #fff; font-weight: 700;">${esc(data.store_name)}</h1>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="background: #fff; padding: 40px; border-radius: 0 0 8px 8px;">
              <table width="100%" cellpadding="0" cellspacing="0">

                <!-- Title -->
                <tr>
                  <td style="padding: 0 0 32px 0;">
                    <h2 style="margin: 0 0 8px 0; font-size: 24px; font-weight: 700; color: #111;">
                      ${isCod ? codTitle(loc) : t('header.confirmed')}
                    </h2>
                    <p style="margin: 0; font-size: 15px; color: #666;">
                      ${t('header.hi')} ${esc(data.customer_email)}, ${t('header.thanks')}
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 14px; color: #999;">
                      ${t('header.orderLabel')} <strong style="color: #111;">${esc(data.order_number)}</strong>
                    </p>
                  </td>
                </tr>

                <!-- COD notice -->
                ${isCod ? renderCodBlock(amountDue, loc) : ''}

                <!-- Downloads (digital) -->
                ${hasDigital ? renderDownloadsBlock(data.items, data.store_base_url, loc) : ''}

                <!-- Service (what happens next) -->
                ${hasService ? renderServiceBlock(data.items, loc) : ''}

                <!-- Shipping address (physical) -->
                ${hasPhysical ? renderShippingBlock(data) : ''}

                <!-- Order items -->
                <tr>
                  <td style="padding: 0 0 24px 0;">
                    <h3 style="margin: 0 0 16px 0; font-size: 14px; font-weight: 600; color: #111; text-transform: uppercase; letter-spacing: 0.05em;">
                      ${t('section.summary')}
                    </h3>
                    ${renderItemsTable(data.items, cur, loc)}
                  </td>
                </tr>

                <!-- Totals -->
                <tr>
                  <td style="padding: 0 0 32px 0; border-top: 1px solid #f0f0f0; padding-top: 16px;">
                    ${renderTotals(data)}
                  </td>
                </tr>

                <!-- Footer note -->
                <tr>
                  <td style="padding: 24px 0 0 0; border-top: 1px solid #f0f0f0;">
                    <p style="margin: 0; font-size: 13px; color: #999; line-height: 1.6;">
                      ${t('footer.questions')}
                      ${storeLink}.
                      ${hasDigital ? t('footer.downloads.expiry') : ''}
                    </p>
                  </td>
                </tr>

              </table>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  // Plain text fallback
  const itemLines = data.items.map(i =>
    `  ${i.title} × ${i.qty}  ${formatAmount(i.unit_price_cents * i.qty, cur, loc)}` +
    (i.product_type === 'digital' && i.download_token
      ? `\n  ${t('text.download')} ${downloadUrl(data.store_base_url, encodeURIComponent(i.download_token), loc)}`
      : '')
  ).join('\n');

  const onlyServices = data.items.length > 0 && data.items.every(i => i.product_type === 'service');
  const shippingLine = data.shipping_cents > 0
    ? `${t('text.shipping')} ${formatAmount(data.shipping_cents, cur, loc)}`
    : onlyServices ? null : `${t('text.shipping')} ${t('text.shipping.free')}`;

  const text = [
    `${data.store_name} — ${t('text.title')}`,
    `${t('text.orderLabel')} ${data.order_number}`,
    '',
    `${t('header.hi')} ${data.customer_email}, ${t('text.thanks')}`,
    '',
    t('text.items'),
    itemLines,
    hasService ? '' : null,
    hasService ? serviceText(data.items, loc) : null,
    isCod ? '' : null,
    isCod ? codText(amountDue, loc) : null,
    '',
    t('text.totals'),
    `${t('text.subtotal')} ${formatAmount(data.subtotal_cents, cur, loc)}`,
    data.discount?.amount_cents ? `${t('text.discount')} (${data.discount.code}): -${formatAmount(data.discount.amount_cents, cur, loc)}` : null,
    shippingLine,
    data.tax_cents > 0 ? `${t('text.tax')} ${formatAmount(data.tax_cents, cur, loc)}` : null,
    `${t('text.total')} ${formatAmount(data.total_cents, cur, loc)}`,
    hasDigital ? t('text.downloads.expiry') : null,
  ].filter((l): l is string => l !== null).join('\n').trim();

  return { html, text };
}
