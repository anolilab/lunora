/**
 * The authenticated Git remote every Artifacts Git-client recipe needs — a
 * **pure string builder**, no I/O, so it is safe in any handler.
 */
import { LunoraError } from "@lunora/errors";

/**
 * Build `https://x:<secret>@host/…` from a repo `remote` and a Git token.
 *
 * A token can carry an `?expires=…` suffix; that is not part of the secret Git
 * sends, so it is stripped first. The result embeds the secret — hand it to a
 * Git client through an environment variable and keep it out of logs, command
 * arguments and error messages. Errors raised here never quote the token.
 */
// eslint-disable-next-line import/prefer-default-export -- named export: the subpath barrel re-exports by name, per the repo's no-default-mixing convention
export const authenticatedRemote = (remote: string, token: string): string => {
    const [secret = ""] = token.split("?expires=");

    if (secret === "") {
        throw new LunoraError("BAD_REQUEST", "@lunora/bindings/artifacts: authenticatedRemote needs a non-empty token");
    }

    let url: URL;

    try {
        url = new URL(remote);
    } catch {
        throw new LunoraError("BAD_REQUEST", "@lunora/bindings/artifacts: authenticatedRemote needs the repo's absolute `remote` URL");
    }

    if (url.protocol !== "https:") {
        throw new LunoraError("BAD_REQUEST", `@lunora/bindings/artifacts: authenticatedRemote needs an https remote, got "${url.protocol}"`);
    }

    // The URL setters percent-encode anything a userinfo component cannot carry,
    // so a token with reserved characters still round-trips through Git.
    url.username = "x";
    url.password = secret;

    return url.toString();
};
