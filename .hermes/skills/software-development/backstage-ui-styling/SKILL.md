---
name: backstage-ui-styling
description: "Use when styling ANY Backstage UI — components, custom elements, or plugins. Covers the COMPLETE BUI CSS token system: 150+ design tokens (colors, typography, spacing, radii, shadows), 23 utility class families, bg layering, dark/light theme variables, CSS layer architecture, component CSS patterns, and rules for custom styling. EVERY element in Backstage MUST use these tokens."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, ui, bui, css, tokens, theming, styling, design-tokens, dark-mode]
    related_skills: [backstage-ui-components, backstage-frontend-services, backstage-plugin-blueprint]
---

# Backstage UI Styling & Theming (`@backstage/ui/css`)

## Overview

`@backstage/ui/css` is the **single source of truth** for ALL styling in Backstage. Every component — whether from `@backstage/ui`, a plugin, or custom app code — MUST use the design tokens defined here. Never hardcode colors, spacing, fonts, or radii. The system supports light and dark themes with zero component changes.

**Core principle:** All visual properties flow through CSS custom properties (`--bui-*`). Components declare `--bg`/`--fg`/`--bg-hover` as internal variables, then assign token values via `[data-variant]`, `[data-size]`, and `[data-on-bg]` selectors. This enables automatic dark mode, bg layering, and theme consistency.

Import once: `import '@backstage/ui/css/styles.css';`

## CSS Architecture — Layer System

```css
@layer tokens, base, components, utilities;
```

1. **`tokens`** — All `--bui-*` design tokens (colors, fonts, spacing, radii, shadows)
2. **`base`** — `normalize.css` (box-sizing, reset) + `core.css` (body defaults, bg inheritance, keyframes)
3. **`components`** — Per-component CSS modules (loaded by component imports)
4. **`utilities`** — Atomic utility classes (padding, margin, display, flex, grid, gap, width, height, position)

## Complete Design Token Reference

### Typography

| Token | Value | Usage |
|---|---|---|
| `--bui-font-regular` | `system-ui` | Body text |
| `--bui-font-monospace` | `ui-monospace, Menlo, Monaco, Consolas, monospace` | Code |
| `--bui-font-weight-regular` | `400` | Normal |
| `--bui-font-weight-bold` | `600` | Bold |

**Font sizes:** `--bui-font-size-1` (10px) through `--bui-font-size-10` (92px). Body default is `--bui-font-size-3` (14px).

### Spacing Scale (4px base)

`--bui-space` = `0.25rem` (4px). Tokens from `--bui-space-0_5` (2px) to `--bui-space-14` (56px).

### Radius

`--bui-radius-1` (2px) through `--bui-radius-6` (20px), plus `--bui-radius-full` (9999px).

### Color System

#### Neutral Backgrounds (layered)

| Token | Light | Dark |
|---|---|---|
| `--bui-bg-app` | `#f8f8f8` | `#333333` |
| `--bui-bg-neutral-1` | `#fff` | `oklch(100% 0 0 / 10%)` |
| `--bui-bg-neutral-2` | `oklch(0% 0 0 / 6%)` | `oklch(100% 0 0 / 6%)` |
| `--bui-bg-neutral-3` | `oklch(0% 0 0 / 6%)` | `oklch(100% 0 0 / 8%)` |
| `--bui-bg-neutral-4` | `oklch(0% 0 0 / 6%)` | `oklch(100% 0 0 / 8%)` |

Each has `-hover`, `-pressed`, `-disabled` variants. Neutral-4 is reserved for leaf components (buttons on dark surfaces).

#### Solid (Brand)

| Token | Light | Dark |
|---|---|---|
| `--bui-bg-solid` | `#1f5493` | `#9cc9ff` |
| `--bui-bg-solid-hover` | `#163a66` | `#83b9fd` |
| `--bui-bg-solid-pressed` | `#0f2b4e` | `#83b9fd` |
| `--bui-bg-solid-disabled` | `#163a66` | `#1b3d68` |

#### Status Backgrounds

| Token | Light | Dark |
|---|---|---|
| `--bui-bg-danger` | `#ffe2e2` | `#300c0c` |
| `--bui-bg-warning` | `#ffedd5` | `#302008` |
| `--bui-bg-success` | `#dcfce7` | `#042713` |
| `--bui-bg-info` | `#dbeafe` | `#132049` |

#### Foreground (Text)

