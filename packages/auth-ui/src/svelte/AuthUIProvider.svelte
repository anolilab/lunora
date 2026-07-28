<!--
    Provides the resolved auth-UI context to the tree. One base Svelte component
    set serves every meta-framework: pass your router into `nav`/`Link`
    (SvelteKit `goto` + `<a>`, or a custom router) and the cards navigate through
    it. The context object is published once during initialisation, matching
    `@lunora/svelte`'s `setLunoraClient` mount-once semantics; what it *holds* is
    read through getters, so server discovery can replace the resolved context
    once the answer lands.
-->
<script lang="ts">
    import { LunoraError } from "@lunora/errors";
    import type { Snippet } from "svelte";
    import { untrack } from "svelte";

    import type { AuthUIConfig } from "../core/config";
    import { DEFAULT_BASE_PATH, resolveContext } from "../core/config";
    import { defaultNav } from "../core/default-nav";
    import type { DiscoveredConfig } from "../core/discovery";
    import { discoverAuthConfig } from "../core/discovery";
    import type { AuthUILinkComponent } from "./context";
    import { setAuthUIContext } from "./context";

    let {
        authClient,
        avatar,
        basePath,
        children,
        discover,
        Link,
        localization,
        nav,
        onError,
        onSessionChange,
        plugins,
        redirects,
        social,
        theme,
        viewPaths,
    }: Omit<AuthUIConfig, "nav"> & {
        children: Snippet;
        /** Framework `Link` for internal links; falls back to a plain `<a>`. */
        Link?: AuthUILinkComponent;
        /** Router bridge; defaults to a `location`-based fallback. */
        nav?: AuthUIConfig["nav"];
    } = $props();

    /*
     * `avatar.upload` is a callback like `nav` and `onError`, so it gets the same
     * treatment: a wrapper that reads the *current* prop at call time. In Svelte
     * that costs nothing — a destructured prop is a live getter — so a swapped
     * handler is picked up without the config object (and with it every
     * controller) having to be rebuilt.
     */
    const upload = async (file: File): Promise<string> => {
        const handler = avatar?.upload;

        if (handler === undefined) {
            throw new LunoraError("INTERNAL", "no avatar upload handler is configured");
        }

        return handler(file);
    };

    /*
     * The config is assembled once, on purpose. Callbacks and `nav` are naturally
     * written inline (`nav={{ navigate: (to) => goto(to) }}`), so a new identity
     * arrives on every parent update; if those reached the context, it — and every
     * controller created from it — would be rebuilt mid-typing: fields blank,
     * resource cards refetch. Only *values* are read here, and `untrack` states
     * that intent to the compiler instead of emitting a `state_referenced_locally`
     * warning per prop — warnings that would otherwise show up in every project
     * that copies this file.
     */
    const config: AuthUIConfig = untrack(() => {
        return {
            authClient,
            // Only `upload`'s *presence* is a config decision (it decides whether
            // the card shows a file picker or a URL field); the function itself is
            // reached through the wrapper above.
            avatar: { maxSize: avatar?.maxSize, upload: avatar?.upload === undefined ? undefined : upload },
            basePath,
            localization,
            nav: {
                navigate: (to: string): void => {
                    (nav ?? defaultNav).navigate(to);
                },
                replace: (to: string): void => {
                    (nav ?? defaultNav).replace(to);
                },
            },
            onError: (error: unknown): void => {
                onError?.(error);
            },
            onSessionChange: (): void => {
                onSessionChange?.();
            },
            plugins,
            redirects,
            social,
            theme,
            viewPaths,
        };
    });

    /*
     * Ask the server which plugins and providers are on. The request is shared
     * process-wide per endpoint (see `discovery.ts`), so mounting several
     * providers costs one fetch — and a provider mounted *after* the answer landed
     * reads it synchronously below, with no rebuild at all.
     */
    const handle = untrack(() => (discover === false ? undefined : discoverAuthConfig(basePath ?? DEFAULT_BASE_PATH)));

    let discovered = $state<DiscoveredConfig | undefined>(handle?.getState().config);

    $effect(() => {
        if (handle === undefined) {
            return undefined;
        }

        // Re-read synchronously: the request can settle between initialisation and
        // this effect. Failure resolves to `undefined` and is never surfaced —
        // discovery is an upgrade, never a dependency.
        discovered = handle.getState().config;

        return handle.subscribe(() => {
            discovered = handle.getState().config;
        });
    });

    // The only reactive input is the discovered payload, which settles once, so
    // this recomputes at most once per mount.
    const core = $derived(resolveContext(config, discovered));

    setAuthUIContext({
        get core() {
            return core;
        },
        get Link() {
            return Link;
        },
    });
</script>

<!--
    Cards read the context during their own initialisation, so an answer that
    arrives afterwards can only reach them through a remount — the Svelte
    equivalent of React re-creating every controller when the context identity
    changes. `core` is stable until discovery settles (and already settled for a
    late-mounting provider), so this happens at most once.
-->
{#key core}
    {@render children()}
{/key}
