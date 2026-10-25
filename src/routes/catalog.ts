import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { z } from '@hono/zod-openapi';
import { getDb } from '../db';
import { authMiddleware, adminOnly } from '../middleware/auth';
import { ApiError, uuid, now, type HonoEnv } from '../types';
import { requestSiteRebuild } from '../lib/rebuild';
import {
  IdParam,
  ProductResponse,
  ProductListResponse,
  CreateProductBody,
  UpdateProductBody,
  ProductQuery,
  VariantResponse,
  CreateVariantBody,
  UpdateVariantBody,
  ErrorResponse,
  DeletedResponse,
} from '../schemas';

const VariantIdParam = z.object({
  id: z.string().uuid().openapi({ param: { name: 'id', in: 'path' } }),
  variantId: z.string().uuid().openapi({ param: { name: 'variantId', in: 'path' } }),
});

const app = new OpenAPIHono<HonoEnv>();

app.use('*', authMiddleware);

function slugify(input: string): string {
  return input
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'product';
}

// Generates a unique slug by appending -2, -3, ... on conflict. Products
// table is small enough that a per-create existence check is cheap.
async function uniqueSlug(db: ReturnType<typeof getDb>, base: string, excludeId?: string): Promise<string> {
  let candidate = base;
  let suffix = 2;
  while (true) {
    const rows = excludeId
      ? await db.query<{ id: string }>(`SELECT id FROM products WHERE slug = ? AND id != ?`, [candidate, excludeId])
      : await db.query<{ id: string }>(`SELECT id FROM products WHERE slug = ?`, [candidate]);
    if (rows.length === 0) return candidate;
    candidate = `${base}-${suffix++}`;
  }
}

const listProducts = createRoute({
  method: 'get',
  path: '/',
  tags: ['Products'],
  summary: 'List products',
  security: [{ bearerAuth: [] }],
  request: { query: ProductQuery },
  responses: {
    200: { content: { 'application/json': { schema: ProductListResponse } }, description: 'List of products' },
  },
});

app.openapi(listProducts, async (c) => {
  const db = getDb(c.var.db);
  const { limit: limitStr, cursor, status, tag } = c.req.valid('query');
  const limit = Math.min(parseInt(limitStr || '20'), 100);

  let query = `SELECT * FROM products`;
  const params: unknown[] = [];
  const conditions: string[] = [];

  if (status) {
    conditions.push(`status = ?`);
    params.push(status);
  }
  if (tag) {
    // tags is stored as a JSON array string (e.g. '["skincare","bestseller"]');
    // a simple LIKE on the quoted value is enough for this volume of data.
    conditions.push(`tags LIKE ?`);
    params.push(`%"${tag}"%`);
  }
  if (cursor) {
    conditions.push(`created_at < ?`);
    params.push(cursor);
  }

  if (conditions.length > 0) {
    query += ` WHERE ${conditions.join(' AND ')}`;
  }

  query += ` ORDER BY created_at DESC LIMIT ?`;
  params.push(limit + 1);

  const products = await db.query<any>(query, params);
  const hasMore = products.length > limit;
  if (hasMore) products.pop();

  const productIds = products.map((p) => p.id);
  const variantsByProduct: Record<string, any[]> = {};

  if (productIds.length > 0) {
    const placeholders = productIds.map(() => '?').join(',');
    // Stock only means something for physical goods — digital variants are
    // always available regardless of their inventory row (every variant gets
    // one at creation, defaulting to on_hand: 0, which would otherwise make
    // brand-new digital products wrongly show as out of stock).
    const allVariants = await db.query<any>(
      `SELECT v.*,
         CASE WHEN v.product_type IN ('digital', 'service') THEN 1
              ELSE CASE WHEN COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0) > 0 THEN 1 ELSE 0 END
         END as in_stock
       FROM variants v
       LEFT JOIN inventory i ON i.sku = v.sku
       WHERE v.product_id IN (${placeholders}) ORDER BY v.created_at ASC`,
      productIds
    );

    for (const v of allVariants) {
      if (!variantsByProduct[v.product_id]) {
        variantsByProduct[v.product_id] = [];
      }
      variantsByProduct[v.product_id].push(v);
    }
  }

  const items = products.map((p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    slug: p.slug,
    description_fr: p.description_fr,
    description_en: p.description_en,
    tags: p.tags ? JSON.parse(p.tags) : null,
    video_url: p.video_url ?? null,
    deposit_type: p.deposit_type ?? null,
    deposit_value: p.deposit_value ?? null,
    deposit_due_days: p.deposit_due_days ?? null,
    status: p.status,
    created_at: p.created_at,
    variants: (variantsByProduct[p.id] || []).map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
      weight_g: v.weight_g,
      product_type: v.product_type,
      digital_asset_key: v.digital_asset_key,
      in_stock: !!v.in_stock,
    })),
  }));

  const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].created_at : null;

  return c.json({ items, pagination: { has_more: hasMore, next_cursor: nextCursor } }, 200);
});

