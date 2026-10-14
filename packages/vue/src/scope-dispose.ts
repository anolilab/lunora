import { getCurrentScope, onScopeDispose } from "vue";

/**
 * Register `teardown` with the active effect scope, or — outside any scope —
 * warn in dev that nothing will clean it up. The `getCurrentScope` guard only
 * avoids throwing; it does not auto-clean, so the caller-supplied `warning`
 * must tell the consumer what leaks and how to fix it.
 */
const onScopeDisposeOrWarn = (teardown: () => void, warning: string): void => {
    if (getCurrentScope()) {
        onScopeDispose(teardown);
    } else if (process.env.NODE_ENV !== "production") {
        // eslint-disable-next-line no-console -- deliberate dev-only warning: this adapter has no injected logger, and the branch is already gated on NODE_ENV !== "production"
        console.warn(warning);
    }
};

export default onScopeDisposeOrWarn;
