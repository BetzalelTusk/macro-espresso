import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TABS, type Tab } from "./tabs";
import "./App.css";

type Bounds = { x: number; y: number; width: number; height: number };

function measure(el: HTMLElement): Bounds {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

function App() {
  const [active, setActive] = useState<Tab>(TABS[0]);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState<string | null>(null);
  const content = useRef<HTMLElement>(null);
  // The most recent click wins if a slow tool start finishes after another click.
  const latest = useRef<string>("");

  const show = useCallback(async (tab: Tab) => {
    latest.current = tab.id;
    setActive(tab);
    setError(null);
    setStarting(null);
    if (!content.current) return;
    try {
      if (tab.kind === "native") {
        await invoke("hide_tabs");
        return;
      }
      let url = tab.url;
      if (tab.kind === "local") {
        await invoke("hide_tabs");
        setStarting(tab.name);
        // A fresh start may hand back a one-time sign-in URL (T3 Code pairing).
        const pairing = await invoke<string | null>("ensure_service", { id: tab.service });
        if (latest.current !== tab.id) return;
        setStarting(null);
        if (pairing) {
          // Drop the old webview so the tab opens through the new sign-in URL.
          await invoke("close_tab", { id: tab.id });
          url = pairing;
        }
      }
      await invoke("open_tab", { id: tab.id, url, bounds: measure(content.current) });
    } catch (e) {
      if (latest.current !== tab.id) return;
      setStarting(null);
      setError(String(e));
    }
  }, []);

  // Open the first tab once the layout exists.
  useEffect(() => {
    void show(TABS[0]);
  }, [show]);

  // Keep the active tab's webview over the content area as the window resizes.
  useEffect(() => {
    const el = content.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      invoke("set_tab_bounds", { bounds: measure(el) }).catch((e) => setError(String(e)));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="shell">
      <nav className="sidebar">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            className={tab.id === active.id ? "tab active" : "tab"}
            title={tab.name}
            onClick={() => void show(tab)}
          >
            {tab.icon}
          </button>
        ))}
      </nav>
      <main className="content" ref={content}>
        {error && <p className="error">{error}</p>}
        {starting && (
          <div className="placeholder">
            <p>Starting {starting}…</p>
          </div>
        )}
        {active.kind === "native" && (
          <div className="placeholder">
            <h1>{active.name}</h1>
            <p>Native {active.name.toLowerCase()} view goes here.</p>
          </div>
        )}
      </main>
    </div>
  );
}

export default App;
