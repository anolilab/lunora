import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuthClient, AuthResponse, AuthUIConfig } from "../../src/core";
import { resetAuthConfigDiscovery, resetFlowWarnings } from "../../src/core";
import { AuthUIProvider, AvatarCard, LinkedAccountsCard, UserButton } from "../../src/react";

const ok = <T,>(data: T = null as T): Promise<AuthResponse<T>> => Promise.resolve({ data, error: null });

const stubClient = (overrides: Partial<Record<string, unknown>> = {}): AuthClient =>
    ({
        getSession: vi.fn(() => ok({ user: { email: "ada@example.com", name: "Ada Lovelace" } })),
        linkSocial: vi.fn(() => ok({})),
        listAccounts: vi.fn(() => ok([{ accountId: "1", id: "a1", providerId: "github" }])),
        signOut: vi.fn(() => ok({ success: true })),
        unlinkAccount: vi.fn(() => ok({ status: true })),
        updateUser: vi.fn(() => ok({ status: true })),
        ...overrides,
    }) as unknown as AuthClient;

const renderWith = (client: AuthClient, node: ReactElement, config: Partial<AuthUIConfig> = {}): void => {
    render(
        // `discover={false}` keeps these render tests off the network; discovery
        // itself is covered in __tests__/core/discovery.test.ts.
        <AuthUIProvider authClient={client} avatar={config.avatar} discover={false} nav={{ navigate: vi.fn(), replace: vi.fn() }} social={config.social}>
            {node}
        </AuthUIProvider>,
    );
};

// eslint-disable-next-line vitest/require-top-level-describe -- one cross-suite teardown hook belongs at the top level.
afterEach(() => {
    resetFlowWarnings();
    resetAuthConfigDiscovery();
});

describe("userButton", () => {
    it("renders the signed-in user's name once the session settles", async () => {
        expect.assertions(1);

        renderWith(stubClient(), <UserButton />);

        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Ada Lovelace" }).getAttribute("aria-haspopup")).toBe("true");
        });
    });

    it("opens and closes the menu, keeping aria-expanded honest", async () => {
        expect.assertions(3);

        renderWith(stubClient(), <UserButton />);

        const trigger = await screen.findByRole("button", { name: "Ada Lovelace" });

        expect(trigger.getAttribute("aria-expanded")).toBe("false");

        fireEvent.click(trigger);

        expect(trigger.getAttribute("aria-expanded")).toBe("true");

        fireEvent.keyDown(document, { key: "Escape" });

        expect(trigger.getAttribute("aria-expanded")).toBe("false");
    });

    it("offers sign-in rather than an empty slot when nobody is signed in", async () => {
        expect.assertions(1);

        renderWith(stubClient({ getSession: vi.fn(() => ok({})) }), <UserButton />);

        await waitFor(() => {
            expect(screen.getByRole("link").textContent).toBe("Sign in");
        });
    });

    it("renders nothing when signed out and asked to stay hidden", async () => {
        expect.assertions(1);

        const client = stubClient({ getSession: vi.fn(() => ok({})) });

        renderWith(client, <UserButton hideWhenSignedOut />);

        await waitFor(() => {
            expect(screen.queryByRole("link")).toBeNull();
        });
    });
});

describe("linkedAccountsCard", () => {
    it("will not offer to unlink the only remaining account", async () => {
        expect.assertions(1);

        // Unlinking the last one locks the user out. The button exists so the
        // reason is visible, but it must be disabled rather than fail on submit.
        renderWith(stubClient(), <LinkedAccountsCard />);

        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Remove" }).hasAttribute("disabled")).toBe(true);
        });
    });

    it("hides unlink for the credential row, which is the password not a link", async () => {
        expect.assertions(1);

        const client = stubClient({
            listAccounts: vi.fn(() =>
                ok([
                    { accountId: "1", id: "a1", providerId: "credential" },
                    { accountId: "2", id: "a2", providerId: "github" },
                ]),
            ),
        });

        renderWith(client, <LinkedAccountsCard />);

        await waitFor(() => {
            // Two rows, one unlink button — the credential row has none.
            expect(screen.getAllByRole("button", { name: "Remove" })).toHaveLength(1);
        });
    });

    it("offers only the providers that are not already linked", async () => {
        expect.assertions(2);

        renderWith(stubClient(), <LinkedAccountsCard />, { social: ["github", "google"] });

        await waitFor(() => {
            expect(screen.getByRole("button", { name: "Link account: Google" }).tagName).toBe("BUTTON");
        });

        expect(screen.queryByRole("button", { name: "Link account: GitHub" })).toBeNull();
    });
});

describe("avatarCard", () => {
    it("renders nothing when the app configured no upload handler", () => {
        expect.assertions(1);

        renderWith(stubClient(), <AvatarCard />);

        // Without somewhere to put the bytes there is no upload to offer, and
        // <ProfileCard>'s URL field is the honest fallback.
        expect(screen.queryByRole("button", { name: "Upload photo" })).toBeNull();
    });

    it("uploads a picked file and stores the returned URL", async () => {
        expect.assertions(2);

        const upload = vi.fn(() => Promise.resolve("https://cdn.example.com/a.png"));
        const client = stubClient();

        renderWith(client, <AvatarCard />, { avatar: { upload } });

        const file = new File(["x"], "a.png", { type: "image/png" });

        fireEvent.change(screen.getByLabelText("Upload photo"), { target: { files: [file] } });

        await waitFor(() => {
            expect(upload).toHaveBeenCalledWith(file);
        });

        expect(client.updateUser).toHaveBeenCalledWith({ image: "https://cdn.example.com/a.png" });
    });

    it("rejects an oversized file before spending the upload", async () => {
        expect.assertions(2);

        const upload = vi.fn(() => Promise.resolve("nope"));
        const client = stubClient();

        renderWith(client, <AvatarCard />, { avatar: { maxSize: 10, upload } });

        fireEvent.change(screen.getByLabelText("Upload photo"), {
            target: { files: [new File(["much-larger-than-ten-bytes"], "a.png", { type: "image/png" })] },
        });

        await waitFor(() => {
            expect(screen.getByRole("alert").textContent).toContain("too large");
        });

        expect(upload).not.toHaveBeenCalled();
    });
});
