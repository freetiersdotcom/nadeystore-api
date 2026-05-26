// =============================================================================
// src/__tests__/fixtures.ts
//
// Realistic API payload fixtures matching actual production formats.
// Use these in tests instead of ad-hoc inline objects.
//
// Sources verified:
//   Stripe:  https://docs.stripe.com/api/events/object
//            checkout.session.completed shape from Stripe docs + Merchant source
//   FedaPay: https://github.com/fedapay/fedapay-cli (raw event log)
//            Raw webhook format: { klass, id, type, entity (string), object_id }
// =============================================================================

// =============================================================================
// STRIPE FIXTURES
// =============================================================================

/**
 * Full checkout.session.completed event as Stripe sends it.
 * Fields accessed by Merchant's webhooks.ts:
 *   - event.id                              → deduplication
 *   - event.type                            → event routing
 *   - event.data.object.metadata.cart_id    → cart lookup
 *   - event.data.object.id                  → session ID for stripe.checkout.sessions.retrieve()
 *   - (retrieve) session.shipping_details   → shipping address
 *   - (retrieve) session.amount_total       → total
 *   - (retrieve) session.total_details      → tax/shipping breakdown
 *   - (retrieve) session.payment_intent     → order record
 */
export function stripeCheckoutCompletedEvent(opts: {
  cartId:        string;
  customerEmail: string;
  amountTotal?:  number;
  currency?:     string;
  sessionId?:    string;
  eventId?:      string;
  discountId?:   string;
  withShipping?: boolean;
} = { cartId: 'cart_test', customerEmail: 'buyer@test.com' }): object {
  const sessionId = opts.sessionId ?? 'cs_test_abc123';
  return {
    id:          opts.eventId ?? 'evt_test_stripe_001',
    object:      'event',
    api_version: '2024-11-20',
    created:     Math.floor(Date.now() / 1000),
    type:        'checkout.session.completed',
    data: {
      object: {
        id:             sessionId,
        object:         'checkout.session',
        status:         'complete',
        payment_status: 'paid',
        mode:           'payment',
        currency:       (opts.currency ?? 'xof').toLowerCase(),
        amount_total:   opts.amountTotal ?? 2000,
        customer_email: opts.customerEmail,
        payment_intent: 'pi_test_paymentintent_001',
        metadata: {
          cart_id: opts.cartId,
          ...(opts.discountId && {
            discount_id:   opts.discountId,
            discount_code: 'TESTCODE',
            discount_type: 'fixed_amount',
          }),
        },
        // shipping_details is null when collect_shipping was false
        shipping_details: opts.withShipping ? {
          name:    'Jean Dupont',
          phone:   null,
          address: {
            line1:       '12 Rue de la Paix',
            line2:       null,
            city:        'Cotonou',
            state:       null,
            postal_code: '229',
            country:     'BJ',
          },
        } : null,
        customer_details: {
          name:  'Jean Dupont',
          email: opts.customerEmail,
          phone: null,
        },
        total_details: {
          amount_discount: 0,
          amount_shipping: 0,
          amount_tax:      0,
        },
      },
    },
    livemode: false,
  };
}

/**
 * What stripe.checkout.sessions.retrieve() returns.
 * Called in the Stripe webhook handler after checkout.session.completed.
 */
export function stripeSessionRetrieved(opts: {
  cartId:        string;
  customerEmail: string;
  amountTotal?:  number;
  currency?:     string;
  sessionId?:    string;
  withShipping?: boolean;
}) {
  return {
    id:             opts.sessionId ?? 'cs_test_abc123',
    object:         'checkout.session',
    status:         'complete',
    currency:       (opts.currency ?? 'xof').toLowerCase(),
    amount_total:   opts.amountTotal ?? 2000,
    customer_email: opts.customerEmail,
    payment_intent: 'pi_test_paymentintent_001',
    metadata: { cart_id: opts.cartId },
    shipping_details: opts.withShipping ? {
      name:    'Jean Dupont',
      address: {
        line1:       '12 Rue de la Paix',
        line2:       null,
        city:        'Cotonou',
        state:       null,
        postal_code: '229',
        country:     'BJ',
      },
    } : null,
    customer_details: {
      name:  'Jean Dupont',
      email: opts.customerEmail,
    },
    total_details: {
      amount_discount: 0,
      amount_shipping: 0,
      amount_tax:      0,
    },
  };
}

