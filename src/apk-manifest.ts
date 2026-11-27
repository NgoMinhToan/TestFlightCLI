import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";
import { inflateRawSync } from "node:zlib";
import { normalizeAbi, sortAbis, type Abi } from "./abi.js";

/**
 * The mismatch categories the server accepts in `?allow_mismatch=`. The CLI
 * only sends the ones a user deliberately overrode, never a blanket value.
 */
export type MismatchKind = "package" | "version" | "sdk" | "abi";

export const MISMATCH_KINDS: readonly MismatchKind[] = [
  "package",
  "version",
  "sdk",
  "abi",
];

/**
 * Metadata read from an APK's binary `AndroidManifest.xml`. The field names and
 * semantics are shared with the server and the dashboard parser.
 */
export interface ApkMetadata {
  packageName: string;
  versionCode: number;
  versionName: string | null;
  minSdk: number | null;
  targetSdk: number | null;
  /** Native ABIs found under `lib/<abi>/`; never contains `universal`. */
  abis: Abi[];
  universal: boolean;
  debuggable: boolean;
  testOnly: boolean;
  split: string | null;
  configSplit: boolean;
}

export interface DetectedApk extends ApkMetadata {
  /** The ABI artifact the APK should be published as. */
  artifactAbi: Abi;
}

export type ApkInspectionErrorCode = "invalid_apk" | "zip64";

/** A malformed APK or an archive the zero-dependency reader cannot inspect. */
export class ApkInspectionError extends Error {
  readonly code: ApkInspectionErrorCode;

