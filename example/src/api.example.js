// ============================================================
// MERCHANT API CLIENT
// ============================================================
// Set these via your build tool / env or replace directly:
//   PUBLIC_API_URL  — your Worker URL
//   PUBLIC_KEY      — your public API key (pk_...)

const API_URL = window.__MERCHANT_API_URL__ || 'http://localhost:8787';
const PUBLIC_KEY = 'pk_your_public_key_here' || window.__MERCHANT_PUBLIC_KEY__ || 'pk_your_public_key_here';

async function request(endpoint, options = {}) {
  const headers = {
    Authorization: `Bearer ${PUBLIC_KEY}`,
    ...options.headers,
  };

  // Only set Content-Type for JSON bodies — never for FormData
  if (options.body && typeof options.body === 'string') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers,
  });

  const data = await res.json();

  if (!res.ok) {
    const err = new Error(data.error?.message || 'API request failed');
    err.code = data.error?.code || 'unknown';
    err.status = res.status;
    throw err;
  }

  return data;
}

// ============================================================
// PRODUCTS
// ============================================================

export async function getProducts({ status = 'active' } = {}) {
  const data = await request(`/v1/products?status=${status}`);
  return data.items.filter((p) => p.variants?.length > 0);
}

export async function getProduct(id) {
  return request(`/v1/products/${id}`);
}

// ============================================================
// CARTS
// ============================================================

/**
 * Create a new cart. email is required by the API.
 */
export async function createCart(email) {
  return request('/v1/carts', {
    method: 'POST',
    body: JSON.stringify({ customer_email: email }),
  });
}

/**
 * Load an existing cart by ID.
 * Returns null (not throws) on 404 — caller should create a new cart.
 */
export async function loadCart(cartId) {
  try {
    return await request(`/v1/carts/${cartId}`);
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/**
 * Add or update items in a cart.
 * items: Array<{ sku: string, qty: number }>
 */
export async function addItems(cartId, items) {
  return request(`/v1/carts/${cartId}/items`, {
    method: 'POST',
    body: JSON.stringify({ items }),
  });
}

export async function updateCartItem(cartId, sku, qty) {
  return request(`/v1/carts/${cartId}/items/${encodeURIComponent(sku)}`, {
    method: 'PATCH',
    body: JSON.stringify({ qty }),
  });
}

export async function removeCartItem(cartId, sku) {
  return request(`/v1/carts/${cartId}/items/${encodeURIComponent(sku)}`, {
    method: 'DELETE',
  });
}

export async function setCartCurrency(cartId, currency) {
  return request(`/v1/carts/${cartId}/currency`, {
    method: 'PATCH',
    body: JSON.stringify({ currency }),
  });
}

/**
 * Apply a discount code to the cart.
 * Returns updated cart or throws with a user-readable message.
 */
export async function applyDiscount(cartId, code) {
  return request(`/v1/carts/${cartId}/discount`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
}

/**
 * Remove the applied discount from the cart.
 */
export async function removeDiscount(cartId) {
  return request(`/v1/carts/${cartId}/discount`, {
    method: 'DELETE',
  });
}

/**
 * Save a shipping address to the cart.
 * Required before checkout when cart has physical items.
 */
export async function setShipping(cartId, address) {
  return request(`/v1/carts/${cartId}/shipping`, {
    method: 'PATCH',
    body: JSON.stringify(address),
  });
}

// ============================================================
// CHECKOUT — provider-aware
// ============================================================

const CHECKOUT_PROVIDERS = {
  fedapay: (cartId, body) => request(`/v1/carts/${cartId}/checkout/fedapay`, { method: 'POST', body: JSON.stringify(body) }),
  stripe:  (cartId, body) => request(`/v1/carts/${cartId}/checkout`,  { method: 'POST', body: JSON.stringify(body) }),
  // Add new providers here:
  // paystack: (cartId, body) => request(`/v1/carts/${cartId}/checkout/paystack`, { method: 'POST', body: JSON.stringify(body) }),
};

/**
 * Start checkout with a specific payment provider.
 *
 * @param {string} cartId
 * @param {'fedapay'|'stripe'} provider
 * @param {{ successUrl: string, cancelUrl: string }} urls
 * @returns {Promise<{ checkout_url: string }>}
 */
export async function startCheckout(cartId, provider, { successUrl, cancelUrl }) {
  const handler = CHECKOUT_PROVIDERS[provider];
  if (!handler) throw new Error(`Unknown payment provider: "${provider}". Supported: ${Object.keys(CHECKOUT_PROVIDERS).join(', ')}`);

  return handler(cartId, {
    success_url: successUrl,
    cancel_url: cancelUrl,
  });
}

// ============================================================
// DOWNLOADS
// ============================================================

/**
 * Validate a download token and get file metadata.
 * Returns { product_title, filename, downloads_remaining, expires_at, download_url }
 * or throws with a user-readable error.
 */
export async function getDownload(token) {
  return request(`/v1/downloads/${token}`, {
    headers: { Accept: 'application/json' },
  });
}
