import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus, RefreshCw, Trash2, Pencil, Shuffle } from 'lucide-react';
import { api, Discount } from '../lib/api';
import { formatPrice } from '../lib/format';
import { Modal } from '../components/Modal';
import { useT } from '../lib/locale-context';
import clsx from 'clsx';

const ADJECTIVES = ['SUMMER', 'WINTER', 'PROMO', 'SPECIAL', 'WELCOME', 'VIP', 'LAUNCH', 'FLASH'];

function generateCode(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const num = Math.floor(Math.random() * 90) + 10;
  return `${adj}${num}`;
}

function discountStatus(d: Discount): 'active' | 'inactive' | 'expired' | 'exhausted' {
  if (d.status === 'inactive') return 'inactive';
  if (d.expires_at && new Date(d.expires_at) < new Date()) return 'expired';
  if (d.usage_limit !== null && d.usage_count >= d.usage_limit) return 'exhausted';
  return 'active';
}

const statusStyles = {
  active: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  inactive: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  expired: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  exhausted: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
};

type FormState = {
  code: string;
  type: 'percentage' | 'fixed_amount';
  value: string;
  max_discount_cents: string;   // percentage cap, optional
  usage_limit: string;
  usage_limit_per_customer: string;
  starts_at: string;
  expires_at: string;
  min_purchase_cents: string;
};

const emptyForm = (): FormState => ({
  code: '',
  type: 'percentage',
  value: '',
  max_discount_cents: '',
  usage_limit: '',
  usage_limit_per_customer: '1',
  starts_at: '',
  expires_at: '',
  min_purchase_cents: '',
});

