/**
 * Pure: one push request → what is sent to Apple's push service (PROTOCOL.md "Push route").
 * The alert is the text a phone shows when it cannot open the content; the relay has nothing else to say.
 */
import type { PushEnvironment, PushRequest } from "../frames.js";

export const APNS_HOSTS: Record<PushEnvironment, string> = {
  production: "api.push.apple.com",
  sandbox: "api.sandbox.push.apple.com",
};
export const PUSH_EXPIRES_AFTER_MS = 60 * 60 * 1000;
export const FALLBACK_ALERT = { title: "Grenade", body: "An agent is waiting for you" } as const;

export interface ApnsMessage {
  host: string;
  path: string;
  headers: Record<string, string>;
  body: string;
}

export function apnsBody(request: PushRequest): string {
  return JSON.stringify({
    aps: { alert: FALLBACK_ALERT, sound: "default", "mutable-content": 1 },
    g: { v: 1, e: request.e, c: request.c },
  });
}

/** `token` is the provider token (`apnsToken`), `now` ms since epoch. */
export function apnsMessage(request: PushRequest, token: string, now: number): ApnsMessage {
  return {
    host: APNS_HOSTS[request.environment],
    path: `/3/device/${request.deviceToken}`,
    headers: {
      authorization: `bearer ${token}`,
      "apns-topic": request.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-collapse-id": request.collapse,
      "apns-expiration": String(Math.floor((now + PUSH_EXPIRES_AFTER_MS) / 1000)),
      "content-type": "application/json",
    },
    body: apnsBody(request),
  };
}
