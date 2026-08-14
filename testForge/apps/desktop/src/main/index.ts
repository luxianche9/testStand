import { app } from "electron";
import { startDesktop } from "./lifecycle.js";
import { registerAssetScheme } from "./protocols.js";

registerAssetScheme();

if (process.env.TESTFORGE_USER_DATA_DIR) app.setPath("userData", process.env.TESTFORGE_USER_DATA_DIR);

void app.whenReady()
  .then(startDesktop)
  .catch((error) => { console.error(error); app.exit(1); });
