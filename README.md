# Macro Espresso

A lightweight desktop workspace with [Macro](https://macro.com) at its centre. Macro sits beside the
tools I live in (WhatsApp, Spotify, T3 Code, Paperclip, my files and my notes) in one keyboard-first
window.

Built with Tauri 2, Rust and React. Windows first (developed on Windows 11 ARM64).

## What it does

- **Tabs that feel native.** Each tab is its own webview: real sites load as themselves, not in iframes.
  Split view (Ctrl+\\), a command palette (Ctrl+K), Ctrl+1–9 and Ctrl+Tab, right-click menus,
  close-to-tray and single instance.
- **Instant switching.** After launch, local tools start and every tab loads out of sight, so opening
  one takes about 100 ms.
- **Local tools, supervised.** T3 Code and Paperclip are started, health-checked, signed in (T3's
  one-time pairing URL is read from its log) and shut down with the app, including tools left behind
  by a crash.
- **Notes.** An [Astro](https://astro.build) site with Benji Tusk's
  [astro-mdx-editor](https://github.com/benjitusk/astro-mdx-editor) runs as a tab. Notes are plain
  `.mdx` files in git. The site maps this app's design tokens onto the editor's variables, so the
  editor takes on the look without changes to its code.
- **Files.** A native file browser: places and drives, breadcrumbs, filter, sort, keyboard control.
- **Settings.** Show, hide and reorder tabs; open at Windows sign-in (into the tray); background
  warm-up; close-to-tray. Per-tab "Sign out and reset" clears one site's data.
- **Updates.** The app checks for a newer installer and installs it from Settings.

## Design

Cool graphite ground in stepped lightness, three inks, and one amber-to-rose accent with a strict
budget ("active", the mark, "working"). While a tab loads: drifting dark smoke, film grain and
registration crosshairs. Inter throughout. Tokens live in [`src/theme.css`](src/theme.css); the
vocabulary and rules are in [`PROJECT.md`](PROJECT.md).

## Layout

```
src/                 React UI: rail, panes, palette, Files, Settings, ambient
src-tauri/src/
  lib.rs             window, tab webviews, tray, title bar, site-data reset
  services.rs        local tools: start, health, pairing, leftovers, quit
  files.rs           native file listing
  shortcuts.rs       global shortcuts while focused
  updates.rs         update check and install
tools/
  patch-paperclip.mjs  Windows fixes for an installed Paperclip
  pty_bridge.py        ConPTY bridge for Claude sign-in on Windows
```

## Build

Needs Node 22+, Rust (stable) and the Tauri prerequisites for Windows.

```sh
npm install
npx tauri dev                    # run
npx tauri build --bundles nsis   # installer in src-tauri/target/release/bundle/nsis
```

The tools the tabs use are installed separately: T3 Code (`npm install -g t3`), Paperclip, and the
notes site (an Astro blog with `astro-mdx-editor`).

## How it was built

AI-first: I set the direction, designed every screen and tested it hard; AI agents wrote much of the
code. Every release runs a 17-check regression against the running app before it ships
([`QA.md`](QA.md)).

## License

Code: [MIT](LICENSE). The Macro name and mark are Macro's and are not covered by the license; this is
an independent personal project, not affiliated with Macro. See [`NOTICE`](NOTICE).
