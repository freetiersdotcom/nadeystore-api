import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Loader2, CheckCircle, AlertCircle, Eye, EyeOff, Send } from 'lucide-react';
import { api, EmailProvider } from '../lib/api';
import { useT } from '../lib/locale-context';

const PROVIDERS: { value: EmailProvider; label: string }[] = [
  { value: 'resend',   label: 'Resend'   },
  { value: 'sendgrid', label: 'SendGrid' },
  { value: 'mailgun',  label: 'Mailgun'  },
  { value: 'postmark', label: 'Postmark' },
];

export function SetupEmail() {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [provider, setProvider] = useState<EmailProvider>('resend');
  const [apiKey, setApiKey] = useState('');
  const [fromAddress, setFromAddress] = useState('');
  const [mailgunDomain, setMailgunDomain] = useState('');
  const [mailgunRegion, setMailgunRegion] = useState<'US' | 'EU'>('US');
  const [showKey, setShowKey] = useState(false);
  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [testLoading, setTestLoading] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['setup', 'email'],
    queryFn: () => api.getEmailConfig(),
  });

  const mutation = useMutation({
    mutationFn: () =>
      api.saveEmailConfig({
        provider,
        api_key: apiKey.trim(),
        from_address: fromAddress.trim(),
        ...(provider === 'mailgun'
          ? { mailgun_domain: mailgunDomain.trim(), mailgun_region: mailgunRegion }
          : {}),
      }),
    onSuccess: () => {
      refetch();
      setEditing(false);
      setApiKey('');
    },
  });

  const handleEdit = () => {
    setProvider(data?.provider || 'resend');
    setFromAddress(data?.from_address || '');
    setTestResult(null);
    setEditing(true);
  };

  const handleProviderChange = (p: EmailProvider) => {
    setProvider(p);
    setApiKey('');
  };

  const handleTest = async () => {
    setTestLoading(true);
    setTestResult(null);
    try {
      const res = await api.testEmail(testEmail || undefined);
      setTestResult({
        ok: res.ok,
        message: res.ok
          ? `Test email sent via ${res.provider}${res.message_id ? ` (${res.message_id})` : ''}`
          : res.error || 'Test failed',
      });
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Test failed' });
    } finally {
      setTestLoading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('setup.email.title')}
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {t('setup.email.description')}
        </p>
      </div>

      <div
        className="p-5 rounded-lg"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <span className="font-medium text-sm" style={{ color: 'var(--text)' }}>
              {isLoading
                ? '—'
                : data?.configured
                  ? `${PROVIDERS.find((p) => p.value === data.provider)?.label ?? data.provider}`
                  : t('common.notConfigured')}
            </span>
            {isLoading ? (
              <Loader2 size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
            ) : data?.configured ? (
              <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                <CheckCircle size={13} /> {t('common.configured')}
              </span>
            ) : (
              <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
                <AlertCircle size={13} /> {t('common.notConfigured')}
              </span>
            )}
          </div>
          {!editing && (
            <button
              onClick={handleEdit}
              className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {data?.configured ? t('setup.email.update') : t('setup.email.configure')}
            </button>
          )}
        </div>

        {/* Current config display */}
        {!editing && data?.configured && data.from_address && (
          <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {t('setup.email.currentFrom')} {data.from_address}
          </p>
        )}

        {/* Edit form */}
        {editing && (
          <form onSubmit={handleSubmit} className="space-y-4 pt-2 border-t" style={{ borderColor: 'var(--border)' }}>
            {/* Provider selector */}
            <div className="pt-4">
              <label className="block text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
                {t('setup.email.provider')}
              </label>
              <div className="grid grid-cols-4 gap-2">
                {PROVIDERS.map((p) => (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => handleProviderChange(p.value)}
                    className="px-3 py-2 text-xs font-medium rounded-lg transition-colors"
                    style={{
                      border: `1px solid ${provider === p.value ? 'var(--accent)' : 'var(--border)'}`,
                      background: provider === p.value ? 'rgba(245, 199, 71, 0.1)' : 'var(--bg-card)',
                      color: provider === p.value ? 'var(--text)' : 'var(--text-muted)',
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </div>

            {/* API Key */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                {t('setup.email.apiKey')}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={data?.configured
                    ? `(${t('common.optional')})`
                    : t('setup.email.apiKey')}
                  required={!data?.configured}
                  className="w-full px-3 py-2 pr-10 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
                />
                <button
                  type="button"
                  onClick={() => setShowKey(!showKey)}
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ color: 'var(--text-muted)' }}
                  tabIndex={-1}
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
            </div>

            {/* From address */}
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                {t('setup.email.from')}
              </label>
              <input
                type="text"
                value={fromAddress}
                onChange={(e) => setFromAddress(e.target.value)}
                placeholder={t('setup.email.fromPlaceholder')}
                required
                className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
            </div>

            {/* Mailgun extras */}
            {provider === 'mailgun' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    {t('setup.email.domain')}
                  </label>
                  <input
                    type="text"
                    value={mailgunDomain}
                    onChange={(e) => setMailgunDomain(e.target.value)}
                    placeholder="mg.yourstore.com"
                    required
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
                    {t('setup.email.region')}
                  </label>
                  <select
                    value={mailgunRegion}
                    onChange={(e) => setMailgunRegion(e.target.value as 'US' | 'EU')}
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
                  >
                    <option value="US">US</option>
                    <option value="EU">EU</option>
                  </select>
                </div>
              </div>
            )}

            {mutation.isError && (
              <p className="text-xs text-red-500">{(mutation.error as Error).message}</p>
            )}

            <div className="flex gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="px-3 py-1.5 text-sm"
                style={{ color: 'var(--text-muted)' }}
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={mutation.isPending}
                className="px-3 py-1.5 text-sm font-semibold rounded-lg disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {mutation.isPending ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        )}

        {/* Test email section — shown when configured */}
        {data?.configured && !editing && (
          <div className="mt-4 pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
            <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('setup.email.sendTest')}
            </p>
            <div className="flex gap-2">
              <input
                type="email"
                value={testEmail}
                onChange={(e) => setTestEmail(e.target.value)}
                placeholder={t('setup.email.testToPlaceholder')}
                className="flex-1 px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
              <button
                onClick={handleTest}
                disabled={testLoading}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg disabled:opacity-50 transition-colors hover:bg-[var(--bg-hover)]"
                style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
              >
                {testLoading
                  ? <><Loader2 size={13} className="animate-spin" /> {t('setup.email.sending')}</>
                  : <><Send size={13} /> {t('setup.email.sendTest')}</>
                }
              </button>
            </div>
            {testResult && (
              <p className={`text-xs mt-2 ${testResult.ok ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                {testResult.ok ? '✓' : '✗'} {testResult.message}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
