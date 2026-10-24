// src/lib/currency.ts
// Minor-unit helpers shared by emails, the pay page API and settings.
// Amounts everywhere in the API are "cents": the currency's smallest unit.
// For zero-decimal currencies (XOF, JPY...) 1 cent = 1 unit; otherwise 100 cents = 1 unit.

const ZERO_DECIMAL = new Set([
  'XOF', 'XAF', 'GNF', 'JPY', 'KRW', 'RWF', 'UGX', 'VND', 'CLP', 'PYG', 'KMF', 'DJF', 'BIF', 'MGA', 'VUV', 'XPF',
]);

export function isZeroDecimal(currency: string): boolean {
  return ZERO_DECIMAL.has((currency || '').toUpperCase());
}

/** How many minor units make one major unit (1 for XOF, 100 for EUR). */
export function minorFactor(currency: string): number {
  return isZeroDecimal(currency) ? 1 : 100;
}
