# meyppi.com

Marketing site for **Meyppi** — independent media delivery verification.
Static (Astro), zero-JS-by-default, deployed on **Cloudflare Pages free tier**
from this GitHub repo.

Brand reference: `brand.md` in this repo (colors, typography, voice, copy rules).

## Local development

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # dist/ (also generates PNG icons from the SVG logo)
npm run preview      # serve the production build locally
```

## Site structure (9 pages + legal)

`/` · `/how-it-works` · `/pricing` · `/sample-report` · `/for-agencies` ·
`/for-brands` · `/about` · `/contact` · `/privacy` · `/terms`

Primary CTA on every page: **Request a Campaign Audit**.

## Deploy to Cloudflare Pages (free tier)

1. **Push this repo to GitHub** (public or private both work on the free plan):

   ```bash
   git remote add origin git@github.com:<you>/meyppi-web.git
   git push -u origin main
   ```

2. **Cloudflare dashboard → Workers & Pages → Create → Pages → Connect to Git.**
   Select the repo. Build settings:
   - Framework preset: **Astro**
   - Build command: `npm run build`
   - Build output directory: `dist`
   - Node version (env var): `NODE_VERSION` = `22`

3. **Deploy.** You get a free `*.pages.dev` URL immediately. Every push to
   `main` auto-deploys; every branch gets a preview URL.

4. **Attach meyppi.com** (when registered):
   - Cloudflare Registrar / DNS for the domain (free tier)
   - Pages project → **Custom domains** → Set up `meyppi.com` (and `www`)
   - DNS records are created automatically when the domain is on Cloudflare

## Configuration (env vars)

Set in Cloudflare Pages → Settings → Environment variables, then redeploy:

| Variable | Purpose |
|---|---|
| `PUBLIC_FORMSPREE_ENDPOINT` | Contact form endpoint. Create a free form at [formspree.io](https://formspree.io), copy the action URL (e.g. `https://formspree.io/f/abcd1234`). Until set, the contact page shows a direct-email fallback instead of a broken form. |
| `PUBLIC_CF_ANALYTICS_TOKEN` | Cloudflare Web Analytics beacon token (Cloudflare dashboard → Web Analytics → Add site → copy token). Free, cookieless. |

## Icons / logo

The logo suite is generated from SVG sources at build time
(`scripts/make-icons.mjs`): favicon SVG + PNG 32, apple-touch-icon 180,
OG image 1200×630. Edit `public/logo-mark.svg` / `public/favicon.svg`
and rebuild to regenerate everything.

## Adding the sample-report PDF button

The button triggers the browser print dialog with a print stylesheet
(`/sample-report` prints clean). If you prefer a downloadable static PDF,
generate one from the audit product and drop it into `public/`.

## Non-goals (brand.md §9 — enforced)

No dashboard, no login, no pricing calculator, no blog, no popups,
no countdown timers, no dark patterns, no "AI-powered" language,
no legal-proof claims.
