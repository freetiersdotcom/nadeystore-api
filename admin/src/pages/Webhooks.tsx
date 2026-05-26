import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Loader2,
  RefreshCw,
  Plus,
  Trash2,
  Copy,
  Check,
  AlertCircle,
  CheckCircle,
  Clock,
  RotateCw,
} from 'lucide-react';
import { api, Webhook, WebhookDetail } from '../lib/api';
import { Modal } from '../components/Modal';
import { useT } from '../lib/locale-context';
import clsx from 'clsx';

// Event labels and descriptions remain in English as they are technical API identifiers.
// See i18n-notes.md for the recommended fix.
const WEBHOOK_EVENTS = [
  { value: 'order.created',  label: 'Order Created',    description: 'When a new order is placed' },
  { value: 'order.updated',  label: 'Order Updated',    description: 'When order status changes' },
  { value: 'order.shipped',  label: 'Order Shipped',    description: 'When order is marked shipped' },
  { value: 'order.refunded', label: 'Order Refunded',   description: 'When order is refunded' },
  { value: 'inventory.low',  label: 'Low Inventory',    description: 'When stock drops below threshold' },
  { value: 'order.*',        label: 'All Order Events', description: 'Subscribe to all order events' },
  { value: '*',              label: 'All Events',       description: 'Subscribe to everything' },
] as const;

