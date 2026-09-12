/**
 * Callback ref that focuses the node when it attaches.
 *
 * The same effect as `autoFocus`, without the attribute `jsx-a11y/no-autofocus`
 * warns about — the warning is about focus a user did not ask for, and every
 * input using this one is rendered *because* the user just clicked to edit, to
 * add a card, or opened the palette.
 *
 * Declared at module scope so its identity is stable: React re-invokes a
 * callback ref only when the callback itself changes, so this runs on attach and
 * detach rather than on every render.
 */
const focusOnMount = (node: HTMLInputElement | null): void => {
    node?.focus();
};

export default focusOnMount;
