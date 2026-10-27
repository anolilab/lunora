import type { LunoraAdminClient } from "@lunora/client/admin";
import { isLunoraAdminClient } from "@lunora/client/admin";
import { LunoraError } from "@lunora/errors";
import { useLunora } from "@lunora/react";

/**
 * The Studio's client: the provider's, which must carry the admin surface
 * (`LunoraAdminClient`). The shell constructs one; an embedding that injects
 * its own client must inject that type too.
 */
const useStudioClient = (): LunoraAdminClient => {
    const client = useLunora();

    if (!isLunoraAdminClient(client)) {
        throw new LunoraError("INTERNAL", "The Studio needs a LunoraAdminClient (`@lunora/client/admin`), not a plain LunoraClient.");
    }

    return client;
};

export default useStudioClient;
