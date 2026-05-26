// ============================================================
// SUCCESS PAGE
// ============================================================
// FedaPay redirects here with query params after payment.
// We clear the cart ID and show a contextual confirmation.
//
// FedaPay callback params (at minimum):
//   ?id=TX_ID&status=approved
//
// Do NOT verify payment status here by calling the FedaPay API.
// That creates a race condition with the webhook.
// The webhook handler creates the order — this page is UI only.
// ============================================================

import { clearCartId, updateCartBadge } from './cart.js';
import { t } from './i18n.js';

export function applyI18n() {
  // Page title
  document.title                                    = `${t('success.heading')} — Store`;

  // Main heading and message (initial/confirmed state)
  document.getElementById('success-heading')
    .textContent                                    = t('success.heading');
  document.getElementById('success-message')
    .textContent                                    = t('success.message');

  // Digital download note
  document.querySelector('#digital-note p:first-of-type')
    .textContent                                    = t('success.digital.title');
  document.querySelector('#digital-note p:last-of-type')
    .textContent                                    = t('success.digital.message');

  // Transaction ref label
  document.querySelector('#ref-container p:first-child')
    .textContent                                    = t('success.ref.label');

  // CTA
  document.querySelector('main a')
    .textContent                                    = t('success.cta');

  // Help text
  document.querySelector('main > p:last-child')
    .textContent                                    = t('success.help');
}


document.addEventListener('DOMContentLoaded', () => {
	
  applyI18n();
	
  const params = new URLSearchParams(window.location.search);

  // FedaPay params
  const transactionId = params.get('id');
  const status = params.get('status');

  // Stripe param (if Stripe was used)
  const sessionId = params.get('session_id');

  // Show transaction reference if available
  const refEl = document.getElementById('transaction-ref');
  const refContainer = document.getElementById('ref-container');

  if (transactionId && refEl && refContainer) {
    refEl.textContent = transactionId;
    refContainer.style.display = 'block';
  } else if (sessionId && refEl && refContainer) {
    refEl.textContent = sessionId;
    refContainer.style.display = 'block';
  }

  // If status is not approved/succeeded, show a softer message
  const isConfirmed = !status || status === 'approved' || status === 'succeeded';
  const headingEl = document.getElementById('success-heading');
  const messageEl = document.getElementById('success-message');

  if (!isConfirmed && headingEl) {
    headingEl.textContent = t('success.processing.heading');//'Payment processing';
    if (messageEl) messageEl.textContent = t('success.processing.message');//"We're confirming your payment. You'll receive an email once it's complete.";
  }

  // Check if the order had digital items — stored as a flag before redirect
  // (set by cart-page.js before initiating checkout)
  const hadDigitalItems = sessionStorage.getItem('merchant_had_digital') === 'true';
  sessionStorage.removeItem('merchant_had_digital');

  const digitalNoteEl = document.getElementById('digital-note');
  if (digitalNoteEl) {
    digitalNoteEl.style.display = hadDigitalItems ? 'block' : 'none';
  }

  // Clear cart — order is confirmed
  clearCartId();
  updateCartBadge(0);
});