  constructor(code: ApkInspectionErrorCode, message: string) {
    super(message);
    this.name = "ApkInspectionError";
    this.code = code;
  }
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 200_000;
const MAX_COMPRESSED_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_INFLATED_MANIFEST_BYTES = 8 * 1024 * 1024;

const AXML_SIGNATURE = 0x0003;
const AXML_STRING_POOL = 0x0001;
const AXML_START_ELEMENT = 0x0102;
const UTF8_STRING_POOL_FLAG = 0x100;

const TYPE_REFERENCE = 0x01;
const TYPE_STRING = 0x03;
const TYPE_INT_DEC = 0x10;
const TYPE_INT_HEX = 0x11;
const TYPE_INT_BOOLEAN = 0x12;

const NO_INDEX = 0xffffffff;

/** Random-access byte source; files are read in ranges, never wholly loaded. */
export interface ByteSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Buffer>;
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function invalid(message: string): ApkInspectionError {
  return new ApkInspectionError("invalid_apk", message);
}

function bufferSource(buffer: Buffer): ByteSource {
  return {
    size: buffer.length,
    read(offset, length) {
      const start = Math.max(0, Math.min(offset, buffer.length));
      const end = Math.max(start, Math.min(offset + length, buffer.length));
      return Promise.resolve(buffer.subarray(start, end));
    },
  };
}

/** Wraps an open file handle so ZIP structures can be read in ranges. */
export function fileByteSource(handle: FileHandle, size: number): ByteSource {
  return {
    size,
    async read(offset, length) {
      if (length <= 0 || offset >= size) return Buffer.alloc(0);
      const available = Math.min(length, size - offset);
      const buffer = Buffer.alloc(available);
      let read = 0;
      while (read < available) {
        const result = await handle.read(buffer, read, available - read, offset + read);
        if (result.bytesRead === 0) break;
        read += result.bytesRead;
      }
      return read === available ? buffer : buffer.subarray(0, read);
    },
  };
}

interface EndOfCentralDirectory {
  tail: Buffer;
  offset: number;
}

async function findEndOfCentralDirectory(source: ByteSource): Promise<EndOfCentralDirectory> {
  if (source.size < EOCD_MIN_SIZE) throw invalid("file is too small to be a ZIP archive");

  const tailSize = Math.min(source.size, EOCD_MIN_SIZE + MAX_COMMENT_SIZE);
  const tail = await source.read(source.size - tailSize, tailSize);
  for (let offset = tail.length - EOCD_MIN_SIZE; offset >= 0; offset -= 1) {
    if (tail.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
    const commentLength = tail.readUInt16LE(offset + 20);
    if (offset + EOCD_MIN_SIZE + commentLength <= tail.length) {
      return { tail, offset };
    }
  }
  throw invalid("no end-of-central-directory record");
}

/**
 * Reads and validates the ZIP central directory. Throws `zip64` for archives
 * that use ZIP64 sentinels, which this parser intentionally does not support.
 */
export async function readCentralDirectory(source: ByteSource): Promise<ZipEntry[]> {
  const { tail, offset } = await findEndOfCentralDirectory(source);
  const entryCount = tail.readUInt16LE(offset + 10);
  const centralDirectorySize = tail.readUInt32LE(offset + 12);
  const centralDirectoryOffset = tail.readUInt32LE(offset + 16);

  if (
    entryCount === 0xffff ||
    centralDirectorySize === 0xffffffff ||
    centralDirectoryOffset === 0xffffffff
  ) {
    throw new ApkInspectionError("zip64", "ZIP64 archives are not supported");
  }
  if (centralDirectorySize > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw invalid("central directory is implausibly large");
  }
  if (centralDirectoryOffset + centralDirectorySize > source.size) {
    throw invalid("central directory is out of bounds");
  }

  const centralDirectory = await source.read(centralDirectoryOffset, centralDirectorySize);
  if (centralDirectory.length !== centralDirectorySize) {
    throw invalid("central directory is truncated");
  }

  const entries: ZipEntry[] = [];
  let offsetInDirectory = 0;

  while (offsetInDirectory + 46 <= centralDirectory.length) {
    if (centralDirectory.readUInt32LE(offsetInDirectory) !== CENTRAL_DIRECTORY_SIGNATURE) break;

    const method = centralDirectory.readUInt16LE(offsetInDirectory + 10);
    const compressedSize = centralDirectory.readUInt32LE(offsetInDirectory + 20);
    const uncompressedSize = centralDirectory.readUInt32LE(offsetInDirectory + 24);
    const nameLength = centralDirectory.readUInt16LE(offsetInDirectory + 28);
    const extraLength = centralDirectory.readUInt16LE(offsetInDirectory + 30);
    const commentLength = centralDirectory.readUInt16LE(offsetInDirectory + 32);
    const localHeaderOffset = centralDirectory.readUInt32LE(offsetInDirectory + 42);

    const nameStart = offsetInDirectory + 46;
    const nameEnd = nameStart + nameLength;
    if (nameEnd > centralDirectory.length) throw invalid("central directory entry is truncated");

    if (entries.length >= MAX_ENTRIES) throw invalid("archive has too many entries");

    // ZIP64 sentinels can also live only in a single entry.
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localHeaderOffset === 0xffffffff
    ) {
      throw new ApkInspectionError("zip64", "ZIP64 archives are not supported");
    }

    entries.push({
      name: centralDirectory.toString("utf8", nameStart, nameEnd),
      method,
      compressedSize,
      uncompressedSize,
      localHeaderOffset,
    });

    offsetInDirectory = nameEnd + extraLength + commentLength;
  }

  return entries;
}

/** Collects `lib/<abi>/` names into a sorted, de-duplicated ABI list. */
export function collectAbis(entries: readonly ZipEntry[]): Abi[] {
  const abis = new Set<Abi>();
  for (const entry of entries) {
    if (!entry.name.startsWith("lib/")) continue;
    const abi = entry.name.split("/")[1];
    if (!abi) continue;
    const normalized = normalizeAbi(abi);
    if (normalized) abis.add(normalized);
  }
  return sortAbis(abis);
}

function isStoredOrDeflated(method: number): boolean {
  return method === 0 || method === 8;
}

async function readManifestBytes(
  source: ByteSource,
  entries: readonly ZipEntry[],
): Promise<Buffer> {
  const entry = entries.find((candidate) => candidate.name === "AndroidManifest.xml");
  if (!entry) throw invalid("AndroidManifest.xml is missing");

  if (!isStoredOrDeflated(entry.method)) {
    throw invalid(`AndroidManifest.xml uses unsupported compression method ${entry.method}`);
  }
  if (entry.compressedSize > MAX_COMPRESSED_MANIFEST_BYTES) {
    throw invalid("AndroidManifest.xml is larger than 16 MiB compressed");
  }
  if (entry.uncompressedSize > MAX_INFLATED_MANIFEST_BYTES) {
    throw invalid("AndroidManifest.xml is larger than 8 MiB");
  }

  const localHeader = await source.read(entry.localHeaderOffset, 30);
  if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== LOCAL_FILE_SIGNATURE) {
    throw invalid("AndroidManifest.xml local header is unreadable");
  }
  const nameLength = localHeader.readUInt16LE(26);
  const extraLength = localHeader.readUInt16LE(28);
  const dataOffset = entry.localHeaderOffset + 30 + nameLength + extraLength;
  if (dataOffset + entry.compressedSize > source.size) {
    throw invalid("AndroidManifest.xml data is out of bounds");
  }

