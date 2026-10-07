import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// Canonical production URL (site deploys to *.pages.dev until meyppi.com
// DNS is attached; canonical/sitemap already point at the final domain).
export default defineConfig({
  site: 'https://meyppi.com',
  integrations: [
    sitemap({
      // /demo is auth-gated and noindex — keep it out of the sitemap
      filter: (page) => !page.includes('/demo'),
    }),
  ],
  build: { inlineStylesheets: 'auto' },
});
