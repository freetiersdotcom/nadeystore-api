// ============================================================
// CART PAGE
// ============================================================

import {
  loadCart, addItems, updateCartItem, removeCartItem,
  applyDiscount, removeDiscount, setShipping, setCartCurrency,
  startCheckout
} from './api.js';
import { getCartId, setCartId, clearCartId, updateCartBadge, cartItemCount, cartNeedsShipping, formatPrice } from './cart.js';
import { t } from './i18n.js';

// ── Config ────────────────────────────────────────────────────

// Change to 'stripe' if Stripe is configured instead of FedaPay.
// In a real multi-provider setup you'd let the user choose or
// detect based on their country.
const PAYMENT_PROVIDER = window.__MERCHANT_PROVIDER__ || 'fedapay';

const SUCCESS_URL = window.location.origin + '/success.html';
const CANCEL_URL  = window.location.origin + '/cart.html';

// ── State ─────────────────────────────────────────────────────

let currentCart = null;

// ── Init ──────────────────────────────────────────────────────

async function init() {
  const cartId = getCartId();

  if (!cartId) {
    showEmpty();
    return;
  }

  showLoading(true);

  try {
    currentCart = await loadCart(cartId);

    if (!currentCart) {
      // Cart expired (404) — clear stale ID
      clearCartId();
      showEmpty();
      return;
    }
	
	// Set store currency if not already set
	if (!currentCart.currency || currentCart.currency !== (window.__MERCHANT_CURRENCY__ || 'XOF')) {
	  await initCartCurrency();
	  currentCart = await loadCart(getCartId());
	}

    updateCartBadge(cartItemCount(currentCart));
    renderCart();
  } catch (err) {
    showError(err.message);
  } finally {
    showLoading(false);
  }
}

async function initCartCurrency() {
  const STORE_CURRENCY = window.__MERCHANT_CURRENCY__ || 'XOF';
  try {
    await setCartCurrency(getCartId(), STORE_CURRENCY);
  } catch (err) {
    // Non-fatal — cart will use its default currency
    console.warn('Could not set cart currency:', err.message);
  }
}

// ── Apply i18n.js ─────────────────────────────────────────────────

function applyI18n() {
  // Page title
  document.title                                    = `${t('cart.title')} — Store`;

  // Nav
  document.querySelector('header a[href="/"]')
    .textContent                                    = 'STORE'; // brand name, not translated

	document.querySelector('#shop')
    .textContent                                    = t('nav.shop');

  // Page heading
  document.querySelector('main h1')
    .textContent                                    = t('cart.title');

  // Empty state
  document.querySelector('#empty-cart h2')
    .textContent                                    = t('cart.empty.title');
  document.querySelector('#empty-cart p')
    .textContent                                    = t('cart.empty.subtitle');
  document.querySelector('#empty-cart a')
    .textContent                                    = t('cart.empty.cta');

  // Shipping section heading
  document.querySelector('#shipping-section h2')
    .textContent                                    = t('cart.shipping.heading');

  // Shipping field labels
  const labels = document.querySelectorAll('#shipping-section label');
  // Labels appear in DOM order — match to keys accordingly
  const labelKeys = [
    'cart.shipping.name',
    'cart.shipping.line1',
    'cart.shipping.line2',
    'cart.shipping.city',
    'cart.shipping.state',
    'cart.shipping.postal',
    'cart.shipping.country',
  ];
  labels.forEach((el, i) => {
    if (labelKeys[i]) el.textContent = t(labelKeys[i]);
  });

  // Shipping field placeholders
  document.getElementById('shipping-name')
    .placeholder                                    = t('cart.shipping.name.ph');
  document.getElementById('shipping-line1')
    .placeholder                                    = t('cart.shipping.line1.ph');
  document.getElementById('shipping-line2')
    .placeholder                                    = t('cart.shipping.line2.ph');
  document.getElementById('shipping-city')
    .placeholder                                    = t('cart.shipping.city.ph');
  document.getElementById('shipping-state')
    .placeholder                                    = t('cart.shipping.state.ph');
  document.getElementById('shipping-postal')
    .placeholder                                    = t('cart.shipping.postal.ph');
  document.getElementById('shipping-country')
    .placeholder                                    = t('cart.shipping.country.ph');

  // Order summary heading
  document.querySelector('#cart-summary h2')
    .textContent                                    = t('cart.summary.title');

  // Subtotal / Total labels (the values themselves are set by renderSummary())
  const subtotalLabel = document.querySelector('#subtotal')
    ?.previousElementSibling;
  if (subtotalLabel) subtotalLabel.textContent      = t('cart.summary.subtotal');

  const totalLabel = document.querySelector('#total')
    ?.previousElementSibling;
  if (totalLabel) totalLabel.textContent            = t('cart.summary.total');

  // Discount code input & button
  document.getElementById('discount-code')
    .placeholder                                    = t('cart.discount.placeholder');
  document.getElementById('apply-discount')
    .textContent                                    = t('cart.discount.apply');

  // Checkout button (initial state — JS updates this during processing)
  document.getElementById('checkout-btn')
    .textContent                                    = t('cart.checkout.cta');

  // Provider / secure label (initial state — renderSummary() may overwrite)
  document.getElementById('provider-label')
    .textContent     
}

