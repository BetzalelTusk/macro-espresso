export type Tab =
  | { id: string; name: string; icon: string; kind: "web"; url: string }
  | { id: string; name: string; icon: string; kind: "native" };

/** The sidebar's tabs, top to bottom. Web tabs each get their own webview. */
export const TABS: Tab[] = [
  { id: "macro", name: "Macro", icon: "M", kind: "web", url: "https://macro.com/app" },
  { id: "whatsapp", name: "WhatsApp", icon: "W", kind: "web", url: "https://web.whatsapp.com" },
  { id: "spotify", name: "Spotify", icon: "S", kind: "web", url: "https://open.spotify.com" },
  { id: "files", name: "Files", icon: "F", kind: "native" },
];
