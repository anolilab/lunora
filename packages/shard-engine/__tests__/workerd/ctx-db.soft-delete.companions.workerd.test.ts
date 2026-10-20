import { aroundEach } from "vitest";

import runSoftDeleteCompanionScenarios from "../_scenarios/ctx-db.soft-delete.companions";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runSoftDeleteCompanionScenarios(createWorkerdExec);
