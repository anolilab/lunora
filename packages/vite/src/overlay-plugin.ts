import type { Plugin } from "vite";

// Module-level dedup so the "overlay disabled" warning is emitted at most once
// per process, even if `overlayPlugin()` is called multiple times.
let warned = false;

/**
 * Loads `@visulima/vite-overlay` if available and returns its plugin output.
 * If the module is not installed, returns a no-op plugin and warns once
 * **per process** (see {@link warned}).
 *
 * Returns a Promise because the dynamic import is async; `cirrus()` flattens it.
 */
const overlayPlugin = async (): Promise<Plugin | ReadonlyArray<Plugin>> => {
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
        if (!warned) {
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
