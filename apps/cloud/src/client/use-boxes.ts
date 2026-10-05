import { useLunora, useQuery } from "@lunora/react";
import { useRouteContext } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { api } from "../../lunora/_generated/api.js";
import type { MemberRole } from "./boxes";
import { roleOf } from "./boxes";
import type { OrgId } from "./types";

/**
 * The signed-in operator's role in `organizationId`, from the live member roster
 * and the session the `_authed` layout resolved. `undefined` while the roster
 * loads. Only for hiding controls the server would refuse anyway — every box and
 * target mutation asserts the role itself.
 */
export const useMyRole = (organizationId: OrgId): MemberRole | undefined => {
    const userId = useRouteContext({ from: "/_authed", select: (context) => context.session.user.id });
    const members = useQuery(api.members.list, { organizationId });

    return roleOf(members, userId);
};

/**
 * The apex box hostnames live under (`LUNORA_BOX_DOMAIN`), read once per org
 * through the `boxes.domain` action — an action because the value is a Worker
 * var. `undefined` until it answers, or if it fails; the hostname column then
 * shows the bare slug rather than a guessed domain.
 */
export const useBoxDomain = (organizationId: OrgId): string | undefined => {
    const client = useLunora();
    const [loaded, setLoaded] = useState<{ domain: string; organizationId: OrgId } | undefined>(undefined);

    useEffect(() => {
        let cancelled = false;

        void (async () => {
            try {
                const domain = await client.action(api.boxes.domain, { organizationId });

                if (!cancelled) {
                    setLoaded({ domain, organizationId });
                }
            } catch {
                // Fails soft: a missing domain only shortens a label.
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [client, organizationId]);

    return loaded?.organizationId === organizationId ? loaded.domain : undefined;
};
