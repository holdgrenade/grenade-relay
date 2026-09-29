/** Pure: what Apple's push service answered → what the push route answers (PROTOCOL.md "Push route"). */
import type { PushError, PushErrorCode, PushResponse } from "../frames.js";

/** `status` 0 means the push service could not be reached (network error, timeout). */
export interface ApnsResult {
  status: number;
  /** APNs' `reason` ("BadDeviceToken", "Unregistered", …), or what went wrong on the way. */
  reason?: string;
}

export interface RouteReply {
  status: number;
  body: PushResponse | PushError;
  headers?: Record<string, string>;
}

const STATUS: Record<PushErrorCode, number> = {
  bad_request: 400,
  unauthorized: 401,
  topic_not_served: 403,
  unregistered: 410,
  too_large: 413,
  rate_limited: 429,
  apns_failed: 502,
  push_unavailable: 503,
};

/** How long a sender waits after the push service itself said "too many". */
export const APNS_RETRY_AFTER_S = 60;

export function refusal(error: PushErrorCode, retryAfterSeconds?: number): RouteReply {
  const reply: RouteReply = { status: STATUS[error], body: { error } };
  if (retryAfterSeconds !== undefined) reply.headers = { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSeconds))) };
  return reply;
}

const WRONG_TOPIC = ["DeviceTokenNotForTopic", "TopicDisallowed", "BadTopic"];

export function replyForApns(r: ApnsResult): RouteReply {
  if (r.status === 200) return { status: 200, body: { ok: true } };
  if (r.status === 410 || (r.status === 400 && r.reason === "BadDeviceToken")) return refusal("unregistered");
  if (r.reason !== undefined && WRONG_TOPIC.includes(r.reason)) return refusal("topic_not_served");
  if (r.status === 429) return refusal("rate_limited", APNS_RETRY_AFTER_S);
  if (r.status === 413) return refusal("too_large");
  return refusal("apns_failed");
}

/** True when APNs refused our provider token, so the next push must bring a new one. */
export function isTokenRefused(r: ApnsResult): boolean {
  return r.status === 403 && (r.reason === "ExpiredProviderToken" || r.reason === "InvalidProviderToken");
}
