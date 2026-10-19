import { aroundEach } from "vitest";

import runGeoScenarios from "../_scenarios/ctx-db.geo";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runGeoScenarios(createWorkerdExec);
