import { parseSetCookieHeader } from "better-auth/cookies";

/** A browser's view of cookies: each `Set-Cookie` replaces the cookie of that name. */
class CookieJar {
    readonly #cookies = new Map<string, string>();

    public absorb(headers: Headers | undefined): void {
        const raw = headers?.get("set-cookie");

        if (!raw) {
            return;
        }

        for (const [name, { value }] of parseSetCookieHeader(raw)) {
            this.#cookies.set(name, value);
        }
    }

    public has(fragment: string): boolean {
        return [...this.#cookies.keys()].some((name) => name.includes(fragment));
    }

    public headers(): Headers {
        return new Headers({ cookie: [...this.#cookies].map(([name, value]) => `${name}=${value}`).join("; ") });
    }
}

export default CookieJar;
