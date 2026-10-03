/**
 * Leveled logger to stderr: local time, a plain sentence, then `key=value` pairs. `silentLogger` for tests.
 * A line is always one line: a sentence may quote a name a Mac chose, so control characters in it become spaces.
 */
export type Level = "debug" | "info" | "warn" | "error";
export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
}

/** A string value with any of these is written JSON-quoted, which escapes them. */
const UNSAFE_IN_A_VALUE = /[\s\u0000-\u001f\u007f-\u009f]/;

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function formatLine(level: Level, msg: string, fields: Fields | undefined, at: Date): string {
  const kv = Object.entries(fields ?? {})
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v instanceof Error ? JSON.stringify(v.message) : typeof v === "string" && !UNSAFE_IN_A_VALUE.test(v) ? v : JSON.stringify(v)}`)
    .join(" ");
  return `${at.toISOString()} ${level.toUpperCase().padEnd(5)} ${msg.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")}${kv ? " " + kv : ""}`;
}

export function createLogger(min: Level = "info"): Logger {
  const write = (level: Level) => (msg: string, fields?: Fields) => {
    if (ORDER[level] >= ORDER[min]) process.stderr.write(formatLine(level, msg, fields, new Date()) + "\n");
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
