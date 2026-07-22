<!--
    Provides the resolved auth-UI context to the tree. One base Svelte component
    set serves every meta-framework: pass your router into `nav`/`Link`
    (SvelteKit `goto` + `<a>`, or a custom router) and the cards navigate through
    it. The context is published once during initialisation, matching
    `@lunora/svelte`'s `setLunoraClient` mount-once semantics.
-->
<script lang="ts">
    import type { Snippet } from "svelte";

    import type { AuthUIConfig } from "../core";
    import { defaultNav, resolveContext } from "../core";
    import type { AuthUILinkComponent } from "./context";
    import { setAuthUIContext } from "./context";

    let {
        authClient,
        basePath,
        children,
        Link,
        localization,
        nav,
        onError,
        onSessionChange,
        plugins,
        redirects,
        social,
    }: Omit<AuthUIConfig, "nav"> & {
        children: Snippet;
        /** Framework `Link` for internal links; falls back to a plain `<a>`. */
        Link?: AuthUILinkComponent;
        /** Router bridge; defaults to a `location`-based fallback. */
        nav?: AuthUIConfig["nav"];
    } = $props();

    setAuthUIContext({
        core: resolveContext({
            authClient,
            basePath,
            localization,
            nav: nav ?? defaultNav,
            onError,
            onSessionChange,
            plugins,
            redirects,
            social,
        }),
        Link,
    });
</script>

{@render children()}
