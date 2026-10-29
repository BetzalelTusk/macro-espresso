# Shell — overnight QA loop

## Morning summary (2026-10-29)

Every item below is done and verified in the running app; the final regression passed
17/17. Twelve commits overnight, from e1a71e1 to bdc5b64.

**Install it:** run `Desktop\macro-desktop\Shell_0.1.0_arm64-setup.exe` (1.6 MB; the optimized
build, smoke-tested: launches, restores your layout, quits cleanly). Close the test build
first if it's open. Your logins, layout and Paperclip setup carry over.

**What you asked for**
- **Divider drag is smooth**: 60 fps (was re-rendering the whole app per mouse move).
- **Spotify and WhatsApp fit any pane**: their sites have minimum widths (800 / 748 px);
  below that the tab zooms to fit instead of being cut off.
- **Spotify and WhatsApp are steady**: no reloads on tab switches; they keep running while
  hidden (music and connection continue); logins survive restarts; links open in your
  browser, sign-in popups stay in the app.
- **T3 Code signs in by itself** on every start, including after a crash (an old T3 left
  running used to force the pairing screen).
- **Paperclip** opens straight to your Tavor Digital dashboard (no password: local mode);
  Restart and quit work; nothing is left running after quit.
- **Files tab is built**: places and drives, breadcrumbs, filter, sort, hidden-files toggle,
  open/show-in-Explorer/copy path, keyboard control, fast on huge folders.

**Also fixed or added**
- Notifications were blocked in every tab; WhatsApp can now notify.
- Tabs reopen on the page you left (e.g. a Spotify album).
- Title bar tinted to match; film grain kept off content.
- Two bugs the regression caught: tabs stopped following resizes after a swap; quick
  arrow-key presses on the divider dropped steps.

**Please check in the morning** (my tools can't see or do these):
1. A real WhatsApp notification shows up (send yourself a message from your phone).
2. The title bar looks graphite rather than grey.
3. Drag the divider by hand, it should feel smooth.
4. In T3 Code, enable Claude Code under Settings → Providers.

---

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
- [x] **Paperclip sign-in works properly**: first-run onboarding reachable and usable;
  survives restart; restart/log menu actions work.
- [x] **T3 Code sign-in works properly**: pairing is automatic on every fresh start
  (no "Still connecting"), stays paired across restarts; provider settings reachable.

## To build

- [x] **Files tab**: native file browser for local files (Tauri fs/commands):
  sidebar of places (Home, Desktop, Documents, Downloads, drives), breadcrumb path,
  list with icon/name/size/modified, sort, open with default app, reveal in Explorer,
  keyboard navigation, loading/empty/error states, follows PROJECT.md. Google Drive
  later (needs the user's OAuth app).

## UI/UX polish

- [x] Window title bar matches the dark theme on Windows (or custom title bar).
- [x] Rail tooltips feel native (title attr is slow and plain).
- [x] Notifications from web tabs (WhatsApp) reach Windows while the shell runs.
- [x] Tab memory: reopening restores each tab's page, not only the layout.
- [x] Review every screen against PROJECT.md and the anti-slop audit; fix findings.
- [x] Re-run the full regression (below) after all fixes.

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
- Tool orphans (left by a crash or force-quit) broke sign-in and cleanup. T3 Code: an orphan
  with the shell's own arguments is replaced, so a fresh pairing URL exists; 3/3 fresh starts
  (one with an orphan running) landed paired in T3's main screen in 12-14s. Paperclip: orphans
  are adopted and stopped on quit; leftover matching now normalises mixed slashes (Paperclip's
  node command line was never matched before). Verified: dashboard after clean start (24s)
  and after palette Restart (21s, self-reconnects); quit leaves 0 postgres; no sign-in needed
  (trusted local mode). Test harness: scratchpad harness.mjs, t3-test.mjs, paperclip-test.mjs.
- Files tab built: places (standard folders + drives), back/forward/up, breadcrumbs, filter,
  sortable columns, hidden-files toggle, virtualised list, double-click/Enter opens (folders in
  place, files in their app), right-click Open / Show in Explorer / Copy path, Backspace and
  Alt+arrows, remembered folder. Verified: System32 (4,677 items) lists in ~1s and scrolls at
  60 fps with 38 rows in the DOM; access-denied shows a clear message; narrow panes drop
  places then dates (fixed a container-query bug that left the list 196px wide). Google Drive
  still needs the user's own Google OAuth app.
- Notifications: WebView2 had stored "denied" for every tab (it denies requests the host
  doesn't answer). Each tab's origin is now set to allow notifications in its profile and later
  requests are answered allow (other permissions unchanged). WhatsApp: denied -> granted.
  Not shown a real toast overnight; the user should confirm one arrives.
- Title bar: tinted with the shell's tokens via DWM (caption --ground-1, text --ink-2,
  border --line); not visible to the test tools, user to check. Also fixed the native GROUND
  colour (#15191c -> #0b0f11, the real --ground-0).
- Tab memory: each https tab's page is saved on hide-to-tray and quit and reopened on the next
  start if it's on the same site. Verified: Spotify /search survives a restart. Local tools
  excluded (one-time sign-in URLs).
- Rail tooltips: kept the native title tooltip on purpose. Any HTML tooltip would draw into the
  stage, where the tab webviews cover it (PROJECT.md anti-pattern).
- Review: slop-scan clean apart from the sanctioned exceptions in PROJECT.md; Files covers
  loading/empty/error/disabled. Fix: film grain moved off content (it textured the Files list)
  onto the atmosphere only (ambient stage, rail).
- Regression (scratchpad regression.mjs, 17 checks) found two real bugs, both fixed:
  pane resize observer kept watching replaced pane elements after a swap or tab change, so
  tabs stopped following resizes; quick divider arrow-key presses dropped steps. Final run:
  17/17 (launch/restore, split fit, shortcuts, swap, keyboard resize + tab follows, close pane,
  palette filter/no-match/Esc/Enter, close-to-tray, single instance, quit leaves nothing).
