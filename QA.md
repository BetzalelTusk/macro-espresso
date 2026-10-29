# Shell — overnight QA loop

The work list for the autonomous loop (started 2026-10-29). Each round: take the first
open item, fix or build it, **verify it in the running app** (CDP on port 9334, see
"How to verify" below), commit, tick it here with a one-line result, then continue.
New bugs found along the way go to the end of the list.

Limits: never sign into the user's accounts or type passwords; never send messages or
play audible media; touch nothing outside `shell/` and the shell's own tools folder;
never push. Sign-in work means the sign-in *page* works and persists, not signing in.

## Bugs reported by the user

- [x] **Divider drag is choppy.** Every pointermove sets React state, re-renders the
  app and fires ResizeObserver → IPC. Drive the drag with a CSS variable + rAF, commit
  the ratio on release; no IPC while tabs are hidden.
- [x] **WhatsApp and Spotify don't fit narrow panes / small windows** (Paperclip does).
  Find out why (likely the sites' minimum layout width). Fix so every tab fits its pane,
  e.g. per-tab minimum width and webview zoom below it. Verify at 3 pane widths.
- [x] **Spotify must work seamlessly**: loads, no glitches on tab switch, split,
  resize, hide/show, reload; playback continues while the tab is hidden; DRM present.
- [x] **WhatsApp must work seamlessly**: same checks; stays connected while hidden;
  session persists across app restarts (check storage survives).
- [ ] **Paperclip sign-in works properly**: first-run onboarding reachable and usable;
  survives restart; restart/log menu actions work.
- [ ] **T3 Code sign-in works properly**: pairing is automatic on every fresh start
  (no "Still connecting"), stays paired across restarts; provider settings reachable.

## To build

- [ ] **Files tab**: native file browser for local files (Tauri fs/commands):
  sidebar of places (Home, Desktop, Documents, Downloads, drives), breadcrumb path,
  list with icon/name/size/modified, sort, open with default app, reveal in Explorer,
  keyboard navigation, loading/empty/error states, follows PROJECT.md. Google Drive
  later (needs the user's OAuth app).

## UI/UX polish

- [ ] Window title bar matches the dark theme on Windows (or custom title bar).
- [ ] Rail tooltips feel native (title attr is slow and plain).
- [ ] Notifications from web tabs (WhatsApp) reach Windows while the shell runs.
- [ ] Tab memory: reopening restores each tab's page, not only the layout.
- [ ] Review every screen against PROJECT.md and the anti-slop audit; fix findings.
- [ ] Re-run the full regression (below) after all fixes.

## Regression checklist (run at the end, and after risky changes)

1. Launch → last layout restored, no white flash, tabs reveal after load.
2. Rail click, Ctrl+1–6, Ctrl+Tab, Ctrl+K, Ctrl+\, Ctrl+Q.
3. Split open/close/swap/resize (drag + arrow keys); both webviews sized right.
4. Window resize (small and maximised): every visible tab fits.
5. Palette: filter, arrows, Enter, Esc, no-match state.
6. Local tools: start, restart, show log; quit leaves no processes (postgres, t3).
7. Close → tray; tray click restores; second launch focuses the running app.

## How to verify

- Build: `npx tauri build --debug --no-bundle` in `shell/` (close the running shell first).
- Run with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9334`.
- Scripts in the session scratchpad: `eval.mjs` (Runtime.evaluate), `shot.mjs`
  (Page.captureScreenshot), `drag4.mjs` (divider drag via Input.dispatchMouseEvent).
- Tab webviews appear as separate CDP targets; check `innerWidth`/`innerHeight`.

## Log

- e1a71e1 Divider drag: CSS variables per animation frame, ratio committed on release,
  no IPC while hidden. Simulated drag: 60 fps (avg 17 ms, p95 17 ms frames).
- 7deaace Fit: Spotify (body min-width 800) and WhatsApp (container 748) were clipped.
  Tabs declare `minWidth`; the webview zooms (≥0.4) below it. At a 304px pane no tab
  overflows; Macro, T3 Code and Paperclip are responsive and need no zoom.
- Spotify/WhatsApp hardening: zoom only re-sent when it changes (no re-layout flicker on
  resize/switch); new-window links open in the default browser, sized popups (sign-in) stay
  in-app. Verified: 8 tab switches without reload; hidden tabs keep running timers at full
  rate (connection/playback continue); both stayed signed in across ~20 restarts; DRM present.
