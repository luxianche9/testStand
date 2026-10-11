// Local-only driver: launches the dev app with the user's data and evaluates posted scripts. Never commit.
import http from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { _electron as electron } from "@playwright/test";

const desktopDir = path.dirname(fileURLToPath(import.meta.url));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE; delete env.TESTSTAND_USER_DATA_DIR; delete env.TESTSTAND_AGENT_INTEGRATION_TEST_MODE;
let app; let page;
async function launch() {
  app = await electron.launch({ args: [desktopDir], cwd: desktopDir, env, timeout: 90_000 });
  page = await app.firstWindow();
  page.setDefaultTimeout(20_000);
  await page.waitForLoadState("domcontentloaded");
}
await launch();
http.createServer(async (req, res) => {
  let body = ""; for await (const chunk of req) body += chunk;
  try {
    if (body.trim() === "__exit__") { await app.close().catch(() => {}); res.end("bye"); setTimeout(() => process.exit(0), 200); return; }
    const fn = new Function("page", "app", `return (async () => { ${body} })();`);
    const value = await fn(page, app);
    res.end(JSON.stringify(value, null, 1) ?? "undefined");
  } catch (error) { res.end(String(error?.stack ?? error)); }
}).listen(9555, "127.0.0.1", () => console.log("drive ready"));
