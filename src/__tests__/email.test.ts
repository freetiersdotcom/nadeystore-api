// =============================================================================
// src/__tests__/email.test.ts
//
// Tests for each email provider adapter.
// Verifies that each provider constructs the correct HTTP request
// without actually sending email. All outbound fetch is mocked.
// =============================================================================

import { describe, it, expect, afterEach } from 'vitest';
import { mockFetch } from './setup';

// Import provider factories directly (bypassing the dynamic import in index.ts
// which doesn't work in DO event handlers — see Cloudflare known issues)
import { createResendProvider } from '../lib/email/resend';
import { createSendGridProvider } from '../lib/email/sendgrid';
import { createMailgunProvider } from '../lib/email/mailgun';
import { createPostmarkProvider } from '../lib/email/postmark';
import { renderOrderConfirmation } from '../lib/email/template';

const BASE_CONFIG = {
  api_key:      'test_api_key',
  from_address: 'Test Store <noreply@teststore.com>',
};

// ── Resend ────────────────────────────────────────────────────────────────────

describe('Resend adapter', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('sends to correct Resend endpoint', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;

    restore = mockFetch((url, init) => {
      capturedUrl  = url;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ id: 'email_123' }), { status: 200 });
    });

    const provider = await createResendProvider({ ...BASE_CONFIG, provider: 'resend' });
    await provider.send({ to: 'buyer@test.com', subject: 'Test', html: '<p>Hello</p>' });

    expect(capturedUrl).toBe('https://api.resend.com/emails');
    expect(capturedBody.to).toBe('buyer@test.com');
    expect(capturedBody.from).toBe(BASE_CONFIG.from_address);
    expect(capturedBody.subject).toBe('Test');
  });

  it('throws on non-200 response', async () => {
    restore = mockFetch(() => new Response('{"error":"invalid_api_key"}', { status: 401 }));
    const provider = await createResendProvider({ ...BASE_CONFIG, provider: 'resend' });
    await expect(provider.send({ to: 'a@b.com', subject: 'S', html: 'H' })).rejects.toThrow();
  });
});

// ── SendGrid ──────────────────────────────────────────────────────────────────

describe('SendGrid adapter', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('sends to correct SendGrid endpoint with correct structure', async () => {
    let capturedUrl  = '';
    let capturedBody: any = null;

    restore = mockFetch((url, init) => {
      capturedUrl  = url;
      capturedBody = JSON.parse(init?.body as string);
      return new Response('', { status: 202 });
    });

    const provider = await createSendGridProvider({ ...BASE_CONFIG, provider: 'sendgrid' });
    await provider.send({ to: 'buyer@test.com', subject: 'Test', html: '<p>Hi</p>' });

    expect(capturedUrl).toContain('sendgrid.com');
    expect(capturedBody.personalizations[0].to[0].email).toBe('buyer@test.com');
  });
});

// ── Mailgun ───────────────────────────────────────────────────────────────────

describe('Mailgun adapter', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('sends to correct Mailgun endpoint with domain', async () => {
    let capturedUrl = '';

    restore = mockFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ id: 'mg_123', message: 'Queued' }), { status: 200 });
    });

    const provider = await createMailgunProvider({
      ...BASE_CONFIG,
      provider: 'mailgun',
      mailgun_domain: 'mg.teststore.com',
    });
    await provider.send({ to: 'buyer@test.com', subject: 'Test', html: '<p>Hi</p>' });

    expect(capturedUrl).toContain('api.mailgun.net');
    expect(capturedUrl).toContain('mg.teststore.com');
  });

  it('uses EU endpoint when mailgun_region is eu', async () => {
    let capturedUrl = '';
    restore = mockFetch((url) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ id: 'mg_eu_123' }), { status: 200 });
    });

    const provider = await createMailgunProvider({
      ...BASE_CONFIG,
      provider: 'mailgun',
      mailgun_domain: 'mg.teststore.com',
      mailgun_region: 'eu',
    });
    await provider.send({ to: 'a@b.com', subject: 'S', html: 'H' });

    expect(capturedUrl).toContain('api.eu.mailgun.net');
  });
});