const getProduct = createRoute({
  method: 'get',
  path: '/{id}',
  tags: ['Products'],
  summary: 'Get product by ID',
  security: [{ bearerAuth: [] }],
  request: { params: IdParam },
  responses: {
    200: { content: { 'application/json': { schema: ProductResponse } }, description: 'Product details' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});

app.openapi(getProduct, async (c) => {
  const db = getDb(c.var.db);
  const { id } = c.req.valid('param');

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!product) throw ApiError.notFound('Product not found');

  const variants = await db.query<any>(
    `SELECT v.*,
       CASE WHEN v.product_type IN ('digital', 'service') THEN 1
            ELSE CASE WHEN COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0) > 0 THEN 1 ELSE 0 END
       END as in_stock
     FROM variants v LEFT JOIN inventory i ON i.sku = v.sku
     WHERE v.product_id = ? ORDER BY v.created_at ASC`,
    [id]
  );

  return c.json({
    id: product.id,
    title: product.title,
    description: product.description,
    slug: product.slug,
    description_fr: product.description_fr,
    description_en: product.description_en,
    tags: product.tags ? JSON.parse(product.tags) : null,
    video_url: product.video_url ?? null,
    deposit_type: product.deposit_type ?? null,
    deposit_value: product.deposit_value ?? null,
    deposit_due_days: product.deposit_due_days ?? null,
    status: product.status,
    created_at: product.created_at,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
      weight_g: v.weight_g,
      product_type: v.product_type,
      digital_asset_key: v.digital_asset_key,
      in_stock: !!v.in_stock,
    })),
  }, 200);
});

