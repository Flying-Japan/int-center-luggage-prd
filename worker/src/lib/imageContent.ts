/** Bounded structural validation, not a pixel decoder. Never permit active image
 * documents (SVG/XML/HTML). Responses also require nosniff + sandbox CSP. */
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const allowed = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
export function normalizedPhotoMime(value: string | null) {
  const essence = (value ?? '').split(';', 1)[0].trim().toLowerCase();
  const canonical = essence === 'image/jpg' ? 'image/jpeg' : essence;
  return allowed.has(canonical) ? canonical : null;
}
const ascii = (b: Uint8Array, offset: number, length: number) => String.fromCharCode(...b.subarray(offset, offset + length));
const crcTable = Uint32Array.from({length:256},(_,value)=>{let n=value;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);return n>>>0;});
function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function dimensions(width: number, height: number) { return width > 0 && height > 0 && width * height <= 100_000_000; }
function png(b: Uint8Array, view: DataView) {
  if (ascii(b, 0, 8) !== '\x89PNG\r\n\x1a\n') return false;
  let offset = 8, header = false, pixels = false;
  while (offset + 12 <= b.length) {
    const length = view.getUint32(offset), kind = ascii(b, offset + 4, 4), end = offset + 12 + length;
    if (end > b.length || !/^[A-Za-z]{4}$/.test(kind) || crc32(b.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) return false;
    if (!header) {
      if (kind !== 'IHDR' || length !== 13 || !dimensions(view.getUint32(offset + 8), view.getUint32(offset + 12))) return false;
      header = true;
    } else if (kind === 'IHDR') return false;
    if (kind === 'IDAT' && length > 0) pixels = true;
    if (kind === 'IEND') return length === 0 && header && pixels && end === b.length;
    offset = end;
  }
  return false;
}
function jpeg(b: Uint8Array, view: DataView) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return false;
  let offset = 2, frame = false, scan = false;
  while (offset < b.length) {
    if (b[offset++] !== 0xff) return false;
    while (b[offset] === 0xff) offset++;
    const marker = b[offset++];
    if (marker === 0xd9) return frame && scan && offset === b.length;
    if (offset + 2 > b.length || marker === 0x00 || marker === 0xd8) return false;
    const length = view.getUint16(offset);
    if (length < 2 || offset + length > b.length) return false;
    if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
      if (length < 8 || !dimensions(view.getUint16(offset + 5), view.getUint16(offset + 3))) return false;
      frame = true;
    }
    offset += length;
    if (marker === 0xda) {
      if (!frame) return false; scan = true;
      while (offset < b.length) {
        if (b[offset] !== 0xff) { offset++; continue; }
        const next = b[offset + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) { offset += 2; continue; }
        break;
      }
    }
  }
  return false;
}
function webp(b: Uint8Array, view: DataView) {
  if (ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 4) !== 'WEBP' || view.getUint32(4, true) + 8 !== b.length) return false;
  let offset = 12, image = false;
  while (offset + 8 <= b.length) {
    const type = ascii(b, offset, 4), length = view.getUint32(offset + 4, true), end = offset + 8 + length;
    if (end > b.length) return false;
    if (type === 'VP8 ' && length >= 10 && b[offset + 11] === 0x9d && b[offset + 12] === 0x01 && b[offset + 13] === 0x2a)
      image = dimensions(view.getUint16(offset + 14, true) & 0x3fff, view.getUint16(offset + 16, true) & 0x3fff);
    if (type === 'VP8L' && length >= 5 && b[offset + 8] === 0x2f) image = true;
    // Animated WebP is outside the static-photo contract.
    if (type === 'ANMF' || type === 'ANIM') return false;
    offset = end + (length % 2);
  }
  return image && offset === b.length;
}
function heif(b: Uint8Array, view: DataView, declared: string) {
  let offset = 0, brand = false, meta = false, data = false;
  while (offset + 8 <= b.length) {
    const length = view.getUint32(offset), type = ascii(b, offset + 4, 4);
    // Large/zero-sized boxes are not accepted by this bounded photo contract.
    if (length < 8 || offset + length > b.length) return false;
    if (offset === 0) {
      if (type !== 'ftyp' || length < 16 || length % 4) return false;
      const primary = ascii(b, offset + 8, 4);
      const heic = ['heic','heix','hevc','hevx'].includes(primary);
      const generic = ['mif1','msf1','heif'].includes(primary);
      brand = heic || (declared === 'image/heif' && generic);
    }
    if (type === 'meta' && length > 12) meta = true;
    if (type === 'mdat' && length > 8) data = true;
    offset += length;
  }
  return brand && meta && data && offset === b.length;
}
export function inspectPhotoContent(body: ArrayBuffer, declaredMime: string | null): string | null {
  const mime = normalizedPhotoMime(declaredMime);
  if (!mime || body.byteLength < 12 || body.byteLength > MAX_PHOTO_BYTES) return null;
  const bytes = new Uint8Array(body), view = new DataView(body);
  try {
    const valid = mime === 'image/png' ? png(bytes, view) : mime === 'image/jpeg' ? jpeg(bytes, view)
      : mime === 'image/webp' ? webp(bytes, view) : heif(bytes, view, mime);
    return valid ? mime : null;
  } catch { return null; }
}

export async function readBoundedPhoto(stream: ReadableStream<Uint8Array>): Promise<ArrayBuffer | null> {
  const reader = stream.getReader(); const parts: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > MAX_PHOTO_BYTES) { await reader.cancel(); return null; } parts.push(value);
    }
    const buffer = new Uint8Array(new ArrayBuffer(size)); let offset = 0;
    for (const part of parts) { buffer.set(part, offset); offset += part.byteLength; }
    return buffer.buffer;
  } finally { reader.releaseLock(); }
}
