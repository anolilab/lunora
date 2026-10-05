/**
 * The zero-config navigation fallback. When an app doesn't wire its router into
 * `<AuthUIProvider nav={...}>`, the components still work by driving
 * `globalThis.location` directly. Meta-frameworks should override this with
 * their own router for client-side transitions.
 */
import type { NavAdapter } from "./config";

const defaultNav: NavAdapter = {
    navigate: (to: string): void => {
        globalThis.location.assign(to);
    },
    replace: (to: string): void => {
        globalThis.location.replace(to);
    },
};

export { defaultNav };
