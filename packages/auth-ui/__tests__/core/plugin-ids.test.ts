// `lastLoginMethod` and `oneTap` have no per-plugin subpath in better-auth's
// exports map — they ship only through the barrel.
import { lastLoginMethod, oneTap } from "better-auth/plugins";
import { admin } from "better-auth/plugins/admin";
import { anonymous } from "better-auth/plugins/anonymous";
import { deviceAuthorization } from "better-auth/plugins/device-authorization";
import { emailOTP } from "better-auth/plugins/email-otp";
import { magicLink } from "better-auth/plugins/magic-link";
import { multiSession } from "better-auth/plugins/multi-session";
import { organization } from "better-auth/plugins/organization";
import { phoneNumber } from "better-auth/plugins/phone-number";
import { twoFactor } from "better-auth/plugins/two-factor";
import { username } from "better-auth/plugins/username";
import { describe, expect, it } from "vitest";

import { PLUGIN_ID_TO_FLOW } from "../../src/core";

/**
 * `PLUGIN_ID_TO_FLOW` maps a better-auth plugin's `id` to the flow our cards
 * gate on, and it is keyed by a string literal. A rename upstream — or a typo
 * here — does not break a build or a type: it makes discovery silently stop
 * recognising that plugin, so the server reports it, the map ignores it, and the
 * card never appears. That failure is invisible until someone reports a missing
 * screen.
 *
 * So the ids are asserted against the real plugin instances rather than against
 * a second copy of the same literals.
 *
 * `passkey` and `oauth-provider` are not covered: they live in their own
 * packages (`@better-auth/passkey`, `@better-auth/oauth-provider`) which this
 * one does not depend on, so they cannot be instantiated here. Their ids were
 * checked by hand against those packages' sources.
 */
const SERVER_PLUGINS = [
    admin(),
    anonymous(),
    deviceAuthorization(),
    emailOTP({ sendVerificationOTP: () => Promise.resolve() }),
    lastLoginMethod(),
    magicLink({ sendMagicLink: () => Promise.resolve() }),
    multiSession(),
    oneTap(),
    organization(),
    phoneNumber(),
    twoFactor(),
    username(),
];

describe("plugin id map", () => {
    it.each(SERVER_PLUGINS.map((plugin) => [plugin.id]))("recognises the %s plugin", (id) => {
        expect.assertions(1);

        expect(PLUGIN_ID_TO_FLOW[id]).toBeDefined();
    });

    it("maps every id to a flow the gate actually knows", async () => {
        expect.assertions(1);

        const { FLOW_NAMES } = await import("../../src/core");
        const unknown = Object.values(PLUGIN_ID_TO_FLOW).filter((flow) => !(FLOW_NAMES as ReadonlyArray<string>).includes(flow));

        expect(unknown).toStrictEqual([]);
    });
});
