"""Windows stand-in for Paperclip's Python `pty` bridge (Linux only).

Runs a command (``claude setup-token``) inside a Windows pseudo-console
(ConPTY, via pywinpty) and forwards bytes only: stdin -> terminal,
terminal -> stdout. Nothing is logged; the stream can carry a sign-in token.

Usage: python pty_bridge.py <command> [args...]
"""

import os
import shutil
import sys
import threading
import time

from winpty import PtyProcess

# Wide enough that the sign-in URL is never wrapped across lines.
COLUMNS, ROWS = 1000, 50


def main() -> int:
    argv = sys.argv[1:]
    if not argv:
        return 2
    program = shutil.which(argv[0], path=os.environ.get("PATH")) or argv[0]
    proc = PtyProcess.spawn([program, *argv[1:]], dimensions=(ROWS, COLUMNS), env=dict(os.environ))

    def forward_input() -> None:
        stdin = sys.stdin.buffer
        while True:
            data = stdin.read1(4096) if hasattr(stdin, "read1") else os.read(0, 4096)
            if not data:
                # Paperclip closed our stdin: the sign-in is over.
                proc.terminate(force=True)
                return
            proc.write(data.decode("utf-8", "replace"))

    threading.Thread(target=forward_input, daemon=True).start()
    out = sys.stdout.buffer
    while True:
        try:
            text = proc.read(4096)
        except EOFError:
            break
        if text:
            out.write(text.encode("utf-8"))
            out.flush()
        elif not proc.isalive():
            break
    deadline = time.monotonic() + 5
    while proc.isalive() and time.monotonic() < deadline:
        time.sleep(0.05)
    return proc.exitstatus or 0


if __name__ == "__main__":
    code = main()
    sys.stdout.flush()
    # Leave without Python's normal shutdown: pywinpty's teardown crashes
    # (0xC0000005) after the child exits, and Paperclip reads that exit code
    # as a failed sign-in even when the token was delivered.
    os._exit(code)
