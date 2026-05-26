import { useState, useRef } from 'react';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import { getAgencyMode, setAgencyMode } from '../lib/store';
import { useT } from '../lib/locale-context';

type LoginProps = {
  onLogin: (apiUrl: string, apiKey: string) => Promise<void>;
};

const STORE_NAME = import.meta.env.VITE_STORE_NAME || 'merchant';
const HAS_API_URL = Boolean(import.meta.env.VITE_API_URL);

export function Login({ onLogin }: LoginProps) {
  const t = useT();

  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [agencyMode, setAgencyModeState] = useState(getAgencyMode());

  // Triple-click on logo to reveal agency mode toggle
  const logoClickCount = useRef(0);
  const logoClickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [agencyUnlocked, setAgencyUnlocked] = useState(getAgencyMode());

  const handleLogoClick = () => {
    logoClickCount.current += 1;
    if (logoClickTimer.current) clearTimeout(logoClickTimer.current);
    logoClickTimer.current = setTimeout(() => {
      logoClickCount.current = 0;
    }, 600);
    if (logoClickCount.current >= 3) {
      logoClickCount.current = 0;
      setAgencyUnlocked(true);
    }
  };

  const handleAgencyToggle = (enabled: boolean) => {
    setAgencyMode(enabled);
    setAgencyModeState(enabled);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    const resolvedUrl = HAS_API_URL
      ? (import.meta.env.VITE_API_URL as string)
      : apiUrl.replace(/\/$/, '');

    try {
      await onLogin(resolvedUrl, apiKey.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : t('login.connectionFailed'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'var(--bg-app)' }}
    >
      <div className="w-full max-w-sm">
        {/* Logo + store name */}
        <div className="text-center mb-8">
          <button
            type="button"
            onClick={handleLogoClick}
            className="inline-flex items-center justify-center mb-4 select-none focus:outline-none"
            tabIndex={-1}
          >
            <svg
              className="w-10 h-10"
              viewBox="0 0 88 88"
              fill="currentColor"
              style={{ color: 'var(--text)' }}
            >
              <path d="M46 84V88H42V84H46ZM84 46V42C84 21.0132 66.9868 4 46 4H42C21.0132 4 4 21.0132 4 42V46C4 66.9868 21.0132 84 42 84V88C18.804 88 0 69.196 0 46V42C1.01484e-06 19.1665 18.221 0.588624 40.916 0.0136719L42 0H46L47.084 0.0136719C69.779 0.588625 88 19.1665 88 42V46L87.9863 47.084C87.4114 69.779 68.8335 88 46 88V84C66.9868 84 84 66.9868 84 46Z" />
              <path d="M55.6 29C60.4 29 63.6 32.2 63.6 37V61H57.2V40.2C57.2 37 55.6 35.4 52.4 35.4C49.2 35.4 47.6 37 47.6 40.2V61H41.2V35.4H31.6V61H25.2V29H47.6V37C47.6 32.2 50.8 29 55.6 29Z" />
            </svg>
          </button>
          <h1 className="text-base font-semibold" style={{ color: 'var(--text)' }}>
            {STORE_NAME}
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
            {t('login.tagline')}
          </p>
        </div>

        <div
          className="p-6 rounded-lg shadow-sm"
          style={{ background: 'var(--bg-content)', border: '1px solid var(--border)' }}
        >
          <form onSubmit={handleSubmit} className="space-y-3">
            {/* API URL — only shown if no env var AND agency mode unlocked */}
            {!HAS_API_URL && agencyMode && (
              <div>
                <label
                  className="block text-xs font-medium mb-1.5"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {t('login.apiUrl')}
                </label>
                <input
                  type="url"
                  value={apiUrl}
                  onChange={(e) => setApiUrl(e.target.value)}
                  placeholder={t('login.apiUrlPlaceholder')}
                  required
                  className="w-full px-3 py-2.5 text-sm font-mono rounded-sm transition-colors focus:outline-none focus:ring-2"
                  style={{
                    background: 'var(--bg-content)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    ['--tw-ring-color' as string]: 'var(--accent)',
                  }}
                />
              </div>
            )}

            {/* Access key field */}
            <div>
              <label
                className="block text-xs font-medium mb-1.5"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('login.accessKey')}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t('login.accessKeyPlaceholder')}
                  required
                  autoComplete="current-password"
                  className="w-full px-3 py-2.5 pr-10 text-sm font-mono rounded-sm transition-colors focus:outline-none focus:ring-2"
                  style={{
                    background: 'var(--bg-content)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                    ['--tw-ring-color' as string]: 'var(--accent)',
                  }}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 transition-colors"
                  style={{ color: 'var(--text-muted)' }}
                  tabIndex={-1}
                >
                  {showKey ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>

            {error && (
              <p className="text-xs text-red-500 py-1">{error}</p>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-1 px-4 py-2.5 text-sm font-semibold rounded-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              style={{
                background: 'var(--accent)',
                color: 'var(--text-inverse)',
              }}
            >
              {loading && <Loader2 size={15} className="animate-spin" />}
              {loading ? t('common.loading') : t('login.submit')}
            </button>
          </form>

          {/* Agency mode toggle — only visible after triple-click unlock */}
          {agencyUnlocked && (
            <div
              className="mt-4 pt-4 border-t flex items-center justify-between"
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
                {t('login.agencyMode')}
              </span>
              <button
                type="button"
                onClick={() => handleAgencyToggle(!agencyMode)}
                className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none"
                style={{
                  background: agencyMode ? 'var(--accent)' : 'var(--border)',
                }}
              >
                <span
                  className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform"
                  style={{
                    transform: agencyMode ? 'translateX(18px)' : 'translateX(3px)',
                  }}
                />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
