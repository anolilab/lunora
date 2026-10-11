/**
 * The admin plugin's roles for the cloud app. `auth.ts` passes this map to the
 * `admin()` plugin, and the admin-removal guard reads the same map to decide who
 * may delete a user. Change a role here, once, and both follow; neither copies it.
 */

export { defaultRoles as ADMIN_ROLES } from "better-auth/plugins/admin/access";
