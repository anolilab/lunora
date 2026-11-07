import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useId, useState } from "react";

import { api } from "../../lunora/_generated/api";
import type { Id } from "../../lunora/_generated/dataModel";
import { authClient } from "./auth-client";

/*
 * A deliberately thin client: enough to sign up, create an organisation and
 * drive the core tasks surface by hand. The bench measures the server; this page
 * exists so `lunora dev` is a working app and not just a Worker.
 */

const field = (form: FormData, name: string): string => {
    const value = form.get(name);

    return typeof value === "string" ? value : "";
};

/** Verifies one code with the method the user picked: an app code, an email code, or a backup code. */
const verifyCode = (method: string, code: string) => {
    if (method === "otp") {
        return authClient.twoFactor.verifyOtp({ code });
    }

    if (method === "backup") {
        return authClient.twoFactor.verifyBackupCode({ code });
    }

    return authClient.twoFactor.verifyTotp({ code });
};

/**
 * The second step of a password sign-in for an account with two-factor enabled. The
 * password call creates no session until this one succeeds, so the page reloads only
 * after it.
 */
const SecondFactor = (): ReactElement => {
    const [error, setError] = useState<string>();
    const codeId = useId();

    const submit = async (form: FormData): Promise<void> => {
        const result = await verifyCode(field(form, "method"), field(form, "code"));

        if (result.error) {
            setError(result.error.message ?? "verification failed");

            return;
        }

        globalThis.location.reload();
    };

    const emailCode = async (): Promise<void> => {
        const result = await authClient.twoFactor.sendOtp();

        setError(result.error ? (result.error.message ?? "could not send a code") : undefined);
    };

    return (
        <form action={submit}>
            <h1>Two-factor verification</h1>
            <label htmlFor={codeId}>
                Code
                <input autoComplete="one-time-code" id={codeId} name="code" required />
            </label>
            <button name="method" type="submit" value="totp">
                Verify app code
            </button>
            <button name="method" type="submit" value="otp">
                Verify email code
            </button>
            <button name="method" type="submit" value="backup">
                Use backup code
            </button>
            <button onClick={() => void emailCode()} type="button">
                Email me a code
            </button>
            {error === undefined ? undefined : <p role="alert">{error}</p>}
        </form>
    );
};

const SignIn = (): ReactElement => {
    const [error, setError] = useState<string>();
    const [needsSecondFactor, setNeedsSecondFactor] = useState(false);
    const emailId = useId();
    const passwordId = useId();

    const submit = async (form: FormData): Promise<void> => {
        const email = field(form, "email");
        const password = field(form, "password");
        const result =
            field(form, "mode") === "up"
                ? await authClient.signUp.email({ email, name: email.split("@")[0] ?? email, password })
                : await authClient.signIn.email({ email, password });

        if (result.error) {
            setError(result.error.message ?? "sign-in failed");

            return;
        }

        // Better Auth answers a password sign-in for a two-factor account with a redirect instead of a session.
        if ("twoFactorRedirect" in result.data) {
            setNeedsSecondFactor(true);

            return;
        }

        globalThis.location.reload();
    };

    const signInWithPasskey = async (): Promise<void> => {
        const result = await authClient.signIn.passkey();

        if (result.error) {
            setError(result.error.message ?? "passkey sign-in failed");

            return;
        }

        globalThis.location.reload();
    };

    if (needsSecondFactor) {
        return <SecondFactor />;
    }

    return (
        <form action={submit}>
            <h1>Lunora bench</h1>
            <label htmlFor={emailId}>
                Email
                <input autoComplete="email" id={emailId} name="email" required type="email" />
            </label>
            <label htmlFor={passwordId}>
                Password
                <input autoComplete="current-password" id={passwordId} minLength={8} name="password" required type="password" />
            </label>
            <button name="mode" type="submit" value="in">
                Sign in
            </button>
            <button name="mode" type="submit" value="up">
                Sign up
            </button>
            <button onClick={() => void signInWithPasskey()} type="button">
                Sign in with a passkey
            </button>
            {error === undefined ? undefined : <p role="alert">{error}</p>}
        </form>
    );
};

