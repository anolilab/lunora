import { aroundEach } from "vitest";

import runAdminTokenScenarios from "../_scenarios/admin-tokens";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runAdminTokenScenarios(createWorkerdExec);
