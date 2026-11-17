import { extractLink, waitForMail } from "@lunora/mail/testing";
import type { BrowserContext } from "@playwright/test";
import { expect, test } from "@playwright/test";

/**
 * The kit's first five minutes, end to end: an owner signs up, verifies, creates
 * an organization and a project; a teammate is invited, signs up, accepts — and
 * lands in the same tenant, seeing the owner's project live and without the
 * owner's write controls.
 *
 * Auth is driven through better-auth's HTTP API rather than through screens,
 * because the template ships the auth server but not the screens (`lunora add
 * auth-ui` adds those, and `auth-ui-screens.spec.ts` covers them). What this
 * spec owns is the kit's half: that a better-auth organization becomes a Lunora
 * tenant — the claim `resolveIdentity` builds, the shard `authorizeShard` admits,
 * and the dashboard that renders from it.
 */

/** Matches `LUNORA_ADMIN_TOKEN` in the `.dev.vars` `saas-app.mjs` writes. */
const ADMIN_TOKEN = "e2e-deterministic-admin-token";
const PASSWORD = "saas-e2e-password-1234"; // gitleaks:allow

/** Sign up, follow the captured verification link, then sign in — leaving the context holding a session. */
const signUp = async (context: BrowserContext, baseURL: string, email: string): Promise<void> => {
    const headers = { Origin: baseURL };
    const created = await context.request.post("/api/auth/sign-up/email", { data: { email, name: email.split("@")[0], password: PASSWORD }, headers });

    expect(created.status()).toBe(200);

    // `requireEmailVerification` is on, so sign-in is refused until the link is followed.
    const mail = await waitForMail({ adminToken: ADMIN_TOKEN, baseUrl: baseURL, subjectMatch: "Verify", timeoutMs: 30_000, to: email });
    const verified = await context.request.get(extractLink(mail), { maxRedirects: 0 });

    expect(verified.status()).toBeLessThan(400);

    const signedIn = await context.request.post("/api/auth/sign-in/email", { data: { email, password: PASSWORD }, headers });

    expect(signedIn.status()).toBe(200);
};

/**
 * Make `organizationId` the context's active organization, in the session row AND
 * the session cookie. better-auth's `organization/create` and `accept-invitation`
 * both set the active organization in the row only, while the signed session
 * cookie cache (on by default in `@lunora/auth`, 60 s) keeps serving the old
 * session — so for up to a minute the caller has no tenant claim. `set-active`
 * rewrites the cookie; auth-ui's organization list takes the same step.
 */
const activate = async (context: BrowserContext, baseURL: string, organizationId: string): Promise<void> => {
    const activated = await context.request.post("/api/auth/organization/set-active", { data: { organizationId }, headers: { Origin: baseURL } });

    expect(activated.status()).toBe(200);

    const session = await context.request.get("/api/auth/get-session");

    expect(((await session.json()) as { session: { activeOrganizationId?: string } }).session.activeOrganizationId).toBe(organizationId);
};

test("an owner signs up, creates an organization and invites a teammate who accepts", async ({ baseURL, browser }) => {
    expect(baseURL).toBeDefined();

    const origin = baseURL as string;
    const headers = { Origin: origin };
    // Nothing resets the template's D1 between runs, so every name is this run's own.
    const run = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const teammateEmail = `teammate-${run}@lunora.test`;
    const project = `Launch ${run}`;

    const owner = await browser.newContext({ baseURL: origin });

    await signUp(owner, origin, `owner-${run}@lunora.test`);

    // `resolveIdentity` turns the session's active organization into the tenant claim.
    const organization = await owner.request.post("/api/auth/organization/create", { data: { name: `Acme ${run}`, slug: `acme-${run}` }, headers });

    expect(organization.status()).toBe(200);

    const { id: organizationId } = (await organization.json()) as { id: string };

    await activate(owner, origin, organizationId);

    const ownerPage = await owner.newPage();

    await ownerPage.goto("/dashboard");
    await ownerPage.getByPlaceholder("Website redesign").fill(project);
    await ownerPage.getByRole("button", { name: "Create" }).click();
    await expect(ownerPage.getByText(project, { exact: true })).toBeVisible();

    const invitation = await owner.request.post("/api/auth/organization/invite-member", { data: { email: teammateEmail, role: "member" }, headers });

    expect(invitation.status()).toBe(200);

    const { id: invitationId } = (await invitation.json()) as { id: string };
    const teammate = await browser.newContext({ baseURL: origin });

    await signUp(teammate, origin, teammateEmail);

    const accepted = await teammate.request.post("/api/auth/organization/accept-invitation", { data: { invitationId }, headers });

    expect(accepted.status()).toBe(200);

    await activate(teammate, origin, organizationId);

    const teammatePage = await teammate.newPage();

    await teammatePage.goto("/dashboard");

    // Same tenant: the owner's project is on the teammate's dashboard.
    await expect(teammatePage.getByText(project, { exact: true })).toBeVisible();
    // A member reads but does not write, and the controls say so by not existing.
    await expect(teammatePage.getByRole("button", { name: "Create" })).toHaveCount(0);

    await owner.close();
    await teammate.close();
});
