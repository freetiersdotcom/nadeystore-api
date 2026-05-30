import { et } from './i18n';

// ============================================================
// ORDER CONFIRMATION EMAIL TEMPLATE
// ============================================================
//
// Pure TypeScript → HTML string, no external dependencies.
// Adapts automatically:
//   - Physical orders: shows shipping address block
//   - Digital orders: shows download links block
//   - Mixed orders: shows both sections
//   - Discounts: shows discount row only when a discount was applied

export interface TemplateOrderItem {
  sku: string;
  title: string;
  qty: number;
  unit_price_cents: number;
  /** Determines whether a download link is rendered for this item */
  product_type: 'physical' | 'digital';
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
}

// ============================================================
// HELPERS
// ============================================================

const ZERO_DECIMAL_CURRENCIES = new Set(['XOF', 'GNF', 'JPY', 'KRW', 'VND']);

function formatAmount(amount: number, currency = 'XOF', locale = 'fr-FR'): string {
  const cur = (currency || 'XOF').toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(cur);

  return new Intl.NumberFormat(locale, {
    style:                 'currency',
    currency:              cur,
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
  }).format(isZeroDecimal ? amount : amount / 100);
}

function cents(amount: number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
  }).format(amount / 100);
}

function esc(str: string | null | undefined): string {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// SECTION RENDERERS
// ============================================================

function renderShippingBlock(data: OrderConfirmationData): string {
  const { shipping_address, shipping_name } = data;
  if (!shipping_address) return '';

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
		  ${et('section.shipping')}
        </h3>
        <p style="margin: 0; font-size: 15px; line-height: 1.6; color: #444;">
          ${lines}
        </p>
      </td>
    </tr>`;
}

function renderDownloadsBlock(items: TemplateOrderItem[], baseUrl: string): string {
  const digitalItems = items.filter(i => i.product_type === 'digital' && i.download_token);
  if (digitalItems.length === 0) return '';

  const rows = digitalItems.map(item => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #f0f0f0;">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td style="font-size: 14px; color: #111;">${esc(item.title)}</td>
            <td align="right">
              <a href="${esc(baseUrl)}/fr/telechargements/?token=${esc(item.download_token)}"
                 style="display: inline-block; padding: 8px 16px; background: #111; color: #fff;
                        text-decoration: none; font-size: 13px; border-radius: 4px;">
                ${et('downloads.button')}
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
          ${et('section.downloads')}
        </h3>
        <p style="margin: 0 0 16px 0; font-size: 14px; color: #666;">
          ${et('downloads.expiry')}
        </p>
        <table width="100%" cellpadding="0" cellspacing="0">
          ${rows}
        </table>
      </td>
    </tr>`;
}

function renderItemsTable(items: TemplateOrderItem[], currency: string, locale = 'fr-FR'): string {
  const rows = items.map(item => `
    <tr>
      <td style="padding: 12px 0; border-bottom: 1px solid #f0f0f0; font-size: 14px; color: #111;">
        ${esc(item.title)}
        ${item.product_type === 'digital' ? '<span style="display:inline-block;margin-left:6px;font-size:11px;color:#666;background:#f5f5f5;padding:1px 6px;border-radius:3px;">'+et('summary.badge.digital')+'</span>' : ''}
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
          <th style="padding: 10px 0; font-size: 12px; color: #999; font-weight: 500; text-align: left; text-transform: uppercase; letter-spacing: 0.05em;">${et('summary.col.item')}</th>
          <th style="padding: 10px 0; font-size: 12px; color: #999; font-weight: 500; text-align: center; text-transform: uppercase; letter-spacing: 0.05em;">${et('summary.col.qty')}</th>
          <th style="padding: 10px 0; font-size: 12px; color: #999; font-weight: 500; text-align: right; text-transform: uppercase; letter-spacing: 0.05em;">${et('summary.col.price')}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderTotals(data: OrderConfirmationData): string {
  const cur = data.currency ?? 'USD';
  const rows: string[] = [];

  rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666;">${et('totals.subtotal')}</td>
      <td style="padding: 8px 0; font-size: 14px; color: #111; text-align: right;">${formatAmount(data.subtotal_cents, cur, data.locale ?? 'fr-FR')}</td>
    </tr>`);

  if (data.discount && data.discount.amount_cents > 0) {
    rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #22863a;">${et('totals.discount')} (${esc(data.discount.code)})</td>
      <td style="padding: 8px 0; font-size: 14px; color: #22863a; text-align: right;">−${formatAmount(data.discount.amount_cents, cur, data.locale ?? 'fr-FR')}</td>
    </tr>`);
  }

  if (data.shipping_cents > 0) {
    rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666;">${et('totals.shipping')}</td>
      <td style="padding: 8px 0; font-size: 14px; color: #111; text-align: right;">${formatAmount(data.shipping_cents, cur, data.locale ?? 'fr-FR')}</td>
    </tr>`);
  } else {
    rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666;">${et('totals.shipping')}</td>
      <td style="padding: 8px 0; font-size: 14px; color: #111; text-align: right;">${et('totals.shipping.free')}</td>
    </tr>`);
  }

  if (data.tax_cents > 0) {
    rows.push(`
    <tr>
      <td style="padding: 8px 0; font-size: 14px; color: #666;">${et('totals.tax')}</td>
      <td style="padding: 8px 0; font-size: 14px; color: #111; text-align: right;">${formatAmount(data.tax_cents, cur, data.locale ?? 'fr-FR')}</td>
    </tr>`);
  }

  rows.push(`
    <tr style="border-top: 2px solid #111;">
      <td style="padding: 14px 0 0 0; font-size: 16px; font-weight: 700; color: #111;">${et('totals.total')}</td>
      <td style="padding: 14px 0 0 0; font-size: 16px; font-weight: 700; color: #111; text-align: right;">${formatAmount(data.total_cents, cur, data.locale ?? 'fr-FR')}</td>
    </tr>`);

  return `<table width="100%" cellpadding="0" cellspacing="0">${rows.join('')}</table>`;
}

// ============================================================
// MAIN RENDERER
// ============================================================

export function renderOrderConfirmation(data: OrderConfirmationData): { html: string; text: string } {
  const hasPhysical = data.items.some(i => i.product_type === 'physical');
  const hasDigital = data.items.some(i => i.product_type === 'digital');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${et('doc.title')} — ${esc(data.order_number)}</title>
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
                      ${et('header.confirmed')}
                    </h2>
                    <p style="margin: 0; font-size: 15px; color: #666;">
                      ${et('header.hi')} ${esc(data.customer_email)}, ${et('header.thanks')}
                    </p>
                    <p style="margin: 8px 0 0 0; font-size: 14px; color: #999;">
                      ${et('header.orderLabel')} <strong style="color: #111;">${esc(data.order_number)}</strong>
                    </p>
                  </td>
                </tr>

                <!-- Downloads (digital) -->
                ${hasDigital ? renderDownloadsBlock(data.items, data.store_base_url) : ''}

                <!-- Shipping address (physical) -->
                ${hasPhysical ? renderShippingBlock(data) : ''}

                <!-- Order items -->
                <tr>
                  <td style="padding: 0 0 24px 0;">
                    <h3 style="margin: 0 0 16px 0; font-size: 14px; font-weight: 600; color: #111; text-transform: uppercase; letter-spacing: 0.05em;">
                      ${et('section.summary')}
                    </h3>
                    ${renderItemsTable(data.items, data.currency ?? 'USD')}
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
                      ${et('footer.questions')}
                      <a href="mailto:${esc(data.customer_email)}" style="color: #666;">${esc(data.store_name)}</a>.
                      ${hasDigital ? et('footer.downloads.expiry') : ''}
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
  const cur = data.currency ?? 'USD';
  const itemLines = data.items.map(i =>
    `  ${i.title} × ${i.qty}  ${formatAmount(i.unit_price_cents * i.qty, cur, data.locale ?? 'fr-FR')}` +
    (i.product_type === 'digital' && i.download_token
      ? `\n  ${et('text.download')} ${data.store_base_url}/downloads/${i.download_token}`
      : '')
  ).join('\n');

  const text = [
    `${data.store_name} — ${et('text.title')}`,
    `${et('text.orderLabel')} ${data.order_number}`,
    '',
    `Hi ${data.customer_email}, ${et('text.thanks')}`,
    '',
    et('text.items'),
    itemLines,
    '',
    et('text.totals'),
    `${et('text.subtotal')}: ${formatAmount(data.subtotal_cents, cur, data.locale ?? 'fr-FR')}`,
    data.discount?.amount_cents ? `${et('text.discount')} (${data.discount.code}): -${formatAmount(data.discount.amount_cents, cur, data.locale ?? 'fr-FR')}` : '',
    `${et('text.shipping')} ${data.shipping_cents > 0 ? formatAmount(data.shipping_cents, cur, data.locale ?? 'fr-FR') : et('text.shipping.free')}`,
    data.tax_cents > 0 ? `${et('text.tax')} ${formatAmount(data.tax_cents, cur, data.locale ?? 'fr-FR')}` : '',
    `${et('text.total')} ${formatAmount(data.total_cents, cur, data.locale ?? 'fr-FR')}`,
    hasDigital ? et('text.download.expiry') : '',
  ].filter(l => l !== null && l !== undefined).join('\n').trim();

  return { html, text };
}
