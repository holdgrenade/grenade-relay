/**
 * Pure: one board push → what is sent to Apple's push service for a Live Activity (PROTOCOL.md "Board push route").
 * Times come from the request's `at` (Unix seconds), never from a clock, so the same request is always the same message.
 */
import type { BoardPushRequest } from "../frames.js";
import { APNS_HOSTS, type ApnsMessage } from "./pushPayload.js";

export const BOARD_EXPIRES_AFTER_S = 60 * 60;
export const BOARD_STALE_AFTER_S = 2 * 60 * 60;
export const BOARD_ALERT = { title: "Grenade", body: "An agent needs you", sound: "default" } as const;

/** The `aps` payload, keys in the order PROTOCOL.md and the fixture show them. */
export function boardPayload(request: BoardPushRequest): { aps: Record<string, unknown> } {
  const aps: Record<string, unknown> = { timestamp: request.at, event: request.event, "content-state": request.state };
  if (request.event === "end") {
    aps["dismissal-date"] = request.at;
  } else {
    aps["stale-date"] = request.at + BOARD_STALE_AFTER_S;
    if (request.alert) aps["alert"] = BOARD_ALERT;
  }
  return { aps };
}

/** The APNs headers that depend on the push (not the provider token). */
export function boardHeaders(request: BoardPushRequest): Record<string, string> {
  return {
    "apns-push-type": "liveactivity",
    "apns-topic": `${request.topic}.push-type.liveactivity`,
    "apns-priority": request.alert || request.event === "end" ? "10" : "5",
    "apns-expiration": String(request.at + BOARD_EXPIRES_AFTER_S),
  };
}

/** `token` is the provider token (`apnsToken`). */
export function boardApnsMessage(request: BoardPushRequest, token: string): ApnsMessage {
  return {
    host: APNS_HOSTS[request.environment],
    path: `/3/device/${request.pushToken}`,
    headers: { authorization: `bearer ${token}`, ...boardHeaders(request), "content-type": "application/json" },
    body: JSON.stringify(boardPayload(request)),
  };
}
