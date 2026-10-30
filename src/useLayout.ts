import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { SETTINGS_TAB, TABS, type Tab, type TabStatus } from "./tabs";

export type Layout = {
  /** Tab ids on screen, left to right: one, or two in a split. */
  panes: string[];
  /** Which pane rail clicks and Ctrl+1-9 change. */
  focused: number;
  /** The left pane's share of the width in a split. */
  ratio: number;
};

const LAYOUT_KEY = "shell:layout";
export const MIN_RATIO = 0.25;
export const MAX_RATIO = 0.75;

export const tabById = (id: string): Tab =>
  id === SETTINGS_TAB.id ? SETTINGS_TAB : (TABS.find((t) => t.id === id) ?? TABS[0]);

/** The saved layout, keeping only tabs that may be shown (`allowed`). */
function savedLayout(allowed: string[]): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Layout | null;
    const panes = (raw?.panes ?? []).filter((id) => allowed.includes(id)).slice(0, 2);
    if (panes.length > 0) {
      return {
        panes,
        focused: Math.min(Math.max(raw?.focused ?? 0, 0), panes.length - 1),
        ratio: Math.min(Math.max(raw?.ratio ?? 0.5, MIN_RATIO), MAX_RATIO),
      };
    }
  } catch {
    // A missing or unreadable saved layout just means the default one.
  }
  return { panes: [allowed[0]], focused: 0, ratio: 0.5 };
}

type Bounds = { x: number; y: number; width: number; height: number };

