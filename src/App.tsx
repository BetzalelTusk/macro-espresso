import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Menu, MenuItem, PredefinedMenuItem } from "@tauri-apps/api/menu";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ArrowLeftRight,
  Columns2,
  ExternalLink,
  FileText,
  Power,
  RotateCw,
  SquareX,
} from "lucide-react";
import { Ambient } from "./components/Ambient";
import { Files } from "./components/Files";
import { Palette, type PaletteCommand } from "./components/Palette";
import { Panes } from "./components/Panes";
import { Rail } from "./components/Rail";
import { TABS, type Tab, type TabStatus } from "./tabs";
import { tabById, useLayout, type Layout } from "./useLayout";
import "./App.css";

/** Show `tab` in the focused pane, or focus the pane already showing it. */
function select(layout: Layout, tab: Tab): Layout {
  const existing = layout.panes.indexOf(tab.id);
  if (existing >= 0) return { ...layout, focused: existing };
  const panes = [...layout.panes];
  panes[layout.focused] = tab.id;
  return { ...layout, panes };
}

/** Show `tab` beside the focused pane (replacing the other side if split). */
function openInSplit(layout: Layout, tab: Tab): Layout {
  const existing = layout.panes.indexOf(tab.id);
  if (existing >= 0) return { ...layout, focused: existing };
  if (layout.panes.length === 1) return { ...layout, panes: [layout.panes[0], tab.id], focused: 1 };
  const other = 1 - layout.focused;
  const panes = [...layout.panes];
  panes[other] = tab.id;
  return { ...layout, panes, focused: other };
}

function closePane(layout: Layout, pane: number): Layout {
  if (layout.panes.length < 2) return layout;
  return { ...layout, panes: layout.panes.filter((_, i) => i !== pane), focused: 0 };
}

function swap(layout: Layout): Layout {
  if (layout.panes.length < 2) return layout;
  return {
    ...layout,
    panes: [layout.panes[1], layout.panes[0]],
    focused: 1 - layout.focused,
    ratio: 1 - layout.ratio,
  };
}

/** Ctrl+\: close the split, or open one with the next tab not on screen. */
function toggleSplit(layout: Layout): Layout {
  if (layout.panes.length > 1) return closePane(layout, 1 - layout.focused);
  const start = TABS.findIndex((t) => t.id === layout.panes[0]);
  const next = TABS[(start + 1) % TABS.length];
  return openInSplit(layout, next);
}

function cycle(layout: Layout, step: number): Layout {
  const current = TABS.findIndex((t) => t.id === layout.panes[layout.focused]);
  for (let i = 1; i <= TABS.length; i++) {
    const tab = TABS[(current + step * i + TABS.length * i) % TABS.length];
    if (!layout.panes.includes(tab.id)) return select(layout, tab);
  }
  return layout;
}

