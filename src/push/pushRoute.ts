/**
 * `POST /v1/push` (PROTOCOL.md "Push route"), transport-agnostic: the server hands over what it read, this decides.
 * The route keeps nothing and reads nothing it cannot: `c` is sealed to the phone. A board push (`kind: "board"`,
 * PROTOCOL.md "Board push route") goes the same way, to a Live Activity's push token. A device or push token never
 * reaches a log line; `phone` in the logs is the first 8 hex of its SHA-256.
 */
import { keyMatches, sha256hex } from "../auth.js";
import { isBoardPush, parsePushRouteRequest, pushAddress, type PushRouteRequest } from "../frames.js";
import type { Logger } from "../log.js";
import type { ApnsSender } from "./apnsClient.js";
import type { PushLimiter } from "./pushLimiter.js";
import { refusal, replyForApns, type RouteReply } from "./pushResult.js";
import type { Upstream } from "./upstream.js";

export const MAX_PUSH_BODY_BYTES = 8 * 1024;

export interface PushRouteInput {
  /** The bearer token the sender presented, if any. */
  authorization: string | null;
  /** The request came through another relay (it carried `X-Grenade-Push-Hops`). */
  hops: boolean;
  ip: string | undefined;
  /** The body as read, cut off a little past `MAX_PUSH_BODY_BYTES` when it was longer. */
  rawBody: string;
}

export interface PushRouteDeps {
  registrationKey?: string | undefined;
  /** Bundle ids this relay's push key sends for. Only checked when `apns` is set. */
  topics: readonly string[];
  /** Set when this relay holds a push key. */
  apns: ApnsSender | null;
  /** Set when this relay passes pushes on. Unused while `apns` is set. */
  upstream: Upstream | null;
  limiter: PushLimiter;
  log: Logger;
  now: () => number;
}

export async function handlePush(input: PushRouteInput, d: PushRouteDeps): Promise<RouteReply> {
  if (!keyMatches(d.registrationKey, input.authorization)) return refused(d, "unauthorized", input);
  if (Buffer.byteLength(input.rawBody, "utf8") > MAX_PUSH_BODY_BYTES) return refused(d, "too_large", input);
  const request = parse(input.rawBody);
  if (!request) return refused(d, "bad_request", input);
  const tokenHash = sha256hex(pushAddress(request));
  const phone = tokenHash.slice(0, 8);
  const kind = isBoardPush(request) ? "board" : "sealed";
  if (d.apns && !d.topics.includes(request.topic)) return refused(d, "topic_not_served", input, phone);
  if (!d.apns && (!d.upstream || input.hops)) return refused(d, "push_unavailable", input, phone);

  const wait = d.limiter.take(input.ip, tokenHash, d.now());
  if (wait > 0) {
    d.log.info("Refused a push: too many", { phone, ip: input.ip, retryAfter: wait });
    return refusal("rate_limited", wait);
  }

  if (d.apns) {
    const result = await d.apns.send(request);
    const reply = replyForApns(result);
    if (reply.status === 200) d.log.debug("Sent a push", { phone, kind, environment: request.environment });
    else d.log.info("A push was not delivered", { phone, kind, environment: request.environment, apnsStatus: result.status, reason: result.reason, answered: reply.status });
    return reply;
  }
  const upstream = d.upstream as Upstream;
  const reply = await upstream.forward(input.rawBody);
  if (reply.status === 200) d.log.debug("Passed a push upstream", { phone, kind, upstream: upstream.url });
  else d.log.info("The upstream relay did not deliver a push", { phone, kind, upstream: upstream.url, answered: reply.status });
  return reply;
}

function parse(rawBody: string): PushRouteRequest | null {
  try {
    return parsePushRouteRequest(JSON.parse(rawBody));
  } catch {
    return null;
  }
}

function refused(d: PushRouteDeps, error: Parameters<typeof refusal>[0], input: PushRouteInput, phone?: string): RouteReply {
  d.log.info(`Refused a push: ${error}`, { phone, ip: input.ip });
  return refusal(error);
}
