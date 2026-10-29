import { Disc3, FolderClosed, LayoutGrid, Settings } from "lucide-react";
import { PaperclipIcon, T3Icon, type TabIcon, WhatsAppIcon } from "./brand-icons";

type Common = {
  id: string;
  name: string;
  icon: TabIcon;
  /**
   * The narrowest layout the site supports, in CSS px (its `min-width`). In a
   * narrower pane the shell zooms the page out to fit instead of clipping it.
   */
  minWidth?: number;
};

export type Tab =
  | (Common & { kind: "web"; url: string })
  /** A local tool: the shell starts `service` (see services.rs), then shows `url`. */
  | (Common & { kind: "local"; service: string; url: string })
  | (Common & { kind: "native" });

/**
 * Every tab, in built-in order. The person's order and which ones show live in
 * Settings (settings.ts: `visibleTabs`).
 */
export const TABS: Tab[] = [
  { id: "macro", name: "Macro", icon: LayoutGrid, kind: "web", url: "https://macro.com/app" },
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: WhatsAppIcon,
    kind: "web",
    url: "https://web.whatsapp.com",
    // Its app container has min-width: 748px and scrolls sideways below that.
    minWidth: 748,
  },
  {
    id: "spotify",
    name: "Spotify",
    icon: Disc3,
    kind: "web",
    url: "https://open.spotify.com",
    // body { min-width: 800px } in the web player.
    minWidth: 800,
  },
  {
    id: "t3",
    name: "T3 Code",
    icon: T3Icon,
    kind: "local",
    service: "t3",
    url: "http://127.0.0.1:3773",
  },
  {
    id: "paperclip",
    name: "Paperclip",
    icon: PaperclipIcon,
    kind: "local",
    service: "paperclip",
    url: "http://127.0.0.1:3100",
  },
  { id: "files", name: "Files", icon: FolderClosed, kind: "native" },
];

/** The Settings tab: native, always available, pinned at the rail's foot. */
export const SETTINGS_TAB: Tab = { id: "settings", name: "Settings", icon: Settings, kind: "native" };

/** Where a tab is in its life. Native tabs are always "ready". */
export type TabStatus =
  | { state: "idle" }
  | { state: "starting" } // a local tool is booting
  | { state: "loading" } // the page is loading, not shown yet
  | { state: "ready" }
  | { state: "error"; message: string };