// =============================================================================
// FEDAPAY FIXTURES
// =============================================================================

/**
 * Raw FedaPay webhook payload as actually POSTed to the endpoint.
 *
 * IMPORTANT: The `entity` field is a STRINGIFIED JSON string, not an object.
 * The `type` field is used (not `name`).
 * The `id` field is the FedaPay event ID (used for deduplication).
 * The `object_id` is the numeric transaction ID.
 *
 * Source: https://github.com/fedapay/fedapay-cli (events log output)
 */
export function fedaPayRawWebhookEvent(opts: {
  cartId:    string;           // stored as merchant_reference / reference
  txId?:     number;
  eventId?:  string;
  status?:   string;
  amount?:   number;
  eventType?: string;
}): string {
  const txId     = opts.txId     ?? 16851;
  const eventId  = opts.eventId  ?? 'AXVA3Z99XcBqjxRq9dZr';
  const status   = opts.status   ?? 'approved';
  const amount   = opts.amount   ?? 2000;
  const eventType = opts.eventType ?? 'transaction.approved';

  // The entity is a stringified transaction object
  // Note: currency_id (FK) is present, NOT currency ISO directly
  const entity = JSON.stringify({
    id:               txId,
    reference:        opts.cartId,   // merchant_reference becomes reference
    amount:           amount,
    description:      'Test payment',
    status,
    currency_id:      1,             // 1 = XOF in FedaPay's system
    customer_id:      2568,
    mode:             null,
    operation:        'payment',
    metadata:         {},
    custom_metadata:  null,
    commission:       null,
    fees:             null,
    amount_transferred: null,
    created_at:       new Date().toISOString(),
    updated_at:       new Date().toISOString(),
    approved_at:      status === 'approved' ? new Date().toISOString() : null,
    canceled_at:      null,
    declined_at:      status === 'declined' ? new Date().toISOString() : null,
    refunded_at:      null,
    transferred_at:   null,
    deleted_at:       null,
    last_error_code:  null,
    receipt_url:      null,
  });

  return JSON.stringify({
    klass:     'v1/event',
    id:        eventId,
    type:      eventType,
    entity,
    object_id: txId,
  });
}

/**
 * What GET /v1/transactions/:id returns from the FedaPay API.
 * Used in verifyFedaPayTransaction().
 */
export function fedaPayTransactionVerifyResponse(opts: {
  txId?:   number;
  status?: string;
  amount?: number;
}): object {
  return {
    v1_transaction: {
      id:               opts.txId   ?? 16851,
      klass:            'v1/transaction',
      reference:        'trx__hQ_test',
      amount:           opts.amount ?? 2000,
      status:           opts.status ?? 'approved',
      currency_id:      1,
      customer_id:      2568,
      created_at:       new Date().toISOString(),
      updated_at:       new Date().toISOString(),
      approved_at:      new Date().toISOString(),
      metadata:         {},
      custom_metadata:  null,
    },
  };
}

/**
 * What POST /v1/transactions returns from FedaPay API.
 */
export function fedaPayCreateTransactionResponse(txId = 16851): object {
  return {
    v1_transaction: {
      id:          txId,
      klass:       'v1/transaction',
      reference:   `trx__test_${txId}`,
      amount:      2000,
      status:      'pending',
      currency_id: 1,
      customer_id: null,
      created_at:  new Date().toISOString(),
      updated_at:  new Date().toISOString(),
    },
  };
}

/**
 * What POST /v1/transactions/:id/token returns.
 */
export function fedaPayTokenResponse(txId = 16851): object {
  return {
    token: `tok_test_${txId}`,
    url:   `https://checkout.sandbox.fedapay.com/checkout/${txId}`,
  };
}

/**
 * What GET /v1/transactions?per_page=1 returns (used to validate API key in setup route).
 */
export function fedaPayTransactionListResponse(): object {
  return {
    v1_transactions: [],
    meta: { page: 1, per_page: 1, total_count: 0 },
  };
}
