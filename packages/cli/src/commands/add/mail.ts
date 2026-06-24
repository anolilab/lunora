/**
 * Mail-feature helpers shared by `lunora init`'s offer and `lunora add email`.
 *
 * The `mail` manifest ships a `send_email` binding with a placeholder
 * `destination_address` (`REPLACE_ME@example.com`). Cloudflare Email Workers'
 * single-recipient binding only delivers to a *verified* destination, so the
 * placeholder must be replaced before production delivery works (in `lunora dev`
 * sends are captured into the studio, so it doesn't block local work). Rather
 * than leave a placeholder to hunt down, the front doors prompt for it.
 */
import type { RegistryManifest } from "../registry/types";
import { setBindingField } from "../registry/types";

/** The send-email binding name the `mail` item declares. */
const SEND_EMAIL_BINDING = "SEND_EMAIL";

/** The destination-address prompt shared by both front doors. */
const MAIL_DESTINATION_PROMPT = "Verified destination email for production delivery (blank = set it later in wrangler.jsonc)";

/**
 * Light structural check that `value` looks like an email address — a non-empty
 * local part, a single `@`, and a dotted domain — without a backtracking-prone
 * regex. Good enough to catch fat-finger input; Cloudflare does the real
 * verification.
 */
const isValidEmail = (value: string): boolean => {
    const trimmed = value.trim();

    if (trimmed.length === 0 || trimmed.includes(" ")) {
        return false;
    }

    const at = trimmed.indexOf("@");

    if (at <= 0 || at !== trimmed.lastIndexOf("@")) {
        return false;
    }

    const domain = trimmed.slice(at + 1);

    return domain.length >= 3 && domain.includes(".") && !domain.startsWith(".") && !domain.endsWith(".");
};

/**
 * Turn a typed/flag answer into a destination address, or `undefined` to keep
 * the placeholder: blank is a silent skip ("set it later"); a non-email entry is
 * rejected via `warn` (the caller adds any command prefix). Shared by both front
 * doors so the trim/validate/warning wording can't drift between them.
 */
const resolveTypedDestination = (entered: string, warn: (message: string) => void): string | undefined => {
    const trimmed = entered.trim();

    if (trimmed === "") {
        return undefined;
    }

    if (!isValidEmail(trimmed)) {
        warn(`"${trimmed}" doesn't look like an email — leaving the placeholder; set destination_address in wrangler.jsonc.`);

        return undefined;
    }

    return trimmed;
};

/**
 * Return a copy of `manifest` with the `SEND_EMAIL` binding's
 * `destination_address` set to `address`. No-ops on items without a matching
 * binding, so it's safe to pass as a {@link RegistryManifest} transform.
 */
const withMailDestination = (manifest: RegistryManifest, address: string): RegistryManifest =>
    setBindingField(manifest, "send_email", { key: "name", value: SEND_EMAIL_BINDING }, "destination_address", address);

export { isValidEmail, MAIL_DESTINATION_PROMPT, resolveTypedDestination, SEND_EMAIL_BINDING, withMailDestination };
