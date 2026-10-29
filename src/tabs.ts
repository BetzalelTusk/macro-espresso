import {
  Disc3,
  FolderClosed,
  LayoutGrid,
  type LucideIcon,
  MessageCircle,
  Paperclip,
  SquareTerminal,
} from "lucide-react";

type Common = { id: string; name: string; icon: LucideIcon };

export type Tab =
  | (Common & { kind: "web"; url: string })
  /** A local tool: the shell starts `service` (see services.rs), then shows `url`. */
  | (Common & { kind: "local"; service: string; url: string })
  | (Common & { kind: "native" });

/** The rail's tabs, top to bottom. Ctrl+1..9 follow this order. */
export const TABS: Tab[] = [
  { id: "macro", name: "Macro", icon: LayoutGrid, kind: "web", url: "https://macro.com/app" },
  {
    id: "whatsapp",
    name: "WhatsApp",
    icon: MessageCircle,
    kind: "web",
    url: "https://web.whatsapp.com",
  },
  { id: "spotify", name: "Spotify", icon: Disc3, kind: "web", url: "https://open.spotify.com" },
  {
    id: "t3",
    name: "T3 Code",
    icon: SquareTerminal,
    kind: "local",
    service: "t3",
    url: "http://127.0.0.1:3773",
  },
  {
    id: "paperclip",
    name: "Paperclip",
    icon: Paperclip,
    kind: "local",
    service: "paperclip",
    url: "http://127.0.0.1:3100",
  },
  { id: "files", name: "Files", icon: FolderClosed, kind: "native" },
];

/** Where a tab is in its life. Native tabs are always "ready". */
export type TabStatus =
  | { state: "idle" }
  | { state: "starting" } // a local tool is booting
  | { state: "loading" } // the page is loading, not shown yet
  | { state: "ready" }
  | { state: "error"; message: string };
