import { useMutation, useQuery } from "@lunora/react";
import type { ReactElement } from "react";
import { useState } from "react";

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

const SignIn = (): ReactElement => {
    const [error, setError] = useState<string>();

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

        globalThis.location.reload();
    };

    return (
        <form action={submit}>
            <h1>Lunora bench</h1>
            <input autoComplete="email" name="email" placeholder="email" required type="email" />
            <input autoComplete="current-password" minLength={8} name="password" placeholder="password" required type="password" />
            <button name="mode" type="submit" value="in">
                Sign in
            </button>
            <button name="mode" type="submit" value="up">
                Sign up
            </button>
            {error === undefined ? undefined : <p role="alert">{error}</p>}
        </form>
    );
};

const CreateOrganization = (): ReactElement => {
    const submit = async (form: FormData): Promise<void> => {
        const name = field(form, "name");
        const created = await authClient.organization.create({ name, slug: name.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-") });

        if (created.data) {
            await authClient.organization.setActive({ organizationId: created.data.id });
            globalThis.location.reload();
        }
    };

    return (
        <form action={submit}>
            <h1>Create an organization</h1>
            <input name="name" placeholder="Acme" required />
            <button type="submit">Create</button>
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
                <input name="title" placeholder="New task" required />
                <button type="submit">Add</button>
            </form>
            <ul>
                {(tasks ?? []).map((task) => (
                    <li key={task._id}>
                        {task.title} — {task.status}{" "}
                        {task.status === "done" ? undefined : (
                            <button
                                onClick={() => {
                                    complete(task._id);
                                }}
                                type="button"
                            >
                                Done
                            </button>
                        )}
                    </li>
                ))}
            </ul>
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

    if (!me.organizationId) {
        return <CreateOrganization />;
    }

    return <Tasks organizationId={me.organizationId} />;
};
