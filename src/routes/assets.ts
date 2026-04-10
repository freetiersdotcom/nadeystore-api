// ============================================================
// DIGITAL ASSET UPLOAD
// ============================================================
// POST /v1/catalog/products/:id/variants/:variantId/asset
//
// Uploads a digital file (PDF, ZIP, etc.) to R2 under the
// "assets/" prefix, then stores the R2 key on the variant.
//
// This is a standalone route file. Mount it in index.ts or
// merge into catalog.ts alongside the existing variant routes.

import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { ErrorResponse } from '../schemas';

const app = new OpenAPIHono<HonoEnv>();
app.use('*', authMiddleware, adminOnly);

// ============================================================
// SCHEMAS
// ============================================================

const VariantAssetParam = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
  variantId: z.string().uuid().openapi({ param: { name: 'variantId', in: 'path' } }),
});

const AssetUploadResponse = z.object({
  key: z.string(),
  size_bytes: z.number().int(),
  content_type: z.string(),
  variant_id: z.string().uuid(),
}).openapi('AssetUpload');

// ============================================================
// POST /:id/variants/:variantId/asset
// ============================================================
// Accepts multipart/form-data with a single "file" field.
// Max size is determined by the worker's request size limit.

const uploadAsset = createRoute({
  method: 'post',
  path: '/{id}/variants/{variantId}/asset',
  tags: ['Catalog'],
  summary: 'Upload digital asset for a variant',
  description: [
    'Uploads a file (PDF, ZIP, MP4, etc.) to R2 storage and links it to the variant.',
    'The variant must have product_type = "digital".',
    'Send the file as multipart/form-data with field name "file".',
    'The R2 key is stored on the variant and used to generate presigned download URLs.',
  ].join(' '),
  security: [{ bearerAuth: [] }],
  request: { params: VariantAssetParam },
  responses: {
    200: { content: { 'application/json': { schema: AssetUploadResponse } }, description: 'Asset uploaded' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not a digital variant or missing file' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Product or variant not found' },
    503: { content: { 'application/json': { schema: ErrorResponse } }, description: 'R2 storage not configured' },
  },
});

app.openapi(uploadAsset, async (c) => {
  const { id: productId, variantId } = c.req.valid('param');

  const r2 = c.env.IMAGES as R2Bucket | undefined;
  if (!r2) {
    throw new ApiError('storage_unavailable', 503, 'R2 storage is not configured');
  }

  const db = getDb(c.var.db);

  const [variant] = await db.query<any>(
    `SELECT v.*, p.id as product_id FROM variants v
     JOIN products p ON v.product_id = p.id
     WHERE v.id = ? AND p.id = ? LIMIT 1`,
    [variantId, productId]
  );

  if (!variant) throw ApiError.notFound('Variant not found');

  if (variant.product_type !== 'digital') {
    throw ApiError.invalidRequest(
      'This variant is not a digital product. Set product_type = "digital" on the variant first.'
    );
  }

  // Parse multipart
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    throw ApiError.invalidRequest('Expected multipart/form-data');
  }

  const file = formData.get('file') as File | null;
  if (!file) {
    throw ApiError.invalidRequest('Missing "file" field in multipart body');
  }

  // Determine content type
  const contentType = file.type || 'application/octet-stream';

  // Build R2 key: assets/{variantId}/{sanitized-filename}
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const key = `assets/${variantId}/${safeName}`;

  // Upload to R2
  const buffer = await file.arrayBuffer();
  await r2.put(key, buffer, {
    httpMetadata: { contentType },
    customMetadata: {
      variant_id: variantId,
      product_id: productId,
      original_name: file.name,
      uploaded_at: now(),
    },
  });

  // Update variant with the asset key
  await db.run(
    `UPDATE variants SET digital_asset_key = ?, updated_at = ? WHERE id = ?`,
    [key, now(), variantId]
  );

  return c.json({
    key,
    size_bytes: buffer.byteLength,
    content_type: contentType,
    variant_id: variantId,
  }, 200);
});

// ============================================================
// DELETE /:id/variants/:variantId/asset
// ============================================================

const deleteAsset = createRoute({
  method: 'delete',
  path: '/{id}/variants/{variantId}/asset',
  tags: ['Catalog'],
  summary: 'Remove digital asset from a variant',
  security: [{ bearerAuth: [] }],
  request: { params: VariantAssetParam },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ deleted: z.literal(true) }) } }, description: 'Asset removed' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Variant not found' },
  },
});

app.openapi(deleteAsset, async (c) => {
  const { id: productId, variantId } = c.req.valid('param');
  const r2 = c.env.IMAGES as R2Bucket | undefined;
  const db = getDb(c.var.db);

  const [variant] = await db.query<any>(
    `SELECT v.digital_asset_key FROM variants v
     JOIN products p ON v.product_id = p.id
     WHERE v.id = ? AND p.id = ? LIMIT 1`,
    [variantId, productId]
  );

  if (!variant) throw ApiError.notFound('Variant not found');

  // Delete from R2 if key exists and bucket is configured
  if (variant.digital_asset_key && r2) {
    await r2.delete(variant.digital_asset_key);
  }

  await db.run(
    `UPDATE variants SET digital_asset_key = NULL, updated_at = ? WHERE id = ?`,
    [now(), variantId]
  );

  return c.json({ deleted: true as const }, 200);
});

export { app as assetRoutes };
