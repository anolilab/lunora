/**
 * Which optional flows are available — and therefore which cards render.
 *
 * A card like `&lt;MagicLinkCard>` can only work if the matching better-auth client
 * plugin is installed. Rather than make every app restate that in a `plugins`
 * prop (a second place to forget), the flags are **derived from the auth client
 * itself**: a client built with `magicLink()` has `signIn.magicLink`, one
 * without it doesn't. An explicit `plugins` entry always wins, for the cases
 * where detection can't see through a wrapper or a mock.
 */
import type { ControllerContext, PluginFlags } from "./config";

/** The optional flows a card can depend on. */
type FlowName = keyof PluginFlags;

/** A structural view of the client used only for capability detection. */
type ClientShape = Record<string, undefined | Record<string, unknown>>;

const isFunction = (value: unknown): boolean => typeof value === "function";

/** One probe per flow: the method that only exists when the plugin is installed. */
const PROBES: Record<FlowName, (client: ClientShape) => boolean> = {
    admin: (client) => isFunction(client.admin?.listUsers),
    apiKey: (client) => isFunction(client.apiKey?.create),
    emailOtp: (client) => isFunction(client.emailOtp?.sendVerificationOtp),
    magicLink: (client) => isFunction(client.signIn?.magicLink),
    organization: (client) => isFunction(client.organization?.list),
    passkey: (client) => isFunction(client.passkey?.addPasskey),
    twoFactor: (client) => isFunction(client.twoFactor?.enable),
};

/** Detect which plugins a better-auth client was built with. */
const derivePluginFlags = (authClient: unknown): Required<PluginFlags> => {
    const client = (authClient ?? {}) as ClientShape;
    const flags = {} as Required<PluginFlags>;

    for (const flow of Object.keys(PROBES) as FlowName[]) {
        flags[flow] = PROBES[flow](client);
    }

    return flags;
};

/** Warn about a given flow at most once, so a re-rendering card can't spam the console. */
const warned = new Set<string>();

const isProduction = (): boolean => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.NODE_ENV === "production";

/**
 * Whether `flow`'s card should render. When it shouldn't, warn once (outside
 * production) naming the component and the fix — a card that vanishes with no
 * explanation is a worse bug than the one this gate prevents.
 */
const isFlowEnabled = (context: ControllerContext, flow: FlowName, component: string): boolean => {
    if (context.plugins[flow]) {
        return true;
    }

    if (!isProduction() && !warned.has(component)) {
        warned.add(component);
        // eslint-disable-next-line no-console -- a deliberate dev-time diagnostic; the alternative is a silently blank card.
        console.warn(
            `[lunora-auth-ui] <${component}> did not render: the "${flow}" flow is off. Add the ${flow} plugin to your auth client (lunora/auth-ui/client.ts), or pass plugins={{ ${flow}: true }} to <AuthUIProvider> to force it on.`,
        );
    }

    return false;
};

/** Test seam: forget which components have already warned. */
const resetFlowWarnings = (): void => {
    warned.clear();
};

export type { FlowName };
export { derivePluginFlags, isFlowEnabled, resetFlowWarnings };
