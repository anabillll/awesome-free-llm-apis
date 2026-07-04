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

## Drag-and-drop customization

Every repeatable piece of content is a schema **block**, not a hardcoded loop, so merchants can add, remove, and drag-reorder it from the theme editor's block list — and every section has a `presets` entry so it shows up in "Add section":

| Section | Block type(s) |
|---|---|
| `main-product` | `pricing_tier` (quantity tiers), `accordion`, `trust_icon`, `cross_sell_item` |
| `usp-icon-bar` | `icon` |
| `image-gallery-grid` | `image` |
| `ingredients-showcase` | `ingredient` |
| `comparison-table` | `feature_row` |
| `faq-accordion` | `question` |
| `product-recommendations` | `product` |
| `last-chance-cta` | `button` |
| `newsletter-footer` | `link_column`, `app_badges` |
| `media-with-text` | none — it's a single image+text pairing; use two separate section instances (as the template does for Benefit 1/2) and drag the *sections* themselves to reorder |

Known limitation: `comparison-table`'s competitor columns (Competitor 1/2/3) are fixed at three and set via section settings, not blocks — Shopify schema can't dynamically add matrix columns that every row block then references, so the row *content* is fully block-driven (draggable/addable/removable) but the column *count* isn't. If you need a variable number of competitors, that requires a metafield- or app-driven table instead of static blocks.

## Text alignment

Every section has a `text_alignment` setting (Left / Center / Right) in the theme editor. It's scoped to that section's actual prose — headings, intros, body copy — not to things where centering would break the UI (table cell data stays centered/start regardless, FAQ answers and footer nav columns stay left-aligned, forms and buttons keep their own layout). Defaults match the original design: centered for the marketing sections (USP bar, gallery grid heading, comparison/FAQ/recommendations headings, final CTA, newsletter block), left-aligned for the buy box, benefit blocks, and ingredients intro.

## Animations

- `snippets/scroll-reveal.liquid` is rendered once per section (like `theme-fonts`) and is idempotent — it defines a `.reveal` class (fade + rise on scroll, via `IntersectionObserver`) and re-runs itself on `shopify:section:load` so it keeps working while editing in the theme customizer. Fully disabled (content shown immediately, no motion) under `prefers-reduced-motion: reduce`.
- Headings and repeated blocks (USP icons, gallery images, ingredient rows, FAQ questions, recommendation cards, cross-sell cards) use `.reveal` with a small per-item `transition-delay` (via `forloop.index0`) for a staggered entrance instead of everything fading in at once.
- Buttons get a tactile `:active { transform: scale(.97) }` press; cards (cross-sell, recommendations) lift slightly on hover.
- Accordion/FAQ content fades in on open instead of the native `<details>` hard-cut, via a short CSS keyframe scoped to `[open]`.

## Background / text color

Every section has `background_color` and `text_color` color pickers in the theme editor — no code editing needed to change the look. All ten now default to white background / near-black text (previously three sections — ingredients, FAQ, footer — defaulted to a dark/black band; that's just the starting value now, still changeable per section).

How it's wired so a color change doesn't quietly break contrast elsewhere:
- "Inverted" elements that sit on top of the section (solid buttons, badges, the popular-tier ribbon) use `text_color` as their own background and `background_color` as their own text, so a solid black button on a white section automatically becomes a solid white button if you flip the section to a black background — it always contrasts against whatever you pick, instead of assuming white-on-black.
- Subtle dividers/borders/track-fills that used to be hardcoded `rgba(255,255,255,.15)` (which would vanish if the background ever went light) now use Shopify's built-in `color_modify: 'alpha', 0.15` filter on `text_color`, so they stay visibly faint against *any* background/text combination.
- Data/status colors (sale red, save green, star-rating gold) are intentionally left as fixed accents, not tied to `background_color`/`text_color` — they're semantic, not brand palette.
