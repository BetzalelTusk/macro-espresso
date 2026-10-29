import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";
import { ChevronDown, ChevronUp } from "lucide-react";
import { orderedTabs, type Settings } from "../settings";
import "./settings.css";

type Props = {
  settings: Settings;
  onChange: (change: Partial<Settings>) => void;
};

/** A labelled on/off switch: the whole row is the control. */
function Toggle({
  label,
  detail,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="settings-row settings-toggle" data-disabled={disabled || undefined}>
      <span className="settings-text">
        <span className="settings-label">{label}</span>
        {detail && <span className="settings-detail">{detail}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="settings-switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
    </label>
  );
}

/** Settings: how Macro Espresso looks and behaves, saved as you change it. */
export function SettingsView({ settings, onChange }: Props) {
  const tabs = orderedTabs(settings);
  const shownCount = tabs.filter((t) => !settings.hiddenTabs.includes(t.id)).length;
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartError, setAutostartError] = useState<string | null>(null);
  const [version, setVersion] = useState("");

  useEffect(() => {
    isEnabled().then(setAutostart, () => setAutostart(false));
    getVersion().then(setVersion, () => {});
  }, []);

  const move = (id: string, step: -1 | 1) => {
    const order = tabs.map((t) => t.id);
    const at = order.indexOf(id);
    const to = at + step;
    if (to < 0 || to >= order.length) return;
    [order[at], order[to]] = [order[to], order[at]];
    onChange({ order });
  };

  const setShown = (id: string, shown: boolean) => {
    const hiddenTabs = shown
      ? settings.hiddenTabs.filter((h) => h !== id)
      : [...settings.hiddenTabs, id];
    onChange({ hiddenTabs });
  };

  const setLaunchAtLogin = async (on: boolean) => {
    setAutostartError(null);
    try {
      await (on ? enable() : disable());
      setAutostart(await isEnabled());
    } catch (e) {
      setAutostartError(String(e));
    }
  };

  return (
    <div className="settings-frame">
      <div className="settings">
        <header className="settings-header">
          <h1 className="settings-title">Settings</h1>
          <p className="settings-lede">Changes apply right away.</p>
        </header>

        <section className="settings-section" aria-labelledby="settings-tabs">
          <h2 id="settings-tabs" className="settings-heading">
            Tabs
          </h2>
          <p className="settings-note">
            Pick the tabs in the sidebar and their order. Ctrl+1–9 follow this order.
          </p>
          <ul className="settings-list">
            {tabs.map((tab, index) => {
              const Icon = tab.icon;
              const shown = !settings.hiddenTabs.includes(tab.id);
              const lastShown = shown && shownCount === 1;
              return (
                <li key={tab.id} className="settings-row settings-tab" data-hidden={!shown || undefined}>
                  <span className="settings-tab-icon" aria-hidden="true">
                    <Icon size={18} strokeWidth={1.6} />
                  </span>
                  <span className="settings-text">
                    <span className="settings-label">{tab.name}</span>
                    {lastShown && <span className="settings-detail">At least one tab stays in the sidebar.</span>}
                  </span>
                  <span className="settings-order">
                    <button
                      type="button"
                      className="settings-icon-button"
                      aria-label={`Move ${tab.name} up`}
                      disabled={index === 0}
                      onClick={() => move(tab.id, -1)}
                    >
                      <ChevronUp size={16} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="settings-icon-button"
                      aria-label={`Move ${tab.name} down`}
                      disabled={index === tabs.length - 1}
                      onClick={() => move(tab.id, 1)}
                    >
                      <ChevronDown size={16} strokeWidth={1.8} aria-hidden="true" />
                    </button>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    className="settings-switch"
                    aria-label={`Show ${tab.name} in the sidebar`}
                    checked={shown}
                    disabled={lastShown}
                    onChange={(e) => setShown(tab.id, e.target.checked)}
                  />
                </li>
              );
            })}
          </ul>
        </section>

        <section className="settings-section" aria-labelledby="settings-startup">
          <h2 id="settings-startup" className="settings-heading">
            Startup
          </h2>
          <div className="settings-list">
            <Toggle
              label="Open when you sign in to Windows"
              detail="Starts in the tray, so your tabs are ready before you open it."
              checked={autostart ?? false}
              disabled={autostart === null}
              onChange={(on) => void setLaunchAtLogin(on)}
            />
            {autostartError && (
              <p className="settings-error" role="alert">
                Couldn’t change this: {autostartError}
              </p>
            )}
            <Toggle
              label="Get tabs ready in the background"
              detail="After launch, starts T3 Code and Paperclip and loads every tab, so each opens instantly. Uses more memory. Takes effect next launch."
              checked={settings.warmUp}
              onChange={(warmUp) => onChange({ warmUp })}
            />
          </div>
        </section>

        <section className="settings-section" aria-labelledby="settings-window">
          <h2 id="settings-window" className="settings-heading">
            Window
          </h2>
          <div className="settings-list">
            <Toggle
              label="Keep running in the tray when closed"
              detail="Notifications and music keep going. Quit from the tray icon or with Ctrl+Q."
              checked={settings.closeToTray}
              onChange={(closeToTray) => onChange({ closeToTray })}
            />
          </div>
        </section>

        <footer className="settings-footer">Macro Espresso{version && ` ${version}`}</footer>
      </div>
    </div>
  );
}
