import { createMailerFromEnv } from "@cirrus/mail";

/**
 * Transactional email for the control plane (CLOUD-PLAN.md §3). Built on
 * `@cirrus/mail`'s env-driven mailer: a Resend transport in production (or the
 * Worker `send_email` binding), captured into the studio Mail tab in dev. These
 * run at the Worker edge (the deploy router), where `env` is available — Cirrus
 * mutations can't do I/O, so the email is sent here rather than inside the
 * `invitations.invite` mutation.
 */

export interface InvitationEmail {
    /** The one-time accept link carrying the invite token. */
    acceptUrl: string;
    /** Optional organization name for the copy. */
    organizationName?: string;
    /** Invitee address. */
    to: string;
}

/** Send a team-invitation email with the one-time accept link. */
export const sendInvitationEmail = async (env: Record<string, unknown>, invitation: InvitationEmail): Promise<void> => {
    const org = invitation.organizationName ? ` to ${invitation.organizationName}` : "";

    await createMailerFromEnv(env).send({
        subject: `You've been invited${org} on Cirrus Cloud`,
        text: `You've been invited${org} on Cirrus Cloud.\n\nAccept your invitation:\n${invitation.acceptUrl}`,
        to: invitation.to,
    });
};
