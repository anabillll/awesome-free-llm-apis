# Shopify PDP (Liquid)

Drop-in Online Store 2.0 sections that reproduce the product page mockup: gallery, buy box with variant/subscription/tiered pricing, cross-sell, USP bar, benefit blocks, ingredients showcase, comparison table, FAQ, recommendations, CTA, and a newsletter/footer.

## Install

1. Copy `sections/`, `snippets/`, and `assets/` (if any) into your theme's matching folders.
2. Copy `templates/product.pdp.json` into your theme's `templates/` folder, or merge its `sections`/`order` into an existing product template.
3. In Shopify admin, assign the `pdp` template to any product via **Product > Theme template**.
4. Every section ships with schema settings/blocks, so merchants can edit copy, images, prices, and FAQ/comparison rows from the theme editor without touching code.

## Notes

- `newsletter-footer.liquid` renders a full footer. Skip adding it to the template if your theme already renders a global footer in `layout/theme.liquid`, to avoid duplicates.
- Buy-box tier pricing, subscription toggle, and cross-sell "Add Selected to Cart" are wired to `/cart/add.js` via fetch; no page reload.
- All sections are self-contained (scoped styles/JS keyed by `section.id`), so they can be reordered or reused elsewhere (e.g. `media-with-text` for both benefit blocks).
- Translated strings use `| t` filters (e.g. `products.product.add_to_cart`); add matching keys to your theme's `locales/en.default.json` or they'll fall back to the key name.

## Arabic / RTL support

- Every section renders `snippets/theme-fonts.liquid` once, which declares two self-hosted `@font-face` rules from `assets/caprasimo.woff2` (Latin display face) and `assets/cairo-arabic.woff2` (Arabic display/body fallback, variable 400–700, `unicode-range`-scoped so it only loads when Arabic text is present). Headings use `font-family: 'Caprasimo', 'Cairo', ...` so Arabic copy automatically falls through to Cairo instead of rendering with missing glyphs.
- All layout CSS uses logical properties (`inset-inline-start/end`, `margin-inline-start`, `text-align: start`) instead of physical `left`/`right`, so the sections mirror correctly under `dir="rtl"` with no section-specific overrides needed.
- `dir`/`lang` themselves are set at the theme layout level, not per-section — add `<html lang="{{ request.locale.iso_code }}" dir="{{ request.locale.iso_code | rtl_locale_list }}">` in `layout/theme.liquid` (or hardcode a small RTL locale list, e.g. `{% assign rtl_locales = 'ar,he,fa,ur' | split: ',' %}`) if this drop-in package isn't going into a theme that already handles it.
- For full Arabic copy, add an `ar.json` locale file with the same keys as `en.default.json` — the existing `| t` filters pick it up automatically; no section code changes needed.
