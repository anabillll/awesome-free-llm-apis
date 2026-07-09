# Shopify PDP + Homepage (Liquid)

Drop-in Online Store 2.0 sections for a product page and a homepage, sharing one design system: announcement bar, gallery, buy box with variant/subscription/tiered pricing, cross-sell, hero banner, featured collections, USP bar, an "as featured on" logo marquee, benefit blocks, ingredients showcase, comparison table, testimonials, FAQ, recommendations, CTA, and a newsletter/footer.

## Install

1. Copy `sections/`, `snippets/`, and `assets/` into your theme's matching folders.
2. **Product page**: copy `templates/product.pdp.json` into your theme's `templates/` folder (or merge its `sections`/`order` into an existing product template), then assign it to any product via **Product > Theme template** in Shopify admin.
3. **Homepage**: copy `templates/index.json` into your theme's `templates/` folder — Shopify uses `index.json` as the homepage automatically, no assignment step needed. If your theme already has a homepage template you want to keep, merge the `sections`/`order` instead of overwriting the file.
4. Every section ships with schema settings/blocks, so merchants can edit copy, images, prices, and FAQ/comparison rows from the theme editor without touching code.

## Homepage composition

`templates/index.json` wires together, in order: `announcement-bar` → `hero-banner` → `usp-icon-bar` → `featured-on` ("As Featured On") → `featured-collections` ("Shop By Flavor") → `product-recommendations` (relabeled "Bestsellers" — same section as the PDP's cross-sell, it just takes a heading/product blocks like any other instance) → `media-with-text` (Brand Story) → `ingredients-showcase` → `testimonials` → `faq-accordion` → `last-chance-cta` → `newsletter-footer`. Everything except `hero-banner`, `featured-collections`, and `testimonials` is the exact same section file used on the product page — add/remove/reorder sections in the homepage template the same way you would anywhere else. `product.pdp.json` wires the same `announcement-bar` and `featured-on` sections in near the top too, right after the buy box's USP bar.

`featured-collections` blocks reference real Shopify collections (`type: "collection"`) with a `fallback_title`/`fallback_image` pair used only until a merchant picks an actual collection — same pattern as the cross-sell/recommendation blocks elsewhere in this package.

## Notes

- `newsletter-footer.liquid` renders a full footer. Skip adding it to the template if your theme already renders a global footer in `layout/theme.liquid`, to avoid duplicates.
- Buy-box tier pricing, subscription toggle, and cross-sell "Add Selected to Cart" are wired to `/cart/add.js` via fetch; no page reload.
- All sections are self-contained (scoped styles/JS keyed by `section.id`), so they can be reordered or reused elsewhere (e.g. `media-with-text` for both benefit blocks).
- Translated strings use `| t` filters (e.g. `products.product.add_to_cart`); add matching keys to your theme's `locales/en.default.json` or they'll fall back to the key name.

## Announcement bar & "As Featured On"

- `announcement-bar.liquid` is an infinite-scrolling message ticker; each message is its own `message` block (text + optional link), so merchants can add/remove/reorder messages from the theme editor. `speed` (seconds per loop) and `pause_on_hover` are also editable.
- `featured-on.liquid` is a press-logo marquee. Each `logo` block has an `image_picker` — merchants upload their own logo per block from the theme editor, same pattern as every other image field in this package. Until a logo is uploaded, the block falls back to a styled text pill using its `fallback_label` setting, so the section never renders empty/broken.
- Both marquees duplicate their content once (the copy is `aria-hidden="true"` and its links are `tabindex="-1"`) to create a seamless infinite CSS `animation` loop — no JavaScript needed for the scroll itself.
- **Direction follows reading order, not a fixed left/right**: both sections check `request.locale.rtl?` in Liquid and set `dir="ltr"`/`dir="rtl"` on their own wrapper, then flip the animation with `animation-direction: reverse` under `[dir="rtl"]`. In an LTR storefront the ticker moves left → right; switch the store to an RTL locale (Arabic, Hebrew, etc.) and it automatically reverses to move right → left — no per-locale settings to configure. Both respect `prefers-reduced-motion: reduce` (animation is disabled, content stays static).

## Arabic / RTL support

- Every section renders `snippets/theme-fonts.liquid` once, which declares two self-hosted `@font-face` rules from `assets/caprasimo.woff2` (Latin display face) and `assets/cairo-arabic.woff2` (Arabic display/body fallback, variable 400–700, `unicode-range`-scoped so it only loads when Arabic text is present). Headings use `font-family: 'Caprasimo', 'Cairo', ...` so Arabic copy automatically falls through to Cairo instead of rendering with missing glyphs.
- All layout CSS uses logical properties (`inset-inline-start/end`, `margin-inline-start`, `text-align: start`) instead of physical `left`/`right`, so the sections mirror correctly under `dir="rtl"` with no section-specific overrides needed.
- `dir`/`lang` themselves are set at the theme layout level, not per-section — add `<html lang="{{ request.locale.iso_code }}" dir="{{ request.locale.iso_code | rtl_locale_list }}">` in `layout/theme.liquid` (or hardcode a small RTL locale list, e.g. `{% assign rtl_locales = 'ar,he,fa,ur' | split: ',' %}`) if this drop-in package isn't going into a theme that already handles it.
- For full Arabic copy, add an `ar.json` locale file with the same keys as `en.default.json` — the existing `| t` filters pick it up automatically; no section code changes needed.

## Drag-and-drop customization

Every repeatable piece of content is a schema **block**, not a hardcoded loop, so merchants can add, remove, and drag-reorder it from the theme editor's block list — and every section has a `presets` entry so it shows up in "Add section":

| Section | Block type(s) |
|---|---|
| `announcement-bar` | `message` |
| `featured-on` | `logo` |
| `main-product` | `pricing_tier` (quantity tiers), `accordion`, `trust_icon`, `cross_sell_item` |
| `hero-banner` | `button` |
| `usp-icon-bar` | `icon` |
| `featured-collections` | `collection_tile` |
| `image-gallery-grid` | `image` |
| `ingredients-showcase` | `ingredient` |
| `comparison-table` | `feature_row` |
| `testimonials` | `testimonial` |
| `faq-accordion` | `question` |
| `product-recommendations` | `product` |
| `last-chance-cta` | `button` |
| `newsletter-footer` | `link_column`, `app_badges` |
| `media-with-text` | none — it's a single image+text pairing; use two separate section instances (as the template does for Benefit 1/2, or Brand Story on the homepage) and drag the *sections* themselves to reorder |

Known limitation: `comparison-table`'s competitor columns (Competitor 1/2/3) are fixed at three and set via section settings, not blocks — Shopify schema can't dynamically add matrix columns that every row block then references, so the row *content* is fully block-driven (draggable/addable/removable) but the column *count* isn't. If you need a variable number of competitors, that requires a metafield- or app-driven table instead of static blocks.

## Text alignment

Every section has a `text_alignment` setting (Left / Center / Right) in the theme editor. It's scoped to that section's actual prose — headings, intros, body copy — not to things where centering would break the UI (table cell data stays centered/start regardless, FAQ answers and footer nav columns stay left-aligned, forms and buttons keep their own layout). Defaults match the original design: centered for the marketing sections (USP bar, gallery grid heading, comparison/FAQ/recommendations headings, final CTA, newsletter block), left-aligned for the buy box, benefit blocks, and ingredients intro.

## Animations

- `snippets/scroll-reveal.liquid` is rendered once per section (like `theme-fonts`) and is idempotent — it defines a `.reveal` class (fade + rise on scroll, via `IntersectionObserver`) and re-runs itself on `shopify:section:load` so it keeps working while editing in the theme customizer. Fully disabled (content shown immediately, no motion) under `prefers-reduced-motion: reduce`.
- Headings and repeated blocks (USP icons, gallery images, ingredient rows, FAQ questions, recommendation cards, cross-sell cards) use `.reveal` with a small per-item `transition-delay` (via `forloop.index0`) for a staggered entrance instead of everything fading in at once.
- `main-product.liquid`'s above-the-fold buy box (badges → title → price → rating → form) plays its own staggered entrance on page load via `.pdp-intro-in` — it doesn't wait for scroll since it's already in view.
- Buttons get a tactile `:active { transform: scale(.97) }` press; cards (cross-sell, recommendations) lift slightly on hover.
- Accordion/FAQ content fades in on open instead of the native `<details>` hard-cut, via a short CSS keyframe scoped to `[open]`.
- **Add to cart "snap"**: `snippets/add-to-cart-fx.liquid` (rendered by `main-product.liquid` and `product-recommendations.liquid`) is a shared micro-interaction — on a successful `/cart/add.js` response, a small square "snaps" off the button and flies toward the first element carrying `data-cart-icon` in your theme's header, bumping it and incrementing a `[data-cart-count]` element if present; the button label itself also swaps to a translated confirmation (`products.product.added_confirmation`) for ~1.4s. Both attributes are opt-in on your header markup — without them, the square just pops near the button instead of flying to a target, so the effect degrades gracefully in any theme. Fully skipped under `prefers-reduced-motion: reduce` (only the label swap still happens).
- **Wavy section transitions**: any section can grow a wavy top edge instead of a hard line via its `wave_top` checkbox setting (`ingredients-showcase`, `comparison-table`, `faq-accordion`, `product-recommendations`, `last-chance-cta`, `testimonials`, `newsletter-footer`). It's rendered by `snippets/wave-divider.liquid`, which draws an SVG wave filled with *that section's own* `background_color` and overlaps it upward into whatever section comes before — so it always matches your color choice with no cross-section coordination needed, even if you recolor a section from the theme editor. `product.pdp.json`/`index.json` turn it on at every point where a section's default color actually flips (white → black or back), so the out-of-the-box theme already shows it; toggle it on/off anywhere else you want the effect.

## Background / text color

Every section has `background_color` and `text_color` color pickers in the theme editor — no code editing needed to change the look. Seven default to white background / near-black text; `ingredients-showcase`, `faq-accordion`, `newsletter-footer`, and `announcement-bar` default to black background / white text, giving the page an alternating light/dark rhythm out of the box. Any section can be flipped either way from the theme editor — these are just starting values.

How it's wired so a color change doesn't quietly break contrast elsewhere:
- "Inverted" elements that sit on top of the section (solid buttons, badges, the popular-tier ribbon) use `text_color` as their own background and `background_color` as their own text, so a solid black button on a white section automatically becomes a solid white button if you flip the section to a black background — it always contrasts against whatever you pick, instead of assuming white-on-black.
- Subtle dividers/borders/track-fills that used to be hardcoded `rgba(255,255,255,.15)` (which would vanish if the background ever went light) now use Shopify's built-in `color_modify: 'alpha', 0.15` filter on `text_color`, so they stay visibly faint against *any* background/text combination.
- Data/status colors (sale red, save green, star-rating gold) are intentionally left as fixed accents, not tied to `background_color`/`text_color` — they're semantic, not brand palette.
