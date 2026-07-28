/**
 * Which optional flows are available — and therefore which cards render.
 *
 * A card like `&lt;MagicLinkCard>` only works if the matching better-auth client
 * plugin is installed, so the cards need to know which are. They cannot ask the
 * client: `createAuthClient` returns a dynamic-path `Proxy`, so
 * `typeof client.organization?.list === "function"` is true for a plugin-free
 * client — and so is `client.notAPlugin?.notAMethod`. Most plugin methods are
 * inferred request paths rather than concrete functions, so there is nothing on
 * the client to probe, in either direction.
 *
 * Instead the toggles are recorded where they are already declared:
 * `createLunoraAuthClient` (in `lunora/auth-ui/client.ts`) publishes them here,
 * keyed by the client it built. That keeps one declaration point and removes the
 * guessing.
 *
 * A client built some other way is *unknown*, not empty — every flow stays on,
 * because silently hiding a card we cannot reason about is the worse failure.
 * Pass `plugins` to the provider to state it explicitly.
 */
import type { ControllerContext, PluginFlags } from "./config";

/** The optional flows a card can depend on. */
type FlowName = keyof PluginFlags;

const FLOW_NAMES: FlowName[] = ["admin", "apiKey", "emailOtp", "magicLink", "organization", "passkey", "twoFactor"];

/**
 * Toggles by auth client. A `WeakMap` so a discarded client is collectable, and
 * so this carries no state between apps in the same process (SSR).
 */
const registry = new WeakMap<object, Required<PluginFlags>>();

const withEveryFlow = (enabled: boolean): Required<PluginFlags> => {
    const flags = {} as Required<PluginFlags>;

    for (const flow of FLOW_NAMES) {
        flags[flow] = enabled;
    }

    return flags;
};

/**
 * Record which plugins a client was built with. Called by
 * `createLunoraAuthClient`; call it yourself if you build the client by hand and
 * want the cards to follow its plugin set.
 */
const registerAuthClientPlugins = (authClient: unknown, plugins: PluginFlags = {}): void => {
    if (typeof authClient !== "object" && typeof authClient !== "function") {
        return;
    }

    if (authClient === null) {
        return;
    }

    const flags = withEveryFlow(false);

    for (const flow of FLOW_NAMES) {
        flags[flow] = plugins[flow] ?? false;
    }

    registry.set(authClient, flags);
};

/**
 * The flows a client was registered with, or every flow when it wasn't
 * registered (see the note above about unknown clients).
 */
const derivePluginFlags = (authClient: unknown): Required<PluginFlags> => {
    if (authClient === null || (typeof authClient !== "object" && typeof authClient !== "function")) {
        return withEveryFlow(true);
    }

    return registry.get(authClient) ?? withEveryFlow(true);
};

/** Warn about a given flow at most once, so a re-rendering card can't spam the console. */
const warned = new Set<string>();

/**
 * Whether `flow`'s card should render. When it shouldn't, warn once naming the
 * component and the fix — a card that vanishes with no explanation is a worse
 * bug than the one this gate prevents. It only fires for a card you mounted with
 * its flow deliberately off, so it stays quiet in a correct app.
 */
const isFlowEnabled = (context: ControllerContext, flow: FlowName, component: string): boolean => {
    if (context.plugins[flow]) {
        return true;
    }

    if (!warned.has(component)) {
        warned.add(component);
        // eslint-disable-next-line no-console -- a deliberate dev-time diagnostic; the alternative is a silently blank card.
        console.warn(
            `[lunora-auth-ui] <${component}> did not render: the "${flow}" flow is off. Turn it on in lunora/auth-ui/client.ts, or pass plugins={{ ${flow}: true }} to <AuthUIProvider>.`,
        );
    }

    return false;
};

/** Test seam: forget which components have already warned. */
const resetFlowWarnings = (): void => {
    warned.clear();
};

export type { FlowName };
export { derivePluginFlags, isFlowEnabled, registerAuthClientPlugins, resetFlowWarnings };
