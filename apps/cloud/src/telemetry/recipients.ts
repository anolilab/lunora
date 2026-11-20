/**
 * The email destination that means "this organization's owners and admins",
 * resolved when an alert is SENT, not when it is raised: a mutation that fires
 * an alert has no access to the auth plane's user table, and membership can
 * change between raising an alert and draining it.
 *
 * It is a real choice in the studio ("Owners & admins") and what the default
 * spend rule sends to, so an organization that never configured an alert is
 * still told before it is suspended.
 */
import type { ControlPlaneStore } from "../d1-store";

/** The `destination` of an `email` rule that sends to the organization's owners and admins. */
export const ORG_ADMINS_DESTINATION = "org:admins";

/** Find the email addresses of the users with these external ids. */
export type UserEmailLookup = (userIds: ReadonlyArray<string>) => Promise<ReadonlyArray<string>>;

/** At most this many recipients per alert: an organization's owners and admins, never a mailing list. */
const MAX_RECIPIENTS = 50;

/**
 * The owners' and admins' addresses of an organization, deduplicated and
 * sorted. Empty when none can be found — the caller treats that as a failed
 * delivery, so the alert stays visible as `failed` rather than vanishing.
 */
export const orgAdminEmails = async (store: Pick<ControlPlaneStore, "findMany">, organizationId: string, lookup: UserEmailLookup): Promise<string[]> => {
    const { page } = await store.findMany("members", { where: { organizationId } });
    const userIds = (page as { role: string; userId: string }[])
        .filter((member) => member.role === "owner" || member.role === "admin")
        .map((member) => member.userId);

    if (userIds.length === 0) {
        return [];
    }

    const emails = await lookup(userIds.slice(0, MAX_RECIPIENTS));

    return [...new Set(emails.map((email) => email.trim().toLowerCase()).filter((email) => email !== ""))].toSorted((a, b) => a.localeCompare(b));
};
