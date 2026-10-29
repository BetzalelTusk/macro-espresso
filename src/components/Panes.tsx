import { Fragment, useRef, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { ArrowLeftRight, X } from "lucide-react";
import { MAX_RATIO, MIN_RATIO, tabById, type Layout } from "../useLayout";
import "./panes.css";

type Props = {
  layout: Layout;
  bodies: MutableRefObject<(HTMLElement | null)[]>;
  onFocus: (pane: number) => void;
  onClose: (pane: number) => void;
  onSwap: () => void;
  onRatio: (ratio: number) => void;
  /**
   * A drag on the divider starts/ends. Tab webviews are native layers above
   * this UI, so the mouse would stop reporting the moment it crossed onto
   * one; the caller hides them for the drag (a drag shield).
   */
  onDragStart: () => Promise<void>;
  onDragEnd: () => void;
  /** What a pane shows while its tab isn't on screen. */
  renderMessage: (id: string) => ReactNode;
};

const RATIO_STEP = 0.05;

/**
 * One pane, or two side by side. Tab webviews are placed over each pane's
 * body. The headers and the divider sit outside the bodies: webviews draw
 * above the shell's UI, so anything clickable must be where no webview is.
 */
export function Panes({
  layout,
  bodies,
  onFocus,
  onClose,
  onSwap,
  onRatio,
  onDragStart,
  onDragEnd,
  renderMessage,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const split = layout.panes.length > 1;
  const style = { "--split-left": `${layout.ratio}fr`, "--split-right": `${1 - layout.ratio}fr` };

  return (
    <div className="panes" ref={container} data-split={split || undefined} style={style as CSSProperties}>
      {layout.panes.map((id, index) => {
        const tab = tabById(id);
        const Icon = tab.icon;
        const focused = index === layout.focused;
        return (
          <Fragment key={`${index}-${id}`}>
            {index === 1 && (
              <div
                className="pane-divider"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize panes"
                aria-valuemin={MIN_RATIO * 100}
                aria-valuemax={MAX_RATIO * 100}
                aria-valuenow={Math.round(layout.ratio * 100)}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "ArrowLeft") onRatio(Math.max(MIN_RATIO, layout.ratio - RATIO_STEP));
                  if (e.key === "ArrowRight") onRatio(Math.min(MAX_RATIO, layout.ratio + RATIO_STEP));
                }}
                onPointerDown={(e) => {
                  const box = container.current?.getBoundingClientRect();
                  if (!box || e.button !== 0) return;
                  e.preventDefault();
                  // Pointer capture doesn't hold inside this embedded webview,
                  // so follow the mouse on the whole window. The drag shield
                  // (onDragStart) takes the tab webviews out of its way.
                  void onDragStart();
                  // While dragging, move the split by writing the grid's CSS
                  // variables once per frame; React state (and the webview
                  // resize it triggers) updates once, on release.
                  const grid = container.current;
                  let ratio = layout.ratio;
                  let frame = 0;
                  const paint = () => {
                    frame = 0;
                    grid?.style.setProperty("--split-left", `${ratio}fr`);
                    grid?.style.setProperty("--split-right", `${1 - ratio}fr`);
                  };
                  const move = (ev: PointerEvent) => {
                    ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, (ev.clientX - box.left) / box.width));
                    if (!frame) frame = requestAnimationFrame(paint);
                  };
                  let ended = false;
                  const end = () => {
                    if (ended) return;
                    ended = true;
                    window.removeEventListener("pointermove", move);
                    window.removeEventListener("pointerup", end);
                    window.removeEventListener("pointercancel", end);
                    if (frame) cancelAnimationFrame(frame);
                    paint();
                    onRatio(ratio);
                    onDragEnd();
                  };
                  // Not `blur`: the drag shield moves focus to this webview,
                  // which fires a blur that would end the drag at once.
                  window.addEventListener("pointermove", move);
                  window.addEventListener("pointerup", end);
                  window.addEventListener("pointercancel", end);
                }}
              />
            )}
            <section className="pane" data-focused={(split && focused) || undefined} aria-label={tab.name}>
              {split && (
                <header className="pane-header" onMouseDown={() => onFocus(index)}>
                  <Icon size={14} strokeWidth={1.7} aria-hidden="true" />
                  <span className="pane-title">{tab.name}</span>
                  {index === 0 && (
                    <button
                      type="button"
                      className="pane-button"
                      aria-label="Swap sides"
                      title="Swap sides"
                      onClick={onSwap}
                    >
                      <ArrowLeftRight size={14} strokeWidth={1.7} aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    className="pane-button"
                    aria-label={`Close ${tab.name} pane`}
                    title="Close pane  ·  Ctrl+\"
                    onClick={() => onClose(index)}
                  >
                    <X size={14} strokeWidth={1.7} aria-hidden="true" />
                  </button>
                </header>
              )}
              <div
                className="pane-body"
                ref={(el) => {
                  bodies.current[index] = el;
                }}
              >
                {renderMessage(id)}
              </div>
            </section>
          </Fragment>
        );
      })}
    </div>
  );
}
