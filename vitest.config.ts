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
        },
      },
    }),
  ],
  test: {
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
  },
});