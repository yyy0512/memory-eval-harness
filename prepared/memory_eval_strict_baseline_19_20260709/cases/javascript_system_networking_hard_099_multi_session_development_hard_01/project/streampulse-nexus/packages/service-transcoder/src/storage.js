```javascript
/**
 * StreamPulse Nexus – Transcoder Service
 * storage.js
 *
 * A pluggable, event-driven storage layer that persists transcoded media
 * segments to a variety of back-ends (local disk, Amazon S3, …).
 *
 * Patterns exercised:
 *   – Strategy         : select storage adapter at runtime
 *   – Observer / Event : emit progress + lifecycle events
 *   – Command          : expose high-level “store” and “restore” commands
 *
 * NOTE: The file is intentionally written in modern EcmaScript (ES2022)
 *       syntax supported by Node ≥18.x (import.meta.url, top-level await, …).
 */

import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { EventEmitter } from 'node:events';

/* Optional dependency – loaded lazily to avoid pulling the entire SDK for
 * environments that only use LocalDiskAdapter. */
let S3Client, PutObjectCommand, UploadPartCommand, CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand, AbortMultipartUploadCommand;
const maybeLoadAws = () => {
  if (S3Client) return; // already loaded
  // eslint-disable-next-line import/no-extraneous-dependencies, global-require
  ({ S3Client,
    PutObjectCommand,
    UploadPartCommand,
    CreateMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    AbortMultipartUploadCommand
  } = require('@aws-sdk/client-s3'));
};


/* ------------------------------------------------------------------------ *
 *                              CONFIGURATION                               *
 * ------------------------------------------------------------------------ */

const DEFAULTS = {
  adapter: process.env.TRANSCODER_STORAGE_ADAPTER ?? 'local',
  local: {
    rootDir: process.env.TRANSCODER_STORAGE_ROOT ?? path.join(process.cwd(), 'dist', 'segments')
  },
  s3: {
    region     : process.env.AWS_REGION       ?? 'us-east-1',
    bucket     : process.env.S3_BUCKET        ?? 'streampulse-segments',
    endpoint   : process.env.S3_ENDPOINT      ?? undefined, // Optional non-AWS endpoint
    credentials: {
      accessKeyId    : process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    },
    uploadPartSize: Math.min(
      Math.max(parseInt(process.env.S3_UPLOAD_PART_SIZE ?? '10485760', 10), 5_242_880), // 5 MiB ≤ part ≤ 5 GiB
      5_368_709_120
    )
  }
};


/* ------------------------------------------------------------------------ *
 *                             HELPER UTILITIES                             *
 * ------------------------------------------------------------------------ */

/**
 * Generates a cryptographically sound random file/segment name.
 * @param {string} extension including leading dot, e.g. ".m4s"
 */
export const randomKey = (extension = '') =>
  crypto.randomUUID({ disableEntropyCache: true }) + extension;


const ensureDir = async dir => {
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
};


/* ------------------------------------------------------------------------ *
 *                           STORAGE ADAPTER API                            *
 * ------------------------------------------------------------------------ */

/**
 * @typedef {Object} UploadResult
 * @property {string} url   – absolute URL (signed or public) to the stored object
 * @property {number} size  – number of bytes written
 * @property {string} etag  – entity tag / content hash (if available)
 * @property {string} key   – provider-specific object key / path
 */

/** Abstract adapter which concrete providers extend */
class BaseAdapter {
  /**
   * @param {EventEmitter} bus – Event bus to emit lifecycle events to
   * @param {Object} opts – Adapter-specific configuration
   */
  constructor(bus, opts = {}) {
    this.bus  = bus;
    this.opts = opts;
  }

  /** @param {ReadableStream|Buffer|string} source */
  async put(/* source, options */) {
    throw new Error('put() not implemented by adapter');
  }

  /** Optional health check */
  // eslint-disable-next-line class-methods-use-this
  async ping() { return true; }
}


/* --------------------------------- LOCAL -------------------------------- */

class LocalDiskAdapter extends BaseAdapter {
  constructor(bus, opts) {
    super(bus, opts);
    this.root = path.resolve(opts.rootDir);
  }

  /**
   * @param {ReadableStream|Buffer|string} source – file path, buffer or stream
   * @param {Object} [options]
   * @param {string} [options.extension=".dat"]
   * @returns {UploadResult}
   */
  async put(source, options = {}) {
    const extension = options.extension ?? '.dat';
    const key       = randomKey(extension);
    const filePath  = path.join(this.root, key);

    await ensureDir(this.root);
    this.bus.emit('upload-start', { adapter: 'local', key });

    const writeStream = fs.createWriteStream(filePath);
    let size = 0;

    try {
      if (Buffer.isBuffer(source)) {
        size = source.byteLength;
        await fsp.writeFile(filePath, source);
      } else if (typeof source === 'string') {            // path to existing file
        await pipeline(fs.createReadStream(source), writeStream);
        const stat = await fsp.stat(filePath);
        size = stat.size;
      } else if (source?.pipe) {                          // Node stream
        source.on('data', chunk => {
          size += chunk.length;
          this.bus.emit('upload-progress', { adapter: 'local', key, size });
        });
        await pipeline(source, writeStream);
      } else {
        throw new TypeError('Unsupported source type for LocalDiskAdapter#put()');
      }

      this.bus.emit('upload-complete', { adapter: 'local', key, size });
      return {
        url : `file://${filePath}`,
        size,
        etag: crypto.createHash('md5').update(String(size)).digest('hex'), // Simple ETag stand-in
        key
      };
    } catch (err) {
      this.bus.emit('upload-error', { adapter: 'local', key, error: err });
      throw err;
    }
  }

  async ping() {
    try {
      await ensureDir(this.root);
      return true;
    } catch {
      return false;
    }
  }
}


