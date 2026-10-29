import { Command } from "lucide-react";
import type { Tab, TabStatus } from "../tabs";
import "./rail.css";

type Props = {
  tabs: Tab[];
  /** Pinned at the foot of the rail, outside the numbered tabs. */
  settingsTab: Tab;
  /** The focused pane's tab: gets the accent marker. */
  activeId: string;
  /** Every tab on screen (two in a split). */
  shownIds: string[];
  statuses: Record<string, TabStatus>;
  onSelect: (tab: Tab) => void;
  onMenu: (tab: Tab) => void;
  onPalette: () => void;
};

/** Which dot a tab gets. Ready web tabs get none: silence means fine. */
function dotFor(tab: Tab, status: TabStatus | undefined): string | null {
  switch (status?.state) {
    case "starting":
    case "loading":
      return "busy";
    case "error":
      return "error";
    case "ready":
      return tab.kind === "local" ? "running" : null;
    default:
      return null;
  }
}

function statusLabel(status: TabStatus | undefined): string {
  switch (status?.state) {
    case "starting":
      return " (starting)";
    case "loading":
      return " (loading)";
    case "error":
      return " (failed to open)";
    default:
      return "";
  }
}

export function Rail({ tabs, settingsTab, activeId, shownIds, statuses, onSelect, onMenu, onPalette }: Props) {
  const SettingsIcon = settingsTab.icon;
  const settingsActive = settingsTab.id === activeId;
  return (
    <nav className="rail" aria-label="Tabs">
      <div className="rail-mark" aria-hidden="true" />
      <ul className="rail-tabs">
        {tabs.map((tab, index) => {
          const Icon = tab.icon;
          const dot = dotFor(tab, statuses[tab.id]);
          const active = tab.id === activeId;
          const shortcut = index < 9 ? `Ctrl+${index + 1}` : null;
          return (
            <li key={tab.id}>
              <button
                type="button"
                className="rail-tab"
                aria-current={active ? "page" : undefined}
                data-shown={(!active && shownIds.includes(tab.id)) || undefined}
                aria-label={`${tab.name}${statusLabel(statuses[tab.id])}`}
                title={shortcut ? `${tab.name}  ·  ${shortcut}` : tab.name}
                onClick={() => onSelect(tab)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onMenu(tab);
                }}
              >
                <Icon size={20} strokeWidth={1.6} aria-hidden="true" />
                {dot && <span className="rail-dot" data-dot={dot} aria-hidden="true" />}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="rail-tab rail-settings"
        aria-current={settingsActive ? "page" : undefined}
        data-shown={(!settingsActive && shownIds.includes(settingsTab.id)) || undefined}
        aria-label={settingsTab.name}
        title={settingsTab.name}
        onClick={() => onSelect(settingsTab)}
      >
        <SettingsIcon size={18} strokeWidth={1.6} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="rail-tab"
        aria-label="Command palette"
        title="Command palette  ·  Ctrl+K"
        onClick={onPalette}
      >
        <Command size={18} strokeWidth={1.6} aria-hidden="true" />
      </button>
    </nav>
  );
}
