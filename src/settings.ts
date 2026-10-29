import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TABS, type Tab } from "./tabs";

/** How the person wants Macro Espresso to behave. Kept in the UI's storage. */
export type Settings = {
  /** Tabs left out of the rail, palette and shortcuts. */
  hiddenTabs: string[];
  /** Rail order by tab id; tabs missing here keep their built-in place. */
  order: string[];
  /** Start local tools and load every tab out of sight after launch. */
  warmUp: boolean;
  /** Closing the window hides it to the tray instead of quitting. */
  closeToTray: boolean;
};

const KEY = "shell:settings";

const DEFAULTS: Settings = {
  // Macro is parked for now; it comes back with a switch in Settings.
  hiddenTabs: ["macro"],
  order: [],
  warmUp: true,
  closeToTray: true,
};

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Settings> | null;
    return { ...DEFAULTS, ...raw };
  } catch {
    // Unreadable settings just mean the defaults.
    return DEFAULTS;
  }
}

/** Every tab in the person's order. */
export function orderedTabs(settings: Settings): Tab[] {
  const rank = (tab: Tab) => {
    const at = settings.order.indexOf(tab.id);
    return at >= 0 ? at : settings.order.length + TABS.indexOf(tab);
  };
  return [...TABS].sort((a, b) => rank(a) - rank(b));
}

/** The tabs in the rail, top to bottom; Ctrl+1..9 follow this order. */
export function visibleTabs(settings: Settings): Tab[] {
  const shown = orderedTabs(settings).filter((tab) => !settings.hiddenTabs.includes(tab.id));
  // Never an empty rail: the last tab can't be hidden (the UI stops it too).
  return shown.length > 0 ? shown : [orderedTabs(settings)[0]];
}

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(loadSettings);

  const update = useCallback((change: Partial<Settings>) => {
    setSettings((current) => ({ ...current, ...change }));
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      // Private storage can refuse; the settings still apply for this run.
    }
  }, [settings]);

  // Rust owns the window's close behaviour; keep it in step.
  useEffect(() => {
    void invoke("set_close_to_tray", { enabled: settings.closeToTray });
  }, [settings.closeToTray]);

  return { settings, update };
}
