import { useLunora } from "@lunora/react";
import type { LunoraClient } from "lunorash/client";
import type { CSSProperties, ReactElement } from "react";
import { useState } from "react";

import { authClient } from "./auth-client.js";

/** Hoisted so the literal isn't reallocated (and re-flagged) per render. */
const FORM_STYLE: CSSProperties = { display: "grid", gap: 12, margin: "4rem auto", maxWidth: 320 };

/**
 * Sign in or up, then tell the Lunora client: the new cookie is invisible to
 * it, and asking who is signed in now is what replaces the signed-out session.
 * Kept outside the component so its `try` stays out of the React Compiler's way.
 * @returns the error to show, or `null` on success.
 */
const submitCredentials = async (
    client: LunoraClient,
    mode: "signin" | "signup",
    fields: { email: string; name: string; password: string },
): Promise<string | null> => {
    try {
        const result =
            mode === "signin"
                ? await authClient.signIn.email({ email: fields.email, password: fields.password })
                : await authClient.signUp.email({ email: fields.email, name: fields.name || fields.email, password: fields.password });

        if (result.error) {
            return result.error.message ?? `${mode} failed`;
        }

        await client.getCurrentUser();

        return null;
    } catch (error: unknown) {
        return error instanceof Error ? error.message : "unknown error";
    }
};

/**
 * Email/password sign-in + sign-up. Posts at the `/api/auth/*` routes
 * mounted by `@lunora/auth` (better-auth). The HttpOnly session cookie is
 * set by the response — there's no token to plumb back into client state.
 *
 * `authClient.useSession()` in {@link App.tsx} reactively flips to the
 * authenticated view on the next render once the cookie lands.
 */
export const Login = (): ReactElement => {
    const client = useLunora();
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const modeLabel = mode === "signin" ? "Sign in" : "Create account";
    const submitLabel = pending ? "…" : modeLabel;

    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                setError(null);
                setPending(true);

                void (async () => {
                    setError(await submitCredentials(client, mode, { email, name, password }));
                    setPending(false);
                })();
            }}
            style={FORM_STYLE}
        >
            <h1>{mode === "signin" ? "Sign in" : "Sign up"}</h1>
            {mode === "signup" ? (
                <label htmlFor="login-name">
                    Name
                    <input
                        id="login-name"
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                        value={name}
                    />
                </label>
            ) : null}
            <label htmlFor="login-email">
                Email
                <input
                    autoComplete="email"
                    id="login-email"
                    onChange={(event) => {
                        setEmail(event.target.value);
                    }}
                    required
                    type="email"
                    value={email}
                />
            </label>
            <label htmlFor="login-password">
                Password
                <input
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    id="login-password"
                    minLength={8}
                    onChange={(event) => {
                        setPassword(event.target.value);
                    }}
                    required
                    type="password"
                    value={password}
                />
            </label>
            <button disabled={pending} type="submit">
                {submitLabel}
            </button>
            <button
                onClick={() => {
                    setMode(mode === "signin" ? "signup" : "signin");
                    setError(null);
                }}
                type="button"
            >
                {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
            </button>
            {error ? <p role="alert">{error}</p> : null}
        </form>
    );
};
