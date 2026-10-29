import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, RotateCw } from "lucide-react";
import { Ambient } from "./components/Ambient";
import { Palette, type PaletteCommand } from "./components/Palette";
import { Rail } from "./components/Rail";
import { TABS, type Tab, type TabStatus } from "./tabs";
import "./App.css";

type Bounds = { x: number; y: number; width: number; height: number };

const LAST_TAB_KEY = "shell:last-tab";

function measure(el: HTMLElement): Bounds {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function initialTab(): Tab {
  try {
    const saved = localStorage.getItem(LAST_TAB_KEY);
    return TABS.find((t) => t.id === saved) ?? TABS[0];
  } catch {
    return TABS[0];
  }
}

function App() {
  const [active, setActive] = useState<Tab>(initialTab);
  const [statuses, setStatuses] = useState<Record<string, TabStatus>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const content = useRef<HTMLElement>(null);
  // The most recent selection wins when a slow tool start finishes late.
  const latest = useRef(active.id);
  const activeRef = useRef(active);
  activeRef.current = active;

  const setStatus = useCallback((id: string, status: TabStatus) => {
    setStatuses((s) => ({ ...s, [id]: status }));
  }, []);

  const show = useCallback(
    async (tab: Tab) => {
      latest.current = tab.id;
      setActive(tab);
      try {
        localStorage.setItem(LAST_TAB_KEY, tab.id);
      } catch {
        // Remembering the last tab is a convenience; private storage can refuse it.
      }
      if (!content.current) return;
      try {
        if (tab.kind === "native") {
          await invoke("hide_tabs");
          setStatus(tab.id, { state: "ready" });
          return;
        }
        let url = tab.url;
        if (tab.kind === "local") {
          await invoke("hide_tabs");
          setStatuses((s) =>
            s[tab.id]?.state === "ready" ? s : { ...s, [tab.id]: { state: "starting" } },
          );
          // A fresh start may hand back a one-time sign-in URL (T3 Code pairing).
          const pairing = await invoke<string | null>("ensure_service", { id: tab.service });
          if (latest.current !== tab.id) {
            // Switched away while it started: the tool runs, its tab isn't open yet.
            setStatuses((s) =>
              s[tab.id]?.state === "starting" ? { ...s, [tab.id]: { state: "idle" } } : s,
            );
            return;
          }
          if (pairing) {
            await invoke("close_tab", { id: tab.id });
            url = pairing;
          }
        }
        const visible = await invoke<boolean>("open_tab", {
          id: tab.id,
          url,
          bounds: measure(content.current),
        });
        if (latest.current !== tab.id) return;
        setStatuses((s) => ({
          ...s,
          [tab.id]: visible || s[tab.id]?.state === "ready" ? { state: "ready" } : { state: "loading" },
        }));
      } catch (e) {
        setStatus(tab.id, { state: "error", message: String(e) });
      }
    },
    [setStatus],
  );

  const reload = useCallback(
    async (tab: Tab) => {
      if (tab.kind === "native") return;
      await invoke("close_tab", { id: tab.id });
      setStatus(tab.id, { state: "idle" });
      await show(tab);
    },
    [setStatus, show],
  );

  // Open the remembered tab once the layout exists.
  useEffect(() => {
    void show(activeRef.current);
  }, [show]);

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

  const openPalette = useCallback(async () => {
    await invoke("hide_tabs");
    setPaletteOpen(true);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    void show(activeRef.current);
  }, [show]);

  // Shortcuts arrive from Rust so they work even while a website has focus.
  useEffect(() => {
    const off = listen<string>("shortcut", ({ payload }) => {
      const index = TABS.findIndex((t) => t.id === activeRef.current.id);
      if (payload === "palette") {
        void openPalette();
        return;
      }
      setPaletteOpen(false);
      if (payload.startsWith("tab-")) {
        const tab = TABS[Number(payload.slice(4)) - 1];
        if (tab) void show(tab);
      } else if (payload === "next-tab") {
        void show(TABS[(index + 1) % TABS.length]);
      } else if (payload === "previous-tab") {
        void show(TABS[(index - 1 + TABS.length) % TABS.length]);
      }
    });
    return () => {
      void off.then((f) => f());
    };
  }, [openPalette, show]);

  // Keep the active tab's webview over the content area as the window resizes.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      void invoke("set_tab_bounds", { bounds: measure(el) });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = TABS.map((tab, i) => ({
      id: `open-${tab.id}`,
      label: `Open ${tab.name}`,
      icon: tab.icon,
      hint: i < 9 ? `Ctrl ${i + 1}` : undefined,
      run: () => void show(tab),
    }));
    if (active.kind !== "native") {
      list.push({
        id: "reload",
        label: `Reload ${active.name}`,
        icon: RotateCw,
        run: () => void reload(active),
      });
    }
    if (active.kind === "web") {
      list.push({
        id: "browser",
        label: `Open ${active.name} in your browser`,
        icon: ExternalLink,
        run: () => {
          void openUrl(active.url);
          void show(active);
        },
      });
    }
    return list;
  }, [active, reload, show]);

  const status = statuses[active.id] ?? { state: "idle" };
  const covered = status.state === "ready" && active.kind !== "native" && !paletteOpen;

  return (
    <div className="shell">
      <Rail
        tabs={TABS}
        activeId={active.id}
        statuses={statuses}
        onSelect={(tab) => {
          setPaletteOpen(false);
          void show(tab);
        }}
        onPalette={() => void openPalette()}
      />
      <main className="stage" ref={content}>
        <Ambient
          busy={!paletteOpen && (status.state === "starting" || status.state === "loading")}
          paused={covered}
          tone={status.state === "error" ? "error" : "neutral"}
        >
          {!paletteOpen && <StageMessage tab={active} status={status} onRetry={() => void reload(active)} />}
        </Ambient>
        {paletteOpen && <Palette commands={commands} onClose={closePalette} />}
      </main>
      <div className="grain" aria-hidden="true" />
    </div>
  );
}

/** What the stage says while the active tab isn't on screen. */
function StageMessage({
  tab,
  status,
  onRetry,
}: {
  tab: Tab;
  status: TabStatus;
  onRetry: () => void;
}) {
  if (tab.kind === "native") {
    return (
      <div className="stage-message">
        <p className="stage-eyebrow">{tab.name}</p>
        <p className="stage-title">Not built yet</p>
        <p className="stage-detail">Your files and Google Drive will live here.</p>
      </div>
    );
  }
  switch (status.state) {
    case "starting":
      return (
        <div className="stage-message" role="status">
          <p className="stage-eyebrow">{tab.name}</p>
          <p className="stage-title">Starting</p>
        </div>
      );
    case "loading":
    case "idle":
      return (
        <div className="stage-message" role="status">
          <p className="stage-eyebrow">{tab.name}</p>
          <p className="stage-title">Loading</p>
        </div>
      );
    case "error":
      return (
        <div className="stage-message" role="alert">
          <p className="stage-eyebrow">{tab.name}</p>
          <p className="stage-title">Couldn’t open</p>
          <pre className="stage-error">{status.message}</pre>
          <button type="button" className="stage-action" onClick={onRetry}>
            <RotateCw size={14} strokeWidth={1.8} aria-hidden="true" />
            Try again
          </button>
        </div>
      );
    case "ready":
      return null;
  }
}

export default App;
