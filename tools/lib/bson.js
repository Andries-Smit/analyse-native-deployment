'use strict';
/** Minimal BSON reader (enough for Mendix model.mdp). */
function readDoc(buf, off, isArray) {
  const len = buf.readInt32LE(off);
  const end = off + len - 1;
  let p = off + 4;
  const out = isArray ? [] : {};
  while (p < end) {
    const t = buf[p++];
    let z = buf.indexOf(0, p);
    const key = buf.toString('utf8', p, z);
    p = z + 1;
    let v;
    switch (t) {
      case 0x01: v = buf.readDoubleLE(p); p += 8; break;
      case 0x02: { const l = buf.readInt32LE(p); v = buf.toString('utf8', p + 4, p + 4 + l - 1); p += 4 + l; break; }
      case 0x03: case 0x04: { const l = buf.readInt32LE(p); v = readDoc(buf, p, t === 0x04); p += l; break; }
      case 0x05: { const l = buf.readInt32LE(p); const sub = buf[p + 4]; const data = buf.subarray(p + 5, p + 5 + l);
        v = (sub === 3 || sub === 4) && l === 16 ? uuidFromMs(data, sub) : data.toString('base64'); p += 5 + l; break; }
      case 0x06: case 0x0a: v = null; break;
      case 0x07: v = buf.subarray(p, p + 12).toString('hex'); p += 12; break;
      case 0x08: v = buf[p] === 1; p += 1; break;
      case 0x09: v = Number(buf.readBigInt64LE(p)); p += 8; break;
      case 0x10: v = buf.readInt32LE(p); p += 4; break;
      case 0x11: case 0x12: v = Number(buf.readBigInt64LE(p)); p += 8; break;
      default: throw new Error(`Unsupported BSON type 0x${t.toString(16)} at ${p}`);
    }
    if (isArray) out.push(v); else out[key] = v;
  }
  return out;
}
function uuidFromMs(b, sub) {
  // Mendix stores GUIDs as .NET (subtype 3) byte order
  const h = sub === 3
    ? [3,2,1,0,5,4,7,6,8,9,10,11,12,13,14,15].map((i) => b[i].toString(16).padStart(2, '0')).join('')
    : b.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
/** Read all top-level documents in a buffer. */
function readAll(buf) {
  const docs = [];
  let p = 0;
  while (p + 4 <= buf.length) {
    const l = buf.readInt32LE(p);
    if (l <= 4) break;
    docs.push(readDoc(buf, p, false));
    p += l;
  }
  return docs;
}
module.exports = { readDoc, readAll };
