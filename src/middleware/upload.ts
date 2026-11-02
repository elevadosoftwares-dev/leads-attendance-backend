import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import multer from 'multer';
import { env } from '../config/env';
import { localStorage } from '../services/storage.service';
import { AppError } from '../utils/AppError';

interface AllowedType {
  mimeTypes: string[];
  /** Leading bytes every valid file of this type starts with. */
  signature: Buffer;
}

const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // docx/xlsx are zip containers

export const ALLOWED_UPLOADS: Record<string, AllowedType> = {
  '.pdf': { mimeTypes: ['application/pdf'], signature: Buffer.from('%PDF') },
  '.jpg': { mimeTypes: ['image/jpeg', 'image/jpg'], signature: Buffer.from([0xff, 0xd8, 0xff]) },
  '.jpeg': { mimeTypes: ['image/jpeg', 'image/jpg'], signature: Buffer.from([0xff, 0xd8, 0xff]) },
  '.png': {
    mimeTypes: ['image/png'],
    signature: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  },
  '.docx': {
    mimeTypes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    signature: ZIP,
  },
  '.xlsx': {
    mimeTypes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    signature: ZIP,
  },
};

const unsupported = () =>
  AppError.validation('Unsupported file type. Allowed: pdf, jpg, png, docx, xlsx.', {
    fields: [{ field: 'file', message: 'unsupported file type' }],
  });

fs.mkdirSync(localStorage.tempDir, { recursive: true });

const multerUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(localStorage.tempDir, { recursive: true }, (err) => cb(err ?? null, localStorage.tempDir));
    },
    // Never trust the client's file name on disk.
    filename: (_req, _file, cb) => cb(null, `${crypto.randomUUID()}.upload`),
  }),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (_req, file, cb) => {
    const allowed = ALLOWED_UPLOADS[path.extname(file.originalname).toLowerCase()];
    if (!allowed || !allowed.mimeTypes.includes(file.mimetype.toLowerCase())) return cb(unsupported());
    cb(null, true);
  },
}).single('file');

async function hasSignature(filePath: string, signature: Buffer): Promise<boolean> {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(signature.length);
    const { bytesRead } = await handle.read(buffer, 0, signature.length, 0);
    return bytesRead === signature.length && buffer.equals(signature);
  } finally {
    await handle.close();
  }
}

/**
 * Accepts one multipart field named `file` (pdf, jpg, png, docx, xlsx; size limited by MAX_UPLOAD_MB),
 * checks the content actually matches the extension, and leaves it in `req.file` as a temp file.
 */
export function singleFileUpload(req: Request, res: Response, next: NextFunction): void {
  multerUpload(req, res, (err: unknown) => {
    if (err) return next(err);
    const file = req.file;
    if (!file) {
      return next(
        AppError.validation('A file is required', { fields: [{ field: 'file', message: 'is required' }] }),
      );
    }
    const allowed = ALLOWED_UPLOADS[path.extname(file.originalname).toLowerCase()]!;
    hasSignature(file.path, allowed.signature)
      .then(async (ok) => {
        if (ok) return next();
        await fs.promises.rm(file.path, { force: true });
        next(unsupported());
      })
      .catch(next);
  });
}

/** Strips any path and control characters from a client-supplied file name. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f"]/g;

export function safeFileName(original: string): string {
  const base = path.basename(original.replace(/\\/g, '/')).replace(UNSAFE_FILENAME_CHARS, '').trim();
  return (base || 'file').slice(0, 255);
}
