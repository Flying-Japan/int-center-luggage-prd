/**
 * R2 image storage helpers using Worker R2 binding.
 * Replaces the old REST API approach via httpx.
 */

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

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
  await bucket.put(key, body, {
    httpMetadata: { contentType },
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
  return {
    body: obj.body,
    contentType: obj.httpMetadata?.contentType || "application/octet-stream",
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
 */
export function buildImageKey(folder: "id" | "luggage", orderId: string, ext: string): string {
  const uuid = crypto.randomUUID();
  return `${folder}/${orderId}-${uuid}.${ext}`;
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
  return map[contentType.toLowerCase()] || "jpg";
}

/**
 * Validate an uploaded file: size and content type.
 */
export function validateImageUpload(
  size: number,
  contentType: string | null
): { valid: boolean; error?: string } {
  if (!contentType || !contentType.startsWith("image/")) {
    return { valid: false, error: "파일은 이미지 형식이어야 합니다." };
  }
  if (size > MAX_IMAGE_SIZE) {
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
