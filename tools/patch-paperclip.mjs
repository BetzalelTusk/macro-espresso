// Make Paperclip's "Claude subscription" browser sign-in work on Windows.
//
// Paperclip runs `claude setup-token` through a Python `pty` bridge, which only
// exists on Linux/macOS. On Windows this patch swaps in pty_bridge.py (ConPTY
// via pywinpty) from %LOCALAPPDATA%\shell-tools\pty-bridge. Idempotent: run it
// again after updating Paperclip.
//
// Usage: node patch-paperclip.mjs [path-to-shell-tools]
import fs from "node:fs";
import path from "node:path";

const tools = process.argv[2] ?? path.join(process.env.LOCALAPPDATA, "shell-tools");
const file = path.join(
  tools,
  "paperclip/node_modules/paperclipai/node_modules/@paperclipai/server/dist/services/local-ai-browser-login.js",
);
const MARK = "/* macro-espresso: windows pty bridge */";
let source = fs.readFileSync(file, "utf8");
if (source.includes(MARK)) {
  console.log("already patched:", file);
  process.exit(0);
}
const original = `child = spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE, executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });`;
if (!source.includes(original)) {
  console.error("Paperclip changed: the python3 spawn line wasn't found; patch not applied.");
  process.exit(1);
}
const windows = `${MARK}
                const bridge = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "shell-tools", "pty-bridge") : null;
                child = bridge
                    ? spawn(path.join(bridge, "venv", "Scripts", "python.exe"), ["-u", path.join(bridge, "pty_bridge.py"), executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
                    : spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE, executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });`;
fs.copyFileSync(file, `${file}.orig`);
source = source.replace(original, windows);
fs.writeFileSync(file, source);
console.log("patched:", file);
