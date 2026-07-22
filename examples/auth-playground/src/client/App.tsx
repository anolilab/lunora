import { AuthUIProvider, SignInCard, SignUpCard } from "@lunora/auth-ui/react";
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

// A no-op router bridge: this single-page demo swaps views off better-auth's
// reactive `useSession()`, so the cards don't need to navigate on success.
const nav = { navigate: (): void => {}, replace: (): void => {} };

/**
 * Sign-in / sign-up — now rendered with the copy-in `@lunora/auth-ui` React
 * screens (the same components `lunora add auth-ui` scaffolds) instead of
 * hand-rolled forms, wrapped in `<AuthUIProvider>` with the app's authClient.
 */
const SignedOutView = (): ReactElement => (
    <AuthUIProvider authClient={authClient} nav={nav}>
        <div style={{ display: "grid", gap: 24, maxWidth: 360 }}>
            <SignInCard />
            <SignUpCard />
        </div>
    </AuthUIProvider>
);

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
