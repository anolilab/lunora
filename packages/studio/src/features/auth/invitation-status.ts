/**
 * What state a sign-up invitation is in, derived from the two columns the admin
 * plane returns rather than asked of the server.
 *
 * The plane's list is deliberately unfiltered: "pending" is
 * `acceptedAt === null && expiresAt > now`, and applying that after a page would
 * let page one come back empty while pending invitations sat on page two. So the
 * label is computed here, from the row itself.
 */

/** One invitation row as the admin plane returns it — timestamps are epoch-ms. */
interface InvitationRow {
    acceptedAt?: null | number;
    createdAt?: null | number;
    email?: null | string;
    expiresAt?: null | number;
    id: string;
    invitedBy?: null | string;
}

/** The three states a row can be in. `now` is a parameter so this stays a pure function. */
type InvitationStatus = "expired" | "pending" | "spent";

/**
 * Spent beats expired: an invitation that was used is a record of who was let in,
 * and saying "expired" of an address that already has an account would send an
 * operator looking for a problem that isn't there.
 *
 * A row with no `expiresAt` reads as pending rather than expired — an absent
 * value is a malformed row, not proof the invitation has lapsed, and the
 * conservative label keeps it visible instead of quietly aged out of the list.
 */
const invitationStatus = (row: InvitationRow, now: number): InvitationStatus => {
    if (typeof row.acceptedAt === "number") {
        return "spent";
    }

    return typeof row.expiresAt === "number" && row.expiresAt <= now ? "expired" : "pending";
};

export type { InvitationRow, InvitationStatus };
export { invitationStatus };
