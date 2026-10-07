// LocalFilesystemEvidenceStorage: private evidence storage on the local disk for development and CI
// (ADR-006). Exclusive-create writes, read-only vault files, no overwrite and no delete API.
// PRODUCTION_SUBSTITUTION_REQUIRED: never a production control; production uses Alibaba OSS (WORM + KMS).
import { createReadStream } from "node:fs";
import { access, chmod, link, mkdir, open, unlink } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import type { EvidenceStorage } from "@cdf/application";
import { assertObjectKey, QUARANTINE_BUCKET, VAULT_BUCKET } from "./object-key";

export interface LocalFilesystemOptions {
  rootDir: string;
  environment: string;
  isVercel: boolean;
}

export class LocalFilesystemEvidenceStorage implements EvidenceStorage {
  readonly kind = "local-fs" as const;
  private readonly root: string;

  constructor(options: LocalFilesystemOptions) {
    if (options.isVercel || !["local", "test"].includes(options.environment)) {
      throw new Error("LocalFilesystemEvidenceStorage is only available in local and test environments");
    }
    this.root = resolve(options.rootDir);
  }

  private path(bucket: string, objectKey: string): string {
    const full = resolve(this.root, bucket, ...assertObjectKey(objectKey).split("/"));
    if (!full.startsWith(this.root + sep)) throw new Error("Invalid evidence object key");
    return full;
  }

  async putQuarantine(objectKey: string, body: Uint8Array, _contentType: string): Promise<void> {
    const target = this.path(QUARANTINE_BUCKET, objectKey);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // "wx": fail if the file exists. Nothing is ever overwritten (§27).
    const handle = await open(target, "wx", 0o600);
    try {
      await handle.writeFile(body);
    } finally {
      await handle.close();
    }
  }

  async promoteToVault(objectKey: string): Promise<void> {
    const source = this.path(QUARANTINE_BUCKET, objectKey);
    const target = this.path(VAULT_BUCKET, objectKey);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    // link() fails with EEXIST when the vault already holds the key, unlike rename() which would replace it.
    await link(source, target);
    await chmod(target, 0o400);
    await unlink(source);
  }

  async openReadStream(objectKey: string): Promise<ReadableStream<Uint8Array>> {
    const target = this.path(VAULT_BUCKET, objectKey);
    await access(target);
    return Readable.toWeb(createReadStream(target)) as ReadableStream<Uint8Array>;
  }

  async exists(objectKey: string): Promise<boolean> {
    const target = this.path(VAULT_BUCKET, objectKey); // key validation errors propagate
    try {
      await access(target);
      return true;
    } catch {
      return false;
    }
  }

  /** For tests and diagnostics: where a vault object would live. */
  vaultPathFor(objectKey: string): string {
    return join(this.root, VAULT_BUCKET, ...assertObjectKey(objectKey).split("/"));
  }
}
