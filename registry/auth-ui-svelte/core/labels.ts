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

/**
 * Display names for OAuth providers, where naive capitalization gets it wrong.
 *
 * Everything else falls through to capitalizing the id, which is right for
 * `google`, `github`, `discord` and most of the long tail. This table is only
 * the exceptions — brands with internal capitals or spaces that "Gitlab" and
 * "Microsoft entra id" would get visibly wrong.
 */
const PROVIDER_LABELS: Readonly<Record<string, string>> = {
    github: "GitHub",
    gitlab: "GitLab",
    huggingface: "Hugging Face",
    linkedin: "LinkedIn",
    microsoft: "Microsoft",
    "microsoft-entra-id": "Microsoft Entra ID",
    paypal: "PayPal",
    tiktok: "TikTok",
    vk: "VK",
    youtube: "YouTube",
};

/** A provider id as a person would write it: `github` → `GitHub`, `zoom` → `Zoom`. */
const providerLabel = (provider: string): string => {
    const known = PROVIDER_LABELS[provider];

    if (known !== undefined) {
        return known;
    }

    // Hyphenated ids ("generic-oauth") read as words, not as one run-on token.
    return provider
        .split("-")
        .map((part) => (part === "" ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
        .join(" ");
};

/**
 * The accessible name for a per-row action button: what it does, plus which row
 * it does it to.
 *
 * A list of ten "Remove" buttons has ten identical accessible names. Sighted
 * users disambiguate them from the row they sit in, but a screen reader in focus
 * mode announces the button alone — so "Remove" is all anyone tabbing through
 * hears, on a control that deletes something. The row's own label is what tells
 * them apart, and this is where it gets attached.
 *
 * Falls back to the bare action when a row has nothing to identify it by, which
 * is no worse than the name it would otherwise have had.
 */
const rowActionLabel = (action: string, subject: string | undefined): string => (subject === undefined || subject === "" ? action : `${action}: ${subject}`);

export { passkeyLabel, PROVIDER_LABELS, providerLabel, ROLE_OPTIONS, rowActionLabel, sessionLabel, slugify };
