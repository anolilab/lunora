import type { Plugin } from "vite";

/**
 * Loads `@visulima/vite-overlay` if available and returns its plugin output.
 * If the module is not installed, returns a no-op plugin and warns once
 * **per call** — the warned flag lives in a closure that's reset every time
 * `overlayPlugin()` is invoked, so a fresh project load gets a fresh warning.
 *
 * Returns a Promise because the dynamic import is async; `cirrus()` flattens it.
 */
export const overlayPlugin = async (): Promise<Plugin | ReadonlyArray<Plugin>> => {
    let warned = false;

    try {
        const moduleExports: Record<string, unknown> = (await import("@visulima/vite-overlay")) as Record<string, unknown>;

        const factory =
            (moduleExports.default as ((...args: ReadonlyArray<unknown>) => Plugin | ReadonlyArray<Plugin>) | undefined) ??
            (moduleExports.overlay as ((...args: ReadonlyArray<unknown>) => Plugin | ReadonlyArray<Plugin>) | undefined) ??
            (moduleExports.viteOverlay as ((...args: ReadonlyArray<unknown>) => Plugin | ReadonlyArray<Plugin>) | undefined);

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
            name: "cirrus:overlay-injector",
            apply: "serve" as const,
        };
    }
};
