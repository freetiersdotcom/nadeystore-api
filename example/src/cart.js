// ============================================================
// CART STATE
// ============================================================
// The cart ID is the only thing stored in localStorage.
// All cart data (items, totals, discount) lives in the Worker.
// On every page that needs cart data, call loadCart() from api.js.
//
// This avoids stale price/availability data and makes the cart
// the single source of truth across tabs and sessions.
// ============================================================

const CART_ID_KEY = 'merchant_cart_id';

// ── Persistence ───────────────────────────────────────────────

export function getCartId() {
  return localStorage.getItem(CART_ID_KEY) || null;
}

export function setCartId(id) {
  localStorage.setItem(CART_ID_KEY, id);
}

export function clearCartId() {
  localStorage.removeItem(CART_ID_KEY);
  updateCartBadge(0);
}

// ── Badge ─────────────────────────────────────────────────────

/**
 * Update the cart icon badge.
 * Pass a count directly, or omit to read from a cached value.
 */
export function updateCartBadge(count) {
  const badge = document.getElementById('cart-count');
  if (!badge) return;
  const n = count ?? 0;
  badge.textContent = n;
  badge.style.display = n > 0 ? 'flex' : 'none';
}

// ── Helpers ───────────────────────────────────────────────────

/**
 * Total item count from cart API response.
 */
export function cartItemCount(cart) {
  if (!cart?.items) return 0;
  return cart.items.reduce((sum, item) => sum + item.qty, 0);
}

/**
 * Whether a cart contains any physical items.
 * Used to conditionally show the shipping address form.
 */
export function cartNeedsShipping(cart) {
  if (!cart?.items) return false;
  return cart.items.some((item) => item.product_type === 'physical');
}

/**
 * Format cents to a locale-aware price string.
 * currency defaults to XOF (West African CFA franc) — change to match your store.
 */
const ZERO_DECIMAL_CURRENCIES = new Set(['XOF', 'GNF', 'JPY', 'KRW', 'VND']);

export function formatPrice(amount, currency = 'XOF') {
  const cur = (currency || 'XOF').toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(cur);

  return new Intl.NumberFormat(undefined, {
    style:                 'currency',
    currency:              cur,
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
  }).format(isZeroDecimal ? amount : amount / 100);
}