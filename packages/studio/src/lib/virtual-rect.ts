import type { Rect, Virtualizer } from "@tanstack/react-virtual";
import { observeElementRect } from "@tanstack/react-virtual";

/**
 * A react-virtual `observeElementRect` that floors a zero-height viewport to
 * `fallbackHeight`. In a real browser the scroll container always has its CSS
 * height, so this is a no-op there; under jsdom (which measures every box as a
 * 0×0 rect) it gives the virtualizer a real viewport to compute a visible range
 * from, so a bounded, deterministic set of rows mounts in tests instead of zero.
 *
 * Shared by every virtualized list (logs table, data grid, table sidebar) so the
 * trick lives in one place rather than being copy-pasted per list. Pass it as
 * `observeElementRect: (instance, callback) => flooredRectObserver(instance, callback, N)`.
 */
const flooredRectObserver = <TScroll extends Element, TItem extends Element>(
    instance: Virtualizer<TScroll, TItem>,
    callback: (rect: Rect) => void,
    fallbackHeight: number,
): (() => void) | undefined =>
    observeElementRect(instance, (rect) => {
        callback(rect.height > 0 ? rect : { height: fallbackHeight, width: rect.width });
    });

export default flooredRectObserver;
