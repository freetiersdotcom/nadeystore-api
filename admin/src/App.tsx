import { useState, useEffect } from 'react';
import { getAuth, setAuth, setAuthWithUrl, clearAuth, getTheme, setTheme, getAgencyMode } from './lib/store';
import { api } from './lib/api';
import { Layout, Page } from './components/Layout';
import { Login } from './pages/Login';
import { Orders } from './pages/Orders';
import { Customers } from './pages/Customers';
import { Inventory } from './pages/Inventory';
import { Products } from './pages/Products';
import { Webhooks } from './pages/Webhooks';
import { Discounts } from './pages/Discounts';
import { Downloads } from './pages/Downloads';
import { SetupPayments } from './pages/SetupPayments';
import { SetupEmail } from './pages/SetupEmail';

const VALID_PAGES: Page[] = [
  'orders',
  'customers',
  'inventory',
  'products',
  'discounts',
  'downloads',
  'webhooks',
  'setup/payments',
  'setup/email',
];

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [currentPage, setCurrentPage] = useState<Page>('orders');
  const [theme, setThemeState] = useState<'light' | 'dark'>(getTheme());
  const [isAgency, setIsAgency] = useState(getAgencyMode());

  useEffect(() => {
    const auth = getAuth();
    if (auth.isAuthenticated) {
      api
        .getOrders({ limit: 1 })
        .then(() => {
          setIsAuthenticated(true);
          setIsAgency(getAgencyMode());
        })
        .catch(() => {
          clearAuth();
          setIsAuthenticated(false);
        })
        .finally(() => setIsLoading(false));
    } else {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash.slice(1) as Page;
      if (VALID_PAGES.includes(hash)) {
        // Guard: non-agency users can't navigate to agency-only pages
        const agencyOnlyPages: Page[] = ['webhooks', 'setup/payments', 'setup/email'];
        if (agencyOnlyPages.includes(hash) && !getAgencyMode()) return;
        setCurrentPage(hash);
      }
    };
    handleHashChange();
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleLogin = async (apiUrl: string, apiKey: string) => {
    // If VITE_API_URL is set, apiUrl is already resolved from env
    const hasEnvUrl = Boolean(import.meta.env.VITE_API_URL);
    if (hasEnvUrl) {
      setAuth(apiKey);
    } else {
      setAuthWithUrl(apiUrl, apiKey);
    }
    try {
      await api.getOrders({ limit: 1 });
      setIsAuthenticated(true);
      setIsAgency(getAgencyMode());
    } catch {
      clearAuth();
      throw new Error('Invalid access key. Please try again.');
    }
  };

  const handleLogout = () => {
    clearAuth();
    setIsAuthenticated(false);
  };

  const handleThemeToggle = () => {
    const newTheme = theme === 'light' ? 'dark' : 'light';
    setTheme(newTheme);
    setThemeState(newTheme);
  };

  const handleNavigate = (page: Page) => {
    window.location.hash = page;
    setCurrentPage(page);
  };

  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ background: 'var(--bg-app)' }}
      >
        <div className="animate-pulse text-[var(--text-muted)]">Loading...</div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <Layout
      currentPage={currentPage}
      onNavigate={handleNavigate}
      onLogout={handleLogout}
      theme={theme}
      onThemeToggle={handleThemeToggle}
      isAgency={isAgency}
    >
      {currentPage === 'orders' && <Orders />}
      {currentPage === 'customers' && <Customers />}
      {currentPage === 'inventory' && <Inventory />}
      {currentPage === 'products' && <Products />}
      {currentPage === 'discounts' && <Discounts />}
      {currentPage === 'downloads' && <Downloads />}
      {currentPage === 'webhooks' && isAgency && <Webhooks />}
      {currentPage === 'setup/payments' && isAgency && <SetupPayments />}
      {currentPage === 'setup/email' && isAgency && <SetupEmail />}
    </Layout>
  );
}
