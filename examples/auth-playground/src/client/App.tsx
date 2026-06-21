import type { FormEvent, ReactElement } from "react";
import { useEffect, useState } from "react";

import { authClient } from "./auth-client.js";

interface OrgRow {
    id: string;
    name: string;
    slug: string;
}

interface UserRow {
    banned?: boolean;
    email: string;
    id: string;
    name: string;
    role?: string;
}

/**
 * Auth-playground UI. Five flows demonstrate the better-auth plugin surface:
 *
 * 1. Sign-up / sign-in (email + password) using the core auth client.
 * 2. Create an organization (organizationClient).
 * 3. Invite a member by email (organizationClient).
 * 4. Admin panel: list users and ban offenders (adminClient).
 *
 * Everything is intentionally plain HTML / inline styles — the focus is on
 * showing which call goes where, not on UX polish.
 */
export const App = (): ReactElement => {
    const session = authClient.useSession();

    const isSignedIn = Boolean(session.data);

    return (
        <main style={{ maxWidth: 720, margin: "3rem auto", fontFamily: "system-ui", padding: 24 }}>
            <h1>Lunora Auth Playground</h1>
            <p>
                Demo of the <code>@lunora/auth</code> wrapper around better-auth's
                <code> organization</code> and <code>admin</code> plugins.
            </p>
            {isSignedIn ? <SignedInView /> : <SignedOutView />}
        </main>
    );
};

/** Sign-up / sign-in forms — shown when there's no active session. */
const SignedOutView = (): ReactElement => {
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [name, setName] = useState("");
    const [error, setError] = useState<null | string>(null);

    const onSignUp = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setError(null);

        const result = await authClient.signUp.email({ email, name, password });

        if (result.error) {
            setError(result.error.message ?? "sign-up failed");
        }
    };

    const onSignIn = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();
        setError(null);

        const result = await authClient.signIn.email({ email, password });

        if (result.error) {
            setError(result.error.message ?? "sign-in failed");
        }
    };

    return (
        <section>
            <h2>Sign in</h2>
            <form onSubmit={onSignIn} style={{ display: "grid", gap: 8, maxWidth: 320 }}>
                <input onChange={(event) => setEmail(event.target.value)} placeholder="email" type="email" value={email} />
                <input onChange={(event) => setPassword(event.target.value)} placeholder="password" type="password" value={password} />
                <button type="submit">Sign in</button>
            </form>

            <h2 style={{ marginTop: 24 }}>Or create an account</h2>
            <form onSubmit={onSignUp} style={{ display: "grid", gap: 8, maxWidth: 320 }}>
                <input onChange={(event) => setName(event.target.value)} placeholder="full name" value={name} />
                <input onChange={(event) => setEmail(event.target.value)} placeholder="email" type="email" value={email} />
                <input onChange={(event) => setPassword(event.target.value)} placeholder="password" type="password" value={password} />
                <button type="submit">Sign up</button>
            </form>

            {error ? <p style={{ color: "crimson", marginTop: 16 }}>{error}</p> : null}
        </section>
    );
};