/* ---------------------------------- S3 ---------------------------------- */

class S3Adapter extends BaseAdapter {
  constructor(bus, opts) {
    maybeLoadAws();
    super(bus, opts);

    this.client = new S3Client({
      region     : opts.region,
      endpoint   : opts.endpoint,
      credentials: opts.credentials
    });

    this.bucket         = opts.bucket;
    this.uploadPartSize = opts.uploadPartSize;
  }

  /**
   * Uploads object using single PutObject or multipart depending on size.
   * @param {ReadableStream|Buffer|string} source – media segment
   * @param {Object} [options]
   * @param {string} [options.extension=".dat"]
   * @returns {UploadResult}
   */
  async put(source, options = {}) {
    const extension = options.extension ?? '.dat';
    const key       = randomKey(extension);

    // Normalize source into ReadableStream
    let stream, size;
    if (Buffer.isBuffer(source)) {
      size   = source.byteLength;
      stream = ReadableFromBuffer(source);
    } else if (typeof source === 'string') {
      const stat = await fsp.stat(source);
      size   = stat.size;
      stream = fs.createReadStream(source);
    } else if (source?.pipe) {
      stream = source;
      size   = undefined; // unknown for now
    } else {
      throw new TypeError('Unsupported source type for S3Adapter#put()');
    }

    const isMultipart = size === undefined || size > this.uploadPartSize;
    this.bus.emit('upload-start', { adapter: 's3', key, isMultipart });

    try {
      const result = isMultipart
        ? await this.#multipartUpload({ stream, size, key })
        : await this.#singlePut({ stream, size, key });

      this.bus.emit('upload-complete', { adapter: 's3', key, size: result.size });
      return result;
    } catch (err) {
      this.bus.emit('upload-error', { adapter: 's3', key, error: err });
      throw err;
    }
  }

