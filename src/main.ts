/** Entry point: read the environment, start the relay, stop cleanly on SIGINT/SIGTERM. */
import { join } from "node:path";
import { readConfig } from "./config.js";
import { createLogger } from "./log.js";
import { startRelay } from "./server.js";
import { VERSION } from "./version.js";

const log = createLogger(process.env["GRENADE_LOG"] === "debug" ? "debug" : "info");

try {
  const config = readConfig(process.env, process.cwd());
  const relay = await startRelay({
    port: config.port,
    host: config.host,
    dataFile: join(config.dataDir, "daemons.json"),
    registrationKey: config.registrationKey,
    adminKey: config.adminKey,
    trustProxy: config.trustProxy,
    log,
    version: VERSION,
  });
  log.info(`Grenade relay ${VERSION} listening on ${config.host}:${relay.port}`, {
    data: config.dataDir,
    registration: config.registrationKey ? "key required" : "open",
    dashboard: config.adminKey ? "on" : "off",
    trustProxy: config.trustProxy,
  });
  const stop = async (signal: string) => {
    log.info(`Stopping (${signal})`);
    await relay.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
} catch (e) {
  log.error("Could not start the relay", { error: e });
  process.exit(1);
}
