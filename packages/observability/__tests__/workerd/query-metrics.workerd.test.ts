import { aroundEach } from "vitest";

import runQueryMetricsScenarios from "../_scenarios/query-metrics";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runQueryMetricsScenarios(createWorkerdExec);
