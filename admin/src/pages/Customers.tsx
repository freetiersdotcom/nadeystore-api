import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  flexRender,
  createColumnHelper,
  SortingState,
} from '@tanstack/react-table';
import {
  Search,
  ChevronUp,
  ChevronDown,
  ChevronsUpDown,
  Loader2,
  Mail,
  MapPin,
  ShoppingBag,
} from 'lucide-react';
import { api, Customer } from '../lib/api';
import { formatPrice } from '../lib/format';
import { Modal } from '../components/Modal';
import { useT } from '../lib/locale-context';
import clsx from 'clsx';

const columnHelper = createColumnHelper<Customer>();

export function Customers() {
  const queryClient = useQueryClient();
  const t = useT();

  const [sorting, setSorting] = useState<SortingState>([{ id: 'created_at', desc: true }]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);

  // Fetch customers
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['customers'],
    queryFn: () => api.getCustomers({ limit: 100 }),
  });

  // Fetch selected customer details
  const { data: customerDetail } = useQuery({
    queryKey: ['customer', selectedCustomer?.id],
    queryFn: () => (selectedCustomer ? api.getCustomer(selectedCustomer.id) : null),
    enabled: !!selectedCustomer,
  });

  // Fetch customer orders
  const { data: customerOrders } = useQuery({
    queryKey: ['customerOrders', selectedCustomer?.id],
    queryFn: () =>
      selectedCustomer ? api.getCustomerOrders(selectedCustomer.id, { limit: 10 }) : null,
    enabled: !!selectedCustomer,
  });

  // Update customer mutation
  const updateCustomerMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.updateCustomer>[1] }) =>
      api.updateCustomer(id, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['customers'] });
      queryClient.invalidateQueries({ queryKey: ['customer', selectedCustomer?.id] });
    },
  });

  const customers = data?.items || [];

  const columns = useMemo(
    () => [
      columnHelper.accessor('name', {
        header: t('customers.col.name'),
        cell: (info) => <span className="font-mono text-sm">{info.getValue() || '-'}</span>,
      }),
      columnHelper.accessor('email', {
        header: t('customers.col.email'),
        cell: (info) => <span className="font-mono text-sm">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.stats.order_count, {
        id: 'orders',
        header: t('customers.col.orders'),
        cell: (info) => <span className="font-mono text-sm">{info.getValue()}</span>,
      }),
      columnHelper.accessor((row) => row.stats.total_spent_cents, {
        id: 'spent',
        header: t('customers.col.spent'),
        cell: (info) => (
          <span className="font-mono text-sm">{formatPrice(info.getValue())}</span>
        ),
      }),
      columnHelper.accessor('created_at', {
        header: t('customers.col.since'),
        cell: (info) => (
          <span className="font-mono text-sm">
            {new Date(info.getValue()).toLocaleDateString()}
          </span>
        ),
      }),
    ],
    [t]
  );

  const table = useReactTable({
    data: customers,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 h-9">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('customers.title')}
        </h1>
        {isFetching && !isLoading && (
          <Loader2 className="animate-spin" size={16} style={{ color: 'var(--text-muted)' }} />
        )}
      </div>

      {/* Table card */}
      <div
        className="rounded-lg overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        {/* Search */}
        <div className="flex items-center border-b" style={{ borderColor: 'var(--border)' }}>
          <div
            className="flex-1 flex items-center gap-2 px-4 py-3"
            style={{ color: 'var(--text-muted)' }}
          >
            <Search size={16} className="flex-shrink-0" />
            <input
              type="text"
              placeholder={t('customers.search')}
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              className="bg-transparent border-0 font-mono text-sm w-full focus:outline-none"
              style={{ color: 'var(--text)' }}
            />
          </div>
        </div>

        {/* Table */}
        {isLoading ? (
          <div className="py-12 flex items-center justify-center">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : customers.length === 0 ? (
          <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('customers.empty')}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getToggleSortingHandler()}
                      className={clsx(
                        'px-4 py-3 text-left text-xs font-medium uppercase tracking-wide',
                        header.column.getCanSort() &&
                          'cursor-pointer select-none hover:bg-[var(--bg-hover)]'
                      )}
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <span className="ml-1">
                            {header.column.getIsSorted() === 'asc' ? (
                              <ChevronUp size={14} />
                            ) : header.column.getIsSorted() === 'desc' ? (
                              <ChevronDown size={14} />
                            ) : (
                              <ChevronsUpDown size={14} className="opacity-30" />
                            )}
                          </span>
                        )}
                      </div>
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => setSelectedCustomer(row.original)}
                  className="cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-4 py-3">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Customer Detail Modal */}
      <Modal
        open={!!selectedCustomer}
        onClose={() => setSelectedCustomer(null)}
        title={customerDetail?.name || selectedCustomer?.email || t('customers.title')}
        size="lg"
      >
        {selectedCustomer && (
          <div className="space-y-5">
            {/* Two column layout */}
            <div className="grid grid-cols-2 gap-5">
              {/* Left column */}
              <div className="space-y-4">
                {/* Contact Info */}
                <div
                  className="p-3 rounded-lg space-y-3"
                  style={{ border: '1px solid var(--border)' }}
                >
                  <h4
                    className="text-xs font-medium uppercase tracking-wide"
                    style={{ color: 'var(--text-secondary)' }}
                  >
                    {t('customers.detail.contact')}
                  </h4>
                  <div className="space-y-3">
                    {/* Name */}
                    <div>
                      <label
                        className="block text-xs font-medium uppercase tracking-wide mb-1.5"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {t('customers.col.name')}
                      </label>
                      <input
                        type="text"
                        defaultValue={customerDetail?.name || ''}
                        onBlur={(e) => {
                          if (e.target.value !== (customerDetail?.name || '')) {
                            updateCustomerMutation.mutate({
                              id: selectedCustomer.id,
                              data: { name: e.target.value || undefined },
                            });
                          }
                        }}
                        placeholder={t('customers.detail.namePlaceholder')}
                        className="w-full px-3 py-2 font-mono text-sm rounded-lg focus:outline-none focus:ring-2"
                        style={{
                          background: 'var(--bg-card)',
                          border: '1px solid var(--border)',
                          color: 'var(--text)',
                        }}
                      />
                    </div>
                    {/* Email */}
                    <div>
                      <label
                        className="block text-xs font-medium uppercase tracking-wide mb-1.5"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {t('customers.col.email')}
                      </label>
                      <div
                        className="flex items-center gap-2 px-3 py-2 text-sm rounded-lg"
                        style={{
                          background: 'var(--bg-subtle)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        <Mail size={14} style={{ color: 'var(--text-secondary)' }} />
                        <a
                          href={`mailto:${selectedCustomer.email}`}
                          className="font-mono hover:underline"
                          style={{ color: 'var(--accent)' }}
                        >
                          {selectedCustomer.email}
                        </a>
                      </div>
                    </div>
                    {/* Phone */}
                    <div>
                      <label
                        className="block text-xs font-medium uppercase tracking-wide mb-1.5"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {t('common.phone')}
                      </label>
                      <input
                        type="tel"
                        defaultValue={customerDetail?.phone || ''}
                        onBlur={(e) => {
                          if (e.target.value !== (customerDetail?.phone || '')) {
                            updateCustomerMutation.mutate({
                              id: selectedCustomer.id,
                              data: { phone: e.target.value || undefined },
                            });
                          }
                        }}
                        placeholder={t('customers.detail.phonePlaceholder')}
                        className="w-full px-3 py-2 font-mono text-sm rounded-lg focus:outline-none focus:ring-2"
                        style={{
                          background: 'var(--bg-card)',
                          border: '1px solid var(--border)',
                          color: 'var(--text)',
                        }}
                      />
                    </div>
                  </div>
                </div>

                {/* Stats */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
                    <p className="text-xs uppercase" style={{ color: 'var(--text-secondary)' }}>
                      {t('customers.detail.totalOrders')}
                    </p>
                    <p className="text-xl font-semibold font-mono mt-1">
                      {selectedCustomer.stats.order_count}
                    </p>
                  </div>
                  <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
                    <p className="text-xs uppercase" style={{ color: 'var(--text-secondary)' }}>
                      {t('customers.detail.totalSpent')}
                    </p>
                    <p className="text-xl font-semibold font-mono mt-1">
                      {formatPrice(selectedCustomer.stats.total_spent_cents)}
                    </p>
                  </div>
                </div>

                {/* Addresses */}
                {customerDetail?.addresses && customerDetail.addresses.length > 0 ? (
                  <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
                    <h4
                      className="text-xs font-medium uppercase tracking-wide mb-2 flex items-center gap-2"
                      style={{ color: 'var(--text-secondary)' }}
                    >
                      <MapPin size={14} />
                      {t('customers.detail.addresses')}
                    </h4>
                    <div className="space-y-3">
                      {customerDetail.addresses.map((addr) => (
                        <div key={addr.id} className="font-mono text-sm">
                          <div className="flex items-center gap-2 mb-1">
                            {addr.label && (
                              <span
                                className="text-xs px-1.5 py-0.5 rounded font-sans"
                                style={{ background: 'var(--accent)', color: 'white' }}
                              >
                                {addr.label}
                              </span>
                            )}
                            {addr.is_default && (
                              <span
                                className="text-xs font-sans"
                                style={{ color: 'var(--text-muted)' }}
                              >
                                {t('customers.detail.defaultAddress')}
                              </span>
                            )}
                          </div>
                          {addr.name && <p className="font-medium">{addr.name}</p>}
                          {addr.company && (
                            <p style={{ color: 'var(--text-secondary)' }}>{addr.company}</p>
                          )}
                          <p>{addr.line1}</p>
                          {addr.line2 && <p>{addr.line2}</p>}
                          <p>
                            {[addr.city, addr.state, addr.postal_code].filter(Boolean).join(', ')}
                          </p>
                          <p>{addr.country}</p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  customerDetail && (
                    <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                      {t('customers.detail.noAddresses')}
                    </p>
                  )
                )}
              </div>

              {/* Right column - Recent Orders */}
              <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
                <h4
                  className="text-xs font-medium uppercase tracking-wide mb-3 flex items-center gap-2"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  <ShoppingBag size={14} />
                  {t('customers.detail.recentOrders')}
                </h4>
                {customerOrders?.items && customerOrders.items.length > 0 ? (
                  <div className="space-y-2">
                    {customerOrders.items.map((order) => (
                      <div
                        key={order.id}
                        className="flex items-center justify-between py-2 border-b last:border-0"
                        style={{ borderColor: 'var(--border-subtle)' }}
                      >
                        <div>
                          <p className="font-mono text-sm">{order.number}</p>
                          <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>
                            {new Date(order.created_at).toLocaleDateString()}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="font-mono text-sm">
                            {formatPrice(order.amounts.total_cents)}
                          </p>
                          <p
                            className="text-xs font-mono"
                            style={{ color: 'var(--text-muted)' }}
                          >
                            {t(`orders.status.${order.status}` as Parameters<typeof t>[0])}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="text-sm font-mono" style={{ color: 'var(--text-secondary)' }}>
                    {t('customers.detail.noOrders')}
                  </p>
                )}
              </div>
            </div>

            {/* Timestamp */}
            <div
              className="text-xs font-mono pt-4 border-t"
              style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}
            >
              {t('customers.detail.since')} {new Date(selectedCustomer.created_at).toLocaleString()}
              {selectedCustomer.stats.last_order_at && (
                <span>
                  {' '}
                  · {t('customers.detail.lastOrder')}{' '}
                  {new Date(selectedCustomer.stats.last_order_at).toLocaleString()}
                </span>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