  const compressed = await source.read(dataOffset, entry.compressedSize);
  if (compressed.length !== entry.compressedSize) {
    throw invalid("AndroidManifest.xml data is truncated");
  }

  let data: Buffer;
  if (entry.method === 0) {
    data = compressed;
  } else {
    try {
      data = inflateRawSync(compressed, {
        maxOutputLength: MAX_INFLATED_MANIFEST_BYTES,
      });
    } catch {
      throw invalid("AndroidManifest.xml could not be inflated");
    }
  }
  if (data.length > MAX_INFLATED_MANIFEST_BYTES) {
    throw invalid("AndroidManifest.xml is larger than 8 MiB");
  }
  return data;
}

async function readManifestMetadata(
  source: ByteSource,
  entries: readonly ZipEntry[],
): Promise<ApkMetadata> {
  const manifest = await readManifestBytes(source, entries);
  return parseAxmlManifest(manifest);
}

/** Reads just the manifest metadata from an APK file. */
export async function readApkMetadata(filePath: string): Promise<ApkMetadata> {
  return stripDetected(await inspectApkFile(filePath));
}

/** Parses an in-memory APK file, used by tests and the fake server. */
export async function parseApkMetadata(buffer: Buffer): Promise<ApkMetadata> {
  return stripDetected(await inspectApkBuffer(buffer));
}

/** Parses an in-memory APK and adds the artifact ABI. */
export async function inspectApkBuffer(buffer: Buffer): Promise<DetectedApk> {
  return inspectSource(bufferSource(buffer));
}

function stripDetected(detected: DetectedApk): ApkMetadata {
  const { artifactAbi: _artifactAbi, ...metadata } = detected;
  return metadata;
}

/** `universal` unless the APK has exactly one native ABI. */
export function artifactAbiOf(metadata: ApkMetadata): Abi {
  return metadata.universal ? "universal" : (metadata.abis[0] ?? "universal");
}

interface AttributeValue {
  kind: "string" | "int" | "boolean" | "reference" | "unknown";
  string?: string | null;
  int?: number;
  boolean?: boolean;
}

interface ParsedStringPool {
  strings: string[];
}

function ensureRange(buffer: Buffer, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw invalid(`${what} is truncated`);
  }
}

function readUtf8Length(buffer: Buffer, offset: number): { length: number; next: number } {
  ensureRange(buffer, offset, 1, "string pool");
  const first = buffer[offset]!;
  if ((first & 0x80) === 0) return { length: first, next: offset + 1 };
  ensureRange(buffer, offset, 2, "string pool");
  return { length: ((first & 0x7f) << 8) | buffer[offset + 1]!, next: offset + 2 };
}

function readUtf16Length(buffer: Buffer, offset: number): { length: number; next: number } {
  ensureRange(buffer, offset, 2, "string pool");
  const first = buffer.readUInt16LE(offset);
  if ((first & 0x8000) === 0) return { length: first, next: offset + 2 };
  ensureRange(buffer, offset, 4, "string pool");
  const second = buffer.readUInt16LE(offset + 2);
  return { length: ((first & 0x7fff) << 16) | second, next: offset + 4 };
}

