import { useState } from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Search, Loader2, Download, Copy, Check, RefreshCw, AlertCircle } from 'lucide-react';
import { api, Order, DownloadToken } from '../lib/api';
import { useT } from '../lib/locale-context';
import clsx from 'clsx';

type FoundOrder = Order & {
  digital_items: Array<{ sku: string; title: string }>;
};

function tokenStatus(token: DownloadToken): 'active' | 'expired' | 'exhausted' {
  if (token.download_count >= token.max_downloads) return 'exhausted';
  if (new Date(token.expires_at) < new Date()) return 'expired';
  return 'active';
}

const statusStyles = {
  active:    'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  expired:   'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  exhausted: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
};

export function Downloads() {
  const t = useT();

  const [searchQuery, setSearchQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<string | null>(null);
  const [reissuedTokens, setReissuedTokens] = useState<Record<string, { token: string; url: string }>>({});
  const [copied, setCopied] = useState<string | null>(null);

  // Search orders
  const isEmail = submittedQuery.includes('@');
  const { data: ordersData, isLoading: searchLoading } = useQuery({
    queryKey: ['orders-search', submittedQuery],
    queryFn: () =>
      submittedQuery
        ? api.getOrders({
            limit: 20,
            ...(isEmail ? { email: submittedQuery } : {}),
          })
        : Promise.resolve(null),
    enabled: Boolean(submittedQuery),
  });

  // Filter to orders that have digital items
  const orders = (ordersData?.items || []).filter(
    (o) => o.items.some((i) => i.product_type === 'digital')
  ) as FoundOrder[];

  // Get download tokens for selected order
  const { data: downloadData, isLoading: tokenLoading, refetch: refetchTokens } = useQuery({
    queryKey: ['order-downloads', selectedOrderId],
    queryFn: () => api.getOrderDownloads(selectedOrderId!),
    enabled: Boolean(selectedOrderId),
  });

  // Reissue mutation
  const reissueMutation = useMutation({
    mutationFn: ({ orderId, sku }: { orderId: string; sku: string }) =>
      api.reissueDownload(orderId, sku),
    onSuccess: (result, { sku }) => {
      setReissuedTokens((prev) => ({ ...prev, [sku]: { token: result.token, url: result.download_url } }));
      refetchTokens();
    },
  });

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmittedQuery(searchQuery.trim());
    setSelectedOrderId(null);
  };

  const handleCopy = async (text: string, key: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(key);
    setTimeout(() => setCopied(null), 2000);
  };

  const digitalItemCount = (order: Order) =>
    order.items.filter((i) => i.product_type === 'digital').length;

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('downloads.title')}
        </h1>
        <p className="text-sm mt-1" style={{ color: 'var(--text-muted)' }}>
          {t('downloads.description')}
        </p>
      </div>

      {/* Search */}
      <form onSubmit={handleSearch} className="mb-4">
        <div
          className="flex items-center rounded-lg overflow-hidden"
          style={{ border: '1px solid var(--border)', background: 'var(--bg-card)' }}
        >
          <div className="flex items-center gap-2 flex-1 px-4 py-3" style={{ color: 'var(--text-muted)' }}>
            <Search size={16} className="flex-shrink-0" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('downloads.search')}
              className="bg-transparent border-0 font-mono text-sm w-full focus:outline-none"
              style={{ color: 'var(--text)' }}
            />
          </div>
          <button
            type="submit"
            className="px-4 py-3 text-sm font-medium border-l transition-colors hover:bg-[var(--bg-hover)]"
            style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
          >
            {t('common.search')}
          </button>
        </div>
      </form>

      {/* Loading */}
      {searchLoading && (
        <div className="py-8 flex items-center justify-center">
          <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
        </div>
      )}

      {/* Empty state */}
      {submittedQuery && !searchLoading && orders.length === 0 && (
        <div
          className="py-8 text-center rounded-lg text-sm"
          style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
        >
          {t('downloads.empty')} &ldquo;{submittedQuery}&rdquo;
        </div>
      )}

      {/* Results */}
      {orders.length > 0 && (
        <div className="grid gap-4" style={{ gridTemplateColumns: selectedOrderId ? '1fr 1fr' : '1fr' }}>
          {/* Order list */}
          <div
            className="rounded-lg overflow-hidden"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
          >
            {orders.map((order) => {
              const count = digitalItemCount(order);
              return (
                <button
                  key={order.id}
                  onClick={() => setSelectedOrderId(order.id === selectedOrderId ? null : order.id)}
                  className={clsx(
                    'w-full px-4 py-4 text-left transition-colors border-b last:border-0',
                    order.id === selectedOrderId ? '' : 'hover:bg-[var(--bg-hover)]'
                  )}
                  style={{
                    borderColor: 'var(--border-subtle)',
                    background: order.id === selectedOrderId ? 'var(--bg-hover)' : undefined,
                  }}
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-mono text-sm font-medium">
                        {order.number || order.id.slice(0, 8)}
                      </p>
                      <p className="text-xs font-mono mt-0.5" style={{ color: 'var(--text-muted)' }}>
                        {order.customer_email}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                        {new Date(order.created_at).toLocaleDateString()}
                      </p>
                      <p className="text-xs mt-0.5 flex items-center gap-1 justify-end" style={{ color: 'var(--text-muted)' }}>
                        <Download size={11} />
                        {count} {count !== 1 ? t('downloads.col.digitalItemsPlural') : t('downloads.col.digitalItems')}
                      </p>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Token detail panel */}
          {selectedOrderId && (
            <div
              className="rounded-lg p-4"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
            >
              {tokenLoading ? (
                <div className="py-8 flex items-center justify-center">
                  <Loader2 size={18} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                </div>
              ) : !downloadData ? (
                <p className="text-sm text-center py-8" style={{ color: 'var(--text-muted)' }}>
                  {t('common.noResults')}
                </p>
              ) : (
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                      {t('downloads.tokens')}
                    </h3>
                    <button
                      onClick={() => refetchTokens()}
                      className="p-1 rounded transition-colors hover:bg-[var(--bg-hover)]"
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <RefreshCw size={13} />
                    </button>
                  </div>

                  {downloadData.digital_items.map((item) => (
                    <div
                      key={item.sku}
                      className="p-3 rounded-lg space-y-3"
                      style={{ border: '1px solid var(--border)' }}
                    >
                      <div>
                        <p className="text-sm font-medium" style={{ color: 'var(--text)' }}>
                          {item.title}
                        </p>
                        <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                          {item.sku}
                        </p>
                      </div>

                      {item.tokens.length === 0 ? (
                        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                          {t('downloads.noTokens')}
                        </p>
                      ) : (
                        item.tokens.map((token) => {
                          const status = tokenStatus(token);
                          const reissued = reissuedTokens[item.sku];
                          return (
                            <div key={token.token_id} className="space-y-2">
                              <div className="flex items-center justify-between">
                                <span className={clsx('text-xs px-2 py-0.5 rounded-sm font-medium', statusStyles[status])}>
                                  {t(`downloads.status.${status}` as Parameters<typeof t>[0])}
                                </span>
                                <span className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                                  {token.download_count}/{token.max_downloads} {t('downloads.downloads')}
                                </span>
                              </div>
                              <div className="text-xs font-mono space-y-0.5" style={{ color: 'var(--text-muted)' }}>
                                <p>{t('downloads.expires')} {new Date(token.expires_at).toLocaleString()}</p>
                                {token.last_downloaded_at && (
                                  <p>{t('downloads.lastDownloaded')} {new Date(token.last_downloaded_at).toLocaleString()}</p>
                                )}
                              </div>

                              {/* Reissued token URL */}
                              {reissued && (
                                <div
                                  className="p-2 rounded text-xs font-mono"
                                  style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)' }}
                                >
                                  <p className="text-green-600 dark:text-green-400 mb-1 font-medium">
                                    {t('downloads.reissued')}
                                  </p>
                                  <div className="flex items-center gap-1.5">
                                    <span className="truncate flex-1" style={{ color: 'var(--text-muted)' }}>
                                      {reissued.url}
                                    </span>
                                    <button
                                      onClick={() => handleCopy(reissued.url, item.sku)}
                                      className="flex-shrink-0 p-1 rounded transition-colors hover:bg-[var(--bg-hover)]"
                                      style={{ color: 'var(--text-muted)' }}
                                    >
                                      {copied === item.sku
                                        ? <Check size={12} className="text-green-500" />
                                        : <Copy size={12} />}
                                    </button>
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}

                      {/* Reissue button */}
                      <button
                        onClick={() => reissueMutation.mutate({ orderId: selectedOrderId, sku: item.sku })}
                        disabled={reissueMutation.isPending}
                        className="w-full flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg transition-colors hover:bg-[var(--bg-hover)] disabled:opacity-50"
                        style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
                      >
                        {reissueMutation.isPending ? (
                          <Loader2 size={12} className="animate-spin" />
                        ) : (
                          <RefreshCw size={12} />
                        )}
                        {t('downloads.reissue')}
                      </button>

                      {reissueMutation.isError && (
                        <p className="text-xs text-red-500 flex items-center gap-1">
                          <AlertCircle size={11} />
                          {(reissueMutation.error as Error).message}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
