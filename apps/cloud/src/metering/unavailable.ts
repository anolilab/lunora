/**
 * A metering source that cannot read at all, as opposed to one whose read
 * failed this time. Examples: the account's GraphQL schema has no dataset that
 * reports Durable Object rows, or the dataset has no dimension to attribute
 * them by.
 *
 * The readback sweep records the reason in `usageSourceStatus`, logs it, and
 * the Usage tab shows it (`usage.meteringStatus`). The checkpoint stays where
 * it is, so nothing is skipped once the source can read again. A silent
 * zero would leave a runaway invisible to the spend cap, which is what this
 * type exists to prevent.
 *
 * A token the account refuses is reported the same way: the drivers turn the
 * `CloudflareTokenError` every Cloudflare reader throws into this
 * (`unavailableOnRefusal`), since retrying does not grant a permission.
 */
export class UsageUnavailableError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "UsageUnavailableError";
    }
}
