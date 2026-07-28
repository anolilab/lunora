import type { ReactElement, ReactNode } from "react";
import { createContext, use, useCallback, useState } from "react";

import { cn } from "@/lib/utils";

import { authClient } from "../../lunora/auth-ui/client";
import type { AuthClient } from "../../lunora/auth-ui/core";
import { AuthUIProvider, SignInCard, SignUpCard } from "../../lunora/auth-ui/react";
import { COLUMN_LABEL } from "./section-ui";

/**
 * Sign-in / sign-up for the hosted studio.
 *
 * The FORM is the copy-in auth UI (`lunora/auth-ui`, added with
 * `lunora add auth-ui`) rather than hand-rolled markup: it already implements what
 * this app would otherwise rewrite by hand — validation, mapped error messages,
 * pending state, social buttons, and the magic-link / email-OTP / 2FA cards that
 * light up once their server item is installed and toggled in `client.ts`.
 *
 * The LAYOUT stays ours, because this renders outside the dashboard shell and is
 * the app's first impression: an asymmetric split with the wordmark floating
 * unboxed on the left and the card behind a single hairline on the right. The
 * atmospheric glow and the aurora ribbon on "Cloud" are the whole surprise budget
 * for this view.
 *
 * There is exactly one `authClient` in the app — `src/client/auth-client.ts`
 * re-exports this same instance — so the card and the dashboard can never hold
 * divergent views of the session.
 *
 * Navigation stays the caller's business: the `/login` route passes `onSignedIn`,
 * which it uses to do a FULL load to its validated redirect target, guaranteeing
 * the new cookie is on the SSR request. The cards navigate through the provider's
 * `nav` bridge, so every post-auth navigation is routed back into `onSignedIn`
 * rather than the card deciding for itself.
 */
interface LoginProps {
    /** Called after a successful sign-in / sign-up, once the session cookie is set. */
    onSignedIn?: () => void;
}

/** Sentinel hrefs for the cards' "switch mode" footer links — see {@link ModeLink}. */
const SIGN_UP_HREF = "#sign-up";
const SIGN_IN_HREF = "#sign-in";

/**
 * Lets {@link ModeLink} reach the screen's mode setter.
 *
 * A context rather than a closure because the provider takes a `Link` COMPONENT,
 * and defining that component inside `Login` would both re-create its identity on
 * every render (remounting the footer link) and break
 * `react-x/no-nested-component-definitions`.
 */
const ModeContext = createContext<((mode: "signin" | "signup") => void) | null>(null);

/**
 * The cards link to standalone `/sign-up` and `/sign-in` routes; this app has
 * neither — it toggles one screen. Intercepting the two sentinel hrefs keeps the
 * cards' own footer affordance working without inventing routes for it.
 */
const ModeLink = ({ children, className, href }: { children: ReactNode; className?: string; href: string }): ReactElement => {
    const setMode = use(ModeContext);

    return (
        <button
            className={cn(className, "cursor-pointer bg-transparent underline underline-offset-4")}
            onClick={() => {
                setMode?.(href === SIGN_UP_HREF ? "signup" : "signin");
            }}
            type="button"
        >
            {children}
        </button>
    );
};

export const Login = ({ onSignedIn }: LoginProps = {}): ReactElement => {
    const [mode, setMode] = useState<"signin" | "signup">("signin");

    // Every post-auth navigation the cards attempt funnels into `onSignedIn`: the
    // route owns where to go (it validated the `?redirect=` target) and how to get
    // there (a full load, so the cookie reaches the server render).
    const handleNavigate = useCallback(() => {
        onSignedIn?.();
    }, [onSignedIn]);

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

            <section className="flex items-center border-t px-8 py-12 lg:border-t-0 lg:border-l lg:px-10">
                <ModeContext value={setMode}>
                    <div className="mx-auto w-full max-w-sm">
                        <AuthUIProvider
                            // `createAuthClient` returns a dynamic-path PROXY: every method
                            // resolves at runtime, but the static type carries only the core
                            // surface, so it structurally "lacks" the plugin methods. The
                            // registry documents this in `client.ts` — it is why
                            // `registerAuthClientPlugins` has to be told which flows exist
                            // rather than the cards introspecting the client. Which flows are
                            // real is decided by `AUTH_PLUGINS`, now matched to the server.
                            authClient={authClient as unknown as AuthClient}
                            Link={ModeLink}
                            nav={{ navigate: handleNavigate, replace: handleNavigate }}
                            redirects={{ afterSignIn: "/" }}
                        >
                            {mode === "signin" ? <SignInCard signUpHref={SIGN_UP_HREF} /> : <SignUpCard signInHref={SIGN_IN_HREF} />}
                        </AuthUIProvider>
                    </div>
                </ModeContext>
            </section>
        </main>
    );
};
