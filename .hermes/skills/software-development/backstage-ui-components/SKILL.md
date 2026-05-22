---
name: backstage-ui-components
description: "Use when building Backstage frontend UI with the new BUI design system (@backstage/ui). Covers ALL 42 components (layout + UI), 5 hooks, BUIProvider, CSS token system, spacing/padding/margin props, responsive breakpoints, bg system, analytics integration, and usage recipes. The strategic replacement for MUI in Backstage."
version: 1.0.0
author: Hermes Agent
license: MIT
metadata:
  hermes:
    tags: [backstage, ui, bui, design-system, components, react-aria, layout, spacing]
    related_skills: [backstage-frontend-services, backstage-plugin-blueprint, test-driven-development, backstage-ui-styling]
---

# Backstage UI (BUI) — `@backstage/ui`

## Overview

`@backstage/ui` (v0.15) is the **new strategic design system for Backstage** — the replacement for Material UI (MUI). It provides 42 components built on **React Aria Components** + **React Stately** for accessibility, with a CSS Module-based styling layer and a custom spacing/bg/token system. Components are tree-shakeable, typed, and ready for the new frontend system.

**Core principle:** BUI is the forward path. Use it for all new frontend work. MUI (`@backstage/core-components`) is legacy. The two systems coexist during migration.

**Dependencies:** `react-aria-components`, `react-stately`, `@tanstack/react-table`, `@internationalized/date`, `@remixicon/react`, `clsx`.

## When to Use

