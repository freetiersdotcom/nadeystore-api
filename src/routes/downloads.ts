import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { ApiError, type HonoEnv } from '../types';
import { validateDownloadToken, incrementDownloadCount } from '../lib/downloads';
import { getDb } from '../db';
import { ErrorResponse } from '../schemas';

const app = new OpenAPIHono<HonoEnv>();

// ============================================================
// SCHEMAS
// ============================================================

const DownloadTokenParam = z.object({
  token: z.string().min(1).openapi({ param: { name: 'token', in: 'path' } }),
});

const DownloadInfoResponse = z.object({
  sku: z.string(),
  order_id: z.string(),
  downloads_remaining: z.number().int(),
  expires_at: z.string().datetime(),
  redirect_url: z.string().url(),
}).openapi('DownloadInfo');

// ============================================================
// GET /v1/downloads/:token
// ============================================================
// This endpoint is intentionally PUBLIC — no auth middleware.
// The token itself is the credential.
//
// Behaviour:
//   1. Validate token (exists, not expired, under download limit)
//   2. Look up the digital asset R2 key on the variant
//   3. Atomically increment download_count
//   4. Generate a short-lived R2 presigned URL
//   5. 302 redirect to that URL
//
// The frontend download page should simply link to or redirect
// through this endpoint. No separate API call is needed.

const getDownload = createRoute({
  method: 'get',
  path: '/{token}',
  tags: ['Downloads'],
  summary: 'Validate token and redirect to asset',
  description: [
    'Public endpoint — the token is the credential.',
    'Returns 302 redirect to a short-lived R2 presigned URL.',
    'Also returns download metadata in headers for frontend use.',
  ].join(' '),
  request: { params: DownloadTokenParam },
  responses: {
    302: { description: 'Redirect to presigned download URL' },
    200: {
      content: { 'application/json': { schema: DownloadInfoResponse } },
      description: 'Download info (when Accept: application/json)',
    },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Token expired or limit reached' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Token not found' },
    503: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Asset storage not configured' },
  },
});

app.openapi(getDownload, async (c) => {
  const { token } = c.req.valid('param');
  const db = getDb(c.var.db);

  // 1. Validate token
  const result = await validateDownloadToken(db, token);
  if (!result.ok) {
    switch (result.reason) {
      case 'not_found':   throw ApiError.notFound('Download link not found or has expired');
      case 'expired':     throw ApiError.invalidRequest('This download link has expired');
      case 'limit_reached': throw ApiError.invalidRequest('This download link has reached its maximum number of uses');
    }
  }

  const { token: tokenRow } = result;

  // 2. Look up asset key on variant
  const [variant] = await db.query<{ digital_asset_key: string | null; title: string }>(
    `SELECT digital_asset_key, title FROM variants WHERE sku = ? LIMIT 1`,
    [tokenRow.sku]
  );
  if (!variant?.digital_asset_key) {
    throw ApiError.notFound('Asset not found for this product');
  }

  // 3. Check R2 bucket is configured
  const r2 = c.env.IMAGES as R2Bucket | undefined;
  if (!r2) throw new ApiError('storage_unavailable', 503, 'Asset storage is not configured');

  // 4. Fetch object from R2
  const object = await r2.get(variant.digital_asset_key);
  if (!object) throw ApiError.notFound('Asset file not found in storage');

  const filename    = variant.digital_asset_key.split('/').pop() ?? 'download';
  const contentType = object.httpMetadata?.contentType ?? 'application/octet-stream';

  // If the client wants JSON, return metadata instead of the file
  const acceptsJson = c.req.header('Accept')?.includes('application/json');
  const workerUrl = new URL(c.req.url).origin;
  if (acceptsJson) {
	const downloadsRemaining = Math.max(0, tokenRow.max_downloads - tokenRow.download_count);
    return c.json({
      sku:                 tokenRow.sku,
      order_id:            tokenRow.order_id,
      downloads_remaining: downloadsRemaining,
      expires_at:          tokenRow.expires_at,
      download_url:        `${workerUrl}/v1/downloads/${token}`,
    }, 200);
  }
  
  // 5. Atomically increment download count for streaming the file but not for displaying the metadata
  const incremented = await incrementDownloadCount(db, tokenRow.id, tokenRow.max_downloads);
  if (!incremented) {
    throw ApiError.invalidRequest('This download link has reached its maximum number of uses');
  }

  // Stream file directly to the client
  return new Response(object.body, {
    headers: {
      'Content-Type':           contentType,
      'Content-Disposition':    `attachment; filename="${filename}"`,
      'Cache-Control':          'private, no-store',
      'X-Downloads-Remaining':  String(downloadsRemaining),
    },
  });
});

export { app as downloads };