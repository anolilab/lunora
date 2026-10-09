/**
 * Declare a function that proves a value is the caller's own identity. Call it
 * before a write that stores the value, and the ownership lint treats that write
 * as validated:
 *
 * ```ts
 * export const assertOwnOrganizationId = defineIdentityGuard((user: SessionUser, organizationId: string | undefined) => {
 *     if (organizationId && organizationId !== user.activeOrganization?.id) {
 *         throw new LunoraError("FORBIDDEN", "Not a member of that organization");
 *     }
 * });
 * ```
 *
 * The function is returned unchanged, so the declaration costs nothing at runtime.
 * The guarantee is the function's own: it must throw whenever the value is not
 * the caller's identity. The advisor trusts the declaration, not the body.
 */
const defineIdentityGuard = <Guard extends (...args: never[]) => void>(guard: Guard): Guard => guard;

export default defineIdentityGuard;
