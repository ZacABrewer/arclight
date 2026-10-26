/** One part of a multipart/form-data body. */
export interface FormPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Boundary from a `multipart/form-data; boundary=...` content type, or null. */
export function multipartBoundary(contentType: string | undefined): string | null {
  if (!contentType || !/^multipart\/form-data\b/i.test(contentType)) return null;
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/**
 * Splits a buffered multipart/form-data body into its parts. Small and strict: the agent only
 * accepts a .torrent file and a JSON options field, so the whole body is in memory already.
 */
export function parseMultipart(body: Buffer, boundary: string): FormPart[] {
  const delimiter = Buffer.from(`--${boundary}`);
  const parts: FormPart[] = [];
  let pos = body.indexOf(delimiter);
  if (pos < 0) throw new Error('multipart boundary not found');
  for (;;) {
    pos += delimiter.length;
    // "--" right after a delimiter closes the body.
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const headerEnd = body.indexOf('\r\n\r\n', pos);
    if (headerEnd < 0) throw new Error('multipart part without headers');
    const headers = body.subarray(pos, headerEnd).toString('utf8').split('\r\n');
    const next = body.indexOf(delimiter, headerEnd + 4);
    if (next < 0) throw new Error('unterminated multipart body');
    // The part data ends with CRLF before the next delimiter.
    let dataEnd = next;
    if (body[dataEnd - 2] === 0x0d && body[dataEnd - 1] === 0x0a) dataEnd -= 2;
    const part: FormPart = { name: '', data: body.subarray(headerEnd + 4, dataEnd) };
    for (const line of headers) {
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'content-disposition') {
        const name = /\bname="([^"]*)"/i.exec(value);
        const filename = /\bfilename="([^"]*)"/i.exec(value);
        if (name?.[1] !== undefined) part.name = name[1];
        if (filename?.[1] !== undefined) part.filename = filename[1];
      } else if (key === 'content-type') {
        part.contentType = value;
      }
    }
    parts.push(part);
    pos = next;
  }
  return parts;
}