| Token | Usage |
|---|---|
| `--bui-fg-primary` | Primary text (black/white) |
| `--bui-fg-secondary` | Muted/secondary text (50% opacity) |
| `--bui-fg-disabled` | Disabled text (28% opacity) |
| `--bui-fg-solid` | Text on solid bg (white/dark) |
| `--bui-fg-solid-disabled` | Disabled text on solid bg |

#### Status Text

**On status backgrounds** (for text on danger/warning/success/info surfaces):
`--bui-fg-danger-on-bg`, `--bui-fg-warning-on-bg`, `--bui-fg-success-on-bg`, `--bui-fg-info-on-bg`

**Standalone status** (icons, badges, links):
`--bui-fg-danger` (#ec3b18 / #ff5a30), `--bui-fg-warning` (#ef7a32 / #ffa057), `--bui-fg-success` (#1aaf4f / #1ed760), `--bui-fg-info` (#0d74ce / #70b8ff)

#### Borders

`--bui-border-1` (subtle), `--bui-border-2` (standard), `--bui-border-info`, `--bui-border-danger`, `--bui-border-warning`, `--bui-border-success`

#### Special

| Token | Usage |
|---|---|
| `--bui-ring` | Focus ring (#1f5493) |
| `--bui-scrollbar` | Scrollbar track |
| `--bui-scrollbar-thumb` | Scrollbar thumb |
| `--bui-black` / `--bui-white` | Pure black/white |
| `--bui-shadow` | Card/dialog shadow (none in dark mode) |

## The Background (bg) Layering System

Automatic nesting background system using `[data-bg]` attributes:

```tsx
<Box bg="neutral">              {/* data-bg="neutral-1" */}
  <Box bg="neutral">            {/* data-bg="neutral-2" */}
    <Button variant="secondary"> {/* data-on-bg="neutral-2" — adapts automatically */}
    </Button>
  </Box>
</Box>
```

Each `[data-bg]` sets both `background-color` AND `--bui-bg-inherit`. Components read `--bui-bg-inherit` to know what surface they're on.

**bg prop values:** `"neutral"` (increments level), `"danger"`, `"warning"`, `"success"`.

## Utility Classes (all `bui-` prefixed)

### Margin: `.bui-m{N}`, `.bui-mx{N}`, `.bui-my{N}`, `.bui-mt{N}`, `.bui-mb{N}`, `.bui-ml{N}`, `.bui-mr{N}`
### Padding: `.bui-p{N}`, `.bui-px{N}`, `.bui-py{N}`, `.bui-pt{N}`, `.bui-pb{N}`, `.bui-pl{N}`, `.bui-pr{N}`
(Where N = `0.5`, `1`, `1.5`, `2`, `3`, `4`, `5`, `6`, `7`, `8`, `9`, `10`, `11`, `12`, `13`, `14`)

### Display: `.bui-display-none`, `.bui-display-inline`, `.bui-display-inline-block`, `.bui-display-block`
### Flex: `.bui-align-{start/center/end/baseline/stretch}`, `.bui-jc-{start/center/end/between}`, `.bui-fd-{row/column/row-reverse/column-reverse}`, `.bui-grow`, `.bui-shrink`, `.bui-basis`
### Grid: `.bui-columns-{1-12/auto}`, `.bui-col-span-{1-12/auto}`, `.bui-col-start-{1-13/auto}`, `.bui-col-end-{1-13/auto}`, `.bui-row-span-{1-7}`
### Gap: `.bui-gap-{0.5-14}` + `.bui-gap` (dynamic)
### Width/Height: `.bui-w`, `.bui-min-w`, `.bui-max-w`, `.bui-h`, `.bui-min-h`, `.bui-max-h`
### Position: `.bui-static`, `.bui-relative`, `.bui-absolute`, `.bui-fixed`, `.bui-sticky`

All utility classes have responsive variants: `.xs\:bui-*`, `.sm\:bui-*`, `.md\:bui-*`, `.lg\:bui-*`, `.xl\:bui-*`

### Shorthand classes (in xs.css)

`.bui-flex`, `.bui-flex-col`, `.bui-flex-row`, `.bui-flex-wrap`, `.bui-flex-nowrap`, `.bui-flex-wrap-reverse`, `.bui-items-center`, `.bui-items-start`, `.bui-items-end`, `.bui-items-stretch`, `.bui-justify-start`, `.bui-justify-center`, `.bui-justify-end`, `.bui-justify-between`, `.bui-justify-around`, `.bui-justify-stretch`, `.bui-block`, `.bui-hidden`, `.bui-inline`, `.bui-inline-block`, `.bui-border-base`, `.bui-border-error`, `.bui-border-warning`, `.bui-border-none`, `.bui-rounded-{2xs,xs,sm,md,lg,xl,2xl,none}`, `.bui-wrap-reverse`

All with `.bui-sm-*` responsive variants in sm.css.

## Breakpoints

| Name | Min Width | CSS prefix | JS prop |
|---|---|---|---|
| xs | 640px | `.xs\:` | `'xs'` |
| sm | 768px | `.sm\:` | `'sm'` |
| md | 1024px | `.md\:` | `'md'` |
| lg | 1280px | `.lg\:` | `'lg'` |
| xl | 1536px | `.xl\:` | `'xl'` |

## Component CSS Pattern (The BUI Way)

```css
@layer tokens, base, components, utilities;

@layer components {
  .bui-ComponentName {
    /* Internal variables */
    --bg: transparent;
    --bg-hover: transparent;
    --fg: inherit;

    background-color: var(--bg);
    color: var(--fg);
    font-family: var(--bui-font-regular);
  }

  /* Variant theming */
  .bui-ComponentName[data-variant='primary'] {
    --bg: var(--bui-bg-solid);
    --fg: var(--bui-fg-solid);
  }

  .bui-ComponentName[data-variant='secondary'] {
    --bg: var(--bui-bg-neutral-1);
    --fg: var(--bui-fg-primary);
    &[data-on-bg='neutral-1'] { --bg: var(--bui-bg-neutral-2); }
  }

  /* States */
  .bui-ComponentName[data-disabled='true'] { --fg: var(--bui-fg-disabled); }
  .bui-ComponentName[data-focus-visible] { outline: 2px solid var(--bui-ring); }

  /* Dark mode override (only for custom props without tokens) */
  [data-theme-mode='dark'] & { --custom-color: #something; }
}
```

## Rules for Custom Styling

### ✅ ALWAYS

```css
/* Colors via tokens */
background: var(--bui-bg-neutral-1);
color: var(--bui-fg-primary);
border: 1px solid var(--bui-border-1);

/* Spacing via tokens */
padding: var(--bui-space-4);
gap: var(--bui-space-3);

/* Typography via tokens */
font-family: var(--bui-font-regular);
font-size: var(--bui-font-size-3);
font-weight: var(--bui-font-weight-bold);

/* Status text correctly */
.error-banner { color: var(--bui-fg-danger-on-bg); background: var(--bui-bg-danger); }
.error-icon { color: var(--bui-fg-danger); }

/* Layer correctly */
@layer components { .my-component { ... } }

/* bg-aware components */
.my-button[data-on-bg='neutral-1'] { --bg: var(--bui-bg-neutral-2); }
```

### ❌ NEVER

```css
/* ❌ Hardcoded colors */
color: #333;
background: white;

/* ❌ Hardcoded spacing */
padding: 16px;
gap: 24px;

/* ❌ Hardcoded fonts outside scale */
font-size: 13px;

/* ❌ MUI theme with BUI tokens */
color: theme.palette.primary.main;

/* ❌ Bypassing bg layering */
background: var(--bui-bg-neutral-2); /* use bg="neutral" prop instead */
```

## Common Pitfalls

1. **Hardcoding `#fff` for cards** — Use `var(--bui-bg-neutral-1)`. `#fff` doesn't work in dark mode.
2. **Using `color: black/white`** — Use `var(--bui-fg-primary)` / `var(--bui-fg-solid)`.
3. **Using `opacity` for disabled** — Use `var(--bui-fg-disabled)` (proper color, not transparency).
4. **Forgetting `@layer components`** — Without it, utilities may override your styles.
5. **Not importing `styles.css`** — Required: `import '@backstage/ui/css/styles.css'`
6. **Mixing MUI + BUI tokens in one component** — Pick one system per component.
7. **Hardcoding `--bui-bg-neutral-2` directly** — Use `bg="neutral"` prop for automatic nesting.
8. **Creating custom status colors** — Use existing tokens. New semantics should go upstream.

## Verification Checklist

- [ ] `import '@backstage/ui/css/styles.css'` imported
- [ ] All colors use `--bui-fg-*` / `--bui-bg-*` tokens (no hardcoded hex/rgb)
- [ ] All spacing uses `--bui-space-*` tokens (no hardcoded px/rem)
- [ ] All border-radii use `--bui-radius-*` tokens
- [ ] Font sizes use `--bui-font-size-*` tokens
- [ ] Custom CSS in `@layer components`
- [ ] bg-aware components use `[data-on-bg]` selectors
- [ ] Dark mode tested
- [ ] No MUI tokens mixed with BUI tokens in same component
