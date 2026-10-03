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
export const RELAY_PUSH_PATH = "/v1/push";
/** The main relay. A relay without a push key passes pushes on to it. */
export const OFFICIAL_RELAY_URL = "https://relay.holdgrenade.com";
/** Largest sealed push content, as base64 characters: with the rest of the payload it stays under APNs' 4 KB. */
export const PUSH_SEALED_MAX_BASE64 = 2800;
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

// ---- push route (mirror of grenade-protocol/src/push.ts, PROTOCOL.md "Push route") ----

export const PushProvider = z.enum(["apns"]);
export const PushEnvironment = z.enum(["production", "sandbox"]);
export type PushEnvironment = z.infer<typeof PushEnvironment>;

/** Body of `POST /v1/push`. Everything the relay may read; `c` is sealed to the phone. */
export const PushRequest = z.object({
  provider: PushProvider,
  deviceToken: z.string().regex(/^[0-9a-f]{64,200}$/, "not a device token"),
  environment: PushEnvironment,
  /** The app's bundle id: the APNs topic. */
  topic: z.string().regex(/^[A-Za-z0-9.-]{1,155}$/, "not a bundle id"),
  /** Opaque to the relay: a later push with the same value replaces the earlier one on the phone. */
  collapse: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  /** The daemon's ephemeral X25519 public key for this push. */
  e: z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "not a 32-byte key in base64"),
  /** base64(ciphertext ‖ tag). The relay cannot open it. */
  c: z.string().min(24).max(PUSH_SEALED_MAX_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/, "not base64"),
});
export type PushRequest = z.infer<typeof PushRequest>;

export const PushResponse = z.object({ ok: z.literal(true) });
export type PushResponse = z.infer<typeof PushResponse>;

export const PushErrorCode = z.enum([
  "bad_request",
  "unauthorized",
  "topic_not_served",
  "unregistered",
  "too_large",
  "rate_limited",
  "apns_failed",
  "push_unavailable",
]);
export type PushErrorCode = z.infer<typeof PushErrorCode>;
export const PushError = z.object({ error: PushErrorCode });
export type PushError = z.infer<typeof PushError>;

// ---- board push (mirror of grenade-protocol/src/board.ts, PROTOCOL.md "Board push route") ----
// Strict here (unknown keys refused): a board push reaches the phone unsealed, so it may carry nothing but opaque
// keys, statuses and whole-second times.

export const BOARD_SESSIONS_MAX = 12;
export const BoardStatus = z.enum(["answer", "working", "done", "idle"]);
export const BoardKey = z.string().regex(/^[0-9a-f]{16}$/, "not a board key");
export const BoardEntry = z.strictObject({ k: BoardKey, s: BoardStatus, t: z.number().int().nonnegative() });
export const BoardState = z.strictObject({ v: z.literal(1), sessions: z.array(BoardEntry).max(BOARD_SESSIONS_MAX) });
export type BoardState = z.infer<typeof BoardState>;

/** A board push on `POST /v1/push`: sent to the Live Activity's own push token, readable by the relay and Apple by design. */
export const BoardPushRequest = z.strictObject({
  kind: z.literal("board"),
  provider: PushProvider,
  pushToken: z.string().regex(/^[0-9a-f]{32,400}$/, "not a push token"),
  environment: PushEnvironment,
  topic: z.string().regex(/^[A-Za-z0-9.-]{1,155}$/, "not a bundle id"),
  event: z.enum(["update", "end"]),
  alert: z.boolean(),
  /** Unix time in seconds. */
  at: z.number().int().nonnegative(),
  state: BoardState,
});
export type BoardPushRequest = z.infer<typeof BoardPushRequest>;

/** Any body of `POST /v1/push`. */
export type PushRouteRequest = PushRequest | BoardPushRequest;

export function isBoardPush(r: PushRouteRequest): r is BoardPushRequest {
  return "kind" in r && r.kind === "board";
}

/** The address a push goes to: the device token, or the Live Activity's push token. */
export function pushAddress(r: PushRouteRequest): string {
  return isBoardPush(r) ? r.pushToken : r.deviceToken;
}

/** A body with a `kind` is checked as that kind only; one without is a sealed push. */
export function parsePushRouteRequest(json: unknown): PushRouteRequest | null {
  const kind = typeof json === "object" && json !== null ? (json as { kind?: unknown }).kind : undefined;
  const r = kind === undefined ? PushRequest.safeParse(json) : BoardPushRequest.safeParse(json);
  return r.success ? r.data : null;
}

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
