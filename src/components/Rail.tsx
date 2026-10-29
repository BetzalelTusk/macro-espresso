import { Command } from "lucide-react";
import type { Tab, TabStatus } from "../tabs";
import "./rail.css";

type Props = {
  tabs: Tab[];
  activeId: string;
  statuses: Record<string, TabStatus>;
  onSelect: (tab: Tab) => void;
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

export function Rail({ tabs, activeId, statuses, onSelect, onPalette }: Props) {
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
                aria-label={`${tab.name}${statusLabel(statuses[tab.id])}`}
                title={shortcut ? `${tab.name}  ·  ${shortcut}` : tab.name}
                onClick={() => onSelect(tab)}
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
        className="rail-tab rail-palette"
        aria-label="Command palette"
        title="Command palette  ·  Ctrl+K"
        onClick={onPalette}
      >
        <Command size={18} strokeWidth={1.6} aria-hidden="true" />
      </button>
    </nav>
  );
}
