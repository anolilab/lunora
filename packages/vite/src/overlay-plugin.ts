import type { Plugin } from "vite";

/**
 * Loads `@visulima/vite-overlay` if available and returns its plugin output.
 * If the module is not installed, returns a no-op plugin and warns once
 * **per call** — the warned flag lives in a closure that's reset every time
 * `overlayPlugin()` is invoked, so a fresh project load gets a fresh warning.
 *
 * Returns a Promise because the dynamic import is async; `cirrus()` flattens it.
 */
const overlayPlugin = async (): Promise<Plugin | ReadonlyArray<Plugin>> => {
    let warned = false;

    try {
        const moduleExports: Record<string, unknown> = await import("@visulima/vite-overlay");

        type OverlayFactory = (...args: ReadonlyArray<unknown>) => Plugin | ReadonlyArray<Plugin>;

        const factory = (moduleExports.default ?? moduleExports.overlay ?? moduleExports.viteOverlay) as OverlayFactory | undefined;

        if (typeof factory !== "function") {
            throw new TypeError("no recognized factory export");
        }

        const created = factory();

        return created;
    } catch (error: unknown) {
        // `warned` is module-level state mutated across calls to dedupe the warning;
        // TS's per-call flow analysis can't see that, so it mis-reads both lines.
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- warned is mutated on prior calls
        if (!warned) {
            // eslint-disable-next-line no-useless-assignment -- read by the guard above on subsequent calls
            warned = true;
            const message = error instanceof Error ? error.message : String(error);

            // eslint-disable-next-line no-console
            console.warn(`[cirrus] overlay disabled — @visulima/vite-overlay not available (${message})`);
        }

        return {
            apply: "serve" as const,
            name: "cirrus:overlay-injector",
        };
    }
};

export default overlayPlugin;
