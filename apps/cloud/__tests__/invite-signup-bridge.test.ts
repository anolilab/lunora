import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The org-invite → sign-up-invitation bridge (`POST /v1/invitations/send`).
 *
 * Registration is invite-only, so an org invitation to someone with no account
 * is a dead end on its own: accepting needs a session and they cannot create
 * one. The route closes that by minting a sign-up invitation alongside — but
 * only for an address that has no account, because a second invitation is a
 * second account rather than a faster route into the org. That branch is the
 * security-relevant half, and it is what these pin.
 *
 * `../src/auth` is mocked rather than stood up: the real module builds a
 * better-auth instance against D1 and runs a schema migration, and none of that
 * is what is under test here.
 */

const findOne = vi.fn<(query: { model: string; where: { field: string; value: unknown }[] }) => Promise<unknown>>();
const currentAuth = vi.fn<() => unknown>();
const createSignUpInvitation = vi.fn<(auth: unknown, input: { email: string }) => Promise<{ email: string; token: string }>>();
const send = vi.fn<(message: { text: string; to: string }) => Promise<void>>();
const ensureAuth = vi.fn<() => Promise<never>>();

/*
 * String specifiers, not `vi.mock(import(...))`. The typed form makes the
 * factory's return have to satisfy the real module type — which for
 * `currentAuth` means producing an actual `LunoraAuth`, i.e. standing up
 * better-auth against D1, which is the whole thing these mocks exist to avoid.
 */
// eslint-disable-next-line vitest/prefer-import-in-mock -- see above
vi.mock("../src/auth", () => {
    return { currentAuth, ensureAuth };
});

// eslint-disable-next-line vitest/prefer-import-in-mock -- see above
vi.mock("@lunora/auth", async (importOriginal) => {
    return { ...(await importOriginal<Record<string, unknown>>()), createSignUpInvitation };
});

// eslint-disable-next-line vitest/prefer-import-in-mock -- see above
vi.mock("@lunora/mail", async (importOriginal) => {
    return {
        ...(await importOriginal<Record<string, unknown>>()),
        createMailerFromEnv: () => {
            return { send };
        },
    };
});

const { createDeployRouter } = await import("../src/deploy/router");

/** The injected action-context ports, shaped like `router.test.ts`'s. */
type ActionPort = (reference: unknown, args?: Record<string, unknown>) => Promise<unknown>;

/** The worker normally injects this; the route reads `runMutation` off it. */
const environment = (): Record<string, unknown> => {
    return {
        __lunoraCtx: {
            runAction: vi.fn<ActionPort>(),
            runMutation: vi.fn<ActionPort>().mockResolvedValue({ id: "inv_1", token: "org-token" }),
            runQuery: vi.fn<ActionPort>(),
        },
        MAIL_FROM: "Lunora <noreply@lunora.test>",
    };
};

const invite = (): Request =>
    new Request("https://control.lunora.app/v1/invitations/send", {
        body: JSON.stringify({ email: "Ada@Example.com", organizationId: "org_1" }),
        headers: { "cf-connecting-ip": "client-a", "content-type": "application/json" },
        method: "POST",
    });

describe("pOST /v1/invitations/send — the sign-up bridge", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        currentAuth.mockReturnValue({ $context: Promise.resolve({ adapter: { findOne } }) });
        createSignUpInvitation.mockResolvedValue({ email: "ada@example.com", token: "sign-up-token" });
    });

    it("mints a sign-up invitation for an address with no account, and leads the mail with it", async () => {
        expect.assertions(4);

        findOne.mockResolvedValue(null);

        const response = await createDeployRouter().fetch(invite(), environment());

        expect(response.status).toBe(200);
        expect(createSignUpInvitation).toHaveBeenCalledWith(expect.anything(), { email: "Ada@Example.com" });

        const body = send.mock.calls.at(-1)?.[0].text ?? "";

        expect(body).toContain("/login?email=ada%40example.com&invite=sign-up-token");
        // Sign up before accept: accepting needs a session, so an invitee sent to
        // the accept link first lands on a screen that bounces them.
        expect(body.indexOf("/login?")).toBeLessThan(body.indexOf("/accept-invite"));
    });

    it("mints nothing for an address that already has an account", async () => {
        expect.assertions(3);

        findOne.mockResolvedValue({ id: "user_1" });

        const response = await createDeployRouter().fetch(invite(), environment());

        expect(response.status).toBe(200);
        expect(createSignUpInvitation).not.toHaveBeenCalled();
        expect(send.mock.calls.at(-1)?.[0].text ?? "").not.toContain("/login?");
    });

    it("looks the address up case-insensitively, so a capitalised invite finds the existing account", async () => {
        expect.assertions(1);

        findOne.mockResolvedValue({ id: "user_1" });

        await createDeployRouter().fetch(invite(), environment());

        expect(findOne).toHaveBeenCalledWith({ model: "user", where: [{ field: "email", value: "ada@example.com" }] });
    });

    it("still sends the org invitation when auth has not booted, rather than failing the route", async () => {
        expect.assertions(3);

        currentAuth.mockReturnValue(null);

        const response = await createDeployRouter().fetch(invite(), environment());

        expect(response.status).toBe(200);
        expect(createSignUpInvitation).not.toHaveBeenCalled();
        expect(send.mock.calls.at(-1)?.[0].text ?? "").toContain("/accept-invite");
    });
});
