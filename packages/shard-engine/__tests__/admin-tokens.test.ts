import createSqliteExec from "./_helpers/node-sqlite";
import runAdminTokenScenarios from "./_scenarios/admin-tokens";

runAdminTokenScenarios(createSqliteExec);
