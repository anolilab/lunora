import createSqliteExec from "./_helpers/node-sqlite";
import runHeadroomScenarios from "./_scenarios/ctx-db.headroom";

runHeadroomScenarios(createSqliteExec);
