/**
 * Per-framework overlay adapters.
 *
 * The overlay takes a stock `create-vite` base and applies the smallest possible
 * Lunora layer. The only genuinely framework-specific pieces are (a) which
 * `@lunora/*` client adapter to install and (b) the **entry file** that mounts
 * the app — so we ship a tiny, Lunora-wired entry per framework (≈15 lines) and
 * take *everything else* (App, styles, configs, framework deps) from create-vite
 * verbatim. Replacing the small, stable entry is far more robust than codemod-ing
 * create-vite's source, and keeps maintenance to a handful of lines per
 * framework instead of a whole template.
 *
 * The `lunora()` Vite plugin does NOT bundle the framework JSX plugin, so the
 * base's official `react()`/`vue()`/`solid()` plugin is kept and `lunora()` is
 * simply added (see `patchViteConfig`).
 *
 * Each adapter also overwrites create-vite's default `App` + base stylesheet
 * with the branded Lunora welcome (see `./welcome`), so an overlaid project
 * opens on the Lunora hero rather than the generic Vite "Get started" splash.
 */

import { REACT_APP, SOLID_APP, SVELTE_APP, VANILLA_MAIN, VUE_APP, WELCOME_CSS } from "./welcome";

/** A file the overlay writes into the scaffolded project (relative path + contents). */
interface OverlayFile {
    /** File contents (already substituted). */
    contents: string;
    /** Project-relative path, e.g. `src/main.tsx`. */
    path: string;
}

interface FrameworkAdapter {
    /** The `@lunora/*` client adapter to add as a dependency. */
    adapter: string;
    /** The `create-vite` template id this overlays, e.g. `react-ts` (`npm create vite -- --template <id>`). */
    createViteTemplate: string;
    /** Extra runtime deps beyond `lunorash` + the adapter (e.g. none for most). */
    extraDependencies?: Record<string, string>;
    /** The Lunora-wired entry/bootstrap file(s) that replace or augment the base's entry. */
    files: ReadonlyArray<OverlayFile>;
    /** Friendly label for prompts/output. */
    label: string;
}

const READ_URL = `const url = (import.meta.env.VITE_LUNORA_URL as string | undefined) ?? globalThis.location.origin;`;

const REACT_MAIN = `import "./index.css";

import { LunoraProvider } from "@lunora/react";
import { LunoraClient } from "lunorash/client";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App.tsx";

// \`@lunora/vite\` runs the Worker on the same origin as Vite, so default to
// \`location.origin\`. Point \`VITE_LUNORA_URL\` at a deployed Worker to develop
// the client against production data.
${READ_URL}
const client = new LunoraClient({ url });

const root = document.getElementById("root");

if (!root) {
    throw new Error("missing #root mount node");
}

createRoot(root).render(
    <StrictMode>
        <LunoraProvider client={client}>
            <App />
        </LunoraProvider>
    </StrictMode>,
);
`;

const VUE_MAIN = `import "./style.css";

import { createLunora } from "@lunora/vue";
import { LunoraClient } from "lunorash/client";
import { createApp } from "vue";

import App from "./App.vue";

// Provide one LunoraClient at the app root via the Vue plugin form.
${READ_URL}
createApp(App).use(createLunora(new LunoraClient({ url }))).mount("#app");
`;

const SOLID_INDEX = `import "./index.css";

import { LunoraContext } from "@lunora/solid";
import { LunoraClient } from "lunorash/client";
import { render } from "solid-js/web";

import App from "./App";

${READ_URL}
const client = new LunoraClient({ url });
const root = document.getElementById("root");

render(
    () => (
        <LunoraContext.Provider value={client}>
            <App />
        </LunoraContext.Provider>
    ),
    root!,
);
`;

// Svelte context (`setLunoraClient`) must run during a component's init, so we
// can't set it from `main.ts`. A tiny `Root.svelte` sets the client then renders
// the create-vite `App`, and `main.ts` mounts `Root` instead of `App`.
const SVELTE_ROOT = `<script lang="ts">
    import { setLunoraClient } from "@lunora/svelte";
    import { LunoraClient } from "lunorash/client";

    import App from "./App.svelte";

    ${READ_URL}
    setLunoraClient(new LunoraClient({ url }));
</script>

<App />
`;

const SVELTE_MAIN = `import "./app.css";

import { mount } from "svelte";

import Root from "./Root.svelte";

// Mount \`Root\` (it sets the ambient LunoraClient) rather than \`App\` directly.
const app = mount(Root, { target: document.getElementById("app")! });

export default app;
`;

const ADAPTERS: Record<OverlayFramework, FrameworkAdapter> = {
    react: {
        adapter: "@lunora/react",
        createViteTemplate: "react-ts",
        files: [
            { contents: REACT_MAIN, path: "src/main.tsx" },
            { contents: REACT_APP, path: "src/App.tsx" },
            { contents: WELCOME_CSS, path: "src/index.css" },
        ],
        label: "React",
    },
    solid: {
        adapter: "@lunora/solid",
        createViteTemplate: "solid-ts",
        files: [
            { contents: SOLID_INDEX, path: "src/index.tsx" },
            { contents: SOLID_APP, path: "src/App.tsx" },
            { contents: WELCOME_CSS, path: "src/index.css" },
        ],
        label: "Solid",
    },
    svelte: {
        adapter: "@lunora/svelte",
        createViteTemplate: "svelte-ts",
        files: [
            { contents: SVELTE_ROOT, path: "src/Root.svelte" },
            { contents: SVELTE_MAIN, path: "src/main.ts" },
            { contents: SVELTE_APP, path: "src/App.svelte" },
            { contents: WELCOME_CSS, path: "src/app.css" },
        ],
        label: "Svelte",
    },
    vanilla: {
        adapter: "lunorash/client",
        createViteTemplate: "vanilla-ts",
        files: [
            { contents: VANILLA_MAIN, path: "src/main.ts" },
            { contents: WELCOME_CSS, path: "src/style.css" },
        ],
        label: "Vanilla",
    },
    vue: {
        adapter: "@lunora/vue",
        createViteTemplate: "vue-ts",
        files: [
            { contents: VUE_MAIN, path: "src/main.ts" },
            { contents: VUE_APP, path: "src/App.vue" },
            { contents: WELCOME_CSS, path: "src/style.css" },
        ],
        label: "Vue",
    },
};

/** The overlay-supported SPA frameworks (create-vite bases). */
type OverlayFramework = "react" | "solid" | "svelte" | "vanilla" | "vue";

const isOverlayFramework = (value: string): value is OverlayFramework => Object.hasOwn(ADAPTERS, value);

export type { FrameworkAdapter, OverlayFile, OverlayFramework };
export { ADAPTERS, isOverlayFramework };