const CreateOrganization = (): ReactElement => {
    const [error, setError] = useState<string | undefined>(undefined);
    const submit = async (form: FormData): Promise<void> => {
        const name = field(form, "name");
        const created = await authClient.organization.create({ name, slug: name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-") });

        if (created.error) {
            setError(created.error.message ?? "The organization could not be created. Try again.");

            return;
        }

        if (created.data) {
            await authClient.organization.setActive({ organizationId: created.data.id });
            globalThis.location.reload();
        }
    };

    return (
        <form action={submit}>
            <h1>Create an organization</h1>
            <label htmlFor="organization-name">
                Name
                <input id="organization-name" name="name" placeholder="Acme" required />
            </label>
            <button type="submit">Create</button>
            {error === undefined ? undefined : <p role="alert">{error}</p>}
        </form>
    );
};

const Tasks = ({ organizationId }: { organizationId: string }): ReactElement => {
    // Every org-scoped call names the tenant's shard; `authorizeShard` refuses any other.
    const shard = { shardKey: organizationId };
    const tasks = useQuery(api.tasks.list, {}, shard);
    const { mutate: create } = useMutation(api.tasks.create);
    const { mutate: update } = useMutation(api.tasks.update);

    const submit = async (form: FormData): Promise<void> => {
        await create({ labels: [], title: field(form, "title") }, shard);
    };

    const complete = (id: Id<"tasks">): void => {
        void update({ id, status: "done" }, shard);
    };

    return (
        <main>
            <form action={submit}>
                <label htmlFor="task-title">
                    New task
                    <input id="task-title" name="title" required />
                </label>
                <button type="submit">Add</button>
            </form>
            <ul>
                {(tasks?.page ?? []).map((task) => (
                    <li key={task._id}>
                        {task.title} — {task.status}{" "}
                        {task.status === "done" ? undefined : (
                            <button
                                onClick={() => {
                                    complete(task._id);
                                }}
                                type="button"
                            >
                                Mark done
                            </button>
                        )}
                    </li>
                ))}
            </ul>
        </main>
    );
};

/**
 * The landing page of an invitation email, shown to a signed-in user. Accepting
 * joins the organisation, and the page navigates home only once it is active; if
 * activation fails, the accepted organisation is kept so activation can be retried.
 */
const AcceptInvitation = (): ReactElement => {
    const [organizationId, setOrganizationId] = useState<string | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const invitationId = new URLSearchParams(globalThis.location.search).get("id");

    const activate = async (id: string): Promise<void> => {
        const activated = await authClient.organization.setActive({ organizationId: id });

        if (activated.error) {
            setError(activated.error.message ?? "The organisation could not be made active. Try again.");

            return;
        }

        globalThis.location.assign("/");
    };

    const accept = async (): Promise<void> => {
        if (invitationId === null) {
            setError("This invitation link has no invitation id.");

            return;
        }

        const accepted = await authClient.organization.acceptInvitation({ invitationId });
        const accepting = accepted.data?.member.organizationId;

        if (accepted.error || accepting === undefined) {
            setError(accepted.error?.message ?? "The invitation could not be accepted. Sign in with the invited address, then try again.");

            return;
        }

        setOrganizationId(accepting);
        await activate(accepting);
    };

    return (
        <main>
            <h1>Accept invitation</h1>
            {organizationId === undefined ? (
                <button type="button" onClick={() => void accept()}>
                    Accept
                </button>
            ) : (
                <button type="button" onClick={() => void activate(organizationId)}>
                    Open the organisation
                </button>
            )}
            {error === undefined ? undefined : <p role="alert">{error}</p>}
        </main>
    );
};

export const App = (): ReactElement => {
    const [signedOut, setSignedOut] = useState(false);
    const me = useQuery(
        api.saas.me,
        {},
        {
            onError: () => {
                setSignedOut(true);
            },
        },
    );

    if (me === undefined && !signedOut) {
        return <main aria-busy="true" />;
    }

    if (!me) {
        return <SignIn />;
    }

    // Signed out, an invitation opens the sign-in above; sign-in reloads this path, so the invitation resumes here.
    if (globalThis.location.pathname === "/accept-invitation") {
        return <AcceptInvitation />;
    }

    if (!me.organizationId) {
        return <CreateOrganization />;
    }

    return <Tasks organizationId={me.organizationId} />;
};