**Use BUI when:**
- Building any new frontend plugin or page
- Replacing MUI components in existing plugins
- Need accessible, keyboard-navigable, screen-reader-friendly components (built-in via React Aria)
- Need responsive layout with breakpoint-based props
- Want tree-shakeable, lightweight components (no global theme provider like MUI's ThemeProvider)

**Don't use BUI when:**
- Working in legacy plugins that haven't been migrated yet
- Need complex data-grid features beyond what `Table` provides

## Component Catalog — All 42 Components

### Layout Components (5)

| Component | Purpose | Key Props |
|---|---|---|
| `Box` | Universal container with spacing, bg, flex props | `as`, `bg`, `children`, all SpaceProps + FlexItemProps |
| `Grid` | CSS Grid container + `Grid.Item` child | `columns`, `gap`, `alignItems`; Item: `colSpan`, `colStart`, `colEnd`, `rowSpan` |
| `Flex` | Flexbox container | `alignItems`, `justifyContent`, `flexDirection`, `flexWrap`, `gap`, all SpaceProps |
| `Container` | Centered max-width page wrapper | `maxWidth` (default `xl`), `bg`, all SpaceProps |
| `FullPage` | Full-page root layout with sticky header detection | `FullPage.Header` + `FullPage.Content` |

### Buttons & Links (4)

| Component | Purpose | Key Props |
|---|---|---|
| `Button` | Primary action button | `variant` (primary/secondary/tertiary), `size` (small/medium), `iconStart`, `iconEnd`, `isPending`, `destructive` |
| `ButtonIcon` | Icon-only button | `variant`, `size`, `icon`, `isPending` |
| `ButtonLink` | Link styled as a button | `variant`, `size`, `href`, `iconStart`, `iconEnd`, `noTrack` |
| `Link` | Inline text link (with analytics) | `href`, `variant` (text), `color`, `truncate`, `standalone`, `noTrack` |

### Navigation & Structure (5)

| Component | Purpose | Key Props |
|---|---|---|
| `Header` | Entity/page header with title, tabs, tags, metadata, description | `title`, `tabs`, `tags`, `metadata`, `description` (Markdown supported), `customActions`, `sticky` |
| `PluginHeader` | Plugin-level header with icon, title, tabs | `icon`, `title`, `titleLink`, `tabs`, `customActions` |
| `Tabs` | Accessible tab system with URL-synced routing | `Tab` (href+matchStrategy), `TabList`, `TabPanel` |

**⚠️ CRITICAL: BUI Tabs use URL hash routing, not onChange.** Clicking a `Tab` navigates the browser URL hash — it does NOT fire an `onChange` or `onSelectionChange` callback. To detect tab changes, use a `hashchange` listener or React Router hooks. Never use `useState` + `setView` expecting it to fire from tab clicks — it won't. See the full pattern in the Common Pitfalls section below.
| `List` | Vertical list with row items | `List.Row`: `iconStart`, `href`, `action` (secondary text), `description` |
| `Accordion` | Expandable sections | `Accordion.Trigger`, `Accordion.Panel`, `Accordion.Group` |

### Data Display (6)

| Component | Purpose | Key Props |
|---|---|---|
| `Table` | Full-featured data table (TanStack-based) | `columnConfig`, `data`, `pagination`, `sort`, `selection`, `virtualized`, `emptyState`, `isPending`, `error` |
| `TablePagination` | Pagination controls | `count`, `page`, `rowsPerPage`, `onPageChange`, `onRowsPerPageChange` |
| `Card` | Container card (static, link, or button) | `href` (link variant), `onPress` (button variant), `Card.Header`, `Card.Body`, `Card.Footer` |
| `Badge` | Small label/tag | `icon`, `size` (small/medium), children |
| `TagGroup` | Collection of removable tags | `Tag.label`, `Tag.dismissLabel`, `onRemove` |
| `Avatar` | User/entity avatar with fallback initials | `src`, `name`, `size` (x-small to x-large), `purpose` (decoration/informative) |

### Forms & Inputs (14)

| Component | Purpose | Key Props |
|---|---|---|
| `TextField` | Text/email/tel/url input | `size`, `icon`, `placeholder`, `label`, `description`, `secondaryLabel` |
| `PasswordField` | Password input with show/hide toggle | Same as TextField + password behavior |
| `SearchField` | Search input with clear button | `size`, `icon`, `placeholder`, `startCollapsed`, `label` |
| `SearchAutocomplete` | Search with dropdown suggestions | `SearchAutocomplete.Item` for results |
| `Select` | Dropdown select (single/multi, searchable) | `options` (Option[] or OptionSection[]), `selectionMode`, `searchable`, `icon`, `size`, `label` |
| `Combobox` | Autocomplete text input with dropdown | Hybrid of TextField + dropdown suggestions |
| `Checkbox` | Single checkbox | Controlled/uncontrolled, `isIndeterminate` |
| `CheckboxGroup` | Group of checkboxes with label | `options`, `value`, `onChange` |
| `RadioGroup` | Radio button group | `options`, `value`, `onChange`, `orientation` |
| `Switch` | Toggle switch | Controlled/uncontrolled |
| `Slider` | Range slider | `minValue`, `maxValue`, `step`, `formatOptions` |
| `ToggleButton` | Toggle button (on/off) | Press-selected state |
| `ToggleButtonGroup` | Group of toggle buttons | `selectionMode` (single/multiple) |
| `DatePicker` | Calendar date picker | `DatePicker.Group` for ranges, `DatePicker.Calendar` standalone |
| `DateRangePicker` | Date range selection | Start+end date picker group |

### Feedback & Overlays (7)

| Component | Purpose | Key Props |
|---|---|---|
| `Alert` | Status banner (info/success/warning/danger) | `status`, `icon`, `title`, `description`, `customActions`, `isPending` |
| `Dialog` | Modal dialog | `Dialog.Trigger`, `Dialog.Header`, `Dialog.Body`, `Dialog.Footer` |
| `Popover` | Floating content overlay | `Popover.Trigger` + content |
| `Menu` | Dropdown/popup menu | `Menu.Trigger`, `Menu.Item` (iconStart, color, href), `Menu.Section`, `Menu.Separator`, `Menu.SubmenuTrigger`, `MenuListBox`, `MenuAutocomplete` |
| `Tooltip` | Hover tooltip | Content as children, trigger wrapped |
| `Skeleton` | Loading placeholder | Automatic animation |
| `Toast` | Toast notifications | Use `toastApiRef` from `@backstage/frontend-plugin-api` (not a BUI component) |

### Utility (1)

| Component | Purpose | Key Props |
|---|---|---|
| `VisuallyHidden` | Screen-reader-only content | Wraps children for accessibility |

### Form Helpers (2)

| Component | Purpose | Key Props |
|---|---|---|
| `FieldLabel` | Input label with description + secondary label | `label`, `description`, `secondaryLabel` |
| `FieldError` | Validation error message | Children as error text |

## Shared Prop Systems

### Responsive Props (`Responsive<T>`)

Almost every spacing/visual prop accepts `Responsive<T>` = `T | Partial<Record<Breakpoint, T>>`. Breakpoints: `'initial'` | `'xs'` | `'sm'` | `'md'` | `'lg'` | `'xl'`.

```tsx
<Box p={{ initial: '2', md: '4', xl: '6' }}>
<Button size={{ initial: 'small', md: 'medium' }}>
```

### Space Props (`SpaceProps`)

Available on Box, Flex, Grid, Container, Card, Alert, most layout components:
- **Margin:** `m`, `mx`, `my`, `mt`, `mb`, `ml`, `mr` — each `Responsive<Space>`
- **Padding:** `p`, `px`, `py`, `pt`, `pb`, `pl`, `pr` — each `Responsive<Space>`
- **Space scale:** `'0.5'` (2px) through `'14'` (56px), based on 4px base unit

### Flex Item Props (`FlexItemProps`)

Available on Box, Card, and direct Flex children: `grow`, `shrink`, `basis` (all `Responsive`).

### Utility Props (`UtilityProps`)

Available on Flex, Grid: `alignItems`, `justifyContent`, `flexDirection`, `flexWrap`, `gap`, `display`, `border`, `borderRadius`, `columns`.

### Text Variants

- **Sizes:** `'title-large'` | `'title-medium'` | `'title-small'` | `'title-x-small'` | `'body-large'` | `'body-medium'` | `'body-small'` | `'body-x-small'`
- **Weights:** `'regular'` | `'bold'`
- **Colors:** `'primary'` | `'secondary'` | `'danger'` | `'warning'` | `'success'` | `'info'`
- All text props are responsive (per-breakpoint).

## Background (bg) System

Components support a semantic `bg` prop with layered neutral nesting:

- `bg="neutral"` — Increments level from parent (neutral-1 → neutral-2 → neutral-3 → neutral-4). This is always incremental.
- `bg="danger"` | `"warning"` | `"success"` — Intent backgrounds used as-is.
- Internal levels (`ContainerBg`): `'neutral-1'` through `'neutral-3'` + intent levels. `neutral-4` is reserved for leaf components (buttons on dark surfaces).

```tsx
<Box bg="neutral" p="4">
  <Box bg="neutral" p="4">   {/* neutral-2 */}
    <Box bg="neutral" p="4"> {/* neutral-3 */}
      <Button>on neutral-3 surface</Button>  {/* button uses neutral-4 internally */}
    </Box>
  </Box>
</Box>
```

## BUIProvider & Analytics

Wrap with `BUIProvider` to bridge BUI analytics with Backstage:

```tsx
import { BUIProvider } from '@backstage/ui';
import { useAnalytics as useBackstageAnalytics } from '@backstage/core-plugin-api';

<BUIProvider useAnalytics={useBackstageAnalytics}>
  <AppContent />
</BUIProvider>
```

Also auto-integrates with React Router for `Link`, `Tabs`, `Menu` navigation. Without it, BUI components use noop analytics.

## CSS Tokens

Import once in app entry: `import '@backstage/ui/css/styles.css';`

Key tokens (all `--bui-*` prefix):
- Font sizes: `--bui-font-size-1` (10px) through `--bui-font-size-10` (92px)
- Spacing: `--bui-space` (4px multiplier) → `--bui-space-0_5` through `--bui-space-14`
- Per-theme colors, font families, radii, shadows

## Hooks

| Hook | Purpose |
|---|---|
| `useBreakpoint()` | Current active breakpoint |
| `useAnalytics()` | `AnalyticsTracker` for BUI events |
| `useBgProvider()` / `useBgConsumer()` / `BgProvider` | bg level context |
| `useResolvedHref()` | react-router href resolution |
| `useMediaQuery(query)` | CSS media query match |
| `useIsomorphicLayoutEffect()` | SSR-safe layout effect |

## Table — Deep Dive

Built on `@tanstack/react-table` + React Aria:

```tsx
<Table
  columnConfig={[
    { id: 'name', label: 'Name', cell: item => <CellText title={item.name} />, isSortable: true },
    { id: 'type', label: 'Type', cell: item => <CellText title={item.type} />, width: '150px' },
  ]}
  data={entities}
  pagination={{ type: 'page', count: total, page, rowsPerPage, onPageChange, onRowsPerPageChange }}
  sort={{ descriptor: { column: 'name', direction: 'ascending' }, onSortChange }}
  selection={{ mode: 'multiple', selected: selectedKeys, onSelectionChange }}
  emptyState={<Text>No data found</Text>}
  isPending={loading}
  error={error}
  virtualized={{ estimatedRowHeight: 48 }}
/>
```

**Cell types (must use these, not bare text):** `Cell`, `CellText` (title + description + icon + href + color), `CellProfile` (avatar + name + description).

## Practical Recipes

### Recipe 1: Entity Page Layout

```tsx
<FullPage>
  <FullPage.Header>
    <Header title="my-service" tabs={[...]} tags={[...]} metadata={[...]} description="..." customActions={<Button variant="secondary">Edit</Button>} />
  </FullPage.Header>
  <FullPage.Content>
    <Container>
      <Flex gap="4">
        <Card href="/docs" label="View docs"><Card.Header>Docs</Card.Header><Card.Body><Text>Documentation</Text></Card.Body></Card>
        <Card><Card.Header>Dependencies</Card.Header><Card.Body><Text>None</Text></Card.Body></Card>
      </Flex>
    </Container>
  </FullPage.Content>
</FullPage>
```

### Recipe 2: Data Table with Full Features

```tsx
<Table
  columnConfig={[
    { id: 'name', label: 'Name', cell: item => <CellText title={item.name} description={item.desc} />, isSortable: true },
    { id: 'status', label: 'Status', cell: item => <Badge size="small">{item.status}</Badge> },
  ]}
  data={items}
  pagination={{ type: 'page', count: items.length, page, rowsPerPage: 20, onPageChange: setPage, onRowsPerPageChange: () => {} }}
  sort={sortState}
  selection={{ mode: 'multiple', selected: selectedKeys, onSelectionChange: setSelected }}
  emptyState={<Text color="secondary">No items</Text>}
/>
```

### Recipe 3: Responsive Card Grid

```tsx
<Grid columns={{ initial: '1', sm: '2', lg: '3' }} gap="4">
  {items.map(item => (
    <Card key={item.id} href={item.url} label={`View ${item.name}`}>
      <Card.Header>{item.name}</Card.Header>
      <Card.Body><Text>{item.description}</Text></Card.Body>
      <Card.Footer><Badge size="small">{item.type}</Badge></Card.Footer>
    </Card>
  ))}
</Grid>
```

### Recipe 4: Form with Validation

```tsx
<Flex direction="column" gap="4">
  <TextField label="Name" description="Unique across catalog" isRequired />
  <Select label="Environment" options={[{ value: 'prod', label: 'Production' }, { value: 'staging', label: 'Staging' }]} searchable />
  <CheckboxGroup label="Capabilities" options={[{ value: 'api', label: 'API' }, { value: 'web', label: 'Web UI' }]} />
  <Flex gap="2"><Button variant="primary">Save</Button><Button variant="secondary">Cancel</Button></Flex>
</Flex>
```

### Recipe 5: Dialog with Menu

```tsx
<Dialog.Trigger>
  <Button variant="secondary">Settings</Button>
  <Dialog width="500px">
    <Dialog.Header>Settings</Dialog.Header>
    <Dialog.Body>
      <TextField label="API Endpoint" />
      <Menu.Trigger>
        <Button variant="tertiary">Advanced</Button>
        <Menu>
          <Menu.Item onAction={reset}>Reset Defaults</Menu.Item>
          <Menu.Section title="Danger"><Menu.Item color="danger" onAction={del}>Delete</Menu.Item></Menu.Section>
        </Menu>
      </Menu.Trigger>
    </Dialog.Body>
    <Dialog.Footer><Button variant="primary">Save</Button></Dialog.Footer>
  </Dialog>
</Dialog.Trigger>
```

## BUI vs MUI — Quick Migration Reference

| MUI | BUI |
|---|---|
| `Typography` | `Text` |
| `Button` (MUI) | `Button` (BUI) |
| `IconButton` | `ButtonIcon` |
| `Card` + `CardHeader` + `CardContent` | `Card` + `Card.Header` + `Card.Body` |
| `Table` | `Table` (columnConfig-based API) |
| `TextField`, `Select`, `Checkbox`, `Radio`, `Switch`, `Slider` | Same names in BUI |
| `Dialog` + `DialogTitle` + `DialogContent` + `DialogActions` | `Dialog.Trigger` + `Dialog.Header` + `Dialog.Body` + `Dialog.Footer` |
| `Tabs`, `Tab` | `Tabs`, `Tab` (URL-synced) |
| `Alert`, `Skeleton`, `Avatar`, `Tooltip`, `Link`, `Popover` | Same names in BUI |
| `Chip` | `Badge` or `TagGroup.Tag` |
| `Box` (system) | `Box` (BUI — spacing + layout + bg) |
| `Grid` (MUI) | `Grid` (CSS Grid) or `Flex` (Flexbox) |
| `Menu` + `MenuItem` | `Menu.Trigger` + `Menu.Item` |
| `Accordion` | `Accordion.Trigger` + `Accordion.Panel` |
| `Autocomplete` | `Combobox` or `SearchAutocomplete` |
| `Breadcrumbs` | Deprecated — use `Header` tabs |
| `Container`, `ToggleButton`, `ToggleButtonGroup` | Same names in BUI |

## Common Pitfalls

1. **Forgetting `BUIProvider`** — Required for analytics + react-router integration. Without it, Link/Tabs/Menu navigation breaks.
2. **Using bare text in Table cells** — Must wrap in `Cell`, `CellText`, or `CellProfile`.
3. **Using MUI `sx` on BUI components** — BUI uses its own `p`/`m`/`gap` spacing system. MUI props don't work.
4. **Not importing CSS** — Add `import '@backstage/ui/css/styles.css'` to app entry.
5. **`bg="neutral"` is incremental, not absolute** — Nesting produces neutral-1, neutral-2, neutral-3. You cannot set explicit levels.
6. **`Header.Page` deprecated** — Use `Header` directly.
7. **`loading` prop deprecated** — Use `isPending` everywhere.
8. **Missing `noTrack` on utility links** — Links inside menus/popovers should use `noTrack` to avoid duplicate analytics.
9. **Using `useState` + `setView` with BUI Tabs** — BUI Tabs navigate via URL hash, not via `onChange`. `setView` is never called when a tab is clicked. Use a `hashchange` event listener or React Router hooks to detect tab changes. This is the single most common bug in new Backstage dashboards.

## Verification Checklist

- [ ] `@backstage/ui` installed + `import '@backstage/ui/css/styles.css'` in app entry
- [ ] `BUIProvider` wraps the app for analytics + routing
- [ ] Spacing uses BUI's `p`/`m`/`gap` system (not MUI `sx`)
- [ ] Table cells use `Cell`/`CellText`/`CellProfile` wrappers
- [ ] `isPending` used instead of deprecated `loading`
- [ ] `Header.Page` variants replaced with `Header`
- [ ] Responsive props use `{ initial: ..., md: ... }` pattern
- [ ] bg props use semantic values not explicit hex
