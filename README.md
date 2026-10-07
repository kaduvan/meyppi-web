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

The logo suite is generated at build time (`scripts/make-icons.mjs`) from
the approved master `brand-assets/logo-a.png` (waveform + MEYPPI wordmark).
It derives, with background removed:

- `public/brand/logo-full.png` (480w) — light-background lockup
- `public/brand/logo-full-reverse.png` (480w) — white/teal for dark sections
- `public/brand/logo-mark.png` / `logo-mark-reverse.png` (960w) — mark only
- `public/favicon-32x32.png`, `public/apple-touch-icon.png`, `public/og.png`

Replace `brand-assets/logo-a.png` and rebuild to regenerate everything.

## Interactive demo (`/demo`) and login gating

`/demo` is an interactive version of the sample report (filters, per-row
evidence drawers, episode-timeline match visuals) running on illustrative
engine output. It is `noindex` and excluded from the sitemap.

To gate it behind a login on Cloudflare's free tier, use **Cloudflare
Access** (free for up to 50 users):

1. Cloudflare dashboard → Zero Trust → Access → Applications → Add an
   application → **Self-hosted**.
2. Application domain: `<your-site>.pages.dev`, path: `/demo`.
3. Add a policy: Action *Allow*, Include *Emails* → enter the addresses
   that may view the demo.
4. Set up a one-time PIN login method (Zero Trust → Authentication →
   Login methods → Add → One-time PIN) if you have no other IdP.

Visitors to `/demo` then get a Cloudflare-hosted email PIN screen before
the page loads — no server code, no credentials in the repo. Everything
else on the site stays public.

## Adding the sample-report PDF button

The button triggers the browser print dialog with a print stylesheet
(`/sample-report` prints clean). If you prefer a downloadable static PDF,
generate one from the audit product and drop it into `public/`.

## Non-goals (brand.md §9 — enforced)

No dashboard for customers to log into, no pricing calculator, no blog,
no popups, no countdown timers, no dark patterns, no "AI-powered"
language, no legal-proof claims. (The gated `/demo` is a marketing
artifact showing the report format — not a customer SaaS dashboard.)