function decodeStringPool(
  pool: ParsedStringPool,
  chunk: Buffer,
  chunkSize: number,
): void {
  ensureRange(chunk, 0, 28, "string pool header");
  const headerSize = chunk.readUInt16LE(2);
  const stringCount = chunk.readUInt32LE(8);
  const flags = chunk.readUInt32LE(16);
  const stringsStart = chunk.readUInt32LE(20);

  if (stringCount > MAX_ENTRIES) throw invalid("string pool is implausibly large");
  const offsetsStart = headerSize;
  ensureRange(chunk, offsetsStart, stringCount * 4, "string pool offsets");
  if (stringsStart > chunkSize) throw invalid("string pool data is out of bounds");

  const utf8 = (flags & UTF8_STRING_POOL_FLAG) !== 0;

  for (let index = 0; index < stringCount; index += 1) {
    const relative = chunk.readUInt32LE(offsetsStart + index * 4);
    let position = stringsStart + relative;
    if (position >= chunkSize) throw invalid("string pool string is out of bounds");

    if (utf8) {
      const chars = readUtf8Length(chunk, position);
      position = chars.next;
      const bytes = readUtf8Length(chunk, position);
      position = bytes.next;
      ensureRange(chunk, position, bytes.length, "string pool string");
      pool.strings.push(chunk.toString("utf8", position, position + bytes.length));
    } else {
      const length = readUtf16Length(chunk, position);
      position = length.next;
      ensureRange(chunk, position, length.length * 2, "string pool string");
      pool.strings.push(chunk.toString("utf16le", position, position + length.length * 2));
    }
  }
}

function attributeValue(chunk: Buffer, position: number, strings: readonly string[]): AttributeValue {
  const rawIndex = chunk.readUInt32LE(position + 8);
  const dataType = chunk[position + 15]!;
  const data = chunk.readUInt32LE(position + 16);

  switch (dataType) {
    case TYPE_STRING:
      return {
        kind: "string",
        string: data === NO_INDEX ? null : (strings[data] ?? null),
      };
    case TYPE_INT_DEC:
    case TYPE_INT_HEX:
      return { kind: "int", int: data };
    case TYPE_INT_BOOLEAN:
      return { kind: "boolean", boolean: data !== 0 };
    case TYPE_REFERENCE:
      return { kind: "reference" };
    default:
      if (rawIndex !== NO_INDEX && rawIndex < strings.length) {
        return { kind: "string", string: strings[rawIndex] ?? null };
      }
      return { kind: "unknown" };
  }
}

interface ManifestAttributes {
  packageName: string | null;
  versionCode: number | null;
  versionName: string | null;
  minSdk: number | null;
  targetSdk: number | null;
  debuggable: boolean;
  testOnly: boolean;
  split: string | null;
  configForSplit: boolean;
}

function readManifestAttributes(
  attrs: ManifestAttributes,
  element: Buffer,
  chunkSize: number,
  strings: readonly string[],
): void {
  const attributeStart = element.readUInt16LE(24);
  const attributeSize = element.readUInt16LE(26) || 20;
  const attributeCount = element.readUInt16LE(28);

  for (let index = 0; index < attributeCount; index += 1) {
    const position = 16 + attributeStart + index * attributeSize;
    if (position + 20 > chunkSize) throw invalid("manifest attribute is out of bounds");
    const nameIndex = element.readUInt32LE(position + 4);
    const name = nameIndex === NO_INDEX ? null : (strings[nameIndex] ?? null);
    if (!name) continue;
    const value = attributeValue(element, position, strings);

    switch (name) {
      case "package":
        if (value.kind === "string" && value.string) attrs.packageName = value.string;
        break;
      case "versionCode":
        if (value.kind === "int" && value.int !== undefined) attrs.versionCode = value.int;
        break;
      case "versionName":
        attrs.versionName = value.kind === "string" ? (value.string ?? null) : null;
        break;
      case "minSdkVersion":
        if (value.kind === "int" && value.int !== undefined) attrs.minSdk = value.int;
        break;
      case "targetSdkVersion":
        if (value.kind === "int" && value.int !== undefined) attrs.targetSdk = value.int;
        break;
      case "debuggable":
        if (value.kind === "boolean") attrs.debuggable = value.boolean ?? false;
        break;
      case "testOnly":
        if (value.kind === "boolean") attrs.testOnly = value.boolean ?? false;
        break;
      case "split":
        if (value.kind === "string") attrs.split = value.string ?? null;
        break;
      case "configForSplit":
        attrs.configForSplit = true;
        break;
      default:
        break;
    }
  }
}