/** Org management + admin panel — shown once a session is active. */
const SignedInView = (): ReactElement => {
    const session = authClient.useSession();
    const user = session.data?.user as undefined | { email: string; name: string; role?: string };

    const [orgs, setOrgs] = useState<OrgRow[]>([]);
    const [newOrgName, setNewOrgName] = useState("");
    const [inviteEmail, setInviteEmail] = useState("");
    const [activeOrgId, setActiveOrgId] = useState<null | string>(null);

    const refreshOrgs = async (): Promise<void> => {
        const result = await authClient.organization.list();

        setOrgs((result.data as OrgRow[] | undefined) ?? []);
    };

    useEffect(() => {
        void refreshOrgs();
    }, []);

    const onCreateOrg = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        const slug = newOrgName.trim().toLowerCase().replace(/\s+/g, "-");

        await authClient.organization.create({ name: newOrgName, slug });
        setNewOrgName("");
        await refreshOrgs();
    };

    const onInvite = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
        event.preventDefault();

        if (!activeOrgId) {
            return;
        }

        await authClient.organization.inviteMember({ email: inviteEmail, organizationId: activeOrgId, role: "member" });
        setInviteEmail("");
    };

    const onSignOut = async (): Promise<void> => {
        await authClient.signOut();
    };

    return (
        <section>
            <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <p>
                    Signed in as <strong>{user?.email}</strong>
                    {user?.role === "admin" ? " (admin)" : null}
                </p>
                <button onClick={() => void onSignOut()} type="button">
                    Sign out
                </button>
            </header>

            <h2 style={{ marginTop: 32 }}>Organizations</h2>
            <form onSubmit={onCreateOrg} style={{ display: "flex", gap: 8 }}>
                <input onChange={(event) => setNewOrgName(event.target.value)} placeholder="org name" style={{ flex: 1 }} value={newOrgName} />
                <button type="submit">Create org</button>
            </form>
            <ul style={{ listStyle: "none", padding: 0, marginTop: 16 }}>
                {orgs.map((org) => (
                    <li key={org.id} style={{ padding: 8, border: "1px solid #ddd", marginBottom: 8 }}>
                        <strong>{org.name}</strong> <code style={{ color: "#666" }}>{org.slug}</code>{" "}
                        <button onClick={() => setActiveOrgId(org.id)} style={{ marginLeft: 8 }} type="button">
                            {activeOrgId === org.id ? "selected" : "select"}
                        </button>
                    </li>
                ))}
            </ul>

            {activeOrgId ? (
                <>
                    <h3>Invite a member</h3>
                    <form onSubmit={onInvite} style={{ display: "flex", gap: 8 }}>
                        <input
                            onChange={(event) => setInviteEmail(event.target.value)}
                            placeholder="invitee@example.com"
                            style={{ flex: 1 }}
                            type="email"
                            value={inviteEmail}
                        />
                        <button type="submit">Send invite</button>
                    </form>
                </>
            ) : null}

            {user?.role === "admin" ? <AdminPanel /> : null}
        </section>
    );
};

/** Lists every user and lets the admin ban or unban them. */
const AdminPanel = (): ReactElement => {
    const [users, setUsers] = useState<UserRow[]>([]);

    const refresh = async (): Promise<void> => {
        const result = await authClient.admin.listUsers({ query: {} });

        setUsers(((result.data as { users?: UserRow[] } | undefined)?.users ?? []) as UserRow[]);
    };

    useEffect(() => {
        void refresh();
    }, []);

    const onBan = async (userId: string): Promise<void> => {
        await authClient.admin.banUser({ banReason: "spam", userId });
        await refresh();
    };

    const onUnban = async (userId: string): Promise<void> => {
        await authClient.admin.unbanUser({ userId });
        await refresh();
    };

    return (
        <section style={{ marginTop: 32, padding: 16, border: "2px solid #b22222" }}>
            <h2>Admin panel</h2>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                    <tr>
                        <th style={{ textAlign: "left" }}>Email</th>
                        <th style={{ textAlign: "left" }}>Role</th>
                        <th style={{ textAlign: "left" }}>Status</th>
                        <th />
                    </tr>
                </thead>
                <tbody>
                    {users.map((user) => (
                        <tr key={user.id}>
                            <td>{user.email}</td>
                            <td>{user.role ?? "user"}</td>
                            <td>{user.banned ? <span style={{ color: "crimson" }}>banned</span> : "ok"}</td>
                            <td>
                                {user.banned ? (
                                    <button onClick={() => void onUnban(user.id)} type="button">
                                        Unban
                                    </button>
                                ) : (
                                    <button onClick={() => void onBan(user.id)} type="button">
                                        Ban
                                    </button>
                                )}
                            </td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </section>
    );
};
