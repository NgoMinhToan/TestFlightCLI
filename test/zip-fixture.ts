import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { deflateRawSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInput {
  name: string;
  data?: string | Buffer;
  /** 0 = stored, 8 = deflate-raw. Defaults to 0. */
  method?: 0 | 8;
}

/**
 * Builds a minimal, valid ZIP archive. Supports stored and deflated entries,
 * which is enough for the CLI's central-directory + manifest reader.
 */
export function buildZip(entries: ZipInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let localOffset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data)
      ? entry.data
      : Buffer.from(entry.data ?? "", "utf8");
    const method = entry.method ?? 0;
    const stored = method === 8 ? deflateRawSync(data) : data;
    const checksum = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(stored.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(stored.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(localOffset, 42);

    localParts.push(local, name, stored);
    centralParts.push(central, name);
    localOffset += local.length + name.length + stored.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}

export interface FakeManifest {
  packageName?: string;
  versionCode?: number;
  versionName?: string | null;
  minSdk?: number | null;
  targetSdk?: number | null;
  debuggable?: boolean;
  testOnly?: boolean;
  split?: string | null;
  configForSplit?: boolean;
  /** Emit `versionName` as a resource reference instead of a literal. */
  versionNameReference?: boolean;
  /** Emit `versionCode` as a resource reference (invalid for publishing). */
  versionCodeReference?: boolean;
  /** Emit the SDK level as a string (a codename), which parsers map to null. */
  minSdkString?: string;
  targetSdkString?: string;
}

export const DEFAULT_FAKE_MANIFEST: FakeManifest = {
  packageName: "com.example.app",
  versionCode: 1,
  versionName: "1.0.0",
  minSdk: 21,
  targetSdk: 34,
  debuggable: false,
  testOnly: false,
  split: null,
  configForSplit: false,
};

interface AttributeSpec {
  name: string;
  dataType: number;
  /** String-pool index for strings/references, literal for ints/bools. */
  data: number;
}

interface ElementSpec {
  name: string;
  attributes: AttributeSpec[];
}

function encodeUtf8Length(value: number): Buffer {
  if (value > 0x7f) return Buffer.from([0x80 | (value >> 8), value & 0xff]);
  return Buffer.from([value]);
}

function pad4(buffer: Buffer): Buffer {
  const padding = (4 - (buffer.length % 4)) % 4;
  return padding === 0 ? buffer : Buffer.concat([buffer, Buffer.alloc(padding)]);
}

function buildStringPool(strings: readonly string[], utf8: boolean): Buffer {
  const dataParts: Buffer[] = [];
  const offsets: number[] = [];
  let dataLength = 0;

  for (const value of strings) {
    offsets.push(dataLength);
    if (utf8) {
      const bytes = Buffer.from(value, "utf8");
      const encoded = Buffer.concat([
        encodeUtf8Length(value.length),
        encodeUtf8Length(bytes.length),
        bytes,
        Buffer.from([0]),
      ]);
      dataParts.push(encoded);
      dataLength += encoded.length;
    } else {
      const bytes = Buffer.from(value, "utf16le");
      const length = Buffer.alloc(2);
      if (value.length > 0x7fff) {
        length.writeUInt16LE(0x8000 | (value.length >>> 16), 0);
        const low = Buffer.alloc(2);
        low.writeUInt16LE(value.length & 0xffff, 0);
        dataParts.push(length, low, bytes, Buffer.alloc(2), Buffer.alloc(2));
        dataLength += 2 + 2 + bytes.length + 2 + 2;
      } else {
        length.writeUInt16LE(value.length, 0);
        const terminator = Buffer.alloc(2);
        dataParts.push(length, bytes, terminator);
        dataLength += 2 + bytes.length + 2;
      }
    }
  }

  const paddedData = pad4(Buffer.concat(dataParts));
  const headerSize = 28;
  const offsetsStart = headerSize;
  const stringsStart = headerSize + strings.length * 4;
  const size = stringsStart + paddedData.length;
  const chunk = Buffer.alloc(size);

  chunk.writeUInt16LE(0x0001, 0);
  chunk.writeUInt16LE(headerSize, 2);
  chunk.writeUInt32LE(size, 4);
  chunk.writeUInt32LE(strings.length, 8);
  chunk.writeUInt32LE(0, 12);
  chunk.writeUInt32LE(utf8 ? 0x100 : 0, 16);
  chunk.writeUInt32LE(stringsStart, 20);
  chunk.writeUInt32LE(0, 24);

  for (const [index, offset] of offsets.entries()) {
    chunk.writeUInt32LE(offset, offsetsStart + index * 4);
  }
  paddedData.copy(chunk, stringsStart);
  return chunk;
}

function buildStartElement(element: ElementSpec, stringIndex: Map<string, number>): Buffer {
  const attributeSize = 20;
  const size = 36 + element.attributes.length * attributeSize;
  const chunk = Buffer.alloc(size);

  chunk.writeUInt16LE(0x0102, 0);
  chunk.writeUInt16LE(16, 2);
  chunk.writeUInt32LE(size, 4);
  chunk.writeUInt32LE(1, 8); // line number
  chunk.writeUInt32LE(0xffffffff, 12); // comment
  chunk.writeUInt32LE(0xffffffff, 16); // namespace
  chunk.writeUInt32LE(stringIndex.get(element.name) ?? 0, 20);
  chunk.writeUInt16LE(20, 24); // attributeStart (relative to +16)
  chunk.writeUInt16LE(attributeSize, 26);
  chunk.writeUInt16LE(element.attributes.length, 28);
  chunk.writeUInt16LE(0, 30);
  chunk.writeUInt16LE(0, 32);
  chunk.writeUInt16LE(0, 34);

  for (const [index, attribute] of element.attributes.entries()) {
    const position = 36 + index * attributeSize;
    chunk.writeUInt32LE(0xffffffff, position); // namespace
    chunk.writeUInt32LE(stringIndex.get(attribute.name) ?? 0, position + 4);
    chunk.writeUInt32LE(0xffffffff, position + 8); // rawValue
    chunk.writeUInt16LE(8, position + 12);
    chunk.writeUInt8(0, position + 14);
    chunk.writeUInt8(attribute.dataType, position + 15);
    chunk.writeUInt32LE(attribute.data, position + 16);
  }

  return chunk;
}

/**
 * Builds a small but structurally valid binary AndroidManifest.xml with the
 * same chunk layout real APKs use (XML header + string pool + start elements).
 */
export function buildAxmlManifest(
  manifest: FakeManifest,
  options: { utf8?: boolean } = {},
): Buffer {
  const merged = { ...DEFAULT_FAKE_MANIFEST, ...manifest };
  const stringSet = new Set<string>();
  const intern = (value: string): number => {
    if (!stringSet.has(value)) stringSet.add(value);
    return [...stringSet].indexOf(value);
  };

  const manifestAttributes: AttributeSpec[] = [];
  const usesSdkAttributes: AttributeSpec[] = [];

  const pushString = (target: AttributeSpec[], name: string, value: string): void => {
    intern(name);
    target.push({ name, dataType: 0x03, data: intern(value) });
  };
  const pushInt = (target: AttributeSpec[], name: string, value: number): void => {
    intern(name);
    target.push({ name, dataType: 0x10, data: value });
  };
  const pushBool = (target: AttributeSpec[], name: string, value: boolean): void => {
    intern(name);
    target.push({ name, dataType: 0x12, data: value ? 1 : 0 });
  };

  pushString(manifestAttributes, "package", merged.packageName ?? "com.example.app");
  if (merged.versionCodeReference) {
    intern("versionCode");
    manifestAttributes.push({
      name: "versionCode",
      dataType: 0x01,
      data: intern("@integer/version_code"),
    });
  } else {
    pushInt(manifestAttributes, "versionCode", merged.versionCode ?? 1);
  }

  if (merged.versionNameReference) {
    intern("versionName");
    manifestAttributes.push({
      name: "versionName",
      dataType: 0x01,
      data: intern("@string/app_name"),
    });
  } else if (merged.versionName !== null && merged.versionName !== undefined) {
    pushString(manifestAttributes, "versionName", merged.versionName);
  }

  if (merged.debuggable !== undefined) {
    pushBool(manifestAttributes, "debuggable", merged.debuggable);
  }
  if (merged.testOnly !== undefined) {
    pushBool(manifestAttributes, "testOnly", merged.testOnly);
  }
  if (merged.split !== null && merged.split !== undefined) {
    pushString(manifestAttributes, "split", merged.split);
  }
  if (merged.configForSplit) {
    intern("configForSplit");
    pushString(manifestAttributes, "configForSplit", "");
  }

  if (merged.minSdkString !== undefined) {
    pushString(usesSdkAttributes, "minSdkVersion", merged.minSdkString);
  } else if (merged.minSdk !== null && merged.minSdk !== undefined) {
    pushInt(usesSdkAttributes, "minSdkVersion", merged.minSdk);
  }
  if (merged.targetSdkString !== undefined) {
    pushString(usesSdkAttributes, "targetSdkVersion", merged.targetSdkString);
  } else if (merged.targetSdk !== null && merged.targetSdk !== undefined) {
    pushInt(usesSdkAttributes, "targetSdkVersion", merged.targetSdk);
  }

  const elements: ElementSpec[] = [{ name: "manifest", attributes: manifestAttributes }];
  if (usesSdkAttributes.length > 0) {
    elements.push({ name: "uses-sdk", attributes: usesSdkAttributes });
  }

  // Reserve element names so indices are stable regardless of map iteration.
  intern("manifest");
  intern("uses-sdk");

  const strings = [...stringSet];
  const stringIndex = new Map(strings.map((value, index) => [value, index]));
  const pool = buildStringPool(strings, options.utf8 ?? false);
  const elementChunks = elements.map((element) => buildStartElement(element, stringIndex));
  const size = 8 + pool.length + elementChunks.reduce((total, chunk) => total + chunk.length, 0);

  const header = Buffer.alloc(8);
  header.writeUInt16LE(0x0003, 0);
  header.writeUInt16LE(8, 2);
  header.writeUInt32LE(size, 4);

  return Buffer.concat([header, pool, ...elementChunks]);
}

export interface FakeApkOptions {
  /** Compression for every entry (the manifest included). Defaults to stored. */
  method?: 0 | 8;
  /** Replace the manifest bytes, e.g. with garbage to test the error path. */
  manifest?: Buffer | string | null;
  /** Use a UTF-8 string pool instead of UTF-16LE. */
  utf8Strings?: boolean;
  /**
   * Adds `assets/padding.bin` with this many zero bytes. Lets a streamed
   * upload test use a multi-MB body without committing a binary fixture.
   */
  paddingBytes?: number;
}

/**
 * Writes a fake APK containing `lib/<abi>/libtest.so` for every given ABI and a
 * binary manifest built from `manifest` (sensible defaults keep old 3-arg
 * callers working).
 */
export async function writeFakeApk(
  directory: string,
  fileName: string,
  abis: string[],
  manifest: FakeManifest = {},
  options: FakeApkOptions = {},
): Promise<string> {
  await mkdir(directory, { recursive: true });
  const method = options.method ?? 0;
  const manifestData =
    options.manifest === undefined
      ? buildAxmlManifest(manifest, { utf8: options.utf8Strings ?? false })
      : typeof options.manifest === "string"
        ? Buffer.from(options.manifest)
        : (options.manifest ?? Buffer.alloc(0));

  const entries: ZipInput[] = [
    { name: "AndroidManifest.xml", data: manifestData, method },
    { name: "classes.dex", data: "fake-dex", method },
    ...abis.map((abi) => ({
      name: `lib/${abi}/libtest.so`,
      data: `native-${abi}`,
      method,
    })),
  ];
  if (options.paddingBytes && options.paddingBytes > 0) {
    entries.push({
      name: "assets/padding.bin",
      data: Buffer.alloc(options.paddingBytes, 0x61),
      method,
    });
  }
  const filePath = path.join(directory, fileName);
  await writeFile(filePath, buildZip(entries));
  return filePath;
}
