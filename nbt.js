/**
 * Minimal Minecraft NBT reader — just enough to pull ExtraAttributes out of
 * SkyBlock item blobs. Works in Node and in the browser.
 *
 * Auction items and accessory-bag contents both arrive as gzipped NBT in base64.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NBT = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const TAG = { END: 0, BYTE: 1, SHORT: 2, INT: 3, LONG: 4, FLOAT: 5, DOUBLE: 6, BYTE_ARRAY: 7, STRING: 8, LIST: 9, COMPOUND: 10, INT_ARRAY: 11, LONG_ARRAY: 12 };

  /** Parse an uncompressed NBT buffer (Uint8Array / Buffer) into a plain object. */
  function parse(bytes) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let o = 0;

    const u8 = () => view.getUint8(o++);
    const i16 = () => { const v = view.getInt16(o); o += 2; return v; };
    const i32 = () => { const v = view.getInt32(o); o += 4; return v; };
    const str = () => {
      const len = view.getUint16(o); o += 2;
      const s = utf8(bytes.subarray(o, o + len)); o += len; return s;
    };

    function value(tag) {
      switch (tag) {
        case TAG.BYTE: { const v = view.getInt8(o); o += 1; return v; }
        case TAG.SHORT: return i16();
        case TAG.INT: return i32();
        case TAG.LONG: { const v = view.getBigInt64(o); o += 8; return Number(v); }
        case TAG.FLOAT: { const v = view.getFloat32(o); o += 4; return v; }
        case TAG.DOUBLE: { const v = view.getFloat64(o); o += 8; return v; }
        case TAG.BYTE_ARRAY: { const n = i32(); o += n; return null; }
        case TAG.STRING: return str();
        case TAG.LIST: {
          const inner = u8(); const n = i32(); const arr = [];
          for (let i = 0; i < n; i++) arr.push(value(inner));
          return arr;
        }
        case TAG.COMPOUND: {
          const obj = {};
          for (;;) { const t = u8(); if (t === TAG.END) break; obj[str()] = value(t); }
          return obj;
        }
        case TAG.INT_ARRAY: { const n = i32(); o += n * 4; return null; }
        case TAG.LONG_ARRAY: { const n = i32(); o += n * 8; return null; }
        default: throw new Error("unknown NBT tag " + tag);
      }
    }

    if (u8() !== TAG.COMPOUND) throw new Error("NBT root is not a compound");
    str();
    return value(TAG.COMPOUND);
  }

  function utf8(sub) {
    if (typeof TextDecoder !== "undefined") return new TextDecoder("utf-8").decode(sub);
    return Buffer.from(sub).toString("utf8");
  }

  /** base64 -> bytes */
  function fromBase64(b64) {
    if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(b64, "base64"));
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** gunzip, Promise<Uint8Array>. Node uses zlib; browsers use DecompressionStream. */
  const nodeZlib = (typeof process !== "undefined" && process.versions && process.versions.node)
    ? require("zlib") : null;

  async function gunzip(bytes) {
    if (nodeZlib) return new Uint8Array(nodeZlib.gunzipSync(bytes));
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Decode a gzipped-base64 SkyBlock item blob into its list of item compounds. */
  async function decodeItems(b64) {
    const raw = await gunzip(fromBase64(b64));
    const nbt = parse(raw);
    return nbt.i || [];
  }

  return { parse, fromBase64, gunzip, decodeItems };
});
