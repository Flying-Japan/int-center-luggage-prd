import { deflateSync } from 'node:zlib';
/** Real 1x1 grayscale PNG container with valid CRCs/zlib bytes; no personal image. */
export function syntheticPng(label = 'synthetic'): Uint8Array<ArrayBuffer> {
  const chunk = (type: string, data: Uint8Array) => {
    const bytes = new Uint8Array(12 + data.length), view = new DataView(bytes.buffer);
    view.setUint32(0, data.length); bytes.set(new TextEncoder().encode(type), 4); bytes.set(data, 8);
    let crc = 0xffffffff;
    for (const byte of bytes.subarray(4, 8 + data.length)) { crc ^= byte; for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    view.setUint32(8 + data.length, (crc ^ 0xffffffff) >>> 0); return bytes;
  };
  const header = new Uint8Array(13); const view = new DataView(header.buffer); view.setUint32(0,1); view.setUint32(4,1); header[8]=8;
  const chunks = [new Uint8Array([137,80,78,71,13,10,26,10]), chunk('IHDR',header),
    chunk('tEXt',new TextEncoder().encode(`test\0${label}`)),chunk('IDAT',deflateSync(new Uint8Array([0,127]))),chunk('IEND',new Uint8Array())];
  const result = new Uint8Array(new ArrayBuffer(chunks.reduce((n,c)=>n+c.length,0))); let offset = 0;
  for (const item of chunks) { result.set(item,offset); offset += item.length; } return result;
}
