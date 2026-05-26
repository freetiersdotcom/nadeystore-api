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
  RefreshCw,
  Plus,
  ArrowLeft,
  ImageIcon,
  Upload,
  X,
  Pencil,
  FileUp,
  Download,
  File,
  Trash2,
} from 'lucide-react';
import { api, Product, Variant } from '../lib/api';
import { formatPrice } from '../lib/format';
import { assetDownloadUrl, assetDisplayName, assetFilename, formatFileSize } from '../lib/asset-helpers';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/Modal';
import { useT } from '../lib/locale-context';
import clsx from 'clsx';

const columnHelper = createColumnHelper<Product>();

const ACCEPTED_ASSET_TYPES = '.pdf,.zip,.epub,.mp4,.mp3,.docx,.xlsx';

export function Products() {
  const t = useT();
  const queryClient = useQueryClient();
  const [sorting, setSorting] = useState<SortingState>([{ id: 'created_at', desc: true }]);
  const [globalFilter, setGlobalFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('');

  const [createModal, setCreateModal] = useState(false);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const [variantMode, setVariantMode] = useState<'add' | 'edit' | null>(null);
  const [editingVariant, setEditingVariant] = useState<Variant | null>(null);

  // Product form
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');

  // Variant form — image mirrors the existing pattern exactly
  const [variantSku, setVariantSku] = useState('');
  const [variantTitle, setVariantTitle] = useState('');
  const [variantPrice, setVariantPrice] = useState('');
  const [variantImage, setVariantImage] = useState<string | null>(null);
  const [variantProductType, setVariantProductType] = useState<'physical' | 'digital'>('physical');
  const [variantWeightG, setVariantWeightG] = useState('');
  const [uploadingImage, setUploadingImage] = useState(false);

  // Asset state — mirrors variantImage exactly:
  //   null           → no asset (new variant or asset deleted)
  //   string         → digital_asset_key from the API (committed to server)
  //   { pending }    → file picked, uploading in progress
  // After upload completes, state becomes the returned key string.
  // The File object is never kept in state — only the key survives navigation.
  type AssetState =
    | null
    | string                                  // digital_asset_key — already on server
    | { uploading: true; name: string; size: number }; // upload in progress

  const [variantAsset, setVariantAsset] = useState<AssetState>(null);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ['products', statusFilter],
    queryFn: () => api.getProducts({ limit: 100, status: statusFilter || undefined }),
  });

  const products = data?.items || [];

  const createMutation = useMutation({
    mutationFn: (data: { title: string; description?: string }) => api.createProduct(data),
    onSuccess: (product) => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setCreateModal(false);
      setNewTitle('');
      setNewDescription('');
      setSelectedProduct(product);
    },
  });

  const createVariantMutation = useMutation({
    mutationFn: ({
      productId,
      data,
    }: {
      productId: string;
      data: Parameters<typeof api.createVariant>[1];
    }) => api.createVariant(productId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      refreshSelectedProduct();
      resetVariantForm();
      setVariantMode(null);
    },
  });

  const updateProductMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Parameters<typeof api.updateProduct>[1] }) =>
      api.updateProduct(id, data),
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      setSelectedProduct(updated);
    },
  });

  const updateVariantMutation = useMutation({
    mutationFn: ({
      productId,
      variantId,
      data,
    }: {
      productId: string;
      variantId: string;
      data: Parameters<typeof api.updateVariant>[2];
    }) => api.updateVariant(productId, variantId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      refreshSelectedProduct();
      resetVariantForm();
      setVariantMode(null);
      setEditingVariant(null);
    },
  });

  const deleteAssetMutation = useMutation({
    mutationFn: ({ productId, variantId }: { productId: string; variantId: string }) =>
      api.deleteAsset(productId, variantId),
    onSuccess: () => {
      // Clear asset state so the upload zone reappears
      setVariantAsset(null);
      queryClient.invalidateQueries({ queryKey: ['products'] });
      refreshSelectedProduct();
    },
  });

  const refreshSelectedProduct = () => {
    if (selectedProduct) {
      api.getProduct(selectedProduct.id).then(setSelectedProduct);
    }
  };

  const resetVariantForm = () => {
    setVariantSku('');
    setVariantTitle('');
    setVariantPrice('');
    setVariantImage(null);
    setVariantProductType('physical');
    setVariantWeightG('');
    setVariantAsset(null);
  };

  const openEditVariant = (variant: Variant) => {
    setEditingVariant(variant);
    setVariantSku(variant.sku);
    setVariantTitle(variant.title);
    setVariantPrice(String(variant.price_cents));
    setVariantImage(variant.image_url);
    setVariantProductType(variant.product_type ?? 'physical');
    setVariantWeightG(variant.weight_g ? String(variant.weight_g) : '');
    // Populate asset state from the key stored on the variant — mirrors setVariantImage(variant.image_url)
    setVariantAsset(variant.digital_asset_key ?? null);
    setVariantMode('edit');
  };

  // ── Image upload — unchanged from original ─────────────────

  const handleImageUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const result = await api.uploadImage(file);
      setVariantImage(result.url);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Image upload failed');
    }
  };

  // ── Asset upload — immediate on file pick, mirrors image ───

  const handleAssetPick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedProduct) return;

    // Show uploading state immediately
    setVariantAsset({ uploading: true, name: file.name, size: file.size });

    try {
      // For a new variant we don't have a variantId yet — upload is staged
      // against the product only, and the key is finalised on variant save.
      // For an existing variant we upload directly.
      if (variantMode === 'edit' && editingVariant) {
        const result = await api.uploadAsset(selectedProduct.id, editingVariant.id, file);
        // result.key is the digital_asset_key: "assets/{variantId}/{filename}"
        setVariantAsset(result.key);
        // Optimistically refresh so the variant card updates too
        refreshSelectedProduct();
      } else {
        // New variant: stage the File object info in a resolved-looking state.
        // We store the key as a temporary placeholder — the real upload happens
        // after createVariant returns a variantId (see createVariantMutation.onSuccess).
        // To handle this cleanly we keep a ref to the pending File.
        setPendingAssetFile(file);
        // Show as committed in the UI (name is known, size is known)
        setVariantAsset(`__pending__/${file.name}`);
      }
    } catch (err) {
      setVariantAsset(null);
      alert(err instanceof Error ? err.message : 'Asset upload failed');
    }

    // Reset the input so the same file can be picked again if needed
    e.target.value = '';
  };

  // Holds the File object for new variants only — cleared after createVariant succeeds
  const [pendingAssetFile, setPendingAssetFile] = useState<File | null>(null);

  // ── Form submit ────────────────────────────────────────────

  const handleCreateProduct = (e: React.FormEvent) => {
    e.preventDefault();
    createMutation.mutate({ title: newTitle, description: newDescription || undefined });
  };

  const handleVariantSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) return;
    const price = parseInt(variantPrice, 10);
    if (isNaN(price)) return;

    const baseData = {
      sku: variantSku,
      title: variantTitle,
      price_cents: price,
      image_url: variantImage,
      product_type: variantProductType,
      weight_g:
        variantProductType === 'physical' && variantWeightG
          ? parseInt(variantWeightG)
          : variantProductType === 'digital'
          ? 0
          : undefined,
    };

    if (variantMode === 'edit' && editingVariant) {
      // Asset already uploaded on pick — nothing extra needed
      updateVariantMutation.mutate({
        productId: selectedProduct.id,
        variantId: editingVariant.id,
        data: baseData,
      });
    } else {
      // New variant — create first, then upload pending asset if any
      createVariantMutation.mutate(
        { productId: selectedProduct.id, data: baseData },
        {
          onSuccess: async (newVariant) => {
            if (pendingAssetFile) {
              try {
                await api.uploadAsset(selectedProduct.id, newVariant.id, pendingAssetFile);
              } catch (err) {
                // Non-fatal: variant was created, asset upload failed
                // The card will show the "no file" warning
                console.error('Asset upload failed after variant creation:', err);
              } finally {
                setPendingAssetFile(null);
              }
            }
            queryClient.invalidateQueries({ queryKey: ['products'] });
            refreshSelectedProduct();
            resetVariantForm();
            setVariantMode(null);
          },
        }
      );
    }
  };

  // ── Asset removal ──────────────────────────────────────────

  const handleRemoveAsset = () => {
    if (!selectedProduct || !editingVariant) {
      // New variant — just clear local state
      setVariantAsset(null);
      setPendingAssetFile(null);
      return;
    }
    deleteAssetMutation.mutate({
      productId: selectedProduct.id,
      variantId: editingVariant.id,
    });
  };

  // ── Asset display helpers ──────────────────────────────────

  // Is variantAsset a real committed key (not pending)?
  const isCommittedAsset = (a: AssetState): a is string =>
    typeof a === 'string' && !a.startsWith('__pending__/');

  const isPendingAsset = (a: AssetState): a is string =>
    typeof a === 'string' && a.startsWith('__pending__/');

  const isUploadingAsset = (a: AssetState): a is { uploading: true; name: string; size: number } =>
    typeof a === 'object' && a !== null;

  // Display name for the asset chip
  const assetChipLabel = (a: AssetState): string => {
    if (!a) return '';
    if (isUploadingAsset(a)) return a.name;
    if (isPendingAsset(a)) return a.replace('__pending__/', '');
    return assetDisplayName(a); // invert slug → Title Case
  };

  const assetChipSubLabel = (a: AssetState): string => {
    if (!a) return '';
    if (isUploadingAsset(a)) return formatFileSize(a.size);
    if (isPendingAsset(a) && pendingAssetFile) return formatFileSize(pendingAssetFile.size);
    if (isCommittedAsset(a)) return assetFilename(a); // raw slug filename as subtitle
    return '';
  };

  // ── Columns ────────────────────────────────────────────────
  // t is a dependency so headers re-render on locale change

  const columns = useMemo(
    () => [
      columnHelper.accessor('title', {
        header: t('products.col.product'),
        cell: (info) => <span className="font-mono text-sm">{info.getValue()}</span>,
      }),
      columnHelper.accessor('description', {
        header: t('products.form.description'),
        cell: (info) => <span className="font-mono text-sm">{info.getValue() || '—'}</span>,
      }),
      columnHelper.accessor((row) => row.variants.length, {
        id: 'variants',
        header: t('products.col.variants'),
        cell: (info) => <span className="font-mono text-sm">{info.getValue()}</span>,
      }),
      columnHelper.accessor('status', {
        header: t('products.col.status'),
        cell: (info) => <StatusBadge
            status={info.getValue()}
            label={t(`products.status.${info.getValue()}` as Parameters<typeof t>[0])}
          />,
      }),
    ],
    [t]
  );

  const table = useReactTable({
    data: products,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const isPending = createVariantMutation.isPending || updateVariantMutation.isPending;
  const isAssetUploading = isUploadingAsset(variantAsset);

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-4 h-9">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
          {t('products.title')}
        </h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => queryClient.invalidateQueries({ queryKey: ['products'] })}
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
            {t('products.new')}
          </button>
        </div>
      </div>

      {/* Table */}
      <div
        className="rounded-lg overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        <div className="flex items-center border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex-1 flex items-center gap-2 px-4 py-3" style={{ color: 'var(--text-muted)' }}>
            <Search size={16} className="flex-shrink-0" />
            <input
              type="text"
              value={globalFilter}
              onChange={(e) => setGlobalFilter(e.target.value)}
              placeholder={t('common.search')}
              className="bg-transparent border-0 font-mono text-sm w-full focus:outline-none"
              style={{ color: 'var(--text)' }}
            />
          </div>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-full px-4 py-3 font-mono text-sm bg-transparent border-0 border-l focus:outline-none cursor-pointer"
            style={{ borderColor: 'var(--border)', color: statusFilter ? 'var(--text)' : 'var(--text-muted)' }}
          >
            <option value="">{t('common.all')}</option>
            <option value="active">{t('products.status.active')}</option>
            <option value="draft">{t('products.status.draft')}</option>
          </select>
        </div>

        {isLoading ? (
          <div className="py-12 flex items-center justify-center">
            <Loader2 size={20} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
          </div>
        ) : products.length === 0 ? (
          <div className="py-12 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
            {t('products.empty')}
          </div>
        ) : (
          <table className="w-full">
            <thead>
              {table.getHeaderGroups().map((headerGroup) => (
                <tr key={headerGroup.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  {headerGroup.headers.map((header) => (
                    <th
                      key={header.id}
                      onClick={header.column.getCanSort() ? header.column.getToggleSortingHandler() : undefined}
                      className={clsx(
                        'px-4 py-3 text-left text-xs font-medium uppercase tracking-wide',
                        header.column.getCanSort() && 'cursor-pointer select-none hover:bg-[var(--bg-hover)]'
                      )}
                      style={{ color: 'var(--text-muted)' }}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {header.column.getCanSort() && (
                          <span className="ml-1">
                            {header.column.getIsSorted() === 'asc'
                              ? <ChevronUp size={14} />
                              : header.column.getIsSorted() === 'desc'
                              ? <ChevronDown size={14} />
                              : <ChevronsUpDown size={14} className="opacity-30" />}
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
                  onClick={() => setSelectedProduct(row.original)}
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

      {/* ── Create Product Modal ── */}
      <Modal open={createModal} onClose={() => setCreateModal(false)} title={t('products.new')} size="md">
        <form onSubmit={handleCreateProduct} className="space-y-4">
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('products.form.name')}
            </label>
            <input type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)}
              placeholder={t('products.form.namePlaceholder')} required
              className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          </div>
          <div>
            <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
              {t('products.form.description')}
            </label>
            <textarea value={newDescription} onChange={(e) => setNewDescription(e.target.value)}
              placeholder={t('products.form.description')} rows={2}
              className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2 resize-none"
              style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
          </div>
          <div className="flex gap-2 justify-end pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
            <button type="button" onClick={() => setCreateModal(false)} className="px-4 py-2 text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
              {t('common.cancel')}
            </button>
            <button type="submit" disabled={createMutation.isPending} className="px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50" style={{ background: 'var(--accent)', color: 'white' }}>
              {createMutation.isPending ? t('products.form.submitting') : t('products.form.submit')}
            </button>
          </div>
        </form>
      </Modal>

      {/* ── Product Detail Modal ── */}
      <Modal
        open={!!selectedProduct && !variantMode}
        onClose={() => { setSelectedProduct(null); setVariantMode(null); setEditingVariant(null); resetVariantForm(); }}
        title={selectedProduct?.title || t('products.detail.title')}
        size="lg"
      >
        {selectedProduct && (
          <div className="space-y-5">
            <div className="p-3 rounded-lg space-y-3" style={{ border: '1px solid var(--border)' }}>
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1">
                  <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                    {t('products.form.name')}
                  </label>
                  <input type="text" defaultValue={selectedProduct.title}
                    onBlur={(e) => { if (e.target.value !== selectedProduct.title) updateProductMutation.mutate({ id: selectedProduct.id, data: { title: e.target.value } }); }}
                    className="w-full px-3 py-2 font-mono text-sm rounded-lg focus:outline-none focus:ring-2"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
                </div>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                    {t('products.form.status')}
                  </label>
                  <select value={selectedProduct.status}
                    onChange={(e) => updateProductMutation.mutate({ id: selectedProduct.id, data: { status: e.target.value } })}
                    disabled={updateProductMutation.isPending}
                    className="px-3 py-2 font-mono text-sm rounded-lg focus:outline-none focus:ring-2"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }}>
                    <option value="draft">{t('products.status.draft')}</option>
                    <option value="active">{t('products.status.active')}</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                  {t('products.form.description')}
                </label>
                <textarea defaultValue={selectedProduct.description || ''}
                  onBlur={(e) => { if (e.target.value !== (selectedProduct.description || '')) updateProductMutation.mutate({ id: selectedProduct.id, data: { description: e.target.value } }); }}
                  placeholder={t('products.form.description')} rows={2}
                  className="w-full px-3 py-2 font-mono text-sm rounded-lg focus:outline-none focus:ring-2 resize-none"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
              </div>
            </div>

            <div className="p-3 rounded-lg" style={{ border: '1px solid var(--border)' }}>
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                  {t('products.col.variants')} ({selectedProduct.variants.length})
                </h4>
                <button onClick={() => setVariantMode('add')} className="text-sm font-medium hover:underline" style={{ color: 'var(--accent)' }}>
                  + {t('products.detail.newVariant')}
                </button>
              </div>
              {selectedProduct.variants.length === 0 ? (
                <p className="font-mono text-sm py-6 text-center" style={{ color: 'var(--text-secondary)' }}>
                  {t('products.detail.noVariants')}
                </p>
              ) : (
                <div className="space-y-2">
                  {selectedProduct.variants.map((v) => (
                    <VariantCard
                      key={v.id}
                      variant={v}
                      onClick={() => openEditVariant(v)}
                    />
                  ))}
                </div>
              )}
            </div>

            <div className="text-xs font-mono pt-4 border-t" style={{ borderColor: 'var(--border)', color: 'var(--text-muted)' }}>
              {t('common.createdAt')} {new Date(selectedProduct.created_at).toLocaleString()}
            </div>
          </div>
        )}
      </Modal>

      {/* ── Variant Form Modal ── */}
      <Modal
        open={!!selectedProduct && !!variantMode}
        onClose={() => { setVariantMode(null); setEditingVariant(null); resetVariantForm(); }}
        title={variantMode === 'edit' ? t('products.variant.editTitle') : t('products.variant.addTitle')}
        size="md"
      >
        {selectedProduct && variantMode && (
          <div>
            <button
              onClick={() => { setVariantMode(null); setEditingVariant(null); resetVariantForm(); }}
              className="flex items-center gap-2 text-sm font-mono mb-5 hover:underline"
              style={{ color: 'var(--text-muted)' }}
            >
              <ArrowLeft size={14} />
              {selectedProduct.title}
            </button>

            <form onSubmit={handleVariantSubmit} className="space-y-4">

              {/* Product type toggle */}
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                  {t('products.variant.type')}
                </label>
                <div className="flex gap-2">
                  {(['physical', 'digital'] as const).map((type) => (
                    <button
                      key={type}
                      type="button"
                      onClick={() => {
                        setVariantProductType(type);
                        if (type === 'digital') setVariantWeightG('');
                      }}
                      className="flex-1 px-3 py-2 text-sm font-medium rounded-lg transition-colors capitalize"
                      style={{
                        border: `1px solid ${variantProductType === type ? 'var(--accent)' : 'var(--border)'}`,
                        background: variantProductType === type ? 'rgba(245, 199, 71, 0.1)' : 'var(--bg-card)',
                        color: variantProductType === type ? 'var(--text)' : 'var(--text-muted)',
                      }}
                    >
                      {type === 'physical' ? t('products.variant.physical') : t('products.variant.digital')}
                    </button>
                  ))}
                </div>
              </div>

              {/* SKU + Price */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                    {t('products.variant.sku')}
                  </label>
                  <input type="text" value={variantSku} onChange={(e) => setVariantSku(e.target.value)}
                    placeholder={t('products.variant.skuPlaceholder')} required
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
                </div>
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                    {t('products.variant.price')}
                  </label>
                  <input type="number" value={variantPrice} onChange={(e) => setVariantPrice(e.target.value)}
                    placeholder={t('products.variant.pricePlaceholder')} required min="0"
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
                </div>
              </div>

              {/* Title */}
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                  {t('products.variant.title')}
                </label>
                <input type="text" value={variantTitle} onChange={(e) => setVariantTitle(e.target.value)}
                  placeholder={t('products.variant.titlePlaceholder')} required
                  className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                  style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
              </div>

              {/* Weight — physical only */}
              {variantProductType === 'physical' && (
                <div>
                  <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                    {t('products.variant.weight')}
                  </label>
                  <input type="number" value={variantWeightG} onChange={(e) => setVariantWeightG(e.target.value)}
                    placeholder={t('products.variant.weightPlaceholder')} min="0"
                    className="w-full px-3 py-2 text-sm font-mono rounded-lg focus:outline-none focus:ring-2"
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', color: 'var(--text)' }} />
                </div>
              )}

              {/* Image — unchanged pattern */}
              <div>
                <label className="block text-xs font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--text-secondary)' }}>
                  {t('products.variant.image')}
                </label>
                {variantImage ? (
                  <div className="relative inline-block">
                    <img src={variantImage} alt="" className="w-20 h-20 object-cover rounded-lg"
                      style={{ border: '1px solid var(--border)' }} />
                    <button type="button" onClick={() => setVariantImage(null)}
                      className="absolute -top-2 -right-2 w-5 h-5 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600">
                      <X size={12} />
                    </button>
                  </div>
                ) : (
                  <label className="flex flex-col items-center justify-center w-full h-20 border-2 border-dashed rounded-lg cursor-pointer transition-colors hover:border-[var(--accent)]"
                    style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}>
                    <input type="file" accept="image/jpeg,image/png,image/webp,image/gif"
                      onChange={handleImageUpload} className="hidden" />
                    <Upload size={18} style={{ color: 'var(--text-muted)' }} />
                    <span className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>
                      {t('common.clickUpload')}
                    </span>
                  </label>
                )}
              </div>

              {/* Digital asset — mirrors image pattern exactly */}
              {variantProductType === 'digital' && (
                <div className="space-y-2">
                  <label className="block text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-secondary)' }}>
                    {t('products.variant.digitalFile')}
                  </label>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {t('products.variant.digitalFileHint')}
                  </p>

                  {/* Asset chip — shown when a file is set (mirrors the image thumbnail) */}
                  {variantAsset ? (
                    <div
                      className="flex items-center gap-3 p-3 rounded-lg"
                      style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
                    >
                      {/* File icon */}
                      <div
                        className="w-10 h-10 flex items-center justify-center rounded flex-shrink-0"
                        style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)' }}
                      >
                        {isUploadingAsset(variantAsset)
                          ? <Loader2 size={16} className="animate-spin" style={{ color: 'var(--text-muted)' }} />
                          : <File size={16} style={{ color: 'var(--accent)' }} />
                        }
                      </div>

                      {/* Name + subtitle */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate" style={{ color: 'var(--text)' }}>
                          {assetChipLabel(variantAsset)}
                        </p>
                        <p className="text-xs font-mono truncate" style={{ color: 'var(--text-muted)' }}>
                          {isUploadingAsset(variantAsset)
                            ? `${formatFileSize(variantAsset.size)} · ${t('products.variant.uploading')}`
                            : assetChipSubLabel(variantAsset)
                          }
                        </p>
                      </div>

                      {/* Actions — download (committed only) + remove */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        {isCommittedAsset(variantAsset) && (
                          <a
                            href={assetDownloadUrl(variantAsset)}
                            download
                            target="_blank"
                            rel="noreferrer"
                            className="p-1.5 rounded transition-colors hover:bg-[var(--bg-hover)]"
                            style={{ color: 'var(--text-muted)' }}
                            title="Download file"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Download size={14} />
                          </a>
                        )}
                        <button
                          type="button"
                          onClick={handleRemoveAsset}
                          disabled={deleteAssetMutation.isPending || isUploadingAsset(variantAsset)}
                          className="p-1.5 rounded transition-colors hover:bg-red-500/10 hover:text-red-500 disabled:opacity-40"
                          style={{ color: 'var(--text-muted)' }}
                          title="Remove file"
                        >
                          {deleteAssetMutation.isPending
                            ? <Loader2 size={14} className="animate-spin" />
                            : <X size={14} />
                          }
                        </button>
                      </div>
                    </div>
                  ) : (
                    /* Upload zone — shown when no file is set (mirrors image upload zone) */
                    <label
                      className="flex flex-col items-center justify-center w-full h-20 border-2 border-dashed rounded-lg cursor-pointer transition-colors hover:border-[var(--accent)]"
                      style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
                    >
                      <input
                        type="file"
                        accept={ACCEPTED_ASSET_TYPES}
                        onChange={handleAssetPick}
                        className="hidden"
                      />
                      <FileUp size={18} style={{ color: 'var(--text-muted)' }} />
                      <span className="text-xs mt-1 font-mono" style={{ color: 'var(--text-muted)' }}>
                        {t('common.clickUpload')}
                      </span>
                    </label>
                  )}
                </div>
              )}

              <div className="flex gap-2 justify-end pt-4 border-t" style={{ borderColor: 'var(--border)' }}>
                <button type="button"
                  onClick={() => { setVariantMode(null); setEditingVariant(null); resetVariantForm(); }}
                  className="px-4 py-2 text-sm font-medium" style={{ color: 'var(--text-muted)' }}>
                  {t('common.cancel')}
                </button>
                <button type="submit"
                  disabled={isPending || isAssetUploading}
                  className="px-4 py-2 text-sm font-semibold rounded-lg disabled:opacity-50"
                  style={{ background: 'var(--accent)', color: 'white' }}>
                  {isPending
                    ? (variantMode === 'edit' ? t('common.saving') : t('products.variant.add'))
                    : (variantMode === 'edit' ? t('products.variant.save') : t('products.variant.add'))}
                </button>
              </div>
            </form>
          </div>
        )}
      </Modal>
    </div>
  );
}

// ── Variant card ───────────────────────────────────────────────
// Reads digital_asset_key directly from the variant.

function VariantCard({
  variant,
  onClick,
}: {
  variant: Variant;
  onClick: () => void;
}) {
  const t = useT();
  const hasAsset = Boolean(variant.digital_asset_key);

  return (
    <div
      className="flex items-center gap-4 p-3 rounded-lg cursor-pointer transition-colors hover:bg-[var(--bg-hover)]"
      style={{ background: 'var(--bg-subtle)', border: '1px solid var(--border-subtle)' }}
      onClick={onClick}
    >
      {/* Thumbnail */}
      {variant.image_url ? (
        <img src={variant.image_url} alt="" className="w-10 h-10 object-cover rounded flex-shrink-0"
          style={{ border: '1px solid var(--border)' }} />
      ) : (
        <div className="w-10 h-10 flex items-center justify-center rounded flex-shrink-0"
          style={{ background: 'var(--bg-content)', border: '1px solid var(--border)' }}>
          <ImageIcon size={16} style={{ color: 'var(--text-muted)' }} />
        </div>
      )}

      {/* Info */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-mono text-sm">{variant.title}</p>
          {variant.product_type === 'digital' && (
            <span
              className="text-xs px-1.5 py-0.5 rounded font-medium"
              style={{
                background: 'rgba(245,199,71,0.15)',
                color: 'var(--text-secondary)',
                border: '1px solid rgba(245,199,71,0.3)',
              }}
            >
              {t('common.digital')}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <p className="text-xs font-mono" style={{ color: 'var(--text-muted)' }}>{variant.sku}</p>
          {variant.product_type === 'digital' && (
            <p
              className="text-xs font-mono"
              style={{ color: hasAsset ? 'var(--text-muted)' : 'var(--accent)' }}
            >
              {hasAsset
                ? `📎 ${assetDisplayName(variant.digital_asset_key!)}`
                : t('products.variant.noFile')}
            </p>
          )}
        </div>
      </div>

      {/* Price + edit icon */}
      <p className="font-mono text-sm flex-shrink-0">{formatPrice(variant.price_cents)}</p>
      <Pencil size={14} style={{ color: 'var(--text-muted)' }} />
    </div>
  );
}