function App() {
  const { layout, update, statuses, hidden, bodies, hideAll, reshow, reload } = useLayout();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const focusedTab = tabById(layout.panes[layout.focused]);
  const paletteRef = useRef(paletteOpen);
  paletteRef.current = paletteOpen;

  const change = useCallback(
    (fn: (l: Layout) => Layout) => {
      setPaletteOpen(false);
      update(fn);
      // Same panes and focus don't re-apply on their own; bring tabs back.
      if (paletteRef.current) reshow();
    },
    [reshow, update],
  );

  const openPalette = useCallback(async () => {
    await hideAll();
    setPaletteOpen(true);
  }, [hideAll]);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    reshow();
  }, [reshow]);

  const quit = useCallback(() => void invoke("quit"), []);

  const tabActions = useCallback(
    (tab: Tab) => {
      const actions: { id: string; label: string; icon: PaletteCommand["icon"]; run: () => void }[] = [];
      if (tab.kind !== "native") {
        actions.push({
          id: `reload-${tab.id}`,
          label: `Reload ${tab.name}`,
          icon: RotateCw,
          run: () => void reload(tab),
        });
      }
      if (tab.kind === "web") {
        actions.push({
          id: `browser-${tab.id}`,
          label: `Open ${tab.name} in your browser`,
          icon: ExternalLink,
          run: () => void openUrl(tab.url),
        });
      }
      if (tab.kind === "local") {
        actions.push(
          {
            id: `restart-${tab.id}`,
            label: `Restart ${tab.name}`,
            icon: Power,
            run: () => void reload(tab, true),
          },
          {
            id: `log-${tab.id}`,
            label: `Show ${tab.name} log`,
            icon: FileText,
            run: () => void invoke("reveal_log", { id: tab.service }).catch(() => {}),
          },
        );
      }
      return actions;
    },
    [reload],
  );

  // Right-click on a rail tab: a native menu, so it draws above websites.
  const showTabMenu = useCallback(
    async (tab: Tab) => {
      const shown = layout.panes.includes(tab.id);
      const items: (MenuItem | PredefinedMenuItem)[] = [
        await MenuItem.new({ text: `Open ${tab.name}`, action: () => change((l) => select(l, tab)) }),
        await MenuItem.new({
          text: "Open in split",
          enabled: !shown,
          action: () => change((l) => openInSplit(l, tab)),
        }),
      ];
      const actions = tabActions(tab);
      if (actions.length > 0) items.push(await PredefinedMenuItem.new({ item: "Separator" }));
      for (const action of actions) {
        items.push(await MenuItem.new({ text: action.label.replace(` ${tab.name}`, ""), action: action.run }));
      }
      const menu = await Menu.new({ items });
      await menu.popup();
    },
    [change, layout.panes, tabActions],
  );

  // Shortcuts arrive from Rust so they work even while a website has focus.
  useEffect(() => {
    const off = listen<string>("shortcut", ({ payload }) => {
      if (payload === "palette") {
        if (paletteRef.current) closePalette();
        else void openPalette();
      } else if (payload === "quit") {
        quit();
      } else if (payload === "toggle-split") {
        change(toggleSplit);
      } else if (payload === "next-tab") {
        change((l) => cycle(l, 1));
      } else if (payload === "previous-tab") {
        change((l) => cycle(l, -1));
      } else if (payload.startsWith("tab-")) {
        const tab = TABS[Number(payload.slice(4)) - 1];
        if (tab) change((l) => select(l, tab));
      }
    });
    return () => {
      void off.then((f) => f());
    };
  }, [change, closePalette, openPalette, quit]);

  const commands = useMemo<PaletteCommand[]>(() => {
    const list: PaletteCommand[] = TABS.map((tab, i) => ({
      id: `open-${tab.id}`,
      label: `Open ${tab.name}`,
      icon: tab.icon,
      hint: i < 9 ? `Ctrl ${i + 1}` : undefined,
      run: () => change((l) => select(l, tab)),
    }));
    for (const tab of TABS) {
      if (!layout.panes.includes(tab.id)) {
        list.push({
          id: `split-${tab.id}`,
          label: `Open ${tab.name} in split`,
          icon: Columns2,
          run: () => change((l) => openInSplit(l, tab)),
        });
      }
    }
    if (layout.panes.length > 1) {
      list.push(
        { id: "close-split", label: "Close split", icon: SquareX, hint: "Ctrl \\", run: () => change(toggleSplit) },
        { id: "swap", label: "Swap sides", icon: ArrowLeftRight, run: () => change(swap) },
      );
    }
    for (const action of tabActions(focusedTab)) list.push({ ...action });
    list.push({ id: "quit", label: "Quit Shell", icon: Power, hint: "Ctrl Q", run: quit });
    return list;
  }, [change, focusedTab, layout.panes, quit, tabActions]);

  const paneStatus = (id: string): TabStatus => statuses[id] ?? { state: "idle" };
  const busy = layout.panes.some((id) => ["starting", "loading"].includes(paneStatus(id).state));
  const covered =
    !hidden &&
    !paletteOpen &&
    layout.panes.every((id) => tabById(id).kind !== "native" && paneStatus(id).state === "ready");
  const failed = layout.panes.some((id) => paneStatus(id).state === "error");

  return (
    <div className="shell">
      <Rail
        tabs={TABS}
        activeId={focusedTab.id}
        shownIds={layout.panes}
        statuses={statuses}
        onSelect={(tab) => change((l) => select(l, tab))}
        onMenu={(tab) => void showTabMenu(tab)}
        onPalette={() => void openPalette()}
      />
      <main className="stage">
        <Ambient
          busy={busy && !paletteOpen}
          paused={covered}
          framed={layout.panes.length === 1}
          tone={failed ? "error" : "neutral"}
        />
        <Panes
          layout={layout}
          bodies={bodies}
          onFocus={(pane) => change((l) => ({ ...l, focused: pane }))}
          onClose={(pane) => change((l) => closePane(l, pane))}
          onSwap={() => change(swap)}
          onRatio={(ratio) => update((l) => ({ ...l, ratio }))}
          onDragStart={hideAll}
          onDragEnd={reshow}
          renderMessage={(id) =>
            id === "files" ? (
              // Native view: stays mounted (folder, scroll) even under the palette.
              <Files />
            ) : paletteOpen ? null : (
              <StageMessage tab={tabById(id)} status={paneStatus(id)} onRetry={() => void reload(tabById(id))} />
            )
          }
        />
        {paletteOpen && <Palette commands={commands} onClose={closePalette} />}
      </main>
    </div>
  );
}

/** What a pane says while its tab isn't on screen. */
function StageMessage({
  tab,
  status,
  onRetry,
}: {
  tab: Tab;
  status: TabStatus;
  onRetry: () => void;
}) {
  if (tab.kind === "native") return null;
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