// ── Rendering ─────────────────────────────────────────────────

function renderCart() {
  if (!currentCart || currentCart.items.length === 0) {
    showEmpty();
    return;
  }

  show('cart-content');
  hide('empty-cart');

  renderLineItems();
  renderSummary();
  renderShippingForm();
}

function renderLineItems() {
  const container = document.getElementById('cart-items');

  container.innerHTML = currentCart.items.map((item) => {
    const isDigital = item.product_type === 'digital';
    const image = item.image_url
      || 'https://placehold.co/80x80/18181b/52525b?text=•';

    return `
      <div class="flex gap-4 py-4 border-b border-zinc-800" data-sku="${item.sku}">
        <div class="w-20 h-20 bg-zinc-900 rounded-lg overflow-hidden flex-shrink-0">
          <img
            src="${image}"
            alt="${item.title}"
            class="w-full h-full object-cover"
            onerror="this.src='https://placehold.co/80x80/18181b/52525b?text=•'"
          >
        </div>

        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 mb-0.5">
            <h3 class="font-medium text-white truncate">${item.title}</h3>
            ${isDigital
              ? `<span class="text-xs bg-indigo-600 text-white px-1.5 py-0.5 rounded flex-shrink-0">${t('cart.item.digital')}</span>`
              : ''}
          </div>
          <p class="text-zinc-400 text-sm">${formatPrice(item.unit_price_cents, currentCart.currency)}</p>

          <div class="flex items-center gap-3 mt-2">
            ${isDigital
              ? `<!-- Digital items are non-quantity — always qty 1 -->
                 <span class="text-zinc-600 text-xs">${t('cart.item.qty')} ${item.qty}</span>`
              : `<div class="flex items-center border border-zinc-700 rounded-lg">
                   <button class="qty-btn px-3 py-1 text-zinc-400 hover:text-white transition-colors" data-delta="-1">−</button>
                   <span class="qty-display px-2 text-white text-sm">${item.qty}</span>
                   <button class="qty-btn px-3 py-1 text-zinc-400 hover:text-white transition-colors" data-delta="1">+</button>
                 </div>`}
            <button class="remove-btn text-zinc-500 hover:text-red-400 text-sm transition-colors">
              ${t('cart.item.remove')}
            </button>
          </div>
        </div>

        <div class="text-right flex-shrink-0">
          <p class="font-medium text-white">${formatPrice(item.unit_price_cents * item.qty, currentCart.currency)}</p>
        </div>
      </div>
    `;
  }).join('');

  // Quantity buttons
  container.querySelectorAll('.qty-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-sku]');
      const sku = row.dataset.sku;
      const delta = parseInt(e.target.dataset.delta);
      const item = currentCart.items.find((i) => i.sku === sku);
      if (!item) return;

      const newQty = item.qty + delta;
      if (newQty <= 0) {
        await updateItem(sku, 0);
      } else {
        await updateItem(sku, newQty);
      }
    });
  });

  // Remove buttons
  container.querySelectorAll('.remove-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      const row = e.target.closest('[data-sku]');
      await updateItem(row.dataset.sku, 0);
    });
  });
}

function renderSummary() {
  const amounts = currentCart.totals || {};
  const discount = currentCart.discount;

  // Subtotal
  const subtotalEl = document.getElementById('subtotal');
  if (subtotalEl) subtotalEl.textContent = formatPrice(amounts.subtotal_cents || 0, currentCart.currency);

  // Discount row
  const discountRow = document.getElementById('discount-row');
  const discountAmount = document.getElementById('discount-amount');
  const appliedCode = document.getElementById('applied-code');

  if (discount && discountRow) {
    discountRow.style.display = 'flex';
    if (appliedCode) appliedCode.textContent = discount.code;
    if (discountAmount) discountAmount.textContent = `−${formatPrice(discount.amount_cents, currentCart.currency)}`;
  } else if (discountRow) {
    discountRow.style.display = 'none';
  }

  // Total
  const totalEl = document.getElementById('total');
  if (totalEl) totalEl.textContent = formatPrice(amounts.total_cents || 0, currentCart.currency);

  // Provider label
  const providerLabel = document.getElementById('provider-label');
  if (providerLabel) {
    providerLabel.textContent = PAYMENT_PROVIDER === 'fedapay'
      ? t('cart.checkout.via.fedapay')
      : t('cart.checkout.via.stripe')
  }
}

function renderShippingForm() {
  const shippingSection = document.getElementById('shipping-section');
  
  if (!shippingSection) return;

  console.log(shippingSection);
  const needsShipping = cartNeedsShipping(currentCart);
  shippingSection.style.display = needsShipping ? 'block' : 'none';

  // Update checkout button state
  updateCheckoutButton();
}

