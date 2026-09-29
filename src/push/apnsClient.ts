/**
 * Sends pushes to Apple's push service over HTTP/2. One session per host is kept open and made again when it
 * closes or fails. Never throws: a push that could not be sent comes back with status 0.
 */
import { connect, constants, type ClientHttp2Session } from "node:http2";
import type { PushEnvironment, PushRequest } from "../frames.js";
import { ProviderTokens, type ApnsCredentials } from "./apnsToken.js";
import { apnsMessage, type ApnsMessage } from "./pushPayload.js";
import { isTokenRefused, type ApnsResult } from "./pushResult.js";

/** What the push route needs from a sender. Tests pass a fake. */
export interface ApnsSender {
  send(request: PushRequest): Promise<ApnsResult>;
  close?(): void;
}

export interface ApnsSenderOptions {
  credentials: ApnsCredentials;
  now?: () => number;
  timeoutMs?: number;
  /** Where each environment's pushes go. Defaults to Apple's hosts over TLS; tests point it at a local server. */
  origin?: (environment: PushEnvironment, host: string) => string;
}

export function createApnsSender(o: ApnsSenderOptions): ApnsSender {
  const now = o.now ?? Date.now;
  const tokens = new ProviderTokens(o.credentials);
  const origin = o.origin ?? ((_environment, host) => `https://${host}`);
  const client = new ApnsClient(o.timeoutMs ?? 10_000);
  return {
    async send(request) {
      const message = apnsMessage(request, tokens.at(now()), now());
      const result = await client.post(origin(request.environment, message.host), message);
      if (isTokenRefused(result)) tokens.reset();
      return result;
    },
    close: () => client.close(),
  };
}

export class ApnsClient {
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(private readonly timeoutMs: number) {}

  post(origin: string, message: ApnsMessage): Promise<ApnsResult> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (r: ApnsResult) => {
        if (done) return;
        done = true;
        resolve(r);
      };
      let session: ClientHttp2Session;
      try {
        session = this.session(origin);
      } catch (e) {
        return finish({ status: 0, reason: errorText(e) });
      }
      // A session that fails before or during this request: the request's own error may never fire.
      const onSessionError = (e: unknown) => finish({ status: 0, reason: errorText(e) });
      session.once("error", onSessionError);
      const request = session.request({
        [constants.HTTP2_HEADER_METHOD]: "POST",
        [constants.HTTP2_HEADER_PATH]: message.path,
        ...message.headers,
      });
      let status = 0;
      let text = "";
      request.setEncoding("utf8");
      request.setTimeout(this.timeoutMs, () => {
        request.close(constants.NGHTTP2_CANCEL);
        finish({ status: 0, reason: "timeout" });
      });
      request.on("response", (headers) => (status = Number(headers[constants.HTTP2_HEADER_STATUS]) || 0));
      request.on("data", (chunk: string) => {
        if (text.length < 4096) text += chunk;
      });
      request.on("error", (e) => finish({ status: 0, reason: errorText(e) }));
      request.on("close", () => {
        session.off("error", onSessionError);
        const reason = reasonIn(text);
        finish(reason === undefined ? { status } : { status, reason });
      });
      request.end(message.body);
    });
  }

  close(): void {
    for (const s of this.sessions.values()) s.destroy();
    this.sessions.clear();
  }

  private session(origin: string): ClientHttp2Session {
    const held = this.sessions.get(origin);
    if (held && !held.closed && !held.destroyed) return held;
    const session = connect(origin);
    const forget = () => {
      if (this.sessions.get(origin) === session) this.sessions.delete(origin);
    };
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", () => {
      forget();
      session.close();
    });
    // An idle session must not keep the process alive.
    session.unref();
    this.sessions.set(origin, session);
    return session;
  }
}

/** APNs answers errors with `{"reason":"…"}`. */
function reasonIn(body: string): string | undefined {
  if (!body) return undefined;
  try {
    const reason = (JSON.parse(body) as { reason?: unknown }).reason;
    return typeof reason === "string" ? reason.slice(0, 80) : undefined;
  } catch {
    return undefined;
  }
}

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).slice(0, 120);
}
