/**
 * The relay's slice of the Grenade contract, mirrored from grenade-protocol/src/relay.ts (PROTOCOL.md "Remote access").
 * The relay builds on its own, so these are copies. Change the protocol first, then this file, then test/fixtures.
 */
import { z } from "zod";

export const RELAY_PROTOCOL_VERSION = 1 as const;
export const RELAY_DAEMON_PATH = "/v1/daemon";
export const RELAY_CONNECT_PATH = "/v1/connect/";
export const RELAY_PRESENCE_PATH = "/v1/presence/";
export const RELAY_DAEMONS_PATH = "/v1/daemons";
/** Close code for phone pipes when the daemon's link drops. */
export const CLOSE_DAEMON_OFFLINE = 4503;

const Conn = z.string().min(1).max(64);
const Ip = z.string().min(1).max(64);
const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
export const RelayId = z.string().regex(/^r_[0-9a-f]{32}$/);

// ---- daemon → relay ---------------------------------------------------------

export const RelayRegisterFrame = z.object({
  type: z.literal("register"),
  protocol: z.number().int(),
  id: RelayId,
  secret: z.string().regex(/^[0-9a-f]{64}$/),
  name: z.string().min(1).max(100),
  version: z.string().max(40),
  localIps: z.array(Ip).max(16),
  access: z.array(Sha256Hex).max(1000),
});
export const RelayUpdateFrame = z.object({
  type: z.literal("update"),
  name: z.string().min(1).max(100).optional(),
  localIps: z.array(Ip).max(16).optional(),
  access: z.array(Sha256Hex).max(1000).optional(),
});
export const RelayDataFrame = z.object({ type: z.literal("data"), conn: Conn, text: z.string() });
export const RelayDaemonCloseFrame = z.object({
  type: z.literal("close"),
  conn: Conn,
  code: z.number().int().min(1000).max(4999).optional(),
  reason: z.string().max(120).optional(),
});

export const RelayDaemonFrame = z.discriminatedUnion("type", [RelayRegisterFrame, RelayUpdateFrame, RelayDataFrame, RelayDaemonCloseFrame]);
export type RelayDaemonFrame = z.infer<typeof RelayDaemonFrame>;
export type RelayRegisterFrame = z.infer<typeof RelayRegisterFrame>;

// ---- relay → daemon ---------------------------------------------------------

export const RelayErrorCode = z.enum(["unauthorized", "id_taken", "bad_frame"]);
export type RelayErrorCode = z.infer<typeof RelayErrorCode>;

export const RelayRegisteredFrame = z.object({ type: z.literal("registered"), publicIp: Ip.optional() });
export const RelayErrorFrame = z.object({ type: z.literal("error"), code: RelayErrorCode, message: z.string() });
export const RelayOpenFrame = z.object({ type: z.literal("open"), conn: Conn, ip: Ip.optional() });
export const RelayServerCloseFrame = z.object({ type: z.literal("close"), conn: Conn });

export const RelayServerFrame = z.discriminatedUnion("type", [
  RelayRegisteredFrame,
  RelayErrorFrame,
  RelayOpenFrame,
  RelayDataFrame,
  RelayServerCloseFrame,
]);
export type RelayServerFrame = z.infer<typeof RelayServerFrame>;

// ---- HTTP bodies ------------------------------------------------------------

export const Presence = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string(),
  online: z.boolean(),
  since: z.string().datetime().optional(),
  lastSeen: z.string().datetime(),
  publicIp: Ip.optional(),
  localIps: z.array(Ip),
});
export type Presence = z.infer<typeof Presence>;

export const DaemonList = z.object({ daemons: z.array(Presence) });

/** First plaintext frame each way on a phone pipe. The relay forwards it like any other; the schema is for tests. */
export const E2EHello = z.object({ e2e: z.literal(1), e: z.string().min(1) });

// ---- parsing ----------------------------------------------------------------

export type ParseResult<T> = { ok: true; frame: T } | { ok: false; message: string };

export function parseRelayDaemonFrame(raw: string): ParseResult<RelayDaemonFrame> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, message: "not JSON" };
  }
  const r = RelayDaemonFrame.safeParse(json);
  return r.success ? { ok: true, frame: r.data } : { ok: false, message: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}
