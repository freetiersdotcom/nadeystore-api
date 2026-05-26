import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';
import { getLocale, setLocale, INTL_LOCALE, type Locale } from './store';
import { translations, type TranslationKey } from './i18n';

interface LocaleContextValue {
  locale:         Locale;
  intlLocale:     string;
  toggleLocale:   () => void;
  setLocale:      (l: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(getLocale);

  const toggleLocale = useCallback(() => {
    const next: Locale = locale === 'fr' ? 'en' : 'fr';
    setLocale(next);
    setLocaleState(next);
  }, [locale]);

  const handleSetLocale = useCallback((l: Locale) => {
    setLocale(l);
    setLocaleState(l);
  }, []);

  return (
    <LocaleContext.Provider value={{
      locale,
      intlLocale: INTL_LOCALE[locale],
      toggleLocale,
      setLocale: handleSetLocale,
    }}>
      {children}
    </LocaleContext.Provider>
  );
}

export function useLocale(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) throw new Error('useLocale must be used within LocaleProvider');
  return ctx;
}

export function useT() {
  const { locale } = useLocale();
  return useCallback(
    (key: TranslationKey): string =>
      (translations[locale]?.[key] ?? translations.en[key] ?? key) as string,
    [locale]
  );
}
