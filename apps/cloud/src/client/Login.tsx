import type { ReactElement } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

import { authClient } from "./auth-client";
import { COLUMN_LABEL, Field, FormError } from "./section-ui";

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
 *
 * Layout: this is the one screen outside the dashboard shell, so it is composed
 * rather than boxed — a deliberately asymmetric split with the wordmark floating
 * on the background (never boxed, per the container strategy) and the form pinned
 * to a narrow right-hand column behind a single hairline. Three layers: the
 * wordmark is primary at display size, the form is secondary, and the mode
 * switch, eyebrow, footer and error line are tertiary in mono caps. The screen's
 * one moment of surprise is the aurora ribbon on "Cloud" plus the single
 * atmospheric violet glow behind it — the whole budget spent in one place.
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
    const [error, setError] = useState<null | string>(null);
    const [pending, setPending] = useState(false);

    const modeLabel = mode === "signin" ? "Sign in" : "Create account";
    const submitLabel = pending ? "…" : modeLabel;

    return (
        <main className="bg-background text-foreground grid min-h-svh grid-cols-1 lg:grid-cols-[minmax(0,1fr)_minmax(0,26rem)]">
            <section className="relative flex flex-col justify-between overflow-hidden px-8 py-12 lg:px-16 lg:py-16">
                {/* The one atmospheric glow allowed per view — aurora violet, soft, behind the wordmark. */}
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -top-56 -left-48 size-[44rem] opacity-20 blur-[140px]"
                    style={{ background: "radial-gradient(circle, var(--aurora-violet), transparent 70%)" }}
                />
                <p className={cn(COLUMN_LABEL, "text-muted-foreground relative")}>Control plane</p>
                <h1 className="relative my-16 text-[clamp(3rem,9vw,5.5rem)] leading-[0.92] font-light tracking-[-0.035em]">
                    Lunora
                    <br />
                    <span className="bg-clip-text text-transparent" style={{ backgroundImage: "var(--aurora-ribbon)" }}>
                        Cloud
                    </span>
                </h1>
                <p className={cn(COLUMN_LABEL, "text-muted-foreground relative")}>Workers · Durable Objects · D1</p>
            </section>

            <section className="border-border flex flex-col justify-center border-t px-8 py-12 lg:border-t-0 lg:border-l lg:px-12">
                <form
                    action={() => {
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
                    className="grid w-full max-w-sm gap-5"
                >
                    <div className="grid gap-1">
                        <p className={cn(COLUMN_LABEL, "text-muted-foreground")}>{modeLabel}</p>
                        <h2 className="m-0 text-xl font-medium">{mode === "signin" ? "Sign in to your control plane" : "Create your account"}</h2>
                    </div>
                    {mode === "signup" ? (
                        <Field htmlFor="login-name" label="Name">
                            <Input
                                id="login-name"
                                onChange={(event) => {
                                    setName(event.target.value);
                                }}
                                value={name}
                            />
                        </Field>
                    ) : null}
                    <Field htmlFor="login-email" label="Email">
                        <Input
                            autoComplete="email"
                            className="font-mono"
                            id="login-email"
                            onChange={(event) => {
                                setEmail(event.target.value);
                            }}
                            required
                            type="email"
                            value={email}
                        />
                    </Field>
                    <Field htmlFor="login-password" label="Password">
                        <Input
                            autoComplete={mode === "signin" ? "current-password" : "new-password"}
                            className="font-mono"
                            id="login-password"
                            minLength={8}
                            onChange={(event) => {
                                setPassword(event.target.value);
                            }}
                            required
                            type="password"
                            value={password}
                        />
                    </Field>
                    <Button className="w-full" disabled={pending} type="submit">
                        {submitLabel}
                    </Button>
                    <Button
                        className={cn(COLUMN_LABEL, "text-muted-foreground hover:text-foreground h-auto justify-self-start p-0 no-underline")}
                        onClick={() => {
                            setMode(mode === "signin" ? "signup" : "signin");
                            setError(null);
                        }}
                        type="button"
                        variant="link"
                    >
                        {mode === "signin" ? "Need an account? Sign up" : "Have an account? Sign in"}
                    </Button>
                    <FormError message={error} />
                </form>
            </section>
        </main>
    );
};