function updateCheckoutButton() {
  const btn = document.getElementById('checkout-btn');
  if (!btn) return;

  const empty = !currentCart?.items?.length;
  const needsShipping = cartNeedsShipping(currentCart);
  const shippingDone = !needsShipping || isShippingFormComplete();

  btn.disabled = empty || !shippingDone;
  btn.title = !shippingDone ? t('cart.checkout.needShipping') : '';
}

function isShippingFormComplete() {
  const required = ['shipping-name', 'shipping-line1', 'shipping-city', 'shipping-country'];
  return required.every((id) => {
    const el = document.getElementById(id);
    return el && el.value.trim().length > 0;
  });
}

// ── Item updates ──────────────────────────────────────────────

async function updateItem(sku, qty) {
  try {
    if (qty === 0) {
      currentCart = await removeCartItem(getCartId(), sku);
    } else {
      currentCart = await updateCartItem(getCartId(), sku, qty);
    }
    updateCartBadge(cartItemCount(currentCart));
    renderCart();
  } catch (err) {
    showError(err.message);
  }
}

// ── Discount code ─────────────────────────────────────────────

async function handleApplyDiscount() {
  const input = document.getElementById('discount-code');
  const errorEl = document.getElementById('discount-error');
  const applyBtn = document.getElementById('apply-discount');
  const code = input?.value.trim().toUpperCase();

  if (!code) return;

  applyBtn.disabled = true;
  applyBtn.textContent = 'Applying...';
  if (errorEl) errorEl.style.display = 'none';

  try {
    currentCart = await applyDiscount(getCartId(), code);
    input.value = '';
    renderCart(); // was renderSummary() — renderCart covers everything
    // Show success inline
    if (errorEl) {
      errorEl.textContent = `Code "${code}" applied!`;
      errorEl.className = 'text-green-400 text-sm mt-1';
      errorEl.style.display = 'block';
      setTimeout(() => { errorEl.style.display = 'none'; }, 3000);
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || 'Invalid discount code';
      errorEl.className = 'text-red-400 text-sm mt-1';
      errorEl.style.display = 'block';
    }
  } finally {
    applyBtn.disabled = false;
    applyBtn.textContent = 'Apply';
  }
}

async function handleRemoveDiscount() {
  try {
    currentCart = await removeDiscount(getCartId());
    renderCart(); // was renderSummary() — renderCart covers everything
  } catch (err) {
    console.error('Remove discount failed:', err);
  }
}

// ── Shipping form save ────────────────────────────────────────

async function saveShippingAddress() {
  const address = {
    name:        document.getElementById('shipping-name')?.value.trim(),
    line1:       document.getElementById('shipping-line1')?.value.trim(),
    line2:       document.getElementById('shipping-line2')?.value.trim() || undefined,
    city:        document.getElementById('shipping-city')?.value.trim(),
    state:       document.getElementById('shipping-state')?.value.trim() || undefined,
    postal_code: document.getElementById('shipping-postal')?.value.trim() || undefined,
    country:     document.getElementById('shipping-country')?.value.trim(),
  };

  await setShipping(getCartId(), address);
}

// ── Checkout ──────────────────────────────────────────────────

async function handleCheckout() {
  const btn = document.getElementById('checkout-btn');
  const errorEl = document.getElementById('checkout-error');

  if (errorEl) errorEl.style.display = 'none';
  btn.disabled = true;
  btn.textContent = t('cart.checkout.processing');

  try {
    // Save shipping address first if needed
    if (cartNeedsShipping(currentCart)) {
      if (!isShippingFormComplete()) {
        throw new Error(t('cart.checkout.needShipping'));
      }
      await saveShippingAddress();
    }

    const { checkout_url } = await startCheckout(getCartId(), PAYMENT_PROVIDER, {
      successUrl: SUCCESS_URL,
      cancelUrl: CANCEL_URL,
    });

    // Don't clear cart yet — let success page do it after confirmation
    window.location.href = checkout_url;
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || t('cart.checkout.error');
      errorEl.style.display = 'block';
    }
    btn.disabled = false;
    btn.textContent = t('cart.checkout.cta');
    console.error('Checkout error:', err);
  }
}

// ── UI helpers ────────────────────────────────────────────────

function showEmpty() {
  hide('cart-content');
  hide('loading-state');
  show('empty-cart');
}

function showLoading(on) {
  const el = document.getElementById('loading-state');
  if (el) el.style.display = on ? 'flex' : 'none';
}

function showError(msg) {
  const el = document.getElementById('page-error');
  if (el) {
    el.textContent = msg;
    el.style.display = 'block';
  }
}

function show(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'block';
}

function hide(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// ── Bootstrap ─────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  
  applyI18n();
  init();
  
  document.getElementById('checkout-btn')?.addEventListener('click', handleCheckout);
  document.getElementById('apply-discount')?.addEventListener('click', handleApplyDiscount);
  document.getElementById('remove-discount')?.addEventListener('click', handleRemoveDiscount);

  document.getElementById('discount-code')?.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleApplyDiscount();
  });

  // Re-validate checkout button as shipping fields are filled
  document.getElementById('shipping-section')?.addEventListener('input', updateCheckoutButton);
});
