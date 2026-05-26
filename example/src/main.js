// ============================================================
// PRODUCT LISTING PAGE
// ============================================================

import { getProducts, createCart, addItems, updateCartItem, loadCart } from './api.js';
import { getCartId, setCartId, updateCartBadge, cartItemCount, formatPrice } from './cart.js';
import { t } from './i18n.js';

// ── Config ────────────────────────────────────────────────────

const STORE_CURRENCY = window.__MERCHANT_CURRENCY__ || 'XOF';

// Active filter: 'all' | 'physical' | 'digital'
let activeFilter = 'all';
let allProducts = [];

// ── Init ──────────────────────────────────────────────────────

async function init() {
  // Restore cart badge from API (cart may have been created on a previous visit)
  const cartId = getCartId();
  if (cartId) {
    const cart = await loadCart(cartId).catch(() => null);
    if (cart) updateCartBadge(cartItemCount(cart));
  }

  const grid = document.getElementById('products-grid');
  const loading = document.getElementById('loading');
  const errorEl = document.getElementById('error');

  try {
    allProducts = await getProducts();
    loading.style.display = 'none';

    if (allProducts.length === 0) {
      grid.innerHTML = `<div class="col-span-full text-center py-12 text-zinc-500">No products available yet.</div>`;
      return;
    }

    renderGrid();
    setupFilterTabs();
  } catch (err) {
    loading.style.display = 'none';
    errorEl.style.display = 'block';
    errorEl.querySelector('p').textContent = err.message;
    console.error('Failed to load products:', err);
  }
}

// ── Apply i18n.js ─────────────────────────────────────────────────

function applyI18n() {
	document.querySelector('#shop')
    .textContent                                    = t('nav.shop');

  // Hero
  document.querySelector('section h1')
    .textContent                                    = t('index.hero.title');
  document.querySelector('section p')
    .textContent                                    = t('index.hero.subtitle');

  // Filter tabs
  document.querySelector('[data-filter="all"]')
    .textContent                                    = t('index.filter.all');
  document.querySelector('[data-filter="physical"]')
    .textContent                                    = t('index.filter.physical');
  document.querySelector('[data-filter="digital"]')
    .textContent                                    = t('index.filter.digital');

  // Loading state (text node next to spinner)
  const loadingP = document.querySelector('#loading p');
  if (loadingP) loadingP.textContent               = t('index.loading');

  // Error state — title is the first <p>, subtitle is the second
  const errorPs = document.querySelectorAll('#error p');
  if (errorPs[0]) errorPs[0].textContent           = t('index.error.title');
  if (errorPs[1]) errorPs[1].textContent           = t('index.error.subtitle');

  // Email modal
  document.querySelector('#email-modal h2')
    .textContent                                    = t('modal.title');
  document.querySelector('#email-modal > div > p')
    .textContent                                    = t('modal.subtitle');
  document.getElementById('modal-email')
    .placeholder                                    = t('modal.placeholder');
  document.getElementById('modal-cancel')
    .textContent                                    = t('modal.cancel');
  document.getElementById('modal-confirm')
    .textContent                                    = t('modal.confirm');

  // Cart toast (static parts only — product title is set dynamically)
  document.querySelector('#cart-toast [data-toast-label]')
    ?.textContent                                   ?? null; // no static label key needed
  // NOTE: the toast's "Added to cart" label and "View cart" link are
  // rendered inline in showCartToast() — replace those with t() there.
  
  document.getElementById('toast-added')
    .textContent                                    = t('toast.addedToCart');
  document.getElementById('toast-view')
    .textContent                                    = t('modal.confirm');

}

// ── Rendering ─────────────────────────────────────────────────

