import { getAuth } from './store';

export class ApiError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { apiUrl, apiKey } = getAuth();

  const res = await fetch(`${apiUrl}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new ApiError(
      err.error?.code || 'unknown',
      res.status,
      err.error?.message || res.statusText
    );
  }

  return res.json();
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type Order = {
  id: string;
  number?: string;
  status: 'pending' | 'paid' | 'processing' | 'shipped' | 'delivered' | 'refunded' | 'canceled';
  customer_email: string;
  customer_id?: string | null;
  shipping?: {
    name: string | null;
    phone: string | null;
    address: {
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      postal_code?: string;
      country?: string;
    } | null;
  } | null;
  amounts: {
    subtotal_cents: number;
    tax_cents: number;
    shipping_cents: number;
    total_cents: number;
    currency: string;
  };
  tracking?: {
    number: string | null;
    url: string | null;
    shipped_at: string | null;
  };
  stripe?: {
    checkout_session_id: string | null;
    payment_intent_id: string | null;
  };
  items: Array<{
    sku: string;
    title: string;
    qty: number;
    unit_price_cents: number;
    product_type?: 'physical' | 'digital';
  }>;
  created_at: string;
};

export type Customer = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  has_account: boolean;
  accepts_marketing: boolean;
  stats: {
    order_count: number;
    total_spent_cents: number;
    last_order_at: string | null;
  };
  metadata: Record<string, unknown> | null;
  created_at: string;
  updated_at: string;
};

export type CustomerAddress = {
  id: string;
  label: string | null;
  is_default: boolean;
  name: string | null;
  company: string | null;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postal_code: string;
  country: string;
  phone: string | null;
};

export type Product = {
  id: string;
  title: string;
  description: string | null;
  status: 'active' | 'draft';
  created_at: string;
  variants: Variant[];
};

export type Variant = {
  id: string;
  sku: string;
  title: string;
  price_cents: number;
  image_url: string | null;
  product_type: 'physical' | 'digital';
  asset_filename?: string | null;
  asset_uploaded_at?: string | null;
  weight_g?: number;
};

export type InventoryItem = {
  sku: string;
  on_hand: number;
  reserved: number;
  available: number;
  variant_title: string | null;
  product_title: string | null;
};

export type Webhook = {
  id: string;
  url: string;
  events: string[];
  status: 'active' | 'disabled';
  has_secret: boolean;
  created_at: string;
};

export type WebhookDetail = Webhook & {
  recent_deliveries: Array<{
    id: string;
    event_type: string;
    status: 'pending' | 'success' | 'failed';
    attempts: number;
    response_code: number | null;
    created_at: string;
    last_attempt_at: string | null;
  }>;
};

export type WebhookCreated = Webhook & {
  secret: string;
};

export type PaginatedResponse<T> = {
  items: T[];
  pagination: {
    has_more: boolean;
    next_cursor: string | null;
  };
};

// Setup types
export type StripeConfig = {
  configured: boolean;
  has_secret_key: boolean;
  has_webhook_secret: boolean;
};

export type FedaPayConfig = {
  configured: boolean;
  has_secret_key: boolean;
  has_webhook_secret: boolean;
  sandbox: boolean;
};

export type EmailProvider = 'resend' | 'sendgrid' | 'mailgun' | 'postmark';

export type EmailConfig = {
  configured: boolean;
  provider: EmailProvider | null;
  from_address: string | null;
};

// Discount types
export type DiscountType = 'percentage' | 'fixed_amount';

export type Discount = {
  id: string;
  code: string | null;
  type: DiscountType;
  value: number;               // percentage: 0–100 | fixed_amount: cents
  status: 'active' | 'inactive';
  usage_count: number;
  usage_limit: number | null;
  usage_limit_per_customer: number | null;
  starts_at: string | null;
  expires_at: string | null;
  min_purchase_cents: number;  // defaults to 0 in the API, never null
  max_discount_cents: number | null; // caps percentage discounts; null = no cap
  created_at: string;
};

// Explicit payload types — match CreateDiscountBody and UpdateDiscountBody
// in schemas.ts exactly. Optional fields are omitted when absent, not sent as null.
export type CreateDiscountPayload = {
  code?: string;                      // omit for codeless discounts
  type: DiscountType;
  value: number;                      // integer: percentage 0–100, fixed_amount cents
  min_purchase_cents?: number;        // omit for no minimum (API defaults to 0)
  max_discount_cents?: number;        // omit for no cap (percentage only)
  starts_at?: string;                 // ISO 8601 datetime, omit for immediate
  expires_at?: string;                // ISO 8601 datetime, omit for no expiry
  usage_limit?: number;               // omit for unlimited
  usage_limit_per_customer?: number;  // omit for unlimited per customer
};

export type UpdateDiscountPayload = {
  code?: string | null;
  status?: 'active' | 'inactive';
  value?: number;
  min_purchase_cents?: number;
  max_discount_cents?: number | null;
  starts_at?: string | null;
  expires_at?: string | null;
  usage_limit?: number | null;
  usage_limit_per_customer?: number | null;
};

// ── Discount payload sanitiser ────────────────────────────────
// Centralises two concerns so individual mutations don't have to:
//
//   1. datetime-local → ISO 8601
//      <input type="datetime-local"> produces "2026-06-01T14:30" which
//      Zod's .datetime() rejects. We append ":00.000Z" to make it a valid
//      UTC ISO string. Already-valid ISO strings (containing "Z" or "+")
//      are passed through untouched.
//
//   2. null/undefined optional fields → omitted
//      The schema marks starts_at, expires_at, max_discount_cents etc. as
//      optional() not nullable(). Sending null fails Zod validation. We
//      strip any key whose value is null or undefined so it is simply
//      absent from the request body.
//
// Usage: JSON.stringify(sanitiseDiscountPayload(data))

function toDiscountDate(value: string | null | undefined): string | undefined {
  if (!value) return undefined; // omit from payload
  // Already a full ISO string (contains Z or timezone offset) — pass through
  if (value.includes('Z') || value.includes('+') || value.match(/\d{2}:\d{2}:\d{2}/)) {
    return value;
  }
  // datetime-local format "YYYY-MM-DDTHH:MM" — convert to UTC ISO string
  return new Date(value + ':00.000Z').toISOString();
}

function sanitiseDiscountPayload<T extends Record<string, unknown>>(data: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue; // omit
    if ((key === 'starts_at' || key === 'expires_at') && typeof value === 'string') {
      const converted = toDiscountDate(value);
      if (converted !== undefined) result[key] = converted;
      continue;
    }
    result[key] = value;
  }
  return result as Partial<T>;
}

// Download token types
export type DownloadToken = {
  token_id: string;
  sku: string;
  status: 'active' | 'expired' | 'exhausted';
  download_count: number;
  max_downloads: number;
  expires_at: string;
  last_downloaded_at: string | null;
  created_at: string;
};

export type OrderDownloads = {
  order_id: string;
  order_number: string;
  customer_email: string;
  digital_items: Array<{
    sku: string;
    title: string;
    tokens: DownloadToken[];
  }>;
};

// ─── API Methods ──────────────────────────────────────────────────────────────

export const api = {
  // Orders
  async getOrders(params?: { limit?: number; cursor?: string; status?: string; email?: string }) {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.cursor) searchParams.set('cursor', params.cursor);
    if (params?.status) searchParams.set('status', params.status);
    if (params?.email) searchParams.set('email', params.email);
    const query = searchParams.toString();
    return request<PaginatedResponse<Order>>(`/v1/orders${query ? `?${query}` : ''}`);
  },

  async getOrder(id: string) {
    return request<Order>(`/v1/orders/${id}`);
  },

  async updateOrder(
    id: string,
    data: { status?: string; tracking_number?: string; tracking_url?: string }
  ) {
    return request<Order>(`/v1/orders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async refundOrder(id: string, amount_cents?: number) {
    return request<{ stripe_refund_id: string; status: string }>(`/v1/orders/${id}/refund`, {
      method: 'POST',
      body: JSON.stringify(amount_cents ? { amount_cents } : {}),
    });
  },
  
  /*
	async reissueDownload(orderId: string, sku: string) {
    return request<{ token: string; expires_at: string; download_url: string }>(
      `/v1/orders/${orderId}/reissue-download`,
      {
        method: 'POST',
        body: JSON.stringify({ sku }),
      }
    );
  },

  async getOrderDownloads(orderId: string) {
    return request<OrderDownloads>(`/v1/orders/${orderId}/downloads`);
  },
  */

  async getOrderDownloads(orderId: string) {
    return request<{
      order_id: string;
      digital_items: Array<{
        sku: string;
        title: string;
        tokens: DownloadToken[];
      }>;
    }>(`/v1/orders/${orderId}/downloads`);
  },

  async reissueDownload(orderId: string, sku: string) {
    return request<{ token: string; download_url: string; expires_at: string }>(
      `/v1/orders/${orderId}/downloads/${encodeURIComponent(sku)}/reissue`,
      { method: 'POST' }
    );
  },

  // Products
  async getProducts(params?: { limit?: number; cursor?: string; status?: string }) {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.cursor) searchParams.set('cursor', params.cursor);
    if (params?.status) searchParams.set('status', params.status);
    const query = searchParams.toString();
    return request<PaginatedResponse<Product>>(`/v1/products${query ? `?${query}` : ''}`);
  },

  async getProduct(id: string) {
    return request<Product>(`/v1/products/${id}`);
  },

  async createProduct(data: { title: string; description?: string }) {
    return request<Product>('/v1/products', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateProduct(id: string, data: { title?: string; description?: string; status?: string }) {
    return request<Product>(`/v1/products/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async createVariant(
    productId: string,
    data: {
      sku: string;
      title: string;
      price_cents: number;
      image_url?: string;
      product_type?: 'physical' | 'digital';
      weight_g?: number;
    }
  ) {
    return request<Variant>(`/v1/products/${productId}/variants`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateVariant(
    productId: string,
    variantId: string,
    data: {
      sku?: string;
      title?: string;
      price_cents?: number;
      image_url?: string | null;
      product_type?: 'physical' | 'digital';
      weight_g?: number;
    }
  ) {
    return request<Variant>(`/v1/products/${productId}/variants/${variantId}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async uploadAsset(productId: string, variantId: string, file: File) {
    const { apiUrl, apiKey } = getAuth();
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(
      `${apiUrl}/v1/catalog/products/${productId}/variants/${variantId}/asset`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}` },
        // No Content-Type — browser sets multipart boundary automatically
        body: formData,
      }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ApiError(
        err.error?.code || 'unknown',
        res.status,
        err.error?.message || 'Asset upload failed'
      );
    }

    return res.json() as Promise<{ filename: string; uploaded_at: string }>;
  },

  async deleteAsset(productId: string, variantId: string) {
    return request<{ deleted: boolean }>(
      `/v1/catalog/products/${productId}/variants/${variantId}/asset`,
      { method: 'DELETE' }
    );
  },

  // Inventory
  async getInventory() {
    return request<{ items: InventoryItem[] }>('/v1/inventory');
  },

  async adjustInventory(sku: string, data: { delta: number; reason: string }) {
    return request<InventoryItem>(`/v1/inventory/${encodeURIComponent(sku)}/adjust`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Images
  async uploadImage(file: File) {
    const { apiUrl, apiKey } = getAuth();
    const formData = new FormData();
    formData.append('file', file);

    const res = await fetch(`${apiUrl}/v1/images`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new ApiError(
        err.error?.code || 'unknown',
        res.status,
        err.error?.message || 'Upload failed'
      );
    }

    return res.json() as Promise<{ url: string; key: string }>;
  },

  // Webhooks
  async getWebhooks() {
    return request<{ items: Webhook[] }>('/v1/webhooks');
  },

  async getWebhook(id: string) {
    return request<WebhookDetail>(`/v1/webhooks/${id}`);
  },

  async createWebhook(data: { url: string; events: string[] }) {
    return request<WebhookCreated>('/v1/webhooks', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async updateWebhook(id: string, data: { url?: string; events?: string[]; status?: string }) {
    return request<Webhook>(`/v1/webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  async deleteWebhook(id: string) {
    return request<{ deleted: boolean }>(`/v1/webhooks/${id}`, {
      method: 'DELETE',
    });
  },

  async rotateWebhookSecret(id: string) {
    return request<{ secret: string }>(`/v1/webhooks/${id}/rotate-secret`, {
      method: 'POST',
    });
  },

  // Customers
  async getCustomers(params?: { limit?: number; cursor?: string; search?: string }) {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.cursor) searchParams.set('cursor', params.cursor);
    if (params?.search) searchParams.set('search', params.search);
    const query = searchParams.toString();
    return request<PaginatedResponse<Customer>>(`/v1/customers${query ? `?${query}` : ''}`);
  },

  async getCustomer(id: string) {
    return request<Customer & { addresses: CustomerAddress[] }>(`/v1/customers/${id}`);
  },

  async getCustomerOrders(id: string, params?: { limit?: number; cursor?: string }) {
    const searchParams = new URLSearchParams();
    if (params?.limit) searchParams.set('limit', String(params.limit));
    if (params?.cursor) searchParams.set('cursor', params.cursor);
    const query = searchParams.toString();
    return request<PaginatedResponse<Order>>(
      `/v1/customers/${id}/orders${query ? `?${query}` : ''}`
    );
  },

  async updateCustomer(
    id: string,
    data: {
      name?: string;
      phone?: string;
      accepts_marketing?: boolean;
      metadata?: Record<string, unknown>;
    }
  ) {
    return request<Customer>(`/v1/customers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    });
  },

  // Setup — Stripe
  async getStripeConfig() {
    return request<StripeConfig>('/v1/setup/stripe');
  },

  async saveStripeConfig(data: { stripe_secret_key: string; webhook_secret?: string }) {
    return request<{ ok: boolean }>('/v1/setup/stripe', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Setup — FedaPay
  async getFedaPayConfig() {
    return request<FedaPayConfig>('/v1/setup/fedapay');
  },

  async saveFedaPayConfig(data: {
    secret_key: string;
    webhook_secret?: string;
    sandbox?: boolean;
  }) {
    return request<{ ok: boolean }>('/v1/setup/fedapay', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Setup — Email
  async getEmailConfig() {
    return request<EmailConfig>('/v1/setup/email');
  },

  async saveEmailConfig(data: {
    provider: EmailProvider;
    api_key: string;
    from_address: string;
    mailgun_domain?: string;
    mailgun_region?: 'US' | 'EU';
  }) {
    return request<{ ok: boolean }>('/v1/setup/email', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  async testEmail(to?: string) {
    return request<{ ok: boolean; provider: string; message_id?: string; error?: string }>(
      '/v1/setup/email/test',
      {
        method: 'POST',
        body: JSON.stringify(to ? { to } : {}),
      }
    );
  },

  // Discounts
  async getDiscounts() {
    return request<{ items: Discount[] }>('/v1/discounts');
  },

  async createDiscount(data: CreateDiscountPayload) {
    return request<Discount>('/v1/discounts', {
      method: 'POST',
      body: JSON.stringify(sanitiseDiscountPayload(data)),
    });
  },

  async updateDiscount(id: string, data: UpdateDiscountPayload) {
    return request<Discount>(`/v1/discounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(sanitiseDiscountPayload(data)),
    });
  },

  async deleteDiscount(id: string) {
    // API soft-deletes (sets status = 'inactive') and returns { ok: true }
    return request<{ ok: true }>(`/v1/discounts/${id}`, {
      method: 'DELETE',
    });
  },

  // Health check (for login validation)
  async healthCheck() {
    return request<{ name: string; version: string; ok: boolean }>('/');
  },
};
