import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Loader2, CheckCircle, AlertCircle, Eye, EyeOff, Copy, Check } from 'lucide-react';
import { api, StripeConfig, FedaPayConfig } from '../lib/api';
import { getAuth } from '../lib/store';
import { useT } from '../lib/locale-context';

export function SetupPayments() {
  const t = useT();
  return (
    <div>
      <div className="mb-6">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('setup.payments.title')}
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {t('setup.payments.description')}
        </p>
      </div>

      <div className="space-y-4">
        <StripeCard />
        <FedaPayCard />
      </div>
    </div>
  );
}

function StripeCard() {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['setup', 'stripe'],
    queryFn: () => api.getStripeConfig(),
  });

  const mutation = useMutation({
    mutationFn: (d: { stripe_secret_key: string; webhook_secret?: string }) =>
      api.saveStripeConfig(d),
    onSuccess: () => {
      refetch();
      setEditing(false);
      setSecretKey('');
      setWebhookSecret('');
    },
  });

  const { apiUrl } = getAuth();
  const webhookUrl = `${apiUrl}/v1/webhooks/stripe`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      stripe_secret_key: secretKey.trim(),
      webhook_secret: webhookSecret.trim() || undefined,
    });
  };

  return (
    <ProviderCard
      name="Stripe"
      logo={
        <svg viewBox="0 0 60 25" className="h-5 w-auto" fill="currentColor">
          <path d="M59.64 14.28h-8.06c.19 1.93 1.6 2.55 3.2 2.55 1.64 0 2.96-.37 4.05-.95v3.32a10 10 0 0 1-4.56 1c-4.01 0-6.83-2.5-6.83-7.48 0-4.19 2.39-7.52 6.3-7.52 3.92 0 5.96 3.28 5.96 7.5 0 .4-.04 1.26-.06 1.58zm-5.92-5.62c-1.03 0-2.17.73-2.17 2.58h4.25c0-1.85-1.07-2.58-2.08-2.58zM40.95 20.3c-1.44 0-2.32-.6-2.9-1.04l-.02 4.63-4.45.94V5.53h3.96l.1 1.2a4.76 4.76 0 0 1 3.23-1.5c2.79 0 5.39 2.5 5.39 7.52 0 5.32-2.55 7.56-5.31 7.56zm-.77-9.98c-.91 0-1.47.33-1.85.79l.02 6.1c.36.44.9.77 1.83.77 1.42 0 2.38-1.59 2.38-3.84 0-2.17-.99-3.82-2.38-3.82zM28.24 5.53h4.47v14.44h-4.47zm0-4.7L32.7 0v3.56l-4.47.94zM22.52 9.19l-.28-1.3H18.1V20h4.45V11.9c1.05-1.38 2.83-1.12 3.38-.94V5.53c-.57-.2-2.64-.52-3.4 3.66zM9.37 6.97L9.07 5.53H5.01V20h4.45v-8.58c0-.63.07-1.06.2-1.35.2-.44.54-.7 1.04-.7 1.03 0 1.44.93 1.44 2.27V20h4.45v-8.5c0-.62.07-1.05.21-1.33.2-.44.54-.7 1.05-.7 1.04 0 1.44.93 1.44 2.27V20h4.45V9.91c0-3.15-1.64-4.55-3.93-4.55-1.55 0-2.75.72-3.52 1.92a3.54 3.54 0 0 0-3.43-1.92c-1.43 0-2.56.65-3.29 1.61z"/>
        </svg>
      }
      configured={data?.configured ?? false}
      isLoading={isLoading}
      editing={editing}
      onEdit={() => setEditing(true)}
      onCancel={() => { setEditing(false); setSecretKey(''); setWebhookSecret(''); }}
    >
      {editing ? (
        <form onSubmit={handleSubmit} className="space-y-3 mt-4">
          <Field label={t('setup.secretKey')}>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder="sk_live_..."
                required
                className="w-full px-3 py-2 pr-10 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
              <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} tabIndex={-1}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>
          <Field label={t('setup.webhookSecret')}>
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={t('setup.webhookSecretPlaceholder')}
              className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
          </Field>
          {mutation.isError && (
            <p className="text-xs text-red-500">{(mutation.error as Error).message}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => { setEditing(false); setSecretKey(''); setWebhookSecret(''); }} className="px-3 py-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={mutation.isPending} className="px-3 py-1.5 text-sm font-semibold rounded-lg disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>
              {mutation.isPending ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      ) : (
        <WebhookReminder url={webhookUrl} copied={copied} onCopy={handleCopy} />
      )}
    </ProviderCard>
  );
}