// ── Postmark ──────────────────────────────────────────────────────────────────

describe('Postmark adapter', () => {
  let restore: () => void;
  afterEach(() => restore?.());

  it('sends to correct Postmark endpoint', async () => {
    let capturedUrl  = '';
    let capturedBody: any = null;

    restore = mockFetch((url, init) => {
      capturedUrl  = url;
      capturedBody = JSON.parse(init?.body as string);
      return new Response(JSON.stringify({ MessageID: 'pm_123' }), { status: 200 });
    });

    const provider = await createPostmarkProvider({ ...BASE_CONFIG, provider: 'postmark' });
    await provider.send({ to: 'buyer@test.com', subject: 'Test', html: '<p>Hi</p>' });

    expect(capturedUrl).toContain('api.postmarkapp.com');
    expect(capturedBody.To).toBe('buyer@test.com');
  });
});

// ── Email template ────────────────────────────────────────────────────────────

describe('renderOrderConfirmation()', () => {
  const BASE = {
    order_number:   'ORD-TEST-001',
    customer_email: 'buyer@test.com',
    store_name:     'Test Store',
    store_base_url: 'https://teststore.com',
    subtotal_cents: 3000,
    tax_cents:      0,
    shipping_cents: 0,
    total_cents:    3000,
    currency:       'XOF',
    discount:       null,
    shipping_address: null,
    shipping_name:  null,
  };

  it('includes order number in HTML', () => {
    const { html } = renderOrderConfirmation({
      ...BASE,
      items: [{ sku: 'SKU-1', title: 'Widget', qty: 1, unit_price_cents: 3000, product_type: 'physical' }],
    });
    expect(html).toContain('ORD-TEST-001');
  });

  it('includes download link for digital items', () => {
    const { html } = renderOrderConfirmation({
      ...BASE,
      items: [{
        sku:             'DIG-1',
        title:           'Ebook',
        qty:             1,
        unit_price_cents: 1000,
        product_type:    'digital',
        download_token:  'abc123token',
      }],
    });
    expect(html).toContain('abc123token');
    expect(html).toContain('/v1/downloads/');
  });

  it('does not include download link for physical items', () => {
    const { html } = renderOrderConfirmation({
      ...BASE,
      items: [{
        sku: 'PHYS-1', title: 'T-Shirt', qty: 1, unit_price_cents: 2000, product_type: 'physical',
      }],
    });
    expect(html).not.toContain('/v1/downloads/');
  });

  it('includes shipping address when provided', () => {
    const { html } = renderOrderConfirmation({
      ...BASE,
      items: [{ sku: 'S', title: 'S', qty: 1, unit_price_cents: 1000, product_type: 'physical' }],
      shipping_name: 'Jean Dupont',
      shipping_address: {
        line1: '12 Rue Test', city: 'Cotonou', postal_code: '229', country: 'BJ',
      },
    });
    expect(html).toContain('Jean Dupont');
    expect(html).toContain('Cotonou');
  });

  it('includes discount row when discount applied', () => {
    const { html } = renderOrderConfirmation({
      ...BASE,
      subtotal_cents: 3000,
      total_cents:    2700,
      items: [{ sku: 'S', title: 'S', qty: 1, unit_price_cents: 3000, product_type: 'physical' }],
      discount: { code: 'SAVE300', amount_cents: 300 },
    });
    expect(html).toContain('SAVE300');
  });

  it('includes both physical and digital items in mixed order', () => {
    const { html } = renderOrderConfirmation({
      ...BASE,
      items: [
        { sku: 'P1', title: 'T-Shirt', qty: 1, unit_price_cents: 2000, product_type: 'physical' },
        { sku: 'D1', title: 'Ebook', qty: 1, unit_price_cents: 1000, product_type: 'digital', download_token: 'tok123' },
      ],
    });
    expect(html).toContain('T-Shirt');
    expect(html).toContain('Ebook');
    expect(html).toContain('tok123');
  });
});
