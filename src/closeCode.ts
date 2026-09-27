/** Pure: make a close code and reason that `ws` accepts, whatever the daemon asked for. */
export function safeCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000;
  const valid = (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  return valid ? code : 1000;
}

/** A close reason must fit in 123 UTF-8 bytes. */
export function safeCloseReason(reason: string | undefined): string {
  let r = reason ?? "";
  while (Buffer.byteLength(r, "utf8") > 123) r = r.slice(0, -1);
  return r;
}
