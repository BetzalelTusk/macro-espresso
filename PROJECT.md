# Shell — UI vocabulary

> **Read this file before building any UI in this repo.** It holds this project's
> names, components and bans. When a token, component or pattern is deleted from the
> code, delete it here in the same change.

## 1. Token vocabulary

Every value lives in `src/theme.css`. These names are the complete set: no raw hex,
no arbitrary values, no framework palette names. If you need a value that isn't here,
use the nearest token and record the gap; adding a token is a change to `theme.css`,
never an inline literal.

| Axis | Names | Notes |
|---|---|---|
| Ground | `--ground-0` … `--ground-4`, `--line` | Cool graphite, hue 235. Surfaces separate by tone, not borders. `--ground-0` is also the native window/webview background (`GROUND` in `lib.rs`); keep them equal |
| Ink | `--ink-1` (primary), `--ink-2` (secondary), `--ink-3` (labels), `--ink-mark` (crosshairs, ticks) | All text pairs ≥ 4.5:1 on `--ground-1…3` and on `--ambient-field` |
| Accent | `--accent`, `--accent-2`, `--accent-sweep` | Amber → rose. The only saturated colour |
| State | `--ok`, `--err`, `--err-ground` | Status dots and the error panel only |
| Ambient | `--ambient-field`, `--smoke-navy`, `--smoke-olive`, `--smoke-umber`, `--grain-opacity` | Smoke is always darker than the field |
| Type | `--font` (Inter Variable), `--text-title`, `--text-body`, `--text-label`, `--tracking-label` | One family. Rank comes from weight and ink, not size jumps |
| Space | `--space-1/2/3/4/6` (4px base), `--rail-width`, `--rail-item` | |
| Radius | `--radius-control` (10px), `--radius-panel` (14px) | |
| Motion | `--t-micro`, `--t-panel`, `--ease-out`, `--t-drift`, `--t-sweep` | See §6 |

**Colour budget.** The accent has exactly three roles: "this is active" (the rail's
active-tab marker, the focused pane's header line), the rail's registration-cross mark,
and the "busy" status dot. Anywhere else is a bug.

## 2. Components

| Component | Use it for | Never build alongside it |
|---|---|---|
| `components/Ambient.tsx` | Every in-between state on the stage: loading, starting, error, empty, behind the palette | A per-tab spinner, skeleton or "loading…" div |
| `components/Rail.tsx` | Tab navigation and per-tab status dots | A second nav bar, a tab strip |
| `components/Palette.tsx` | Every command (Ctrl+K) | A settings menu that duplicates commands |
| `components/Panes.tsx` | One pane or a split: pane bodies (where webviews go), split headers, the divider | A second layout system or absolute-positioned webview hosts |
| `useLayout.ts` | Which tabs are on screen, focus, split ratio, tab statuses; `apply` starts tools and calls `show_tabs` | Calling `show_tabs`/`ensure_service` from components |
| `StageMessage` in `App.tsx` | The text in a pane for each `TabStatus` | Toasts for tab state |
| Native `Menu` (`@tauri-apps/api/menu`) | Right-click menus on rail tabs | HTML context menus (they'd draw under websites) |

Icons: `lucide-react` only, `strokeWidth` 1.6–1.8, sizes 14/16/18/20.

## 3. Named anti-patterns

| Forbidden | Use instead | Why |
|---|---|---|
| UI drawn over the content area while a tab is showing | Hide tabs first (`hide_tabs`), as the palette does | Tab webviews sit above the UI webview; anything drawn there is invisible |
| CSS tooltips or menus that extend from the rail into the stage | `title` for tooltips; native `Menu` for menus | Same reason: they'd render under the tab |
| Clickable UI inside a `.pane-body` (or on its edge) | Pane headers, the divider's own grid column (`--divider-width`) | Webviews cover pane bodies completely |
| Drags that rely on `setPointerCapture` or end on `blur` | Hide tabs for the drag (`hideAll`), track `pointermove`/`pointerup` on `window` | Capture doesn't hold in this webview; hiding tabs moves focus and fires `blur` |
| Brighter-than-field blobs, saturated aurora | Darker smoke tinted by hue | The reference reads as smoke over graphite, not coloured light |
| Animating `filter`, size or position of blobs | `transform` only | Blur on large layers is costly; transform stays on the compositor |
| Animation running under a visible tab | `Ambient paused` when the active tab is ready | Invisible work still costs GPU |
| Sync Tauri commands that create webviews | `async fn` | They leave the webview on about:blank on Windows |

**Sanctioned exceptions**

| Exception | Where | Why |
|---|---|---|
| raw `#000` | `components/rail.css` mask on `.rail-mark` | Mask alpha, never a visible colour |
| inline `style` | `components/Ambient.tsx` tick grid columns and per-tick `animationDelay` | Values computed per element |

## 4. Structural ideas

| Screen | The one idea |
|---|---|
| Whole app | A quiet graphite frame around live apps. The apps are the subject; the frame only becomes expressive in between states |
| Stage (no tab showing) | A framed centre: four registration crosses around one short message. Eyebrow (tab name, label style) + title (state) + optional detail/action |
| Rail | A dark instrument strip: icon, active marker on the inline-start edge, a dot only when something isn't simply fine |
| Split | Two panes with label-style headers; the focused one carries the accent line; rail clicks and Ctrl+1-9 change the focused pane |

**Patterns deleted on purpose**

- Letter-glyph tab buttons ("M", "W", "T3"), replaced 2026-10-29 by icons.
- Coloured aurora blobs, replaced 2026-10-29 by dark smoke (read the reference wrong first).

## 5. Direction and i18n

LTR, English only, no translation layer yet. Use logical properties (`inset-inline-*`,
`padding-block`, `margin-inline`) so RTL stays possible.

## 6. Motion budget

| Level | Trigger | Duration / easing | Animates |
|---|---|---|---|
| Micro | hover, press | `--t-micro` + `--ease-out` | background-color, color |
| Panel | palette opens | `--t-panel` + `--ease-out` | opacity, transform |
| Busy | a tab is loading or a tool is starting | `--t-sweep`, loops only while busy | tick opacity, busy-dot opacity |
| Ambient | stage visible | `--t-drift`, alternate | blob transform |

**Prohibited:** looping motion while nothing is happening; spinners; parallax.
**Reduced motion** (`prefers-reduced-motion: reduce`): blobs stop, ticks show static at
low opacity, the busy dot stops pulsing, the palette appears without movement.
