import { join } from "node:path";
import { app } from "electron";
import { startDesktop } from "./lifecycle.js";
import { initializeLogger, logger } from "./logger.js";

app.setName("testStand");
app.setPath("userData", process.env.TESTSTAND_USER_DATA_DIR ?? join(app.getPath("appData"), "testStand"));
initializeLogger();

void app.whenReady()
  .then(startDesktop)
  .catch((error) => { logger.error("Desktop startup failed", error); app.exit(1); });
