/** Site-wide configuration. Single source of truth for nav, CTA, forms. */

export const SITE = {
  name: 'Meyppi',
  url: 'https://meyppi.com',
  tagline: 'Independent media delivery verification',
  description:
    'Meyppi independently verifies whether contracted audio creatives appeared in published media — when they ran, which version, and whether delivery was complete.',
  contactEmail: 'hello@meyppi.com',
  // Formspree endpoint — set PUBLIC_FORMSPREE_ENDPOINT (env) after creating
  // the form at https://formspree.io. Until set, the contact form shows a
  // configuration notice instead of silently failing.
  formEndpoint: import.meta.env.PUBLIC_FORMSPREE_ENDPOINT ?? '',
  analyticsToken: import.meta.env.PUBLIC_CF_ANALYTICS_TOKEN ?? '',
};

export const NAV_LINKS = [
  { href: '/how-it-works', label: 'How It Works' },
  { href: '/pricing', label: 'Pricing' },
  { href: '/sample-report', label: 'Sample Report' },
  { href: '/about', label: 'About' },
];

export const PRIMARY_CTA = { href: '/contact', label: 'Request Audit' };
export const SECONDARY_CTA = { href: '/how-it-works', label: 'How It Works' };
