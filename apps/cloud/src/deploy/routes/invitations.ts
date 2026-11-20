import { createSignUpInvitation } from "@lunora/auth";

import { api } from "../../../lunora/_generated/api";
import { currentAuth } from "../../auth";
import { sendInvitationEmail } from "../../mail/notify";
import type { RouterEnv } from "./shared";
import { jsonError, nonEmptyString, readJsonObject, rejected, requireContext } from "./shared";

type InviteRole = "admin" | "member" | "owner" | "viewer";

const INVITE_ROLES: ReadonlyArray<InviteRole> = ["admin", "member", "owner", "viewer"];

const isInviteRole = (value: unknown): value is InviteRole => typeof value === "string" && (INVITE_ROLES as ReadonlyArray<string>).includes(value);

/**
 * A sign-up link for an invited address with no account yet, or `undefined` when
 * it already has one (or auth is not up).
 *
 * Registration is invite-only (`inviteOnly()` in `src/auth.ts`), so an org
 * invitation to a stranger is a dead end on its own: accepting needs a session
 * and they cannot create one. Minting a sign-up invitation alongside the org
 * invitation is what closes that.
 *
 * Deliberately narrow. The org invitation is already gated on
 * `assertMember(owner|admin)` and rate-limited, and the sign-up invitation is
 * issued for **exactly** the address that invitation names — so an org admin can
 * admit someone to the platform only by inviting them to their own org, one
 * address at a time. That is the authority they already had over their own
 * membership, not a new one over the cell.
 *
 * Skipped when the address already has an account: `createSignUpInvitation`
 * would happily re-open a row, and a second invitation is a second account
 * rather than a faster way into the org.
 */
const signUpInvitationFor = async (origin: string, email: string): Promise<string | undefined> => {
    const auth = currentAuth();

    if (auth === null) {
        return undefined;
    }

    const context = await auth.$context;
    const existing = await context.adapter.findOne({ model: "user", where: [{ field: "email", value: email.trim().toLowerCase() }] });

    if (existing !== null) {
        return undefined;
    }

    const invitation = await createSignUpInvitation(auth, { email });

    return `${origin}/login?email=${encodeURIComponent(invitation.email)}&invite=${encodeURIComponent(invitation.token)}`;
};

/**
 * `POST /v1/invitations/send` — invite a teammate and email the join link (§3).
 * Runs the `invitations.invite` mutation under the caller's session (so the
 * mutation's `assertMember` gate still applies), then mails the one-time token —
 * which is therefore never exposed to the browser. A sign-up link rides along
 * when the invitee needs one; see {@link signUpInvitationFor}.
 */
export const handleInviteRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);

    const body = await readJsonObject(request);
    const organizationId = nonEmptyString(body?.["organizationId"]);
    const email = nonEmptyString(body?.["email"]);

    if (!organizationId || !email) {
        return jsonError(400, "organizationId and email are required strings");
    }

    // The dashboard sends no role; an invitee joins as a member unless the caller names one.
    const role: unknown = body?.["role"] ?? "member";

    if (!isInviteRole(role)) {
        return jsonError(400, "role must be one of owner, admin, member, viewer");
    }

    let token: string;

    try {
        ({ token } = await context.runMutation<{ id: string; token: string }>(api.invitations.invite, {
            email,
            organizationId,
            role,
        }));
    } catch (error) {
        return rejected(error, "invite rejected");
    }

    // The row exists from here on, so a mail failure is a delivery failure, not a refusal.
    try {
        const { origin } = new URL(request.url);
        const acceptUrl = `${origin}/accept-invite?token=${encodeURIComponent(token)}`;
        const signUpUrl = await signUpInvitationFor(origin, email);

        await sendInvitationEmail(environment, { acceptUrl, ...(signUpUrl === undefined ? {} : { signUpUrl }), to: email });
    } catch {
        return jsonError(502, "invitation was created but its email could not be sent");
    }

    return Response.json({ ok: true });
};
