/**
 * Pure selection and formatting helpers for the dev mail catcher.
 *
 * Their own module because both `useMailCapture` and the panel's markup need
 * them, and because none of them touches React — so they are unit-testable
 * without a renderer.
 */
import type { CapturedMail } from "../../lib/admin";

/**
 * Matches the first `http(s)` URL in a body, stopping at whitespace, quotes, or
 * angle/closing brackets. Intentionally mirrors `@lunora/mail`'s `extractLink`
 * pattern (same char class) but is duplicated here rather than imported: the
 * studio bundle stays decoupled from the `@lunora/mail` runtime (it shares only
 * plain strings/types with the server, never the package). Non-global because
 * the panel only needs the first link.
 */
const LINK_PATTERN = /https?:\/\/[^\s"'<>)]+/i;

/** First `http(s)` URL in `text`, or `undefined` when none — used to deep-link from a captured message. */
const firstLink = (text: string | undefined): string | undefined => {
    if (text === undefined) {
        return undefined;
    }

    const match = LINK_PATTERN.exec(text);

    return match?.[0];
};

/** Join a recipient field (string or list) into one display string. */
const recipientText = (value: string | string[] | undefined): string => {
    if (value === undefined) {
        return "";
    }

    return Array.isArray(value) ? value.join(", ") : value;
};

/** The first link in a captured message: HTML body first, then the plain-text body. */
const selectedLink = (mail: CapturedMail | undefined): string | undefined => {
    if (mail === undefined) {
        return undefined;
    }

    return firstLink(mail.html) ?? firstLink(mail.text);
};

/** Captured mail whose subject or recipients contain `filter` (case-insensitive); everything when it is blank. */
const matchingMail = (entries: ReadonlyArray<CapturedMail>, filter: string): ReadonlyArray<CapturedMail> => {
    const needle = filter.trim().toLowerCase();

    if (needle === "") {
        return entries;
    }

    return entries.filter((entry) => `${entry.subject} ${recipientText(entry.to)}`.toLowerCase().includes(needle));
};

/** The selected message, defaulting to the newest visible one so a refresh or a filter change never leaves the detail pane pointing at nothing. */
const selectedMail = (visible: ReadonlyArray<CapturedMail>, selectedId: null | string): CapturedMail | undefined => {
    if (visible.length === 0) {
        return undefined;
    }

    return visible.find((entry) => entry.id === selectedId) ?? visible[0];
};

export { matchingMail, recipientText, selectedLink, selectedMail };
