import { aroundEach } from "vitest";

import runBatchWriteScenarios from "../_scenarios/ctx-db.batch-writes";
import { createWorkerdExec, FRESH_DO_TIMEOUT, inFreshDurableObject } from "./_helpers/do-sqlite";

aroundEach(inFreshDurableObject, FRESH_DO_TIMEOUT);
runBatchWriteScenarios(createWorkerdExec);
