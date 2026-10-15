import { createAuth } from "@lunora/auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { hashPassword } from "better-auth/crypto";

import { authOptions } from "../../src/auth";

/**
 * A real better-auth instance over an in-memory store, with one verified user who
 * has a password. The cookie names and the signature check are better-auth's, so
 * stubbing them would test nothing; only the database is replaced.
 */

const PASSWORD = "correct horse battery staple";
const EMAIL = "ada@example.com";
const ORIGIN = "https://control.lunora.app";
const SESSION_TOKEN = "__Host-better-auth.session_token";

const env = { AUTH_SECRET: "lunora-unit-test-auth-secret-lunora-unit-test", AUTH_URL: ORIGIN, DB: null, WORKER_ENV: "test" };

type HarnessAuth = Awaited<ReturnType<typeof buildAuth>>;

const buildAuth = async (): Promise<ReturnType<typeof createAuth>> => {
    // The memory adapter throws on a model it has no table for, so every table the
    // sign-in path touches is declared up front.
    const db: Record<string, Record<string, unknown>[]> = { account: [], rateLimit: [], session: [], user: [], verification: [] };
    const auth = createAuth({ ...authOptions(env, ORIGIN), database: memoryAdapter(db) });
    const ctx = await auth.$context;

    const user = await ctx.adapter.create<Record<string, unknown>, { id: string }>({
        data: { email: EMAIL, emailVerified: true, name: "Ada", createdAt: new Date(), updatedAt: new Date() },
        model: "user",
    });
    await ctx.adapter.create({
        data: {
            accountId: user.id,
            createdAt: new Date(),
            password: await hashPassword(PASSWORD),
            providerId: "credential",
            updatedAt: new Date(),
            userId: user.id,
        },
        model: "account",
    });

    return auth;
};

/** Signs in with the email and password. `rememberMe` is sent only when given; `JSON.stringify` drops an undefined value. */
const signIn = (auth: HarnessAuth, rememberMe?: boolean): Promise<Response> =>
    auth.handler(
        new Request(`${ORIGIN}/api/auth/sign-in/email`, {
            body: JSON.stringify({ email: EMAIL, password: PASSWORD, rememberMe }),
            headers: { "content-type": "application/json", origin: ORIGIN },
            method: "POST",
        }),
    );

/** Every Set-Cookie line the response carries, whole, with its attributes. */
const setCookies = (response: Response): string[] => response.headers.getSetCookie();

/** The first Set-Cookie line for `name`, whole, with its attributes. Throws when there is none. */
const cookieNamed = (lines: string[], name: string): string => {
    const line = lines.find((candidate) => candidate.startsWith(`${name}=`));

    if (line === undefined) {
        throw new Error(`no Set-Cookie for ${name}`);
    }

    return line;
};

/** The raw (still-encoded) value of a Set-Cookie line, without its attributes. */
const cookieValue = (line: string): string => line.split(";")[0].slice(line.indexOf("=") + 1);

export { buildAuth, cookieNamed, cookieValue, EMAIL, ORIGIN, PASSWORD, SESSION_TOKEN, setCookies, signIn };
export type { HarnessAuth };
