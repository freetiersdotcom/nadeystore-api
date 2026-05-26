// Simple auth store using localStorage
const API_URL_KEY = 'merchant_api_url';
const API_KEY_KEY = 'merchant_api_key';
const THEME_KEY = 'merchant_theme';
const AGENCY_MODE_KEY = 'merchant_agency_mode';

export type AuthState = {
  apiUrl: string;
  apiKey: string;
  isAuthenticated: boolean;
};

export function getAuth(): AuthState {
  const apiUrl =
    import.meta.env.VITE_API_URL || localStorage.getItem(API_URL_KEY) || '';
  const apiKey = localStorage.getItem(API_KEY_KEY) || '';
  return {
    apiUrl,
    apiKey,
    isAuthenticated: Boolean(apiUrl && apiKey),
  };
}

export function setAuth(apiKey: string) {
  // API URL comes from env var; only persist the key
  if (!import.meta.env.VITE_API_URL) {
    // Fallback: if no env var, key field doubles as "url :: key" — not used
    // in normal deployments, but keeps dev mode working without env var
    localStorage.setItem(API_URL_KEY, 'http://localhost:8787');
  }
  localStorage.setItem(API_KEY_KEY, apiKey);
}

export function setAuthWithUrl(apiUrl: string, apiKey: string) {
  localStorage.setItem(API_URL_KEY, apiUrl);
  localStorage.setItem(API_KEY_KEY, apiKey);
}

export function clearAuth() {
  localStorage.removeItem(API_URL_KEY);
  localStorage.removeItem(API_KEY_KEY);
}

export function getTheme(): 'light' | 'dark' {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function setTheme(theme: 'light' | 'dark') {
  localStorage.setItem(THEME_KEY, theme);
  document.documentElement.classList.toggle('dark', theme === 'dark');
}

export type Locale = 'fr' | 'en';

// Store currency — set once to match the merchant's store config
export const STORE_CURRENCY = import.meta.env.VITE_STORE_CURRENCY || 'XOF';

// Locale — persisted in localStorage, toggleable
export function getLocale(): Locale {
  return (localStorage.getItem('locale') as Locale) || 'fr';
}

export function setLocale(locale: Locale): void {
  localStorage.setItem('locale', locale);
}

// Maps locale to Intl locale string for number/date formatting
export const INTL_LOCALE: Record<Locale, string> = {
  fr: 'fr-FR',
  en: 'en-US',
};

// Agency mode — unlocked via triple-click on logo at login
// Persists in localStorage so it survives page reloads
export function getAgencyMode(): boolean {
  return localStorage.getItem(AGENCY_MODE_KEY) === 'true';
}

export function setAgencyMode(enabled: boolean) {
  if (enabled) {
    localStorage.setItem(AGENCY_MODE_KEY, 'true');
  } else {
    localStorage.removeItem(AGENCY_MODE_KEY);
  }
}

// Initialize theme on load
if (typeof window !== 'undefined') {
  setTheme(getTheme());
}
