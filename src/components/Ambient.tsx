import type { ReactNode } from "react";
import "./ambient.css";

const TICK_COLUMNS = 14;
const TICK_ROWS = 7;

type Props = {
  /** Sweep the tick field: only while something is actually loading. */
  busy?: boolean;
  /** Freeze all motion, e.g. while a tab webview covers this layer. */
  paused?: boolean;
  /** Tint the crosshairs for a failure state. */
  tone?: "neutral" | "error";
  children?: ReactNode;
};

/**
 * The shell's in-between surface: drifting light, grain and a framed centre.
 * It shows while a tab loads, while a tool starts, on errors and on empty tabs,
 * and sits under every tab webview so a reveal never flashes white.
 */
export function Ambient({ busy = false, paused = false, tone = "neutral", children }: Props) {
  return (
    <div className="ambient" data-paused={paused || undefined} data-tone={tone}>
      <div className="ambient-light" aria-hidden="true">
        <span className="blob blob-navy" />
        <span className="blob blob-olive" />
        <span className="blob blob-umber" />
      </div>
      <div className="ambient-frame">
        <span className="mark mark-start-top" aria-hidden="true" />
        <span className="mark mark-end-top" aria-hidden="true" />
        <span className="mark mark-start-bottom" aria-hidden="true" />
        <span className="mark mark-end-bottom" aria-hidden="true" />
        {busy && (
          <div
            className="ticks"
            aria-hidden="true"
            style={{ gridTemplateColumns: `repeat(${TICK_COLUMNS}, 1fr)` }}
          >
            {Array.from({ length: TICK_COLUMNS * TICK_ROWS }, (_, i) => {
              const row = Math.floor(i / TICK_COLUMNS);
              const column = i % TICK_COLUMNS;
              // A diagonal wave: each step down-and-right starts a little later.
              return <span key={i} style={{ animationDelay: `${(row + column) * 70}ms` }} />;
            })}
          </div>
        )}
        <div className="ambient-content">{children}</div>
      </div>
    </div>
  );
}