export function Discounts() {
  const t = useT();
  const queryClient = useQueryClient();
  const [createModal, setCreateModal] = useState(false);
  const [editingDiscount, setEditingDiscount] = useState<Discount | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<Discount | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm());

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['discounts'],
    queryFn: () => api.getDiscounts(),
  });

  const discounts = data?.items || [];

  const createMutation = useMutation({
    mutationFn: () =>
      api.createDiscount({
        code: form.code.trim().toUpperCase() || null,
        type: form.type,
        // percentage: stored as 0–100 | fixed_amount: stored in cents
        value: form.type === 'percentage'
          ? parseFloat(form.value)
          : Math.round(parseFloat(form.value) * 100),
        max_discount_cents: form.max_discount_cents
          ? Math.round(parseFloat(form.max_discount_cents) * 100)
          : null,
        usage_limit: form.usage_limit ? parseInt(form.usage_limit) : null,
        usage_limit_per_customer: form.usage_limit_per_customer
          ? parseInt(form.usage_limit_per_customer)
          : null,
        starts_at: form.starts_at || null,
        expires_at: form.expires_at || null,
        min_purchase_cents: form.min_purchase_cents
          ? Math.round(parseFloat(form.min_purchase_cents) * 100)
          : 0,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discounts'] });
      setCreateModal(false);
      setForm(emptyForm());
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.updateDiscount>[1] }) =>
      api.updateDiscount(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discounts'] });
      setEditingDiscount(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteDiscount(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['discounts'] });
      setDeleteConfirm(null);
    },
  });

  const openEdit = (d: Discount) => setEditingDiscount(d);

  const handleToggleStatus = (d: Discount) => {
    const newStatus = d.status === 'active' ? 'inactive' : 'active';
    updateMutation.mutate({ id: d.id, data: { status: newStatus } });
  };

  const formatValue = (d: Discount) =>
    d.type === 'percentage' ? `${d.value}%` : `${formatPrice(d.value)}`;

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 h-9">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('discounts.title')}
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ['discounts'] })}
            disabled={isFetching}
            className="p-2 rounded hover:bg-[var(--bg-hover)] transition-colors disabled:opacity-50"
            style={{ color: 'var(--text-muted)' }}
          >
            <RefreshCw size={16} className={isFetching ? 'animate-spin' : ''} />
          </button>
          <button
            onClick={() => { setForm(emptyForm()); setCreateModal(true); }}
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded font-semibold transition-colors"
            style={{ background: 'var(--accent)', color: 'var(--text-inverse)' }}
          >
            <Plus size={16} />
            {t('discounts.new')}
          </button>
        </div>
      </div>

      {/* Quick create buttons */}
      <div className="flex gap-2 mb-4">
        {[
          { label: t('discounts.quick.ten'),       		  type: 'percentage'  as const, value: '10' },
          { label: t('discounts.quick.twentyFive'),       type: 'percentage'  as const, value: '25' },
          { label: t('discounts.quick.freeShipping'), 	  type: 'fixed_amount' as const, value: '0'  },
        ].map((preset) => (
          <button
            key={preset.label}
            onClick={() => {
              setForm({ ...emptyForm(), code: generateCode(), type: preset.type, value: preset.value });
              setCreateModal(true);
            }}
            className="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
            style={{ border: '1px solid var(--border)', color: 'var(--text-secondary)' }}
          >
            + {preset.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="rounded-lg overflow-hidden" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}>
        {isLoading ? (
          <div className="py-12 flex items-center justify-center">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : discounts.length === 0 ? (
          <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('discounts.empty')}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {[
                  t('discounts.col.code'),
                  t('discounts.col.value'),
                  t('discounts.col.usage'),
                  t('discounts.col.expires'),
                  t('discounts.col.status'),
                  '',
                ].map((h) => (
                  <th key={h} className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {discounts.map((d) => {
                const status = discountStatus(d);
                return (
                  <tr key={d.id} className="transition-colors hover:bg-[var(--bg-hover)]" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                    <td className="px-4 py-3">
                      <span className="font-mono text-sm font-medium tracking-wide">{d.code}</span>
                    </td>
                    <td className="px-4 py-3 font-mono text-sm">{formatValue(d)}</td>
                    <td className="px-4 py-3 font-mono text-sm">
                      {d.usage_count}
                      {d.usage_limit !== null ? ` / ${d.usage_limit}` : ''}
                    </td>
                    <td className="px-4 py-3 font-mono text-sm" style={{ color: 'var(--text-muted)' }}>
                      {d.expires_at ? new Date(d.expires_at).toLocaleDateString() : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx('inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-sm', statusStyles[status])}>
                        {t(`common.${status}` as any)}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleToggleStatus(d)}
                          className="px-2 py-1 text-xs rounded transition-colors hover:bg-[var(--bg-hover)]"
                          style={{ color: 'var(--text-muted)' }}
                        >
                          {d.status === 'active' ? t('common.deactivate') : t('common.activate')}
                        </button>
                        <button onClick={() => openEdit(d)} className="p-1.5 rounded transition-colors hover:bg-[var(--bg-hover)]" style={{ color: 'var(--text-muted)' }}>
                          <Pencil size={13} />
                        </button>
                        <button onClick={() => setDeleteConfirm(d)} className="p-1.5 rounded transition-colors hover:bg-red-500/10 hover:text-red-500" style={{ color: 'var(--text-muted)' }}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Create Modal */}
      <Modal open={createModal} onClose={() => setCreateModal(false)} title={t('discounts.new')} size="md">
        <DiscountForm
          form={form}
          setForm={setForm}
          onSubmit={(e) => { e.preventDefault(); createMutation.mutate(); }}
          onCancel={() => setCreateModal(false)}
          isPending={createMutation.isPending}
          error={createMutation.isError ? (createMutation.error as Error).message : null}
          submitLabel={t('common.create')}
        />
      </Modal>

      {/* Edit Modal */}
      <Modal open={!!editingDiscount} onClose={() => setEditingDiscount(null)} title={t('discounts.edit.title')} size="md">
        {editingDiscount && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.form.code')}</label>
              <p className="font-mono text-sm font-medium">{editingDiscount.code}</p>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.edit.status')}</label>
              <select
                value={editingDiscount.status}
                onChange={(e) => setEditingDiscount({ ...editingDiscount, status: e.target.value as 'active' | 'inactive' })}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
              >
                <option value="active">{t('common.active')}</option>
                <option value="inactive">{t('common.inactive')}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.edit.usageLimit')}</label>
              <input
                type="number"
                value={editingDiscount.usage_limit ?? ''}
                onChange={(e) => setEditingDiscount({ ...editingDiscount, usage_limit: e.target.value ? parseInt(e.target.value) : null })}
                placeholder={t('common.unlimited')}
                min="0"
                className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.edit.expiresAt')}</label>
              <input
                type="datetime-local"
                value={editingDiscount.expires_at ? editingDiscount.expires_at.slice(0, 16) : ''}
                onChange={(e) => setEditingDiscount({ ...editingDiscount, expires_at: e.target.value || null })}
                className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
              />
            </div>
            <div className="flex gap-2 pt-4 border-t justify-end" style={{ borderColor: 'var(--border)' }}>
              <button onClick={() => setEditingDiscount(null)} className="px-4 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>{t('common.cancel')}</button>
              <button
                onClick={() => updateMutation.mutate({ id: editingDiscount.id, data: { status: editingDiscount.status, usage_limit: editingDiscount.usage_limit ?? undefined, expires_at: editingDiscount.expires_at ?? undefined } })}
                disabled={updateMutation.isPending}
                className="px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50"
                style={{ background: 'var(--accent)', color: 'white' }}
              >
                {updateMutation.isPending ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Delete confirm */}
      <Modal open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} title={t('discounts.delete.title')} size="sm">
        {deleteConfirm && (
          <div className="space-y-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              {t('discounts.delete.body').replace('This cannot be undone.', '')}
              <span className="font-mono font-medium">{deleteConfirm.code}</span>? {t('common.cannotUndo')}
            </p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>{t('common.cancel')}</button>
              <button
                onClick={() => deleteMutation.mutate(deleteConfirm.id)}
                disabled={deleteMutation.isPending}
                className="px-4 py-2 text-sm font-semibold rounded-lg text-white disabled:opacity-50 bg-red-500 hover:bg-red-600"
              >
                {deleteMutation.isPending ? t('common.deleting') : t('discounts.delete.confirm')}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function DiscountForm({
  form,
  setForm,
  onSubmit,
  onCancel,
  isPending,
  error,
  submitLabel,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  isPending: boolean;
  error: string | null;
  submitLabel: string;
}) {
  const t = useT();
  const set = (key: keyof FormState) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm({ ...form, [key]: e.target.value });

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {/* Code */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.form.code')}</label>
        <div className="flex gap-2">
          <input
            type="text"
            value={form.code}
            onChange={set('code')}
            placeholder={t('discounts.form.codePlaceholder')}
            required
            className="flex-1 px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2 uppercase"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
          />
          <button
            type="button"
            onClick={() => setForm({ ...form, code: generateCode() })}
            className="p-2 rounded-lg transition-colors hover:bg-[var(--bg-hover)]"
            style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
            title="Generate code"
          >
            <Shuffle size={14} />
          </button>
        </div>
      </div>

      {/* Type + value */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.form.type')}</label>
          <select value={form.type} onChange={set('type')} className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}>
            <option value="percentage">{t('discounts.type.percentage')}</option>
            <option value="fixed_amount">{t('discounts.type.fixed')}</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            {form.type === 'percentage' ? t('discounts.form.valuePct') : t('discounts.form.valueFixed')}
          </label>
          <input
            type="number"
            value={form.value}
            onChange={set('value')}
            placeholder={form.type === 'percentage' ? '10' : '5.00'}
            required
            min="0"
            max={form.type === 'percentage' ? '100' : undefined}
            step={form.type === 'fixed_amount' ? '0.01' : '1'}
            className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
          />
        </div>
      </div>

      {/* Max discount cap — percentage only */}
      {form.type === 'percentage' && (
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>
            {t('discounts.form.maxDiscount')}
          </label>
          <input
            type="number"
            value={form.max_discount_cents}
            onChange={set('max_discount_cents')}
            placeholder={t('discounts.form.maxDiscountPlaceholder')}
            min="0"
            step="0.01"
            className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
            style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}
          />
        </div>
      )}

      {/* Usage limits */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.form.usageLimit')}</label>
          <input type="number" value={form.usage_limit} onChange={set('usage_limit')} placeholder={t('common.unlimited')} min="1" className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.form.perCustomer')}</label>
          <input type="number" value={form.usage_limit_per_customer} onChange={set('usage_limit_per_customer')} min="1" required className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
        </div>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.form.startsAt')}</label>
          <input type="datetime-local" value={form.starts_at} onChange={set('starts_at')} className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.form.expiresAt')}</label>
          <input type="datetime-local" value={form.expires_at} onChange={set('expires_at')} className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
        </div>
      </div>

      {/* Min purchase */}
      <div>
        <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--text-secondary)' }}>{t('discounts.form.minPurchase')}</label>
        <input type="number" value={form.min_purchase_cents} onChange={set('min_purchase_cents')} placeholder={t('discounts.form.minPurchasePlaceholder')} min="0" step="0.01" className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2" style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2 justify-end pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
        <button type="button" onClick={onCancel} className="px-4 py-2 text-sm" style={{ color: 'var(--text-muted)' }}>{t('common.cancel')}</button>
        <button type="submit" disabled={isPending} className="px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>
          {isPending ? t('common.saving') : submitLabel}
        </button>
      </div>
    </form>
  );
}
