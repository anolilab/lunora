import createSqliteExec from "./_helpers/node-sqlite";
import runRequestLogScenarios from "./_scenarios/request-log";

runRequestLogScenarios(createSqliteExec);
