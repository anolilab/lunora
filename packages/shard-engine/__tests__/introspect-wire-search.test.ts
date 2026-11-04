import createSqliteExec from "./_helpers/node-sqlite";
import runWireSearchScenarios from "./_scenarios/introspect.wire-search";

runWireSearchScenarios(createSqliteExec);
