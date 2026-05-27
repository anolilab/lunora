import { useAuth } from "@cirrus/react";
import type { FormEvent, ReactElement } from "react";
import { useState } from "react";

/**
 * Minimal email/password sign-in form for the playground. Real apps would
 * call the `/auth/signin` endpoint mounted by `@cirrus/auth` and store the
 * returned token via `useAuth().setToken(...)`. Here we keep the form
 * client-side only so the smoke build doesn't depend on a live D1.
 */
export const Login = (): ReactElement => {
    const { setToken } = useAuth();
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [error, setError] = useState<string | null>(null);

    const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setError(null);

        try {
            const response = await fetch("/auth/signin", {
                body: JSON.stringify({ email, password }),
                headers: { "content-type": "application/json" },
                method: "POST",
            });

            if (!response.ok) {
                throw new Error(`sign-in failed (${response.status})`);
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
            <h1>Sign in</h1>
            <label>
                Email
                <input
                    onChange={(e) => {
                        setEmail(e.target.value);
                    }}
                    required
                    type="email"
                    value={email}
                />
            </label>
            <label>
                Password
                <input
                    onChange={(e) => {
                        setPassword(e.target.value);
                    }}
                    required
                    type="password"
                    value={password}
                />
            </label>
            <button type="submit">Sign in</button>
            {error ? <p role="alert">{error}</p> : null}
        </form>
    );
};
