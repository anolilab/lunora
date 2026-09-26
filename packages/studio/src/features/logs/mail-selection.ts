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

/** The `href` of the first `<a>` pointing at an `http(s)` URL — the link a reader would click, not a `<link>` stylesheet in `<head>`. */
const ANCHOR_HREF = /<a\s[^>]*?href\s*=\s*["'](https?:\/\/[^"'\s]+)["']/iu;

/** Ampersand entity (named + numeric decimal/hex forms) an HTML renderer escapes `&` to — the same set `@lunora/mail` decodes. */
const AMPERSAND_ENTITY = /&(?:amp|#0*38|#x0*26);/giu;

/**
 * The link a captured message is about: the first `<a href>` in the HTML body,
 * else the first URL in the text body, else any URL in the HTML. HTML escapes
 * `&` as `&amp;` inside `href`, so the entity is decoded — followed verbatim, a
 * `?uid=1&amp;token=abc` link sends a param literally named `amp;token`.
 */
const selectedLink = (mail: CapturedMail | undefined): string | undefined => {
    if (mail === undefined) {
        return undefined;
    }

    const link = (mail.html === undefined ? undefined : ANCHOR_HREF.exec(mail.html)?.[1]) ?? firstLink(mail.text) ?? firstLink(mail.html);

    return link?.replaceAll(AMPERSAND_ENTITY, "&");
};

/**
 * Captured mail whose subject or recipients contain `filter` (case-insensitive);
 * everything when it is blank.
 *
 * `cc` counts as a recipient because the detail pane shows it as one — filtering
 * by a cc-only address otherwise hides a message the operator can see is there.
 * `bcc` is deliberately excluded: it is not rendered, so matching on it would
 * surface a message whose reason for matching is invisible.
 */
const matchingMail = (entries: ReadonlyArray<CapturedMail>, filter: string): ReadonlyArray<CapturedMail> => {
    const needle = filter.trim().toLowerCase();

    if (needle === "") {
        return entries;
    }

    return entries.filter((entry) => `${entry.subject} ${recipientText(entry.to)} ${recipientText(entry.cc)}`.toLowerCase().includes(needle));
};

/** The selected message, defaulting to the newest visible one so a refresh or a filter change never leaves the detail pane pointing at nothing. */
const selectedMail = (visible: ReadonlyArray<CapturedMail>, selectedId: null | string): CapturedMail | undefined => {
    if (visible.length === 0) {
        return undefined;
    }

    return visible.find((entry) => entry.id === selectedId) ?? visible[0];
};

export { matchingMail, recipientText, selectedLink, selectedMail };
