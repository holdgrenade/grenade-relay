/** Entry point: read the environment, start the relay, stop cleanly on SIGINT/SIGTERM. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readConfig, type PushConfig } from "./config.js";
import { createLogger } from "./log.js";
import { createApnsSender } from "./push/apnsClient.js";
import { readApnsKey } from "./push/apnsToken.js";
import { createUpstream } from "./push/upstream.js";
import { startRelay, type PushOptions } from "./server.js";
import { VERSION } from "./version.js";

const log = createLogger(process.env["GRENADE_LOG"] === "debug" ? "debug" : "info");

/** A push key sends by itself; without one pushes are passed to the upstream relay, or refused when that is off. */
function pushOptions(c: PushConfig): PushOptions {
  if (c.apns) {
    const pem = c.apns.key ?? readFileSync(c.apns.keyFile as string, "utf8");
    const credentials = { key: readApnsKey(pem), keyId: c.apns.keyId, teamId: c.apns.teamId };
    return { apns: createApnsSender({ credentials }), topics: c.apns.topics };
  }
  return c.upstream ? { upstream: createUpstream({ url: c.upstream, key: c.upstreamKey }) } : {};
}

try {
  const config = readConfig(process.env, process.cwd());
  const relay = await startRelay({
    port: config.port,
    host: config.host,
    dataFile: join(config.dataDir, "daemons.json"),
    registrationKey: config.registrationKey,
    adminKey: config.adminKey,
    trustedProxies: config.trustedProxies,
    push: pushOptions(config.push),
    log,
    version: VERSION,
  });
  log.info(`Grenade relay ${VERSION} listening on ${config.host}:${relay.port}`, {
    data: config.dataDir,
    registration: config.registrationKey ? "key required" : "open",
    dashboard: config.adminKey ? "on" : "off",
    trustedProxies: config.trustedProxies,
    push: config.push.apns ? "apns" : config.push.upstream ? `upstream ${config.push.upstream}` : "off",
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
