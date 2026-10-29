import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Menu, MenuItem } from "@tauri-apps/api/menu";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronRight,
  Download,
  Eye,
  EyeOff,
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileVideo,
  Folder,
  HardDrive,
  House,
  Image,
  type LucideIcon,
  Monitor,
  Music,
  RotateCw,
  Search,
  Video,
} from "lucide-react";
import "./files.css";

type Place = { name: string; path: string; kind: string };
type Entry = { name: string; path: string; dir: boolean; size: number; modified: number | null };
type Listing = { path: string; parent: string | null; entries: Entry[]; hidden: number };
type SortKey = "name" | "size" | "modified";

const ROW_HEIGHT = 32;
const OVERSCAN = 8;
const LAST_PATH_KEY = "shell:files-path";

const PLACE_ICONS: Record<string, LucideIcon> = {
  home: House,
  desktop: Monitor,
  documents: FileText,
  downloads: Download,
  pictures: Image,
  music: Music,
  videos: Video,
  drive: HardDrive,
};

const EXTENSION_ICONS: [RegExp, LucideIcon][] = [
  [/\.(png|jpe?g|gif|webp|bmp|svg|heic|ico)$/i, FileImage],
  [/\.(mp4|mov|mkv|avi|webm|wmv)$/i, FileVideo],
  [/\.(mp3|wav|flac|m4a|aac|ogg)$/i, FileAudio],
  [/\.(zip|rar|7z|tar|gz|tgz)$/i, FileArchive],
  [/\.(ts|tsx|js|jsx|rs|py|json|toml|ya?ml|css|html|md|sh|ps1|c|cpp|cs|go|java)$/i, FileCode],
  [/\.(txt|pdf|docx?|rtf|odt|csv|xlsx?|pptx?)$/i, FileText],
];

