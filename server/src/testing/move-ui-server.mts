/** Isolated HTTP fixture: real routes/static UI, stub pi, no model calls. */
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { EventBus } from "../bus.ts";
import { SessionRegistry } from "../registry.ts";
import { createRequestHandler } from "../routes.ts";
import { createStaticHandler } from "../static.ts";
import { STATIC_DIR } from "../config.ts";

if (!process.env.PI_WEB_SIMPLE_HOME || !process.env.PI_WEB_SIMPLE_SESSION_DIR) throw new Error("isolated directories required");
const registry = new SessionRegistry({ cliPath: fileURLToPath(new URL("./stub-pi.mjs", import.meta.url)) });
const handler = createRequestHandler({ registry, bus: new EventBus(), staticHandler: createStaticHandler(STATIC_DIR) });
const server = createServer((req, res) => { void handler(req, res); });
server.listen(Number(process.env.PI_WEB_SIMPLE_PORT), "127.0.0.1");
process.on("SIGTERM", async () => {
  server.close();
  await registry.closeAll("test-cleanup");
  process.exit(0);
});
