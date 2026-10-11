import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements } from "better-auth/plugins/admin/access";
import { describe, expect, it } from "vitest";

import { canDeleteUsers } from "../src/admin-removal";
import { ADMIN_ROLES } from "../src/admin-roles";

/**
 * The admin-removal guard decides who may delete a user from the role map the admin
 * plugin is configured with (`ADMIN_ROLES`), never from a copy of it. These tests pin
 * that: the default map answers as the plugin does, and a map that grants another
 * role changes the answer without any change to the guard.
 */
describe("admin-removal guard permission", () => {
    it("lets an admin delete users and refuses a plain user, under the configured roles", () => {
        expect(canDeleteUsers("admin")).toBe(true);
        expect(canDeleteUsers("user")).toBe(false);
        expect(canDeleteUsers(null)).toBe(false);
    });

    it("follows the role map it is given rather than a built-in copy", () => {
        const granting = createAccessControl(defaultStatements).newRole({ user: ["delete"] });
        const roles = { ...ADMIN_ROLES, user: granting };

        expect(canDeleteUsers("user", roles)).toBe(true);
        expect(canDeleteUsers("user", ADMIN_ROLES)).toBe(false);
    });

    it("refuses a role the map does not name", () => {
        expect(canDeleteUsers("auditor", ADMIN_ROLES)).toBe(false);
    });
});