function FedaPayCard() {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [secretKey, setSecretKey] = useState('');
  const [webhookSecret, setWebhookSecret] = useState('');
  const [sandbox, setSandbox] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['setup', 'fedapay'],
    queryFn: () => api.getFedaPayConfig(),
  });

  const mutation = useMutation({
    mutationFn: (d: { secret_key: string; webhook_secret?: string; sandbox: boolean }) =>
      api.saveFedaPayConfig(d),
    onSuccess: () => {
      refetch();
      setEditing(false);
      setSecretKey('');
      setWebhookSecret('');
    },
  });

  const { apiUrl } = getAuth();
  const webhookUrl = `${apiUrl}/v1/webhooks/fedapay`;

  const handleCopy = async () => {
    await navigator.clipboard.writeText(webhookUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    mutation.mutate({
      secret_key: secretKey.trim(),
      webhook_secret: webhookSecret.trim() || undefined,
      sandbox,
    });
  };

  return (
    <ProviderCard
      name="FedaPay"
      logo={
        <span className="text-base font-bold tracking-tight" style={{ color: 'var(--text)' }}>
          FedaPay
        </span>
      }
      configured={data?.configured ?? false}
      isLoading={isLoading}
      editing={editing}
      onEdit={() => {
        setSandbox(data?.sandbox ?? true);
        setEditing(true);
      }}
      onCancel={() => { setEditing(false); setSecretKey(''); setWebhookSecret(''); }}
      badge={
        data?.configured && data.sandbox ? (
          <span className="text-xs px-2 py-0.5 rounded font-medium bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
            {t('setup.sandboxBadge')}
          </span>
        ) : data?.configured && !data.sandbox ? (
          <span className="text-xs px-2 py-0.5 rounded font-medium bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
            {t('setup.liveBadge')}
          </span>
        ) : undefined
      }
    >
      {editing ? (
        <form onSubmit={handleSubmit} className="space-y-3 mt-4">
          {/* Sandbox toggle */}
          <div className="flex items-center justify-between p-3 rounded-lg" style={{ border: '1px solid var(--border)', background: sandbox ? 'rgba(245, 158, 11, 0.06)' : undefined }}>
            <div>
              <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>{t('setup.sandbox')}</p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                {sandbox ? t('setup.sandboxOn') : t('setup.sandboxOff')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setSandbox(!sandbox)}
              className="relative inline-flex h-5 w-9 items-center rounded-full transition-colors focus:outline-none flex-shrink-0"
              style={{ background: sandbox ? 'var(--accent)' : 'var(--border)' }}
            >
              <span className="inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform" style={{ transform: sandbox ? 'translateX(18px)' : 'translateX(3px)' }} />
            </button>
          </div>

          <Field label={t('setup.secretKey')}>
            <div className="relative">
              <input
                type={showKey ? 'text' : 'password'}
                value={secretKey}
                onChange={(e) => setSecretKey(e.target.value)}
                placeholder={sandbox ? 'sk_sandbox_...' : 'sk_live_...'}
                required
                className="w-full px-3 py-2 pr-10 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
              <button type="button" onClick={() => setShowKey(!showKey)} className="absolute right-3 top-1/2 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} tabIndex={-1}>
                {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
          </Field>
          <Field label={t('setup.webhookSecret')}>
            <input
              type="password"
              value={webhookSecret}
              onChange={(e) => setWebhookSecret(e.target.value)}
              placeholder={t('setup.webhookSecretPlaceholder')}
              className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
            />
          </Field>
          {mutation.isError && (
            <p className="text-xs text-red-500">{(mutation.error as Error).message}</p>
          )}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={() => { setEditing(false); setSecretKey(''); setWebhookSecret(''); }} className="px-3 py-1.5 text-sm" style={{ color: 'var(--text-muted)' }}>
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={mutation.isPending} className="px-3 py-1.5 text-sm font-semibold rounded-lg disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>
              {mutation.isPending ? t('common.saving') : t('common.save')}
            </button>
          </div>
        </form>
      ) : (
        <WebhookReminder url={webhookUrl} copied={copied} onCopy={handleCopy} />
      )}
    </ProviderCard>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────────

function ProviderCard({
  name,
  logo,
  configured,
  isLoading,
  editing,
  onEdit,
  onCancel,
  badge,
  children,
}: {
  name: string;
  logo: React.ReactNode;
  configured: boolean;
  isLoading: boolean;
  editing: boolean;
  onEdit: () => void;
  onCancel: () => void;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="p-5 rounded-lg" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {logo}
          {badge}
        </div>
        <div className="flex items-center gap-3">
          {isLoading ? (
            <Loader2 size={14} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          ) : configured ? (
            <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
              <CheckCircle size={13} /> {t('common.configured')}
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-muted)' }}>
              <AlertCircle size={13} /> {t('common.notConfigured')}
            </span>
          )}
          {!editing && (
            <button
              onClick={onEdit}
              className="text-xs font-medium px-3 py-1.5 rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
              style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
            >
              {configured ? t('setup.update') : t('setup.configure')}
            </button>
          )}
          {editing && (
            <button onClick={onCancel} className="text-xs" style={{ color: 'var(--text-muted)' }}>
              ✕
            </button>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
        {label}
      </label>
      {children}
    </div>
  );
}

function WebhookReminder({ url, copied, onCopy }: { url: string; copied: boolean; onCopy: () => void }) {
  const t = useT();
  return (
    <div className="mt-4 p-3 rounded-lg" style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)' }}>
      <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
        {t('webhooks.reminder.title')} — {t('webhooks.reminder.hint')}
      </p>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
          {url}
        </code>
        <button onClick={onCopy} className="p-1.5 rounded transition-colors hover:bg-[var(--bg-hover)] flex-shrink-0" style={{ color: 'var(--text-muted)' }}>
          {copied ? <Check size={13} className="text-green-500" /> : <Copy size={13} />}
        </button>
      </div>
    </div>
  );
}