function measure(el: HTMLElement): Bounds {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * Timing trace for tab switches, off unless localStorage `shell:trace` is set:
 * each step of `apply` is logged to the console with ms since the switch began.
 */
let traceStart = 0;
function trace(step: string) {
  try {
    if (!localStorage.getItem("shell:trace")) return;
  } catch {
    return;
  }
  if (step.startsWith("apply ")) traceStart = performance.now();
  console.debug(`[apply +${Math.round(performance.now() - traceStart)}ms] ${step}`);
}

/**
 * Lowest zoom used to fit a site. The narrowest pane (MIN_RATIO of a minimum
 * window) is ~300px, and WhatsApp needs 748px, so this must stay ≤ 0.4.
 */
const MIN_FIT_ZOOM = 0.4;

/** Zoom that lets a site with a minimum width fit a narrower pane. */
function fitZoom(tab: Tab, width: number): number {
  if (!tab.minWidth || width >= tab.minWidth) return 1;
  return Math.max(MIN_FIT_ZOOM, width / tab.minWidth);
}

/**
 * The panes, what's in them, and each tab's status. `apply` puts the layout on
 * screen: it starts local tools, then asks Rust to show exactly these tabs.
 */
export function useLayout({ visibleIds, warmUp }: { visibleIds: string[]; warmUp: boolean }) {
  const [layout, setLayout] = useState<Layout>(() => savedLayout([...visibleIds, SETTINGS_TAB.id]));
  // Read once, after launch: the warm-up is a startup step.
  const warmUpRef = useRef({ visibleIds, warmUp });
  warmUpRef.current = { visibleIds, warmUp };
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});
  const [hidden, setHidden] = useState(false);
  const bodies = useRef<(HTMLElement | null)[]>([]);
  // Each apply gets a number; a slow tool start can't act on a newer layout.
  const generation = useRef(0);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  const hiddenRef = useRef(hidden);
  hiddenRef.current = hidden;

  const setStatus = useCallback((id: string, status: TabStatus) => {
    setStatuses((s) => ({ ...s, [id]: status }));
  }, []);

  // One start per tool at a time, shared by opening a tab and the warm-up.
  // A fresh start's sign-in URL waits in `pairings` for whichever creates the
  // tab's webview first (`takePairing`).
  const starting = useRef(new Map<string, Promise<void>>());
  const pairings = useRef(new Map<string, string>());
  const startTool = useCallback((tab: Extract<Tab, { kind: "local" }>) => {
    let start = starting.current.get(tab.id);
    if (!start) {
      start = invoke<string | null>("ensure_service", { id: tab.service })
        .then((pairing) => {
          if (pairing) pairings.current.set(tab.id, pairing);
        })
        .finally(() => starting.current.delete(tab.id));
      starting.current.set(tab.id, start);
    }
    return start;
  }, []);
  const takePairing = (id: string) => {
    const pairing = pairings.current.get(id);
    pairings.current.delete(id);
    return pairing;
  };

  useEffect(() => {
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
    } catch {
      // Remembering the layout is a convenience; private storage can refuse it.
    }
  }, [layout]);

  const placements = useCallback(() => {
    return layoutRef.current.panes.flatMap((id, i) => {
      const el = bodies.current[i];
      const tab = tabById(id);
      if (!el || tab.kind === "native") return [];
      const bounds = measure(el);
      return [{ id, bounds, zoom: fitZoom(tab, bounds.width) }];
    });
  }, []);

  const apply = useCallback(
    async (next: Layout) => {
      const mine = ++generation.current;
      setHidden(false);
      const tabs = next.panes.map(tabById);
      const urls: Record<string, string> = {};

      for (const tab of tabs) {
        if (tab.kind === "native") setStatus(tab.id, { state: "ready" });
      }

      // The panes' webviews, measured now. `urls` overrides a tab's own URL.
      const viewsFor = (include: (tab: Tab) => boolean) =>
        next.panes.flatMap((id, i) => {
          const tab = tabById(id);
          const el = bodies.current[i];
          if (tab.kind === "native" || !el || !include(tab)) return [];
          if (statusesRef.current[id]?.state === "error") return [];
          const bounds = measure(el);
          return [{ id, url: urls[id] ?? tab.url, bounds, zoom: fitZoom(tab, bounds.width) }];
        });

      // A tool still starting would leave the previous tab on screen under the
      // new pane's header until it's up. Swap the screen over right away: show
      // what's ready, hide the rest; the starting pane shows its message.
      const ready = (tab: Tab) => tab.kind !== "local" || statusesRef.current[tab.id]?.state === "ready";
      trace(`apply ${next.panes.join("+")}, ready: ${tabs.map((t) => `${t.id}=${ready(t)}`).join(" ")}`);
      if (!tabs.every(ready)) {
        await invoke("show_tabs", { views: viewsFor(ready), focus: next.panes[next.focused] }).catch(() => {});
        trace("early show_tabs done");
        if (mine !== generation.current) return;
      }

      // Start local tools first; a fresh start may hand back a sign-in URL.
      await Promise.all(
        tabs.map(async (tab) => {
          if (tab.kind !== "local") return;
          urls[tab.id] = tab.url;
          if (statusesRef.current[tab.id]?.state !== "ready") {
            setStatus(tab.id, { state: "starting" });
          }
          try {
            await startTool(tab);
            trace(`tool ${tab.id} ready`);
          } catch (e) {
            setStatus(tab.id, { state: "error", message: String(e) });
          }
        }),
      );
      if (mine !== generation.current) {
        trace("superseded");
        // A newer layout won; tools that finished starting just aren't shown yet.
        setStatuses((s) => {
          const out = { ...s };
          for (const tab of tabs) {
            if (out[tab.id]?.state === "starting") out[tab.id] = { state: "idle" };
          }
          return out;
        });
        return;
      }

      // Only now take sign-in URLs: an apply that lost to a newer one leaves
      // them for the tab's next webview.
      for (const tab of tabs) {
        const pairing = takePairing(tab.id);
        if (!pairing) continue;
        // A webview made before this run of the tool can't sign in.
        await invoke("close_tab", { id: tab.id });
        urls[tab.id] = pairing;
      }

      const views = viewsFor(() => true);
      try {
        const showing = await invoke<string[]>("show_tabs", {
          views,
          focus: next.panes[next.focused],
        });
        trace(`show_tabs done, showing: ${showing.join("+") || "none (loading)"}`);
        if (mine !== generation.current) return;
        setStatuses((s) => {
          const out = { ...s };
          for (const view of views) {
            out[view.id] =
              showing.includes(view.id) || out[view.id]?.state === "ready"
                ? { state: "ready" }
                : { state: "loading" };
          }
          return out;
        });
      } catch (e) {
        for (const view of views) setStatus(view.id, { state: "error", message: String(e) });
      }
    },
    [setStatus, startTool],
  );

  // Warm-up: shortly after launch, start every local tool and load every tab
  // the rail shows, out of sight, so opening one later is instant, like a
  // native app. Off in Settings, tabs load when first opened.
  useEffect(() => {
    const warmUp = async () => {
      const { visibleIds, warmUp } = warmUpRef.current;
      if (!warmUp) return;
      // Native panes have no webview body; any measured pane gives the size.
      const el = bodies.current.find(Boolean);
      if (!el) return;
      const { width, height } = measure(el);
      const preload = (tab: Tab, url: string) =>
        invoke("preload_tabs", {
          views: [{ id: tab.id, url, bounds: { x: 0, y: 0, width, height }, zoom: fitZoom(tab, width) }],
        });
      const waiting = TABS.filter(
        (tab) => visibleIds.includes(tab.id) && !layoutRef.current.panes.includes(tab.id),
      );
      // Local tools first: they take the longest (Paperclip ~30s).
      await Promise.all(
        waiting.map(async (tab) => {
          if (tab.kind !== "local") return;
          if (!statusesRef.current[tab.id]) setStatus(tab.id, { state: "starting" });
          try {
            await startTool(tab);
          } catch (e) {
            setStatus(tab.id, { state: "error", message: String(e) });
            return;
          }
          // Opened meanwhile: `apply` made (or is making) its webview.
          if (layoutRef.current.panes.includes(tab.id)) return;
          await preload(tab, takePairing(tab.id) ?? tab.url).catch(() => undefined);
          if (statusesRef.current[tab.id]?.state === "starting") setStatus(tab.id, { state: "loading" });
        }).concat(
          waiting.map(async (tab) => {
            if (tab.kind === "web") await preload(tab, tab.url).catch(() => undefined);
          }),
        ),
      );
    };
    // After the first layout is up, so the visible tabs load first.
    const timer = setTimeout(() => void warmUp(), 1500);
    return () => clearTimeout(timer);
  }, [setStatus, startTool]);

  /** Change the layout and put it on screen once React has laid the panes out. */
  const update = useCallback((change: (current: Layout) => Layout) => {
    setLayout((current) => change(current));
  }, []);

  // Re-apply whenever the panes or focus change (after the DOM updates).
  const shownKey = `${layout.panes.join("|")}#${layout.focused}`;
  useEffect(() => {
    void apply(layoutRef.current);
  }, [shownKey, apply]);

  // A tab finished its first page load (Rust moved it into place).
  useEffect(() => {
    const off = listen<{ id: string }>("tab-ready", ({ payload }) => {
      setStatuses((s) =>
        s[payload.id]?.state === "error" ? s : { ...s, [payload.id]: { state: "ready" } },
      );
    });
    return () => {
      void off.then((f) => f());
    };
  }, []);

  // Keep tab webviews over their panes as the window or the divider moves.
  // Re-attach whenever the panes change: a swap or a new tab replaces the
  // pane elements, and an observer on the old ones would never fire again.
  const panesKey = layout.panes.join("|");
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      // Hidden tabs (palette, divider drag) get their bounds when re-shown.
      if (hiddenRef.current) return;
      // Stamped in microseconds, so Rust can drop a stale size that arrives
      // after a newer one. A clock (not a counter) keeps rising across reloads.
      const seq = Math.floor((performance.timeOrigin + performance.now()) * 1000);
      void invoke("set_tab_bounds", { placements: placements(), seq });
    });
    for (const el of bodies.current.slice(0, layout.panes.length)) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [panesKey, layout.panes.length, placements]);

  /** Hide every tab so the shell's own UI (the palette) shows. */
  const hideAll = useCallback(async () => {
    generation.current++;
    hiddenRef.current = true;
    setHidden(true);
    await invoke("hide_tabs");
  }, []);

  const reshow = useCallback(() => void apply(layoutRef.current), [apply]);

  /** Drop a tab's page (and restart its tool) so it loads fresh. */
  const reload = useCallback(
    async (tab: Tab, restartTool = false) => {
      if (tab.kind === "native") return;
      if (restartTool && tab.kind === "local") {
        await invoke("restart_service", { id: tab.service });
      }
      await invoke("close_tab", { id: tab.id });
      setStatus(tab.id, { state: "idle" });
      if (layoutRef.current.panes.includes(tab.id)) await apply(layoutRef.current);
    },
    [apply, setStatus],
  );

  return { layout, update, statuses, hidden, bodies, hideAll, reshow, reload };
}
