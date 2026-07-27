import type { ReactElement } from "react";
import { useState } from "react";

import { authClient } from "./auth-client";

/**
 * Email/password sign-in + sign-up for the hosted studio. Posts at the
 * `/api/auth/*` routes mounted by `@lunora/auth` (better-auth). The HttpOnly
 * session cookie is set by the response — there's no token to plumb back into
 * client state.
 *
 * Navigation is the caller's business: the `/login` route passes `onSignedIn`,
 * which fires once the cookie has landed so the router can send the visitor on to
 * whatever they were trying to reach. (Before routing, `authClient.useSession()`
 * in the old `App.tsx` re-rendered into the authenticated view instead.)
 */
interface LoginProps {
    /** Called after a successful sign-in / sign-up, once the session cookie is set. */
    onSignedIn?: () => void;
}

export const Login = ({ onSignedIn }: LoginProps = {}): ReactElement => {
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    const modeLabel = mode === "signin" ? "Sign in" : "Create account";
    const submitLabel = pending ? "…" : modeLabel;

    return (
        <div className="auth-shell">
            <form
                className="card auth-card"
                onSubmit={(event) => {
                    event.preventDefault();
                    setError(null);
                    setPending(true);

                    // Promise combinators instead of try/finally so React
                    // Compiler can memoize the component (it can't lower
                    // try-with-finally yet).
                    const submit = async (): Promise<void> => {
                        const result =
                            mode === "signin"
                                ? await authClient.signIn.email({ email, password })
                                : await authClient.signUp.email({ email, name: name || email, password });

                        if (result.error) {
                            setError(result.error.message ?? `${mode} failed`);

                            return;
                        }

                        onSignedIn?.();
                    };

                    void submit()
                        .catch((error_: unknown) => {
                            setError(error_ instanceof Error ? error_.message : "unknown error");
                        })
                        .finally(() => {
                            setPending(false);
                        });
                }}
            >
                <h1>Lunora Cloud</h1>
                <p className="muted">{mode === "signin" ? "Sign in to your control plane" : "Create your account"}</p>
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
                <button className="primary" disabled={pending} type="submit">
                    {submitLabel}
                </button>
                <button
                    className="link"
                    onClick={() => {
                        setMode(mode === "signin" ? "signup" : "signin");
                        setError(null);
                    }}
                    type="button"
                >
                    {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
                </button>
                {error ? (
                    <p className="error" role="alert">
                        {error}
                    </p>
                ) : null}
            </form>
        </div>
    );
};
