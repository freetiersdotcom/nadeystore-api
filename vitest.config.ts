import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        durableObjects: {
		MERCHANT: {className: 'MerchantDO', useSQLite: true },
        },
        r2Buckets: ['IMAGES'],
        bindings: {
          STORE_NAME: 'Test Store',
          IMAGES_URL: 'https://assets.teststore.com',
          SETUP_TOKEN: 'test-setup-token',
          ADMIN_ORIGINS: 'https://admin.test.com,http://localhost:5173',
          ADMIN_URL: 'https://admin.test.com',
          PASSWORD_PEPPER: 'test-pepper',
          CONFIG_ENCRYPTION_KEY: 'test-config-encryption-key-0123456789',
        },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});
