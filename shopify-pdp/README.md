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
