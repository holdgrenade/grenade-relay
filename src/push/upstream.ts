/**
 * A relay without a push key passes each push, unchanged, to another relay's push route (PROTOCOL.md "Push route").
 * The `X-Grenade-Push-Hops` header marks a push that was passed on, so it is never passed on twice.
 */
import { PushError, PushResponse, RELAY_PUSH_PATH } from "../frames.js";
import { refusal, type RouteReply } from "./pushResult.js";

export const HOPS_HEADER = "x-grenade-push-hops";

export interface Upstream {
  /** Base URL of the relay pushes are passed to, for logs. */
  readonly url: string;
  forward(rawBody: string): Promise<RouteReply>;
}

export interface UpstreamOptions {
  /** Base URL, no trailing slash. */
  url: string;
  /** The upstream's registration key, when it requires one. */
  key?: string | undefined;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

/** Accepts `relay.example.com` or `https://relay.example.com/`; returns `https://relay.example.com`. Throws on anything else. */
export function normalizeUpstreamUrl(input: string): string {
  let s = input.trim();
  if (!/^[a-z]+:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`not a relay URL: ${input}`);
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname) throw new Error(`not a relay URL: ${input}`);
  return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, "")}`;
}

export function createUpstream(o: UpstreamOptions): Upstream {
  const send = o.fetch ?? fetch;
  return {
    url: o.url,
    async forward(rawBody) {
      const headers: Record<string, string> = { "content-type": "application/json", [HOPS_HEADER]: "1" };
      if (o.key) headers["authorization"] = `Bearer ${o.key}`;
      try {
        const res = await send(o.url + RELAY_PUSH_PATH, { method: "POST", headers, body: rawBody, signal: AbortSignal.timeout(o.timeoutMs ?? 10_000) });
        const json: unknown = await res.json().catch(() => null);
        if (res.status === 200 && PushResponse.safeParse(json).success) return { status: 200, body: { ok: true } };
        const error = PushError.safeParse(json);
        if (!error.success || res.status === 200) return refusal("apns_failed");
        const retryAfter = Number(res.headers.get("retry-after"));
        const reply: RouteReply = { status: res.status, body: error.data };
        if (Number.isFinite(retryAfter) && retryAfter > 0) reply.headers = { "Retry-After": String(Math.ceil(retryAfter)) };
        return reply;
      } catch {
        return refusal("apns_failed");
      }
    },
  };
}
