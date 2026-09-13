import type { ReactElement } from "react";
import { useState } from "react";

import { authClient } from "./auth-client.js";

/**
 * One text field out of a `FormData`.
 *
 * `FormData.get` is typed `string | File | null`, so `String(form.get(name) ?? "")`
 * stringifies a `File` to `"[object File]"` — a file input sharing a text field's
 * name would submit that verbatim. Narrowing instead yields `""` for anything
 * that is not text.
 */
const textField = (form: FormData, name: string): string => {
    const value = form.get(name);

    return typeof value === "string" ? value : "";
};

/** Email + password, both flows on one card. Deliberately plain — the chat is the subject here. */
export const SignIn = (): ReactElement => {
    const [mode, setMode] = useState<"in" | "up">("in");

    // Hoisted out of the JSX so it can carry the suppression below: a comment is
    // not valid in attribute position. These are the standard HTML autocomplete
    // tokens that tell a password manager whether to offer a saved credential or
    // generate a new one — dropping them to quiet the scanner would be a real
    // regression for anyone using one.
    const autoCompleteToken = mode === "up" ? "new-password" : "current-password"; // secret-scanner:allow
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const onSubmit = async (form: FormData): Promise<void> => {
        setBusy(true);
        setError(null);

        const email = textField(form, "email");
        const password = textField(form, "password");
        const name = textField(form, "name").trim() || email.split("@")[0];

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
        } catch (error_: unknown) {
            // better-auth resolves most failures into `result.error`, but a
            // network fault rejects — without this the form just went quiet.
            setError(error_ instanceof Error ? error_.message : "could not reach the server");
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
                <input aria-label="Email" autoComplete="email" name="email" placeholder="you@example.com" required type="email" />
                <input aria-label="Password" autoComplete={autoCompleteToken} minLength={8} name="password" placeholder="Password" required type="password" />

                {error && <p className="error">{error}</p>}

                <button className="primary" disabled={busy} type="submit">
                    {mode === "up" ? "Create account" : "Sign in"}
                </button>

                <button
                    className="link"
                    onClick={() => {
                        setMode(mode === "up" ? "in" : "up");
                    }}
                    type="button"
                >
                    {mode === "up" ? "I already have an account" : "Create an account"}
                </button>
            </form>
        </main>
    );
};
