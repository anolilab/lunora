/**
 * Display helpers the cards need but that aren't presentation.
 *
 * These lived inline in all five ports, which meant five copies that had already
 * drifted into three different signatures — and a hard-coded English fallback
 * for the session label sitting next to a localized one for passkeys. Keeping
 * them here makes the fallbacks translatable like everything else.
 */
import type { Localization } from "./localization";
import type { AuthPasskey, AuthSession } from "./types";

/**
 * `"my-org"` from `"My Org"`. Used for the create-organization slug when the
 * user leaves the field blank, so it decides what is actually sent to the
 * server — not merely what is shown.
 */
const slugify = (value: string): string =>
    // Runs of non-alphanumerics collapse to a single "-", so trimming one edge
    // dash each side is enough (keeps the regex linear — no `+` quantifier).
    value
        .toLowerCase()
        .trim()
        .replaceAll(/[^a-z0-9]+/gu, "-")
        .replaceAll(/^-|-$/gu, "");

/** The roles the invite form offers. */
const ROLE_OPTIONS: ReadonlyArray<string> = ["member", "admin", "owner"];

/** A session's user-agent, its IP, or a localized fallback. */
const sessionLabel = (session: AuthSession, localization: Localization): string => {
    const agent = session.userAgent?.trim();

    if (agent !== undefined && agent !== "") {
        return agent;
    }

    return session.ipAddress ?? localization.unknownDevice;
};

/** A passkey's name, or a localized fallback. */
const passkeyLabel = (passkey: AuthPasskey, localization: Localization): string => {
    const name = passkey.name?.trim();

    return name === undefined || name === "" ? localization.passkeyUnnamed : name;
};

export { passkeyLabel, ROLE_OPTIONS, sessionLabel, slugify };
