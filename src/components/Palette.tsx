import { useEffect, useMemo, useRef, useState } from "react";
import type { TabIcon } from "../brand-icons";
import "./palette.css";

export type PaletteCommand = {
  id: string;
  label: string;
  icon: TabIcon;
  hint?: string;
  run: () => void;
};

type Props = {
  commands: PaletteCommand[];
  onClose: () => void;
};

/** Ctrl+K: every action in the shell, filtered by what you type. */
export function Palette({ commands, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return commands.filter((c) => words.every((w) => c.label.toLowerCase().includes(w)));
  }, [commands, query]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setSelected(0), [query]);

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div
      className="palette-scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Command palette">
        <input
          ref={input}
          className="palette-input"
          placeholder="Jump to a tab or run a command"
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={matches[selected] ? `palette-${matches[selected].id}` : undefined}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            else if (e.key === "ArrowDown") {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, matches.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") run(matches[selected]);
          }}
        />
        {matches.length === 0 ? (
          <p className="palette-empty">No command matches “{query}”.</p>
        ) : (
          <ul className="palette-list" id="palette-list" role="listbox">
            {matches.map((command, index) => {
              const Icon = command.icon;
              return (
                <li
                  key={command.id}
                  id={`palette-${command.id}`}
                  role="option"
                  aria-selected={index === selected}
                  className="palette-item"
                  onMouseEnter={() => setSelected(index)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    run(command);
                  }}
                >
                  <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
                  <span className="palette-label">{command.label}</span>
                  {command.hint && <kbd className="palette-hint">{command.hint}</kbd>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
