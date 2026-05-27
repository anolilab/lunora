import { useAuth } from "@cirrus/react";
import type { FormEvent, ReactElement } from "react";
import { useState } from "react";

/**
 * Email/password sign-in + sign-up. Posts directly at the routes mounted
 * by `@cirrus/auth` (`/auth/signin`, `/auth/signup`) and stashes the
 * returned token via `useAuth().setToken()` so subsequent RPCs are
 * authenticated.
 */
export const Auth = (): ReactElement => {
    const { setToken } = useAuth();
    const [mode, setMode] = useState<"signin" | "signup">("signin");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState<string | null>(null);

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setError(null);

        try {
            const response = await fetch(`/auth/${mode}`, {
                body: JSON.stringify({ email, password, name }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });

            if (!response.ok) {
                throw new Error(`${mode} failed (${response.status})`);
            }

            const body = (await response.json()) as { token?: string };

            if (!body.token) {
                throw new Error("no token in response");
            }

            setToken(body.token);
        } catch (error_: unknown) {
            setError(error_ instanceof Error ? error_.message : "unknown error");
        }
    };

    return (
        <form onSubmit={submit} style={{ display: "grid", gap: 12, margin: "4rem auto", maxWidth: 320 }}>
            <h1>{mode === "signin" ? "Sign in" : "Sign up"}</h1>
            {mode === "signup" ? (
                <label>
                    Name
                    <input
                        onChange={(event) => {
                            setName(event.target.value);
                        }}
                        required
                        value={name}
                    />
                </label>
            ) : null}
            <label>
                Email
                <input
                    onChange={(event) => {
                        setEmail(event.target.value);
                    }}
                    required
                    type="email"
                    value={email}
                />
            </label>
            <label>
                Password
                <input
                    onChange={(event) => {
                        setPassword(event.target.value);
                    }}
                    required
                    type="password"
                    value={password}
                />
            </label>
            <button type="submit">{mode === "signin" ? "Sign in" : "Create account"}</button>
            <button
                onClick={() => {
                    setMode(mode === "signin" ? "signup" : "signin");
                }}
                type="button"
            >
                {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
            </button>
            {error ? <p role="alert">{error}</p> : null}
        </form>
    );
};