export function Webhooks() {
  const queryClient = useQueryClient();
  const t = useT();

  const [createModal, setCreateModal] = useState(false);
  const [selectedWebhook, setSelectedWebhook] = useState<string | null>(null);
  const [newSecret, setNewSecret] = useState<string | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  // Form state
  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>(['order.created']);

  // Fetch webhooks
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api.getWebhooks(),
  });

  // Fetch webhook detail
  const { data: webhookDetail } = useQuery({
    queryKey: ['webhook', selectedWebhook],
    queryFn: () => api.getWebhook(selectedWebhook!),
    enabled: !!selectedWebhook,
  });

  const webhooks = data?.items || [];

  // Mutations
  const createMutation = useMutation({
    mutationFn: (data: { url: string; events: string[] }) => api.createWebhook(data),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      setCreateModal(false);
      setNewUrl('');
      setNewEvents(['order.created']);
      setNewSecret(result.secret);
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.updateWebhook>[1] }) =>
      api.updateWebhook(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      queryClient.invalidateQueries({ queryKey: ['webhook', selectedWebhook] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteWebhook(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhooks'] });
      setSelectedWebhook(null);
    },
  });

  const rotateSecretMutation = useMutation({
    mutationFn: (id: string) => api.rotateWebhookSecret(id),
    onSuccess: (result) => {
      setNewSecret(result.secret);
    },
  });

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUrl || newEvents.length === 0) return;
    createMutation.mutate({ url: newUrl, events: newEvents });
  };

  const copySecret = async (secret: string) => {
    await navigator.clipboard.writeText(secret);
    setCopiedSecret(true);
    setTimeout(() => setCopiedSecret(false), 2000);
  };

  const toggleEvent = (event: string) => {
    if (newEvents.includes(event)) {
      setNewEvents(newEvents.filter((e) => e !== event));
    } else {
      setNewEvents([...newEvents, event]);
    }
  };

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 h-9">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('webhooks.title')}
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ['webhooks'] })}
            disabled={isFetching}
            className="p-2 rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
            style={{ color: 'var(--text-muted)' }}
          >
            <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => setCreateModal(true)}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded font-semibold transition-colors"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
          >
            <Plus size={16} />
            {t('webhooks.new')}
          </button>
        </div>
      </div>

      {/* Webhooks list */}
      <div
        className="rounded overflow-hidden"
        style={{ background: 'var(--bg-content)', border: '1px solid var(--border)' }}
      >
        {isLoading ? (
          <div className="py-12 flex items-center justify-center">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : webhooks.length === 0 ? (
          <div className="py-12 text-center">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('webhooks.empty')}
            </p>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              {t('webhooks.emptyHint')}
            </p>
          </div>
        ) : (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {webhooks.map((webhook) => (
              <div
                key={webhook.id}
                onClick={() => setSelectedWebhook(webhook.id)}
                className="px-4 py-4 cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div
                      className={clsx(
                        'w-2 h-2 rounded-full',
                        webhook.status === 'active' ? 'bg-green-500' : 'bg-gray-400'
                      )}
                    />
                    <div>
                      <p className="font-mono text-sm">{webhook.url}</p>
                      <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {webhook.events.join(', ')}
                      </p>
                    </div>
                  </div>
                  <span
                    className={clsx(
                      'text-xs px-2 py-0.5 rounded',
                      webhook.status === 'active'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                    )}
                  >
                    {webhook.status === 'active' ? t('common.active') : t('common.inactive')}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <Modal
        open={createModal}
        onClose={() => setCreateModal(false)}
        title={t('webhooks.new')}
        size="md"
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div>
            <label
              className="block text-xs font-medium uppercase tracking-wide mb-2"
              style={{ color: 'var(--text-secondary)' }}
            >
              {t('webhooks.form.url')}
            </label>
            <input
              type="url"
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder={t('webhooks.form.urlPlaceholder')}
              required
              className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
              }}
            />
          </div>

          <div>
            <label
              className="block text-xs font-medium uppercase tracking-wide mb-2"
              style={{ color: 'var(--text-secondary)' }}
            >
              {t('webhooks.form.events')}
            </label>
            <div
              className="space-y-2 max-h-48 overflow-y-auto p-3 rounded-lg"
              style={{ border: '1px solid var(--border)' }}
            >
              {WEBHOOK_EVENTS.map((event) => (
                <label
                  key={event.value}
                  className="flex items-start gap-3 p-2 rounded-lg cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
                >
                  <input
                    type="checkbox"
                    checked={newEvents.includes(event.value)}
                    onChange={() => toggleEvent(event.value)}
                    className="mt-0.5"
                  />
                  <div>
                    <p className="text-sm font-mono">{event.label}</p>
                    <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                      {event.description}
                    </p>
                  </div>
                </label>
              ))}
            </div>
          </div>

          <div
            className="flex gap-2 justify-end pt-4 border-t"
            style={{ borderColor: 'var(--border)' }}
          >
            <button
              type="button"
              onClick={() => setCreateModal(false)}
              className="px-4 py-2 text-sm font-medium"
              style={{ color: 'var(--text-muted)' }}
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={createMutation.isPending || newEvents.length === 0}
              className="px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50"
              style={{ background: 'var(--accent)', color: 'white' }}
            >
              {createMutation.isPending ? t('common.creating') : t('webhooks.form.submit')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Secret Display Modal */}
      <Modal
        open={!!newSecret}
        onClose={() => setNewSecret(null)}
        title={t('webhooks.secret.title')}
        size="sm"
      >
        <div className="space-y-4">
          <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
            <p className="text-xs font-medium mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('webhooks.secret.save')}
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 font-mono text-xs break-all">{newSecret}</code>
              <button
                onClick={() => copySecret(newSecret!)}
                className="p-2 rounded-lg hover:bg-[var(--bg-hover)] flex-shrink-0"
                style={{ color: 'var(--text-muted)' }}
              >
                {copiedSecret ? <Check size={16} className="text-green-500" /> : <Copy size={16} />}
              </button>
            </div>
          </div>
          <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
            {t('webhooks.secret.hint')}
          </p>
          <button
            onClick={() => setNewSecret(null)}
            className="w-full px-4 py-2 text-sm font-semibold rounded-lg"
            style={{ background: 'var(--accent)', color: 'white' }}
          >
            {t('common.done')}
          </button>
        </div>
      </Modal>

      {/* Webhook Detail Modal */}
      <Modal
        open={!!selectedWebhook}
        onClose={() => setSelectedWebhook(null)}
        title={t('webhooks.detail.title')}
        size="lg"
      >
        {webhookDetail && (
          <div className="space-y-5">
            {/* URL & Status */}
            <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
              <h4
                className="text-xs font-medium uppercase tracking-wide mb-2"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('webhooks.detail.endpoint')}
              </h4>
              <p className="font-mono text-sm break-all">{webhookDetail.url}</p>
              <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                <h4
                  className="text-xs font-medium uppercase tracking-wide mb-2"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {t('webhooks.detail.status')}
                </h4>
                <select
                  value={webhookDetail.status}
                  onChange={(e) =>
                    updateMutation.mutate({
                      id: webhookDetail.id,
                      data: { status: e.target.value },
                    })
                  }
                  disabled={updateMutation.isPending}
                  className="px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                  style={{
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                >
                  <option value="active">{t('common.active')}</option>
                  <option value="disabled">{t('common.inactive')}</option>
                </select>
              </div>
            </div>

            {/* Events */}
            <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
              <h4
                className="text-xs font-medium uppercase tracking-wide mb-2"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('webhooks.detail.events')}
              </h4>
              <div className="flex flex-wrap gap-2">
                {webhookDetail.events.map((event) => (
                  <span
                    key={event}
                    className="px-2 py-1 text-xs font-mono rounded-lg"
                    style={{
                      background: 'var(--bg-subtle)',
                      border: '1px solid var(--border-subtle)',
                    }}
                  >
                    {event}
                  </span>
                ))}
              </div>
            </div>

            {/* Recent Deliveries */}
            <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
              <h4
                className="text-xs font-medium uppercase tracking-wide mb-3"
                style={{ color: 'var(--text-secondary)' }}
              >
                {t('webhooks.detail.deliveries')}
              </h4>
              {webhookDetail.recent_deliveries.length === 0 ? (
                <p className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                  {t('webhooks.detail.noDeliveries')}
                </p>
              ) : (
                <div className="space-y-2">
                  {webhookDetail.recent_deliveries.map((delivery) => (
                    <div
                      key={delivery.id}
                      className="flex items-center justify-between py-2 border-b last:border-0"
                      style={{ borderColor: 'var(--border-subtle)' }}
                    >
                      <div className="flex items-center gap-2">
                        {delivery.status === 'success' && (
                          <CheckCircle size={14} className="text-green-500" />
                        )}
                        {delivery.status === 'failed' && (
                          <AlertCircle size={14} className="text-red-500" />
                        )}
                        {delivery.status === 'pending' && (
                          <Clock size={14} className="text-amber-500" />
                        )}
                        <span className="font-mono text-sm">{delivery.event_type}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                          {delivery.response_code && `${delivery.response_code} · `}
                          {delivery.attempts}{' '}
                          {delivery.attempts !== 1
                            ? t('webhooks.detail.attemptsPlural')
                            : t('webhooks.detail.attempts')}
                        </span>
                        <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                          {new Date(delivery.created_at).toLocaleString()}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Footer: Timestamp + Actions */}
            <div
              className="flex items-center justify-between pt-4 border-t"
              style={{ borderColor: 'var(--border)' }}
            >
              <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                {t('common.createdAt')} {new Date(webhookDetail.created_at).toLocaleString()}
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    if (confirm(t('webhooks.detail.rotateConfirm'))) {
                      rotateSecretMutation.mutate(webhookDetail.id);
                    }
                  }}
                  disabled={rotateSecretMutation.isPending}
                  className="inline-flex items-center gap-1.5 text-sm font-medium hover:underline"
                  style={{ color: 'var(--text-muted)' }}
                >
                  <RotateCw size={14} />
                  {rotateSecretMutation.isPending
                    ? t('common.rotating')
                    : t('webhooks.detail.rotateSecret')}
                </button>
                <button
                  onClick={() => {
                    if (confirm(t('webhooks.detail.deleteConfirm'))) {
                      deleteMutation.mutate(webhookDetail.id);
                    }
                  }}
                  disabled={deleteMutation.isPending}
                  className="inline-flex items-center gap-1.5 text-sm font-medium text-red-500 hover:text-red-600"
                >
                  <Trash2 size={14} />
                  {deleteMutation.isPending ? t('common.deleting') : t('webhooks.detail.delete')}
                </button>
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
