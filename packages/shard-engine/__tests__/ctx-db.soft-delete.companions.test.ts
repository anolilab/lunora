import createSqliteExec from "./_helpers/node-sqlite";
import runSoftDeleteCompanionScenarios from "./_scenarios/ctx-db.soft-delete.companions";

runSoftDeleteCompanionScenarios(createSqliteExec);
