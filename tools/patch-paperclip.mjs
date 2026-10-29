// Windows fixes for Paperclip, applied to its installed files. Idempotent: run
// it again after updating Paperclip.
//
// 1. Claude subscription sign-in: Paperclip runs `claude setup-token` through a
//    Python `pty` bridge that only exists on Linux/macOS. On Windows it uses
//    pty_bridge.py (ConPTY via pywinpty) from %LOCALAPPDATA%\shell-tools\pty-bridge.
// 2. Native ARM64 Node: embedded-postgres has no Windows ARM64 build and refuses
//    to start there. Its x64 PostgreSQL runs fine under Windows' emulation, so
//    ARM64 uses it; the server itself then runs natively (much faster).
//
// Usage: node patch-paperclip.mjs [path-to-shell-tools]
import fs from "node:fs";
import path from "node:path";

const tools = process.argv[2] ?? path.join(process.env.LOCALAPPDATA, "shell-tools");
const modules = path.join(tools, "paperclip/node_modules");
const MARK = "/* macro-espresso:";

const patches = [
  {
    name: "windows pty bridge",
    file: path.join(modules, "paperclipai/node_modules/@paperclipai/server/dist/services/local-ai-browser-login.js"),
    find: `child = spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE, executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });`,
    replace: `${MARK} windows pty bridge */
                const bridge = process.platform === "win32" ? path.join(process.env.LOCALAPPDATA ?? "", "shell-tools", "pty-bridge") : null;
                child = bridge
                    ? spawn(path.join(bridge, "venv", "Scripts", "python.exe"), ["-u", path.join(bridge, "pty_bridge.py"), executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true })
                    : spawn("python3", ["-u", "-c", PYTHON_PTY_BRIDGE, executable, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });`,
  },
  {
    name: "postgres on windows arm64",
    file: path.join(modules, "embedded-postgres/dist/binary.js"),
    find: `                case 'x64':
                    return import('@embedded-postgres/windows-x64');`,
    replace: `                ${MARK} postgres on windows arm64 (x64 build, emulated) */
                case 'arm64':
                case 'x64':
                    return import('@embedded-postgres/windows-x64');`,
  },
];

let failed = false;
for (const patch of patches) {
  let source = fs.readFileSync(patch.file, "utf8");
  if (source.includes(`${MARK} ${patch.name}`)) {
    console.log(`already patched: ${patch.name}`);
    continue;
  }
  if (!source.includes(patch.find)) {
    console.error(`Paperclip changed, not patched: ${patch.name} (${patch.file})`);
    failed = true;
    continue;
  }
  if (!fs.existsSync(`${patch.file}.orig`)) fs.copyFileSync(patch.file, `${patch.file}.orig`);
  source = source.replace(patch.find, patch.replace);
  fs.writeFileSync(patch.file, source);
  console.log(`patched: ${patch.name}`);
}
process.exit(failed ? 1 : 0);
