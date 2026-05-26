// ============================================================
// DOWNLOAD PAGE
// ============================================================
// Customer arrives here from the email link:
//   https://yourstore.com/downloads.html?token=abc123
//
// Flow:
//   1. Read token from URL
//   2. Call GET /v1/downloads/:token (Accept: application/json)
//   3. On success — show product title, download button, remaining count
//   4. On error — show contextual expired / not found message
// ============================================================

import { getDownload } from './api.js';
import { t } from './i18n.js';

async function init() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get('token');

  const loadingEl  = document.getElementById('dl-loading');
  const errorEl    = document.getElementById('dl-error');
  const contentEl  = document.getElementById('dl-content');

  if (!token) {
    showError(errorEl, loadingEl, 'No download token found in this link. Please check your email.');
    return;
  }

  try {
    const dl = await getDownload(token);

	console.log(JSON.stringify(dl));
	console.log(dl.downloads_remaining);
	console.log(dl.redirect_url);
	console.log(dl.expires_at);
	
    // Hide loading
    if (loadingEl) loadingEl.style.display = 'none';

    // Populate content
    const titleEl = document.getElementById('dl-product-title');
    const filenameEl = document.getElementById('dl-filename');
    const remainingEl = document.getElementById('dl-remaining');
    const expiresEl = document.getElementById('dl-expires');
    const dlBtn = document.getElementById('dl-button');

    if (titleEl) titleEl.textContent = dl.sku  || 'Your file'; // dl.product_title || 'Your file';
    if (filenameEl) filenameEl.textContent = assetDisplayName(dl.redirect_url) || '';
    if (remainingEl) remainingEl.textContent = dl.downloads_remaining ?? '—';

    if (expiresEl && dl.expires_at) {
      const expiry = new Date(dl.expires_at);
      expiresEl.textContent = expiry.toLocaleDateString(undefined, {
        year: 'numeric', month: 'long', day: 'numeric',
      });
    }

    if (dlBtn) {
      dlBtn.href = dl.redirect_url;
      dlBtn.addEventListener('click', () => {
        // Decrement the displayed count optimistically
        if (remainingEl) {
          const current = parseInt(remainingEl.textContent);
          if (!isNaN(current)) remainingEl.textContent = Math.max(0, current - 1);
        }
      });
    }

    if (contentEl) contentEl.style.display = 'block';

  } catch (err) {
    let message;

    if (err.status === 404) {
      message = t('dl.err.notFound');//'This download link is invalid or has already expired.';
    } else if (err.code === 'download_limit_reached') {
      message = t('dl.err.limitReached');//'This download link has been used the maximum number of times. Please contact support to request a new link.';
    } else if (err.code === 'token_expired') {
      message = t('dl.err.expired');//'This download link has expired. Please contact support to request a new link.';
    } else {
      message = err.message || t('dl.err.generic');//'Something went wrong. Please try again or contact support.';
    }

    showError(errorEl, loadingEl, message);
  }
}

/**
 * Extract the raw filename from a digital_asset_key.
 * "assets/abc123/my-file-name.pdf" → "my-file-name.pdf"
 */
export function assetFilename(digitalAssetKey) {
  return digitalAssetKey.split('/').pop() ?? digitalAssetKey;
}

/**
 * Convert a slug-style filename to a human-readable display name.
 * Inverts the lowercase-hyphen storage convention.
 *
 * "my-file-name.pdf" → "My File Name.pdf"
 * "guide-to-investing-2024.epub" → "Guide To Investing 2024.epub"
 */
export function assetDisplayName(digitalAssetKey) {
  const filename = assetFilename(digitalAssetKey);
  const lastDot = filename.lastIndexOf('.');
  const hasExt = lastDot > 0;
  const base = hasExt ? filename.slice(0, lastDot) : filename;
  const ext  = hasExt ? filename.slice(lastDot)    : '';

  const displayBase = base
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return displayBase + ext;
}

function applyI18n() {
  // Page title
  document.title                                    = `${t('dl.product.fallback')} — Store`;

  // Loading state
  document.querySelector('#dl-loading p')
    .textContent                                    = t('dl.loading');

  // Error state — heading only (message is set dynamically)
  document.querySelector('#dl-error h1')
    .textContent                                    = t('dl.error.title');
  document.querySelector('#dl-error a')
    .textContent                                    = t('dl.back');

  // Metadata labels
  const metaLabels = document.querySelectorAll(
    '#dl-content .bg-zinc-900 .text-zinc-400'
  );
  if (metaLabels[0]) metaLabels[0].textContent      = t('dl.remaining');
  if (metaLabels[1]) metaLabels[1].textContent      = t('dl.expires');

  // Download button
  document.querySelector('#dl-button-cta')
    .textContent                                    = t('dl.cta');

  /*document.getElementById('dl-button')
    .querySelector('svg')
    .insertAdjacentText('afterend', ` ${t('dl.cta')}`);*/
  // NOTE: the button contains an SVG followed by a text node.
  // Safer to set the text node directly once you confirm DOM structure.
  // Alternative: wrap the label in a <span> in the HTML for easy targeting.

  // Safety notice
  document.querySelector('#dl-content > p')
    .textContent                                    = t('dl.notice');
}


function showError(errorEl, loadingEl, message) {
  if (loadingEl) loadingEl.style.display = 'none';
  if (errorEl) {
    errorEl.querySelector('[data-error-message]').textContent = message;
    errorEl.style.display = 'block';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  
  applyI18n();
  init();

});
