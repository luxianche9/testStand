import { app } from "electron";
import { startDesktop } from "./lifecycle.js";
import { initializeLogger, logger } from "./logger.js";
import { registerAssetScheme } from "./protocols.js";

registerAssetScheme();

if (process.env.TESTFORGE_USER_DATA_DIR) app.setPath("userData", process.env.TESTFORGE_USER_DATA_DIR);
initializeLogger();

void app.whenReady()
  .then(startDesktop)
  .catch((error) => { logger.error("Desktop startup failed", error); app.exit(1); });
