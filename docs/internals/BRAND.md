# Agent Baton brand

Internal reference for the visual identity. All assets are hand-written, dependency-free SVG in `assets/`.

## Concept

A relay baton passed between three agent nodes. Three ink nodes form a triangle (plan, build, review); a white baton capsule sits on one edge, mid-handoff. One accent colour plus ink; no gradients.

## Palette

| Role | Hex | Use |
| --- | --- | --- |
| Baton orange (accent) | `#FF6B35` | Mark tile, highlights, step numbers, final state |
| Ink | `#0F172A` | Nodes, text on light backgrounds |
| Night | `#0B1020` | Dark backgrounds (banner, dark diagram) |
| Paper | `#FFFFFF` | Baton, text on dark backgrounds |
| Panel (dark) | `#111A33` / `#18213D` | Terminal and box fills on dark |
| Slate muted | `#94A3B8` (dark), `#475569` (light) | Secondary text |
| Line | `#334155` (dark), `#CBD5E1` (light) | Borders, leader lines |

Orange tile with ink glyph works on both light and dark pages, so the mark needs no variant.

## Type

- Wordmark: lowercase `agent baton`, drawn as monoline stroked paths (stroke 3.6 on a 20-unit x-height, round caps and joins). No font dependency, renders identically everywhere.
- Banner and diagram text: system stack `ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`.
- Code and terminal: `ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace`.

## Files

| File | Purpose |
| --- | --- |
| `assets/logo.svg` | Horizontal lockup, adapts to light/dark via `prefers-color-scheme` |
| `assets/logo-light.svg` | Lockup with ink wordmark, for light backgrounds |
| `assets/logo-dark.svg` | Lockup with white wordmark, for dark backgrounds |
| `assets/logo-mark.svg` | Square mark, 64x64, avatar |
| `assets/favicon.svg` | Mark with heavier strokes for 16px |
| `assets/banner.svg` | 1280x640 social preview and README hero |
| `assets/diagram-workflow.svg` | plan, split, assign, begin, verify, submit, review, accept over the ledger; light/dark via CSS inside the SVG |
| `assets/preview/*.png` | Local render checks only |

README switching:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
  <img alt="Agent Baton" src="assets/logo-light.svg" height="48">
</picture>
```

Note: SVGs loaded through `<img>` do not inherit page CSS, so use the `<picture>` pair on GitHub rather than `logo.svg`.

## Usage rules

- Keep clear space of at least half the mark's width around the lockup.
- Minimum sizes: mark 16px (use `favicon.svg` below 32px), lockup 24px tall.
- Do not recolour the tile, rotate the baton, add gradients, shadows or outlines, or stretch the lockup.
- Use orange sparingly: one accent per composition.
- The mark may sit on any background; the wordmark must use the matching light or dark variant.
- Assets contain no external references, scripts or fonts.
