export type Tab =
  | { id: string; name: string; icon: string; kind: "web"; url: string }
  /** A local tool: the shell starts `service` (see services.rs), then shows `url`. */
  | { id: string; name: string; icon: string; kind: "local"; service: string; url: string }
  | { id: string; name: string; icon: string; kind: "native" };

/** The sidebar's tabs, top to bottom. Web and local tabs each get their own webview. */
export const TABS: Tab[] = [
  { id: "macro", name: "Macro", icon: "M", kind: "web", url: "https://macro.com/app" },
  { id: "whatsapp", name: "WhatsApp", icon: "W", kind: "web", url: "https://web.whatsapp.com" },
  { id: "spotify", name: "Spotify", icon: "S", kind: "web", url: "https://open.spotify.com" },
  { id: "t3", name: "T3 Code", icon: "T3", kind: "local", service: "t3", url: "http://127.0.0.1:3773" },
  {
    id: "paperclip",
    name: "Paperclip",
    icon: "P",
    kind: "local",
    service: "paperclip",
    url: "http://127.0.0.1:3100",
  },
  { id: "files", name: "Files", icon: "F", kind: "native" },
];