function renderGrid() {
  const grid = document.getElementById('products-grid');

  const filtered = allProducts.filter((p) => {
    if (activeFilter === 'all') return true;
    // A product matches the filter if any of its variants match the type.
    // Most products will have a single type across variants.
    return p.variants.some((v) => (v.product_type || 'physical') === activeFilter);
  });

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="col-span-full text-center py-12 text-zinc-500">No ${activeFilter} products found.</div>`;
    return;
  }

  grid.innerHTML = filtered.map((product) => productCardHTML(product)).join('');

  // Bind interactions
  grid.querySelectorAll('.add-to-cart').forEach((btn) => {
    btn.addEventListener('click', handleAddToCart);
  });
  grid.querySelectorAll('.variant-select').forEach((select) => {
    select.addEventListener('change', handleVariantChange);
  });
}

function productCardHTML(product) {
  const defaultVariant = product.variants[0];
  const isDigital = (defaultVariant.product_type || 'physical') === 'digital';
  const image = defaultVariant.image_url || product.image_url
    || 'https://placehold.co/400x400/18181b/52525b?text=No+Image';

  return `
    <div class="group" data-product-id="${product.id}">
      <div class="aspect-square bg-zinc-900 rounded-xl overflow-hidden mb-4 relative">
        <img
          src="${image}"
          alt="${product.title}"
          class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          onerror="this.src='https://placehold.co/400x400/18181b/52525b?text=No+Image'"
        >
        <div class="absolute top-3 left-3 flex gap-2">
          ${isDigital
            ? `<span class="bg-indigo-600 text-white text-xs px-2 py-1 rounded font-medium">${t('card.badge.digital')}</span>`
            : ''}
          ${product.variants.length > 1
            ? `<span class="bg-black/70 text-white text-xs px-2 py-1 rounded">${product.variants.length} ${t('card.badge.options')}</span>`
            : ''}
        </div>
      </div>

      <h3 class="font-medium text-white mb-1">${product.title}</h3>
      <p class="text-zinc-400 text-sm mb-1">${formatPrice(defaultVariant.price_cents, STORE_CURRENCY)}</p>
      ${isDigital
        ? `<p class="text-indigo-400 text-xs mb-3">${t('card.tag.digital')}</p>`
        : `<p class="text-zinc-500 text-xs mb-3">${t('card.tag.physical')}</p>`}

      ${product.variants.length > 1 ? `
        <select class="variant-select w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-sm text-white mb-3 focus:outline-none focus:border-zinc-700">
          ${product.variants.map((v) => `
            <option
              value="${v.sku}"
              data-price="${v.price_cents}"
              data-type="${v.product_type || 'physical'}"
              data-image="${v.image_url || ''}"
            >${v.title} — ${formatPrice(v.price_cents, STORE_CURRENCY)}</option>
          `).join('')}
        </select>
      ` : ''}

      <button
        class="add-to-cart w-full bg-white text-black font-medium py-2.5 rounded-lg hover:bg-zinc-200 transition-colors"
        data-sku="${defaultVariant.sku}"
        data-product-type="${defaultVariant.product_type || 'physical'}"
      >
        ${t('card.addToCart')}
      </button>
    </div>
  `;
}

// ── Filter tabs ───────────────────────────────────────────────

function setupFilterTabs() {
  document.querySelectorAll('[data-filter]').forEach((tab) => {
    tab.addEventListener('click', () => {
      activeFilter = tab.dataset.filter;
      document.querySelectorAll('[data-filter]').forEach((t) => {
        const isActive = t.dataset.filter === activeFilter;
        t.classList.toggle('bg-white', isActive);
        t.classList.toggle('text-black', isActive);
        t.classList.toggle('text-zinc-400', !isActive);
      });
      renderGrid();
    });
  });
}

// ── Interactions ──────────────────────────────────────────────

function handleVariantChange(e) {
  const select = e.target;
  const card = select.closest('[data-product-id]');
  const btn = card.querySelector('.add-to-cart');
  const selectedOption = select.options[select.selectedIndex];
  btn.dataset.sku = select.value;
  btn.dataset.productType = selectedOption.dataset.type;
}

async function handleAddToCart(e) {
  const btn = e.target;
  const sku = btn.dataset.sku;
  const card = btn.closest('[data-product-id]');
  const productId = card.dataset.productId;
  const product = allProducts.find((p) => p.id === productId);

  btn.disabled = true;
  btn.textContent = t('card.adding');

  try {
    let cartId = getCartId();

    if (!cartId) {
      const email = await promptEmail();
      if (!email) {
        resetBtn(btn);
        return;
      }
      const cart = await createCart(email);
      cartId = cart.id;
      setCartId(cartId);
    }

    // Load current cart state to check for existing SKUs
    let cart = await loadCart(cartId).catch(() => null);

    let updatedCart;
    const existingItem = cart?.items?.find(i => i.sku === sku);

    if (existingItem) {
      // SKU already in cart — increment quantity via PATCH
      updatedCart = await updateCartItem(cartId, sku, existingItem.qty + 1);
    } else {
      // New SKU — pass full current items plus the new one to the replace route
      const updatedItems = [
        ...(cart?.items ?? []).map(i => ({ sku: i.sku, qty: i.qty })),
        { sku, qty: 1 },
      ];
      updatedCart = await addItems(cartId, updatedItems);
    }

    updateCartBadge(cartItemCount(updatedCart));

    btn.textContent = t('card.added');
    btn.classList.add('bg-green-500', 'text-white');
    btn.classList.remove('bg-white', 'text-black');
    showCartToast(product?.title || 'Item');

    setTimeout(() => resetBtn(btn), 1500);
  } catch (err) {
    console.error('Add to cart failed:', err);
    btn.textContent = 'Error — retry';
    btn.classList.add('bg-red-500', 'text-white');
    btn.classList.remove('bg-white', 'text-black');
    setTimeout(() => resetBtn(btn), 2000);
  }
}

function resetBtn(btn) {
  btn.disabled = false;
  btn.textContent = t('card.addToCart');
  btn.classList.remove('bg-green-500', 'bg-red-500', 'text-white');
  btn.classList.add('bg-white', 'text-black');
}

// ── Email prompt ──────────────────────────────────────────────
// The Worker requires an email to create a cart.
// This modal collects it on first add-to-cart.

function promptEmail() {
  return new Promise((resolve) => {
    const modal = document.getElementById('email-modal');
    const input = document.getElementById('modal-email');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');
    const errorEl = document.getElementById('modal-error');

    modal.style.display = 'flex';
    input.value = '';
    errorEl.style.display = 'none';
    input.focus();

    function confirm() {
      const email = input.value.trim();
      if (!email || !email.includes('@')) {
        errorEl.style.display = 'block';
        return;
      }
      cleanup();
      resolve(email);
    }

    function cancel() {
      cleanup();
      resolve(null);
    }

    function cleanup() {
      modal.style.display = 'none';
      confirmBtn.removeEventListener('click', confirm);
      cancelBtn.removeEventListener('click', cancel);
      input.removeEventListener('keypress', onKey);
    }

    function onKey(e) { if (e.key === 'Enter') confirm(); }

    confirmBtn.addEventListener('click', confirm);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keypress', onKey);
  });
}

// ── Cart toast ────────────────────────────────────────────────

function showCartToast(productTitle) {
  const toast = document.getElementById('cart-toast');
  if (!toast) return;
  toast.querySelector('[data-toast-title]').textContent = productTitle;
  toast.style.display = 'flex';
  clearTimeout(toast.__timer);
  toast.__timer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

applyI18n();

init();
