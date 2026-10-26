import type { ReactElement, SyntheticEvent } from "react";
import { useState } from "react";

import { authClient } from "./auth-client";

/**
 * Email and password. Creating an account signs the new user in as well, so one form covers both. A refusal
 * from the sign-in service is shown as the message.
 */
export const SignIn = (): ReactElement => {
    const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-up");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | undefined>(undefined);
    const passwordAutocomplete = mode === "sign-up" ? "new-password" : "current-password"; // secret-scanner:allow -- an autocomplete hint, not a credential

    const submit = async (event: SyntheticEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setError(undefined);

        const result =
            mode === "sign-up" ? await authClient.signUp.email({ email, name: email, password }) : await authClient.signIn.email({ email, password });

        if (result.error) {
            setError(result.error.message ?? "Sign-in failed.");
        }
    };

    return (
        <main>
            <h1>{mode === "sign-up" ? "Create an account" : "Sign in"}</h1>

            <form
                onSubmit={(event) => {
                    void submit(event);
                }}
            >
                <label htmlFor="sign-in-email">
                    Email
                    <input
                        autoComplete="email"
                        id="sign-in-email"
                        onChange={(event) => {
                            setEmail(event.target.value);
                        }}
                        type="email"
                        value={email}
                    />
                </label>{" "}
                <label htmlFor="sign-in-password">
                    Password
                    <input
                        autoComplete={passwordAutocomplete}
                        id="sign-in-password"
                        onChange={(event) => {
                            setPassword(event.target.value);
                        }}
                        type="password"
                        value={password}
                    />
                </label>{" "}
                <button type="submit">{mode === "sign-up" ? "Create account" : "Sign in"}</button>
            </form>

            <button
                onClick={() => {
                    setMode(mode === "sign-up" ? "sign-in" : "sign-up");
                }}
                type="button"
            >
                {mode === "sign-up" ? "I already have an account" : "Create an account instead"}
            </button>

            {error === undefined ? undefined : <p role="alert">{error}</p>}
        </main>
    );
};
