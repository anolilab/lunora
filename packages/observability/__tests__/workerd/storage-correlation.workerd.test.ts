import { aroundEach } from "vitest";

import runStorageCorrelationScenarios from "../_scenarios/storage-correlation";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runStorageCorrelationScenarios(createWorkerdExec);