  async #singlePut({ stream, size, key }) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key   : key,
      Body  : stream
    });
    const { ETag } = await this.client.send(command);
    return {
      url : this.#objectUrl(key),
      size: size ?? 0,
      etag: ETag?.replace(/"/g, ''),
      key
    };
  }

  async #multipartUpload({ stream, key }) {
    // 1. Create multipart session
    const { UploadId } = await this.client.send(
      new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: key })
    );
    const parts = [];
    let partNumber = 1;
    let bytesUploaded = 0;
    const partSize = this.uploadPartSize;

    // 2. Stream → parts
    for await (const chunk of chunkStream(stream, partSize)) {
      const currentPartNumber = partNumber; // snapshot for closure
      const etag = await this.#uploadPart({ UploadId, key, partNumber: currentPartNumber, body: chunk });
      parts.push({ ETag: etag, PartNumber: currentPartNumber });
      bytesUploaded += chunk.length;
      this.bus.emit('upload-progress', { adapter: 's3', key, part: currentPartNumber, bytesUploaded });
      partNumber += 1;
    }

    // 3. Complete or abort
    try {
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket,
        Key   : key,
        UploadId,
        MultipartUpload: { Parts: parts }
      }));
    } catch (err) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: key, UploadId }));
      throw err;
    }

    return {
      url : this.#objectUrl(key),
      size: bytesUploaded,
      etag: parts[parts.length - 1]?.ETag?.replace(/"/g, ''),
      key
    };
  }

  async #uploadPart({ UploadId, key, partNumber, body }) {
    const { ETag } = await this.client.send(new UploadPartCommand({
      Bucket    : this.bucket,
      Key       : key,
      PartNumber: partNumber,
      UploadId,
      Body      : body
    }));
    return ETag?.replace(/"/g, '');
  }

  #objectUrl(key) {
    // NOTE: This may generate a virtual-hosted-style URL.
    // For access-controlled buckets you may want to generate a signed URL instead.
    const endpoint = this.opts.endpoint
      ? new URL(this.opts.endpoint)
      : new URL(`https://${this.bucket}.s3.${this.opts.region}.amazonaws.com`);
    endpoint.pathname = `/${key}`;
    return endpoint.toString();
  }

  async ping() {
    try {
      await this.client.config.credentials();
      return true;
    } catch {
      return false;
    }
  }
}


/* ------------------------------------------------------------------------ *
 *                            PUBLIC FACADE CLASS                           *
 * ------------------------------------------------------------------------ */

/**
 * StorageManager orchestrates uploads via chosen adapter while forwarding
 * events to external observers. Instances are cheap and can be created per
 * request, but callers should generally reuse a single instance to leverage
 * connection pooling.
 */
export class StorageManager extends EventEmitter {
  /**
   * @param {Object} [config] – override defaults
   * @param {'local'|'s3'} [config.adapter]
   * @param {Object} [config.local]
   * @param {Object} [config.s3]
   */
  constructor(config = {}) {
    super({ captureRejections: true });

    const resolved = deepmerge(DEFAULTS, config);
    switch (resolved.adapter) {
      case 'local':
        this.adapter = new LocalDiskAdapter(this, resolved.local);
        break;
      case 's3':
        this.adapter = new S3Adapter(this, resolved.s3);
        break;
      default:
        throw new Error(`Unsupported storage adapter: ${resolved.adapter}`);
    }
  }

  /**
   * Persists the given source to the configured storage backend.
   * @param {ReadableStream|Buffer|string} source
   * @param {Object} [options]
   * @param {string} [options.extension]
   * @returns {Promise<UploadResult>}
   */
  async store(source, options) {
    return this.adapter.put(source, options);
  }

  /**
   * Lightweight check to ensure adapter is healthy.
   */
  async health() {
    return this.adapter.ping();
  }
}


/* ------------------------------------------------------------------------ *
 *                                HELPERS                                   *
 * ------------------------------------------------------------------------ */

import { Readable } from 'node:stream';

/** Turns a buffer into a ReadableStream */
function ReadableFromBuffer(buf) {
  return Readable.from(buf, { objectMode: false });
}

/**
 * Async generator that yields chunks of size ≤ partSize from a stream.
 * Keeps memory footprint small for large uploads.
 */
async function* chunkStream(stream, partSize) {
  let buffer = Buffer.alloc(0);
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= partSize) {
      yield buffer.subarray(0, partSize);
      buffer = buffer.subarray(partSize);
    }
  }
  if (buffer.length) yield buffer;
}

/**
 * Deeply merges two JSON-serializable objects. Keeps arrays from source.
 * @param {Object} base
 * @param {Object} src
 */
function deepmerge(base, src) {
  const out = { ...base };
  for (const [key, value] of Object.entries(src)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      out[key] = deepmerge(base[key] ?? {}, value);
    } else if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}


/* ------------------------------------------------------------------------ *
 *                               SINGLETON                                  *
 * ------------------------------------------------------------------------ */

/**
 * For most transcoder nodes a single shared instance is sufficient.
 * Export default singleton configured via environment variables.
 */
export default new StorageManager();

/* eslint-disable-next-line no-unused-vars */
if (import.meta.vitest) {
  // Example: unit tests that exercise both adapters would live here.
}
```