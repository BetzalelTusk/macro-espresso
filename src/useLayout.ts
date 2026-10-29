import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { TABS, type Tab, type TabStatus } from "./tabs";

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

export const tabById = (id: string): Tab => TABS.find((t) => t.id === id) ?? TABS[0];

function savedLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? "null") as Layout | null;
    const panes = (raw?.panes ?? []).filter((id) => TABS.some((t) => t.id === id)).slice(0, 2);
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
  return { panes: [TABS[0].id], focused: 0, ratio: 0.5 };
}

type Bounds = { x: number; y: number; width: number; height: number };

function measure(el: HTMLElement): Bounds {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
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
export function useLayout() {
  const [layout, setLayout] = useState<Layout>(savedLayout);
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

      // Start local tools first; a fresh start may hand back a sign-in URL.
      await Promise.all(
        tabs.map(async (tab) => {
          if (tab.kind !== "local") return;
          urls[tab.id] = tab.url;
          if (statusesRef.current[tab.id]?.state !== "ready") {
            setStatus(tab.id, { state: "starting" });
          }
          try {
            const pairing = await invoke<string | null>("ensure_service", { id: tab.service });
            if (pairing) {
              await invoke("close_tab", { id: tab.id });
              urls[tab.id] = pairing;
            }
          } catch (e) {
            setStatus(tab.id, { state: "error", message: String(e) });
          }
        }),
      );
      if (mine !== generation.current) {
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

      const views = next.panes.flatMap((id, i) => {
        const tab = tabById(id);
        const el = bodies.current[i];
        if (tab.kind === "native" || !el) return [];
        if (statusesRef.current[id]?.state === "error") return [];
        const bounds = measure(el);
        return [{ id, url: urls[id] ?? tab.url, bounds, zoom: fitZoom(tab, bounds.width) }];
      });
      try {
        const showing = await invoke<string[]>("show_tabs", {
          views,
          focus: next.panes[next.focused],
        });
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
    [setStatus],
  );

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
  useEffect(() => {
    const observer = new ResizeObserver(() => {
      // Hidden tabs (palette, divider drag) get their bounds when re-shown.
      if (hiddenRef.current) return;
      void invoke("set_tab_bounds", { placements: placements() });
    });
    for (const el of bodies.current.slice(0, layout.panes.length)) {
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [layout.panes.length, placements]);

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
