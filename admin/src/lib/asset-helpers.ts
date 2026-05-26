// ── Variant type — updated section only ───────────────────────
// Replace the Variant type in your existing api.ts with this.

export type Variant = {
  id: string;
  sku: string;
  title: string;
  price_cents: number;
  image_url: string | null;
  product_type: 'physical' | 'digital';
  digital_asset_key: string | null;  // "assets/{variant_id}/{filename.ext}"
  weight_g?: number;
};

// ── Asset helpers ─────────────────────────────────────────────
// These are pure utility functions — no API calls.
// Add them to api.ts or a separate src/lib/assets.ts.

const R2_URL = (import.meta.env.VITE_R2_URL as string | undefined)?.replace(/\/$/, '') || '';

/**
 * Derive the public download URL from a digital_asset_key.
 * Requires VITE_R2_URL to be set in the environment.
 *
 * "assets/abc123/my-file.pdf" → "https://media.store.com/assets/abc123/my-file.pdf"
 */
export function assetDownloadUrl(digitalAssetKey: string): string {
  return `${R2_URL}/${digitalAssetKey}`;
}

/**
 * Extract the raw filename from a digital_asset_key.
 * "assets/abc123/my-file-name.pdf" → "my-file-name.pdf"
 */
export function assetFilename(digitalAssetKey: string): string {
  return digitalAssetKey.split('/').pop() ?? digitalAssetKey;
}

/**
 * Convert a slug-style filename to a human-readable display name.
 * Inverts the lowercase-hyphen storage convention.
 *
 * "my-file-name.pdf" → "My File Name.pdf"
 * "guide-to-investing-2024.epub" → "Guide To Investing 2024.epub"
 */
export function assetDisplayName(digitalAssetKey: string): string {
  const filename = assetFilename(digitalAssetKey);
  const lastDot = filename.lastIndexOf('.');
  const hasExt = lastDot > 0;
  const base = hasExt ? filename.slice(0, lastDot) : filename;
  const ext  = hasExt ? filename.slice(lastDot)    : '';

  const displayBase = base
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

  return displayBase + ext;
}

/**
 * Format a file size in bytes to a human-readable string.
 * Used during the upload flow only — size is not persisted.
 *
 * 1_024 → "1.0 KB"
 * 2_500_000 → "2.4 MB"
 */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024)             return `${bytes} B`;
  if (bytes < 1024 * 1024)      return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
