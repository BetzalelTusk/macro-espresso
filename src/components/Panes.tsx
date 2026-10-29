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
  /** What a pane shows while its tab isn't on screen. */
  renderMessage: (id: string) => ReactNode;
};

const RATIO_STEP = 0.05;

/**
 * One pane, or two side by side. Tab webviews are placed over each pane's
 * body. The headers and the divider sit outside the bodies: webviews draw
 * above the shell's UI, so anything clickable must be where no webview is.
 */
export function Panes({ layout, bodies, onFocus, onClose, onSwap, onRatio, renderMessage }: Props) {
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
                  if (!box) return;
                  const target = e.currentTarget;
                  target.setPointerCapture(e.pointerId);
                  const move = (ev: PointerEvent) => {
                    const ratio = (ev.clientX - box.left) / box.width;
                    onRatio(Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)));
                  };
                  const up = () => {
                    target.removeEventListener("pointermove", move);
                    target.removeEventListener("pointerup", up);
                  };
                  target.addEventListener("pointermove", move);
                  target.addEventListener("pointerup", up);
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