const createProduct = createRoute({
  method: 'post',
  path: '/',
  tags: ['Products'],
  summary: 'Create product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { body: { content: { 'application/json': { schema: CreateProductBody } } } },
  responses: {
    201: { content: { 'application/json': { schema: ProductResponse } }, description: 'Product created' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Invalid request' },
  },
});

app.openapi(createProduct, async (c) => {
  const { title, description, slug, description_fr, description_en, tags, video_url } = c.req.valid('json');
  const db = getDb(c.var.db);

  const id = uuid();
  const timestamp = now();
  const finalSlug = await uniqueSlug(db, slug ? slugify(slug) : slugify(title));

  await db.run(
    `INSERT INTO products (id, title, description, slug, description_fr, description_en, tags, video_url, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
    [id, title, description || null, finalSlug, description_fr || null, description_en || null,
     tags ? JSON.stringify(tags) : null, video_url || null, timestamp]
  );

  await requestSiteRebuild(c.var.db);

  return c.json(
    {
      id, title, description: description || null, slug: finalSlug,
      description_fr: description_fr || null, description_en: description_en || null,
      tags: tags || null, video_url: video_url || null,
      status: 'active' as const, created_at: timestamp, variants: [],
    },
    201
  );
});

const updateProduct = createRoute({
  method: 'patch',
  path: '/{id}',
  tags: ['Products'],
  summary: 'Update product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: UpdateProductBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: ProductResponse } }, description: 'Product updated' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
  },
});

app.openapi(updateProduct, async (c) => {
  const { id } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);

  const [existing] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!existing) throw ApiError.notFound('Product not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.title !== undefined) {
    updates.push('title = ?');
    params.push(body.title);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    params.push(body.description);
  }
  if (body.slug !== undefined) {
    const finalSlug = await uniqueSlug(db, slugify(body.slug), id);
    updates.push('slug = ?');
    params.push(finalSlug);
  }
  if (body.description_fr !== undefined) {
    updates.push('description_fr = ?');
    params.push(body.description_fr);
  }
  if (body.description_en !== undefined) {
    updates.push('description_en = ?');
    params.push(body.description_en);
  }
  if (body.tags !== undefined) {
    updates.push('tags = ?');
    params.push(body.tags ? JSON.stringify(body.tags) : null);
  }
  if (body.deposit_type !== undefined || body.deposit_value !== undefined) {
    const dType = body.deposit_type !== undefined ? body.deposit_type : existing.deposit_type;
    const dValue = body.deposit_type === null ? null : body.deposit_value !== undefined ? body.deposit_value : existing.deposit_value;
    if (dType && !dValue) throw ApiError.invalidRequest('deposit_value is required with deposit_type.');
    if (dType === 'percent' && Number(dValue) > 99) throw ApiError.invalidRequest('A percentage deposit must be between 1 and 99.');
    updates.push('deposit_type = ?', 'deposit_value = ?');
    params.push(dType ?? null, dType ? dValue : null);
  }
  if (body.deposit_due_days !== undefined || body.deposit_type === null) {
    updates.push('deposit_due_days = ?');
    params.push(body.deposit_type === null ? null : body.deposit_due_days ?? null);
  }
  if (body.video_url !== undefined) {
    updates.push('video_url = ?');
    params.push(body.video_url || null);
  }
  if (body.status !== undefined) {
    updates.push('status = ?');
    params.push(body.status);
  }

  if (updates.length > 0) {
    params.push(id);
    await db.run(`UPDATE products SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  const variants = await db.query<any>(
    `SELECT v.*,
       CASE WHEN v.product_type IN ('digital', 'service') THEN 1
            ELSE CASE WHEN COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0) > 0 THEN 1 ELSE 0 END
       END as in_stock
     FROM variants v LEFT JOIN inventory i ON i.sku = v.sku
     WHERE v.product_id = ?`,
    [id]
  );

  await requestSiteRebuild(c.var.db);

  return c.json({
    id: product.id,
    title: product.title,
    description: product.description,
    slug: product.slug,
    description_fr: product.description_fr,
    description_en: product.description_en,
    tags: product.tags ? JSON.parse(product.tags) : null,
    video_url: product.video_url ?? null,
    deposit_type: product.deposit_type ?? null,
    deposit_value: product.deposit_value ?? null,
    deposit_due_days: product.deposit_due_days ?? null,
    status: product.status,
    created_at: product.created_at,
    variants: variants.map((v) => ({
      id: v.id,
      sku: v.sku,
      title: v.title,
      price_cents: v.price_cents,
      image_url: v.image_url,
      weight_g: v.weight_g,
      product_type: v.product_type,
      digital_asset_key: v.digital_asset_key,
      in_stock: !!v.in_stock,
    })),
  }, 200);
});

const deleteProduct = createRoute({
  method: 'delete',
  path: '/{id}',
  tags: ['Products'],
  summary: 'Delete product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: IdParam },
  responses: {
    200: { content: { 'application/json': { schema: DeletedResponse } }, description: 'Product deleted' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cannot delete' },
  },
});

app.openapi(deleteProduct, async (c) => {
  const { id } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [id]);
  if (!product) throw ApiError.notFound('Product not found');

  const variants = await db.query<any>(`SELECT sku FROM variants WHERE product_id = ?`, [id]);

  if (variants.length > 0) {
    const skus = variants.map((v) => v.sku);
    const placeholders = skus.map(() => '?').join(',');
    const [orderItem] = await db.query<any>(
      `SELECT id FROM order_items WHERE sku IN (${placeholders}) LIMIT 1`,
      skus
    );

    if (orderItem) {
      throw ApiError.conflict('Cannot delete product with variants that have been ordered. Set status to draft instead.');
    }
  }

  for (const v of variants) {
    await db.run(`DELETE FROM inventory WHERE sku = ?`, [v.sku]);
  }

  await db.run(`DELETE FROM variants WHERE product_id = ?`, [id]);
  await db.run(`DELETE FROM products WHERE id = ?`, [id]);

  await requestSiteRebuild(c.var.db);

  return c.json({ deleted: true as const }, 200);
});

const createVariant = createRoute({
  method: 'post',
  path: '/{id}/variants',
  tags: ['Products'],
  summary: 'Add variant to product',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: IdParam,
    body: { content: { 'application/json': { schema: CreateVariantBody } } },
  },
  responses: {
    201: { content: { 'application/json': { schema: VariantResponse } }, description: 'Variant created' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Product not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'SKU already exists' },
  },
});

app.openapi(createVariant, async (c) => {
  const { id: productId } = c.req.valid('param');
  const { sku, title, price_cents, image_url, product_type, weight_g } = c.req.valid('json');
  const db = getDb(c.var.db);

  const [product] = await db.query<any>(`SELECT * FROM products WHERE id = ?`, [productId]);
  if (!product) throw ApiError.notFound('Product not found');

  const [existingSku] = await db.query<any>(`SELECT * FROM variants WHERE sku = ?`, [sku]);
  if (existingSku) throw ApiError.conflict(`SKU ${sku} already exists`);

  const id = uuid();
  const timestamp = now();
  // digital_asset_key is intentionally not settable here — it's only ever
  // written by the asset upload/delete endpoints in routes/assets.ts.
  await db.run(
    `INSERT INTO variants (id, product_id, sku, title, price_cents, weight_g, image_url, product_type, digital_asset_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, productId, sku, title, price_cents, weight_g, image_url || null, product_type, null, timestamp]
  );

  await db.run(
    `INSERT INTO inventory (id, sku, on_hand, reserved, updated_at) VALUES (?, ?, 0, 0, ?)`,
    [uuid(), sku, timestamp]
  );

  await requestSiteRebuild(c.var.db);

  return c.json({
    id, sku, title, price_cents, image_url: image_url || null, weight_g, product_type,
    digital_asset_key: null,
    in_stock: product_type !== 'physical', // new variants start at on_hand: 0 (digital/service never need stock)
  }, 201);
});

const updateVariant = createRoute({
  method: 'patch',
  path: '/{id}/variants/{variantId}',
  tags: ['Products'],
  summary: 'Update variant',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    params: VariantIdParam,
    body: { content: { 'application/json': { schema: UpdateVariantBody } } },
  },
  responses: {
    200: { content: { 'application/json': { schema: VariantResponse } }, description: 'Variant updated' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'SKU already exists' },
  },
});

app.openapi(updateVariant, async (c) => {
  const { id: productId, variantId } = c.req.valid('param');
  const body = c.req.valid('json');
  const db = getDb(c.var.db);

  const [existing] = await db.query<any>(
    `SELECT * FROM variants WHERE id = ? AND product_id = ?`,
    [variantId, productId]
  );
  if (!existing) throw ApiError.notFound('Variant not found');

  const updates: string[] = [];
  const params: unknown[] = [];

  if (body.sku !== undefined) {
    const [existingSku] = await db.query<any>(
      `SELECT * FROM variants WHERE sku = ? AND id != ?`,
      [body.sku, variantId]
    );
    if (existingSku) throw ApiError.conflict(`SKU ${body.sku} already exists`);

    await db.run(`UPDATE inventory SET sku = ? WHERE sku = ?`, [body.sku, existing.sku]);
    updates.push('sku = ?');
    params.push(body.sku);
  }
  if (body.title !== undefined) {
    updates.push('title = ?');
    params.push(body.title);
  }
  if (body.price_cents !== undefined) {
    updates.push('price_cents = ?');
    params.push(body.price_cents);
  }
  if (body.image_url !== undefined) {
    updates.push('image_url = ?');
    params.push(body.image_url);
  }

  if (body.weight_g !== undefined) {
    updates.push('weight_g = ?');
    params.push(body.weight_g);
  }

  if (body.product_type !== undefined) {
    updates.push('product_type = ?');
    params.push(body.product_type);
  }

  if (updates.length > 0) {
    params.push(variantId);
    await db.run(`UPDATE variants SET ${updates.join(', ')} WHERE id = ?`, params);
  }

  const [variant] = await db.query<any>(
    `SELECT v.*,
       CASE WHEN v.product_type IN ('digital', 'service') THEN 1
            ELSE CASE WHEN COALESCE(i.on_hand, 0) - COALESCE(i.reserved, 0) > 0 THEN 1 ELSE 0 END
       END as in_stock
     FROM variants v LEFT JOIN inventory i ON i.sku = v.sku
     WHERE v.id = ?`,
    [variantId]
  );

  await requestSiteRebuild(c.var.db);

  return c.json({
    id: variant.id,
    sku: variant.sku,
    title: variant.title,
    price_cents: variant.price_cents,
    image_url: variant.image_url,
    weight_g: variant.weight_g,
    product_type: variant.product_type,
    digital_asset_key: variant.digital_asset_key,
    in_stock: !!variant.in_stock,
  }, 200);
});

const deleteVariant = createRoute({
  method: 'delete',
  path: '/{id}/variants/{variantId}',
  tags: ['Products'],
  summary: 'Delete variant',
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: { params: VariantIdParam },
  responses: {
    200: { content: { 'application/json': { schema: DeletedResponse } }, description: 'Variant deleted' },
    404: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Not found' },
    409: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Cannot delete' },
  },
});

app.openapi(deleteVariant, async (c) => {
  const { id: productId, variantId } = c.req.valid('param');
  const db = getDb(c.var.db);

  const [variant] = await db.query<any>(
    `SELECT * FROM variants WHERE id = ? AND product_id = ?`,
    [variantId, productId]
  );
  if (!variant) throw ApiError.notFound('Variant not found');

  const [orderItem] = await db.query<any>(`SELECT id FROM order_items WHERE sku = ? LIMIT 1`, [variant.sku]);
  if (orderItem) {
    throw ApiError.conflict('Cannot delete variant that has been ordered. Set product status to draft instead.');
  }

  await db.run(`DELETE FROM inventory WHERE sku = ?`, [variant.sku]);
  await db.run(`DELETE FROM variants WHERE id = ?`, [variantId]);

  await requestSiteRebuild(c.var.db);

  return c.json({ deleted: true as const }, 200);
});

// Temporary migration route — DELETE AFTER RUNNING ONCE
const migrateImageUrls = createRoute({
  method: 'post',
  path: '/admin/migrate-image-urls',
  tags: ['Products'],
  security: [{ bearerAuth: [] }],
  middleware: [adminOnly] as const,
  request: {
    body: {
      content: {
        'application/json': {
          schema: z.object({
            old_host: z.string(),
            new_host: z.string(),
          }),
        },
      },
    },
  },
  responses: {
    200: {
      content: {
        'application/json': {
          schema: z.object({ updated_variants: z.number() }),//schema: z.object({ updated_products: z.number(), updated_variants: z.number() }),
        },
      },
      description: 'URLs updated',
    },
  },
});

app.openapi(migrateImageUrls, async (c) => {
  const { old_host, new_host } = c.req.valid('json');
  const db = getDb(c.var.db);

  /*const r1 = await db.run(
    `UPDATE products SET image_url = REPLACE(image_url, ?, ?) WHERE image_url LIKE ?`,
    [old_host, new_host, `%${old_host}%`]
  );*/

  const r = await db.run(
    `UPDATE variants SET image_url = REPLACE(image_url, ?, ?) WHERE image_url LIKE ?`,
    [old_host, new_host, `%${old_host}%`]
  );

  return c.json({
    //updated_products: r1.changes,
    updated_variants: r.changes,
  }, 200);
});

export { app as catalog };
