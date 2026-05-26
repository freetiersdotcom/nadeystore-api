import { STORE_CURRENCY, getLocale, INTL_LOCALE } from './store';

const ZERO_DECIMAL_CURRENCIES = new Set(['XOF', 'GNF', 'JPY', 'KRW', 'VND']);

export function formatPrice(
  amount: number,
  currency: string = STORE_CURRENCY
): string {
  const cur = (currency || STORE_CURRENCY).toUpperCase();
  const isZeroDecimal = ZERO_DECIMAL_CURRENCIES.has(cur);
  const locale = INTL_LOCALE[getLocale()];

  return new Intl.NumberFormat(locale, {
    style:                 'currency',
    currency:              cur,
    minimumFractionDigits: isZeroDecimal ? 0 : 2,
    maximumFractionDigits: isZeroDecimal ? 0 : 2,
  }).format(isZeroDecimal ? amount : amount / 100);
}