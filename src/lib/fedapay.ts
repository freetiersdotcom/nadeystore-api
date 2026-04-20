// =============================================================================
// src/lib/fedapay.ts
//
// FedaPay utilities used by the webhook handler and checkout route.
// No npm dependencies — uses Web Crypto API (native in Cloudflare Workers).
// =============================================================================

/**
 * Verify the X-FEDAPAY-SIGNATURE header from a FedaPay webhook.
 *
 * Header format: "t=<unix_timestamp>,s=<hmac_sha256_hex>"
 * Signed payload: "<timestamp>.<raw_body>"
 *
 * Throws on invalid signature, missing components, or payload older than 5 minutes.
 */
export async function verifyFedaPaySignature(
  rawBody: string,
  sigHeader: string,
  secret: string
): Promise<void> {
  const parts: Record<string, string> = {};
  for (const part of sigHeader.split(',')) {
    const i = part.indexOf('=');
    if (i > 0) parts[part.slice(0, i)] = part.slice(i + 1);
  }

  const timestamp = parts['t'];
  const signature = parts['s'];

  if (!timestamp || !signature) {
    throw new Error('x-fedapay-signature header is missing t= or s= components');
  }

  // Reject webhooks older than 5 minutes (replay attack prevention)
  const age = Math.floor(Date.now() / 1000) - parseInt(timestamp, 10);
  if (age > 300) {
    throw new Error(`Webhook is too old (${age}s). Possible replay attack.`);
  }

  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${timestamp}.${rawBody}`)
  );

  const expected = Array.from(new Uint8Array(mac))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Constant-time comparison — prevents timing attacks
  if (expected.length !== signature.length) {
    throw new Error('Webhook signature verification failed');
  }
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  if (diff !== 0) {
    throw new Error('Webhook signature verification failed');
  }
}

export interface FedaPayConfig {
  secret_key: string;
  webhook_secret: string;
  sandbox?: boolean;
}

/**
 * Create a FedaPay hosted checkout session.
 * Returns the checkout URL and transaction ID.
 *
 * cartId is stored as merchant_reference so the webhook handler
 * can look up the cart when the payment is confirmed.
 */
export async function createFedaPayCheckout(opts: {
  cartId: string;
  amountCents: number;
  currency: string;
  customerEmail: string;
  description: string;
  callbackUrl: string;
  config: FedaPayConfig;
}): Promise<{ checkout_url: string; transaction_id: number }> {
  const base = opts.config.sandbox
    ? 'https://sandbox-api.fedapay.com'
    : 'https://api.fedapay.com';

  const headers = {
    Authorization: `Bearer ${opts.config.secret_key}`,
    'Content-Type': 'application/json',
  };

  // Step 1: Create the transaction
  const createRes = await fetch(`${base}/v1/transactions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      description: opts.description,
      amount: opts.amountCents,
      currency: { iso: opts.currency },
      callback_url: opts.callbackUrl,
      // merchant_reference is how the webhook handler identifies the cart
      merchant_reference: opts.cartId,
      customer: { email: opts.customerEmail },
    }),
  });

  if (!createRes.ok) {
    const err = await createRes.text();
    throw new Error(`FedaPay createTransaction failed (${createRes.status}): ${err}`);
  }

  const created = await createRes.json() as { v1_transaction: { id: number } };
  const transactionId = created.v1_transaction.id;

  // Step 2: Get the hosted checkout URL
  const tokenRes = await fetch(`${base}/v1/transactions/${transactionId}/token`, {
    method: 'POST',
    headers,
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`FedaPay getToken failed (${tokenRes.status}): ${err}`);
  }

  const tokenData = await tokenRes.json() as { url: string };

  return {
    checkout_url: tokenData.url,
    transaction_id: transactionId,
  };
}

/**
 * Re-verify a transaction's status directly via FedaPay API.
 * Use for high-value orders as an extra safety check after webhook receipt.
 * Non-fatal — callers should log and proceed if this fails.
 */
export async function verifyFedaPayTransaction(
  transactionId: number,
  config: FedaPayConfig
): Promise<'approved' | 'other'> {
  const base = config.sandbox
    ? 'https://sandbox-api.fedapay.com'
    : 'https://api.fedapay.com';

  const res = await fetch(`${base}/v1/transactions/${transactionId}`, {
    headers: { Authorization: `Bearer ${config.secret_key}` },
  });

  if (!res.ok) throw new Error(`FedaPay API returned ${res.status}`);

  const data = await res.json() as { v1_transaction: { status: string } };
  return data.v1_transaction.status === 'approved' ? 'approved' : 'other';
}
