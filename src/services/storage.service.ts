import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { env } from '../config/env';

/**
 * Where uploaded files live. Only opaque storage keys are persisted in the database, so a cloud
 * implementation (e.g. Azure Blob Storage) can replace the local one without schema changes.
 */
export interface StorageService {
  /** Moves a fully received temporary upload into permanent storage; returns its storage key. */
  saveFromTemp(tempPath: string, extension: string): Promise<string>;
  /** Opens a stored file for reading. Throws if it doesn't exist. */
  open(key: string): Promise<{ stream: Readable; size: number }>;
  /** Deletes a stored file; missing files are ignored. */
  remove(key: string): Promise<void>;
}

export class LocalDiskStorage implements StorageService {
  private readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Directory multer writes in-flight uploads to. */
  get tempDir(): string {
    return path.join(this.root, 'tmp');
  }

  private resolveKey(key: string): string {
    const full = path.resolve(this.root, key);
    // Keys come from our own database, but never let one escape the storage root.
    if (!full.startsWith(this.root + path.sep)) throw new Error('Invalid storage key');
    return full;
  }

  async saveFromTemp(tempPath: string, extension: string): Promise<string> {
    const now = new Date();
    const dir = path.posix.join(
      'attachments',
      String(now.getUTCFullYear()),
      String(now.getUTCMonth() + 1).padStart(2, '0'),
    );
    const key = path.posix.join(dir, `${crypto.randomUUID()}${extension.toLowerCase()}`);
    const target = this.resolveKey(key);
    await fs.promises.mkdir(path.dirname(target), { recursive: true });
    await fs.promises.rename(tempPath, target);
    return key;
  }

  async open(key: string): Promise<{ stream: Readable; size: number }> {
    const full = this.resolveKey(key);
    const stat = await fs.promises.stat(full);
    return { stream: fs.createReadStream(full), size: stat.size };
  }

  async remove(key: string): Promise<void> {
    await fs.promises.rm(this.resolveKey(key), { force: true });
  }
}

export const localStorage = new LocalDiskStorage(env.UPLOAD_DIR);
export const storage: StorageService = localStorage;
