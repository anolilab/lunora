const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** Turnstile documents tokens as at most this long; anything longer is not one. */
const MAX_TOKEN_LENGTH = 2048;

/**
 * Cloudflare's documented test keys: the site key always renders a passing widget
 * and the secret accepts its token. For local runs only; a deploy sets real keys.
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/
 */
const TEST_SITE_KEY = "1x00000000000000000000AA";

/**
 * Asks Turnstile's `siteverify` whether `token` came from a solved widget. Any
 * failure — no token, a rejected token, an unreachable endpoint — is `false`, so a
 * Turnstile outage closes the form rather than opening it to bots.
 */
const verifyTurnstile = async (token: unknown, secret: string, remoteIp: string | null, fetcher: typeof fetch = fetch): Promise<boolean> => {
    if (typeof token !== "string" || token === "" || token.length > MAX_TOKEN_LENGTH) {
        return false;
    }

    const form = new FormData();

    form.set("secret", secret);
    form.set("response", token);

    if (remoteIp) {
        form.set("remoteip", remoteIp);
    }

    try {
        const response = await fetcher(SITEVERIFY_URL, { body: form, method: "POST" });

        if (!response.ok) {
            return false;
        }

        const outcome = (await response.json()) as { success?: unknown };

        return outcome.success === true;
    } catch {
        return false;
    }
};

export { SITEVERIFY_URL, TEST_SITE_KEY, verifyTurnstile };
