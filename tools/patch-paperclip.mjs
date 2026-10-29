// Windows fixes for Paperclip, applied to its installed files. Idempotent: run
// it again after updating Paperclip.
//
// 1. Claude subscription sign-in: Paperclip runs `claude setup-token` through a
//    Python `pty` bridge that only exists on Linux/macOS. On Windows it uses
//    pty_bridge.py (ConPTY via pywinpty) from %LOCALAPPDATA%\shell-tools\pty-bridge.
// 2. A 15-minute sign-in window instead of 5, and the saved login readable on
//    Windows (its checks wanted a Unix owner and mode 600).
// 3. Native ARM64 Node: embedded-postgres has no Windows ARM64 build and refuses
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
    // 5 minutes was too short to get through the provider's browser check and
    // copy the code back; the attempt itself stays valid for 30 minutes.
    name: "15 minute sign-in window",
    file: path.join(modules, "paperclipai/node_modules/@paperclipai/server/dist/services/local-ai-browser-login.js"),
    find: "timeoutMs: 300_000, signal: controller.signal,",
    replace: `timeoutMs: 900_000 ${MARK} 15 minute sign-in window */, signal: controller.signal,`,
    all: true,
  },
  {
    // The saved login must be owned by this Unix uid with mode 600. Windows has
    // neither (no getuid; modes read as 666), so every login was refused with
    // "Could not verify the local subscription". On Windows the user profile's
    // ACLs protect the file; keep the file-type and size checks.
    name: "credential file checks on windows",
    file: path.join(modules, "paperclipai/node_modules/@paperclipai/server/dist/services/local-ai-credential-file.js"),
    find: "if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > MAX_CREDENTIAL_BYTES) {",
    replace: `${MARK} credential file checks on windows */
        const unixOwnerAndMode = process.platform === "win32" || (stat.uid === process.getuid?.() && (stat.mode & 0o777) === 0o600);
        if (!stat.isFile() || !unixOwnerAndMode || stat.size > MAX_CREDENTIAL_BYTES) {`,
  },
  {
    // Its "confined open" exists only for Linux and macOS and refuses
    // everywhere else, so the saved login could never be read on Windows.
    // Windows: refuse a symlink or junction (what confinement guards against),
    // then open the file itself.
    name: "credential file open on windows",
    file: path.join(modules, "paperclipai/node_modules/@paperclipai/server/dist/services/local-ai-credential-file.js"),
    find: "    const file = await openRunnerApiWorkspaceFile(filename);",
    replace: `    ${MARK} credential file open on windows */
    const file = process.platform === "win32"
        ? await (async () => {
            const { lstat, open } = await import("node:fs/promises");
            if ((await lstat(filename)).isSymbolicLink())
                throw new Error("Invalid credential file");
            return open(filename, "r");
        })()
        : await openRunnerApiWorkspaceFile(filename);`,
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
  source = patch.all ? source.replaceAll(patch.find, patch.replace) : source.replace(patch.find, patch.replace);
  fs.writeFileSync(patch.file, source);
  console.log(`patched: ${patch.name}`);
}
process.exit(failed ? 1 : 0);
