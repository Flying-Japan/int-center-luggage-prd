/**
 * R2 image storage helpers using Worker R2 binding.
 * Replaces the old REST API approach via httpx.
 */

import { MAX_PHOTO_BYTES, normalizedPhotoMime, inspectPhotoContent, readBoundedPhoto } from './imageContent';
const MAX_IMAGE_SIZE = MAX_PHOTO_BYTES;

/**
 * Upload an image to R2.
 * @param bucket R2 bucket binding
 * @param key Object key (e.g., "id/20260219-001-uuid.jpg")
 * @param body Image data
 * @param contentType MIME type (e.g., "image/jpeg")
 */
export async function uploadImage(
  bucket: R2Bucket,
  key: string,
  body: ArrayBuffer | ReadableStream,
  contentType: string
): Promise<void> {
  const bytes = body instanceof ArrayBuffer ? body : await readBoundedPhoto(body);
  const canonical = bytes && inspectPhotoContent(bytes, contentType);
  if (!canonical || !bytes) throw Error('IMAGE_CONTENT_INVALID');
  await bucket.put(key, bytes, {
    httpMetadata: { contentType: canonical },
  });
}

/**
 * Download an image from R2.
 * Returns null if not found.
 */
export async function downloadImage(
  bucket: R2Bucket,
  key: string
): Promise<{ body: ReadableStream; contentType: string } | null> {
  const obj = await bucket.get(key);
  if (!obj) return null;
  const declared = normalizedPhotoMime(obj.httpMetadata?.contentType ?? null);
  if (!declared) { await obj.body.cancel(); return null; }
  const bytes = await readBoundedPhoto(obj.body);
  const contentType = bytes && inspectPhotoContent(bytes, declared);
  if (!bytes || !contentType) return null;
  return {
    body: new Blob([bytes]).stream(),
    contentType,
  };
}

/**
 * Delete an image from R2.
 */
export async function deleteImage(bucket: R2Bucket, key: string): Promise<void> {
  await bucket.delete(key);
}

/**
 * Generate a unique R2 key for an image.
 * Format: {folder}/{orderId}-{uuid}.{ext}
 * If orderId is omitted, uses UUID only (for pre-counter uploads).
 */
export function buildImageKey(folder: "id" | "luggage", orderId: string | null, ext: string): string {
  const uuid = crypto.randomUUID();
  const prefix = orderId ? `${orderId}-` : "";
  return `${folder}/${prefix}${uuid}.${ext}`;
}

/**
 * Extract file extension from content type.
 */
export function extFromContentType(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
  };
  return map[normalizedPhotoMime(contentType) ?? ''] || "jpg";
}

/**
 * Validate an uploaded file: size and content type.
 */
export function validateImageUpload(
  size: number,
  contentType: string | null
): { valid: boolean; error?: string } {
  if (!normalizedPhotoMime(contentType)) {
    return { valid: false, error: "파일은 이미지 형식이어야 합니다." };
  }
  if (size <= 0 || size > MAX_IMAGE_SIZE) {
    return { valid: false, error: "이미지 크기는 10MB 이하여야 합니다." };
  }
  return { valid: true };
}

/**
 * Log an image view to the audit log.
 */
export async function logImageView(
  db: D1Database,
  orderId: string,
  staffId: string,
  action: "VIEW_ID" | "VIEW_LUGGAGE"
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO luggage_audit_logs (order_id, staff_id, action, timestamp) VALUES (?, ?, ?, datetime('now'))"
    )
    .bind(orderId, staffId, action)
    .run();
}
