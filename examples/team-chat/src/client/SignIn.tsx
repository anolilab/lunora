import type { ReactElement } from "react";
import { useState } from "react";

import { authClient } from "./auth-client.js";

/** Email + password, both flows on one card. Deliberately plain — the chat is the subject here. */
export const SignIn = (): ReactElement => {
    const [mode, setMode] = useState<"in" | "up">("in");
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const onSubmit = async (form: FormData): Promise<void> => {
        setBusy(true);
        setError(null);

        const email = String(form.get("email") ?? "");
        const password = String(form.get("password") ?? "");
        const name = String(form.get("name") ?? "").trim() || email.split("@")[0];

        /**
         * Everything conditional lives in here rather than in the `try` below.
         * The React Compiler cannot lower a value block — a ternary, a `??`, an
         * optional chain — inside a try/catch, and one such expression makes it
         * skip optimizing the whole component. Resolves to a message to show, or
         * `null` when the sign-in succeeded.
         */
        const submit = async (): Promise<string | null> => {
            const result = mode === "up" ? await authClient.signUp.email({ email, name, password }) : await authClient.signIn.email({ email, password });

            return result?.error ? String(result.error.message ?? "could not sign in") : null;
        };

        try {
            const message = await submit();

            if (message) {
                setError(message);
            }
        } catch (cause: unknown) {
            // better-auth resolves most failures into `result.error`, but a
            // network fault rejects — without this the form just went quiet.
            setError(cause instanceof Error ? cause.message : "could not reach the server");
        }

        // After the catch, not in a `finally`: the React Compiler cannot lower a
        // finalizer, and the catch above cannot throw.
        setBusy(false);
    };

    return (
        <main className="signin">
            <h1>Lunora Team Chat</h1>

            <form
                className="card"
                onSubmit={(event) => {
                    event.preventDefault();
                    void onSubmit(new FormData(event.currentTarget));
                }}
            >
                {mode === "up" && <input aria-label="Display name" name="name" placeholder="Display name" />}
                <input required aria-label="Email" autoComplete="email" name="email" placeholder="you@example.com" type="email" />
                <input
                    required
                    aria-label="Password"
                    autoComplete={mode === "up" ? "new-password" : "current-password"}
                    minLength={8}
                    name="password"
                    placeholder="Password"
                    type="password"
                />

                {error && <p className="error">{error}</p>}

                <button className="primary" disabled={busy} type="submit">
                    {mode === "up" ? "Create account" : "Sign in"}
                </button>

                <button className="link" onClick={() => setMode(mode === "up" ? "in" : "up")} type="button">
                    {mode === "up" ? "I already have an account" : "Create an account"}
                </button>
            </form>
        </main>
    );
};