function iconFor(entry: Entry): LucideIcon {
  if (entry.dir) return Folder;
  return EXTENSION_ICONS.find(([re]) => re.test(entry.name))?.[1] ?? File;
}

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${sizeFormat.format(value)} ${units[unit]}`;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });

/** Split a Windows path into clickable breadcrumb segments. */
function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split("\\").filter(Boolean);
  return parts.map((part, i) => ({
    label: part,
    path: i === 0 ? `${part}\\` : `${parts.slice(0, i + 1).join("\\")}`,
  }));
}

function copyText(text: string) {
  const area = document.createElement("textarea");
  area.value = text;
  document.body.append(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

/** The Files tab: places on the side, one folder at a time in the list. */
export function Files() {
  const [places, setPlaces] = useState<Place[]>([]);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({ key: "name", descending: false });
  const [selected, setSelected] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const history = useRef<{ back: string[]; forward: string[] }>({ back: [], forward: [] });
  const current = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const request = useRef(0);

  const load = useCallback(
    async (path: string, how: "push" | "back" | "forward" | "replace" = "push") => {
      const mine = ++request.current;
      setLoading(true);
      try {
        const next = await invoke<Listing>("fs_list", { path, showHidden });
        if (mine !== request.current) return;
        if (how === "push" && current.current && current.current !== next.path) {
          history.current.back.push(current.current);
          history.current.forward = [];
        }
        current.current = next.path;
        setListing(next);
        setError(null);
        setFilter("");
        setSelected(0);
        list.current?.scrollTo({ top: 0 });
        try {
          localStorage.setItem(LAST_PATH_KEY, next.path);
        } catch {
          // Remembering the folder is a convenience only.
        }
      } catch (e) {
        if (mine !== request.current) return;
        setError(String(e));
        if (how === "push" && current.current) {
          history.current.back.push(current.current);
          history.current.forward = [];
        }
        current.current = path;
        setListing(null);
      } finally {
        if (mine === request.current) setLoading(false);
      }
    },
    [showHidden],
  );

  useEffect(() => {
    void invoke<Place[]>("fs_places").then((p) => {
      setPlaces(p);
      let start: string | null = null;
      try {
        start = localStorage.getItem(LAST_PATH_KEY);
      } catch {
        // Fall back to the first place.
      }
      void load(start ?? p[0]?.path ?? "C:\\", "replace");
    });
    // Load once on mount; `load` changes with showHidden, handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-list the current folder when hidden items are toggled.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    if (current.current) void load(current.current, "replace");
  }, [showHidden, load]);

  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewport(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const entries = useMemo(() => {
    if (!listing) return [];
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    const shown = listing.entries.filter((e) => words.every((w) => e.name.toLowerCase().includes(w)));
    const direction = sort.descending ? -1 : 1;
    return shown.sort((a, b) => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      let order = 0;
      if (sort.key === "size") order = a.size - b.size;
      else if (sort.key === "modified") order = (a.modified ?? 0) - (b.modified ?? 0);
      if (order === 0) order = a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
      return order * direction;
    });
  }, [listing, filter, sort]);

  const open = useCallback(
    (entry: Entry | undefined) => {
      if (!entry) return;
      if (entry.dir) void load(entry.path);
      else void invoke("fs_open", { path: entry.path }).catch((e) => setError(String(e)));
    },
    [load],
  );

  const goBack = () => {
    const previous = history.current.back.pop();
    if (!previous) return;
    if (current.current) history.current.forward.push(current.current);
    void load(previous, "back");
  };
  const goForward = () => {
    const next = history.current.forward.pop();
    if (!next) return;
    if (current.current) history.current.back.push(current.current);
    void load(next, "forward");
  };
  const goUp = () => {
    if (listing?.parent) void load(listing.parent);
  };

  const showMenu = async (entry: Entry) => {
    const menu = await Menu.new({
      items: [
        await MenuItem.new({ text: entry.dir ? "Open" : "Open with default app", action: () => open(entry) }),
        await MenuItem.new({
          text: "Show in File Explorer",
          action: () => void invoke("fs_reveal", { path: entry.path }),
        }),
        await MenuItem.new({ text: "Copy path", action: () => copyText(entry.path) }),
      ],
    });
    await menu.popup();
  };

  const scrollToRow = (index: number) => {
    const el = list.current;
    if (!el) return;
    const top = index * ROW_HEIGHT;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_HEIGHT > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_HEIGHT - el.clientHeight;
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement && !["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const next = Math.min(Math.max(selected + (e.key === "ArrowDown" ? 1 : -1), 0), entries.length - 1);
      setSelected(next);
      scrollToRow(next);
    } else if (e.key === "Enter") {
      e.preventDefault();
      open(entries[selected]);
    } else if (e.key === "Backspace" || (e.altKey && e.key === "ArrowLeft")) {
      e.preventDefault();
      if (e.altKey) goBack();
      else goUp();
    } else if (e.altKey && e.key === "ArrowRight") {
      e.preventDefault();
      goForward();
    }
  };

  const toggleSort = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, descending: !s.descending } : { key, descending: key !== "name" }));

  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const last = Math.min(entries.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const visible = entries.slice(first, last);
  const sortMark = (key: SortKey) => (sort.key === key ? (sort.descending ? " ↓" : " ↑") : "");
  const path = listing?.path ?? current.current ?? "";

  return (
    <div className="files-frame">
    <div className="files" onKeyDown={onKeyDown}>
      <nav className="files-places" aria-label="Places">
        <p className="files-heading">Places</p>
        {places.map((place) => {
          const Icon = PLACE_ICONS[place.kind] ?? Folder;
          const active = path.toLowerCase().replace(/\\$/, "") === place.path.toLowerCase().replace(/\\$/, "");
          return (
            <button
              key={place.path}
              type="button"
              className="files-place"
              aria-current={active ? "location" : undefined}
              onClick={() => void load(place.path)}
            >
              <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
              <span>{place.name}</span>
            </button>
          );
        })}
      </nav>

      <section className="files-main" aria-label="Folder">
        <header className="files-toolbar">
          <div className="files-nav">
            <button type="button" className="files-icon-button" aria-label="Back" title="Back  ·  Alt+←" onClick={goBack} disabled={history.current.back.length === 0}>
              <ArrowLeft size={16} strokeWidth={1.7} aria-hidden="true" />
            </button>
            <button type="button" className="files-icon-button" aria-label="Forward" title="Forward  ·  Alt+→" onClick={goForward} disabled={history.current.forward.length === 0}>
              <ArrowRight size={16} strokeWidth={1.7} aria-hidden="true" />
            </button>
            <button type="button" className="files-icon-button" aria-label="Up one folder" title="Up  ·  Backspace" onClick={goUp} disabled={!listing?.parent}>
              <ArrowUp size={16} strokeWidth={1.7} aria-hidden="true" />
            </button>
          </div>
          <ol className="files-crumbs" aria-label="Path">
            {crumbs(path).map((crumb, i, all) => (
              <li key={crumb.path}>
                <button
                  type="button"
                  className="files-crumb"
                  aria-current={i === all.length - 1 ? "location" : undefined}
                  onClick={() => void load(crumb.path)}
                >
                  {crumb.label}
                </button>
                {i < all.length - 1 && <ChevronRight size={14} strokeWidth={1.6} aria-hidden="true" />}
              </li>
            ))}
          </ol>
          <label className="files-filter">
            <Search size={14} strokeWidth={1.7} aria-hidden="true" />
            <input
              placeholder="Filter"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setSelected(0);
              }}
              aria-label="Filter this folder"
            />
          </label>
          <button
            type="button"
            className="files-icon-button"
            aria-label={showHidden ? "Hide hidden files" : "Show hidden files"}
            aria-pressed={showHidden}
            title={showHidden ? "Hide hidden files" : "Show hidden files"}
            onClick={() => setShowHidden((v) => !v)}
          >
            {showHidden ? <Eye size={16} strokeWidth={1.7} aria-hidden="true" /> : <EyeOff size={16} strokeWidth={1.7} aria-hidden="true" />}
          </button>
          <button
            type="button"
            className="files-icon-button"
            aria-label="Refresh"
            title="Refresh"
            onClick={() => current.current && void load(current.current, "replace")}
          >
            <RotateCw size={15} strokeWidth={1.7} aria-hidden="true" />
          </button>
        </header>

        <div className="files-columns" role="row">
          <button type="button" className="files-column files-column-name" onClick={() => toggleSort("name")}>
            Name{sortMark("name")}
          </button>
          <button type="button" className="files-column files-column-size" onClick={() => toggleSort("size")}>
            Size{sortMark("size")}
          </button>
          <button type="button" className="files-column files-column-date" onClick={() => toggleSort("modified")}>
            Modified{sortMark("modified")}
          </button>
        </div>

        <div
          className="files-list"
          ref={list}
          role="listbox"
          aria-label={`Contents of ${path}`}
          aria-activedescendant={first <= selected && selected < last ? `file-${selected}` : undefined}
          tabIndex={0}
          onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        >
          {error ? (
            <div className="files-state" role="alert">
              <p className="files-state-title">Can’t open this folder</p>
              <p className="files-state-detail">{error}</p>
              {listing === null && history.current.back.length > 0 && (
                <button type="button" className="files-state-action" onClick={goBack}>
                  Go back
                </button>
              )}
            </div>
          ) : loading && !listing ? (
            <div className="files-state" role="status">
              <p className="files-state-title">Loading</p>
            </div>
          ) : entries.length === 0 ? (
            <div className="files-state">
              <p className="files-state-title">{filter ? `Nothing matches “${filter}”` : "This folder is empty"}</p>
              {!filter && listing && listing.hidden > 0 && (
                <p className="files-state-detail">
                  {listing.hidden} hidden {listing.hidden === 1 ? "item" : "items"}.
                </p>
              )}
            </div>
          ) : (
            <div className="files-rows" style={{ height: entries.length * ROW_HEIGHT }}>
              {visible.map((entry, offset) => {
                const index = first + offset;
                const Icon = iconFor(entry);
                return (
                  <div
                    key={entry.path}
                    id={`file-${index}`}
                    role="option"
                    aria-selected={index === selected}
                    className="files-row"
                    data-dir={entry.dir || undefined}
                    style={{ transform: `translateY(${index * ROW_HEIGHT}px)` }}
                    onMouseDown={() => setSelected(index)}
                    onDoubleClick={() => open(entry)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      setSelected(index);
                      void showMenu(entry);
                    }}
                    title={entry.name}
                  >
                    <span className="files-cell files-cell-name">
                      <Icon size={16} strokeWidth={1.6} aria-hidden="true" />
                      <span className="files-name">{entry.name}</span>
                    </span>
                    <span className="files-cell files-cell-size">{entry.dir ? "" : formatSize(entry.size)}</span>
                    <span className="files-cell files-cell-date">
                      {entry.modified ? dateFormat.format(entry.modified) : ""}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <footer className="files-status">
          {listing
            ? `${entries.length} ${entries.length === 1 ? "item" : "items"}${filter ? ` matching “${filter}”` : ""}${
                listing.hidden && !showHidden ? ` · ${listing.hidden} hidden` : ""
              }`
            : ""}
          {loading && listing ? " · Loading…" : ""}
        </footer>
      </section>
    </div>
    </div>
  );
}