/**
 * Parses a binary AndroidManifest.xml (AXML). The accepted chunk layout and
 * typed-value rules match the server and dashboard implementations.
 */
export function parseAxmlManifest(axml: Buffer): ApkMetadata {
  if (axml.length < 8) throw invalid("AndroidManifest.xml is too small");
  if (axml.readUInt16LE(0) !== AXML_SIGNATURE) {
    throw invalid("AndroidManifest.xml is not valid AXML");
  }
  const xmlHeaderSize = axml.readUInt16LE(2);
  const xmlSize = axml.readUInt32LE(4);
  if (xmlHeaderSize < 8 || xmlHeaderSize > axml.length) {
    throw invalid("AndroidManifest.xml header is invalid");
  }
  const end = Math.min(xmlSize, axml.length);
  if (end < xmlHeaderSize) throw invalid("AndroidManifest.xml is truncated");

  const pool: ParsedStringPool = { strings: [] };
  const attrs: ManifestAttributes = {
    packageName: null,
    versionCode: null,
    versionName: null,
    minSdk: null,
    targetSdk: null,
    debuggable: false,
    testOnly: false,
    split: null,
    configForSplit: false,
  };
  let sawManifest = false;

  let offset = xmlHeaderSize;
  while (offset + 8 <= end) {
    const chunkType = axml.readUInt16LE(offset);
    const headerSize = axml.readUInt16LE(offset + 2);
    const chunkSize = axml.readUInt32LE(offset + 4);
    if (headerSize < 8 || chunkSize < headerSize || offset + chunkSize > end) {
      throw invalid("AndroidManifest.xml contains a malformed chunk");
    }
    const chunk = axml.subarray(offset, offset + chunkSize);

    if (chunkType === AXML_STRING_POOL) {
      decodeStringPool(pool, chunk, chunkSize);
    } else if (chunkType === AXML_START_ELEMENT) {
      if (chunkSize < 36) throw invalid("AndroidManifest.xml element is truncated");
      const nameIndex = chunk.readUInt32LE(20);
      const name = nameIndex === NO_INDEX ? null : (pool.strings[nameIndex] ?? null);
      if (name === "manifest") {
        sawManifest = true;
        readManifestAttributes(attrs, chunk, chunkSize, pool.strings);
      } else if (name === "uses-sdk") {
        readManifestAttributes(attrs, chunk, chunkSize, pool.strings);
      }
    }

    offset += chunkSize;
  }

  if (!sawManifest) throw invalid("AndroidManifest.xml has no <manifest> element");
  if (!attrs.packageName) throw invalid("AndroidManifest.xml has no package attribute");
  if (attrs.versionCode === null || attrs.versionCode <= 0) {
    throw invalid("AndroidManifest.xml has no positive versionCode");
  }

  const abis: Abi[] = [];
  const split = attrs.split;
  return {
    packageName: attrs.packageName,
    versionCode: attrs.versionCode,
    versionName: attrs.versionName,
    minSdk: attrs.minSdk,
    targetSdk: attrs.targetSdk,
    abis,
    universal: true,
    debuggable: attrs.debuggable,
    testOnly: attrs.testOnly,
    split,
    configSplit: (split?.startsWith("config.") ?? false) || attrs.configForSplit,
  };
}

/** Metadata plus `lib/<abi>/` entries; the AXML itself never carries ABIs. */
function withEntries(metadata: ApkMetadata, entries: readonly ZipEntry[]): ApkMetadata {
  const abis = collectAbis(entries);
  return { ...metadata, abis, universal: abis.length !== 1 };
}

/** Reads central-directory entries and manifest metadata for a file source. */
export async function inspectSource(source: ByteSource): Promise<DetectedApk> {
  const entries = await readCentralDirectory(source);
  const metadata = withEntries(await readManifestMetadata(source, entries), entries);
  return { ...metadata, artifactAbi: artifactAbiOf(metadata) };
}

export async function inspectApkFile(filePath: string): Promise<DetectedApk> {
  const handle = await open(filePath, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw invalid(`"${filePath}" is not a file`);
    return await inspectSource(fileByteSource(handle, info.size));
  } finally {
    await handle.close();
  }
}

export { withEntries };
