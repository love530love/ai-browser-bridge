import { extname } from 'node:path';

// The upload reply used to carry a four-entry MIME table, so a .pdf was sent
// as application/octet-stream and government portals (CNIPA and peers) rejected
// it in their front-end check. Keep those four original values unchanged and
// add the document, image and archive types a real upload flow actually needs.
export const MIME_TYPES = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.ofd': 'application/ofd',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/csv'
};

const FALLBACK_MIME = 'application/octet-stream';

// A bare type/subtype token: alphanumerics plus +, - and . on each side.
// Parameters like "; charset=utf-8" are intentionally rejected: the upload
// reply carries a media type, not a full Content-Type header.
const MIME_RE = /^[A-Za-z0-9][A-Za-z0-9.+-]*\/[A-Za-z0-9][A-Za-z0-9.+-]*$/;

export function mimeFor(filePath, explicit) {
  if (typeof filePath !== 'string' || filePath.trim() === '') {
    throw new Error('Invalid file path');
  }
  const extension = extname(filePath).toLowerCase();
  // Only an absent override (undefined or null) falls through to the extension
  // table. A present-but-invalid value must fail loudly instead of being
  // silently ignored and quietly replaced by the extension guess.
  if (explicit !== undefined && explicit !== null) {
    if (typeof explicit !== 'string') throw new Error('Invalid mimeType');
    const trimmed = explicit.trim();
    if (!MIME_RE.test(trimmed)) throw new Error('Invalid mimeType');
    return { mimeType: trimmed, source: 'explicit', extension };
  }
  const mimeType = MIME_TYPES[extension];
  if (mimeType) return { mimeType, source: 'extension', extension };
  return { mimeType: FALLBACK_MIME, source: 'fallback', extension };
}
