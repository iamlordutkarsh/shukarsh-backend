import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate, requireAdmin } from "../middleware/auth";
import { customerUploadLimiter } from "../middleware/rate-limit";
import { RETURN_PHOTO_LIMIT } from "../lib/returns";
import { CUSTOMER_PREFIX, deleteImage, isStorageConfigured, uploadImage } from "../lib/storage";

const router = Router();

/**
 * The catalogue is shot on a phone, and a modern phone clears 5 MB a frame
 * without trying. Multer buffers every file in memory before the handler runs,
 * so the ceiling here is `MAX_FILES × MAX_FILE_SIZE` of RAM on one request —
 * raise either and check the instance can still take the spike.
 */
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_FILES = 8;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];

/** iPhones shoot these by default and no browser can display either. */
const APPLE_TYPES = ["image/heic", "image/heif"];

function screenType(mimetype: string): Error | null {
  if (ALLOWED_TYPES.includes(mimetype)) return null;
  if (APPLE_TYPES.includes(mimetype)) {
    return new Error(
      "iPhone HEIC photos cannot be shown in a browser. On the phone, " +
        "Settings > Camera > Formats > Most Compatible, or export the shot as JPEG first."
    );
  }
  return new Error("Only JPEG, PNG, WebP, AVIF or GIF images are allowed");
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const problem = screenType(file.mimetype);
    if (problem) {
      cb(problem);
      return;
    }
    cb(null, true);
  },
});

/**
 * Evidence on a return, not a photo shoot. Larger per file than the catalogue
 * because this arrives straight off a phone camera and nobody is going to resize
 * it first; capped tighter in number because four angles settle any argument.
 */
const CUSTOMER_MAX_FILE_SIZE = 8 * 1024 * 1024;
const CUSTOMER_MAX_FILES = RETURN_PHOTO_LIMIT;

const customerUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CUSTOMER_MAX_FILE_SIZE, files: CUSTOMER_MAX_FILES },
  fileFilter: (_req, file, cb) => {
    const problem = screenType(file.mimetype);
    if (problem) {
      cb(problem);
      return;
    }
    cb(null, true);
  },
});

const deleteSchema = z.object({ url: z.string().url() });

router.post("/", authenticate, requireAdmin, (req, res) => {
  if (!isStorageConfigured()) {
    res.status(503).json({ error: "Image storage is not configured on the server" });
    return;
  }

  upload.array("files", MAX_FILES)(req, res, async (uploadError) => {
    if (uploadError) {
      const message =
        uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE"
          ? `Each image must be smaller than ${megabytes(MAX_FILE_SIZE)}`
          : uploadError.message || "Upload failed";
      res.status(400).json({ error: message });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "No files received" });
      return;
    }

    try {
      const urls = await Promise.all(files.map((file) => uploadImage(file)));
      res.status(201).json({ urls });
    } catch (error) {
      console.error("Image upload error:", error);
      res.status(500).json({ error: "Could not upload image" });
    }
  });
});

/**
 * Photos a customer attaches to a return.
 *
 * Signing in is the only gate, so it is rate limited and lands under its own
 * prefix. There is no matching delete: letting a customer remove a picture after
 * we have looked at it would let evidence disappear mid-decision.
 */
router.post("/returns", authenticate, customerUploadLimiter, (req, res) => {
  if (!isStorageConfigured()) {
    res.status(503).json({ error: "Photo uploads are not available right now" });
    return;
  }

  customerUpload.array("files", CUSTOMER_MAX_FILES)(req, res, async (uploadError) => {
    if (uploadError) {
      const message =
        uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_SIZE"
          ? `Each photo must be smaller than ${megabytes(CUSTOMER_MAX_FILE_SIZE)}`
          : uploadError instanceof multer.MulterError && uploadError.code === "LIMIT_FILE_COUNT"
            ? `Up to ${CUSTOMER_MAX_FILES} photos, please`
            : uploadError.message || "Upload failed";
      res.status(400).json({ error: message });
      return;
    }

    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.status(400).json({ error: "No photos received" });
      return;
    }

    try {
      const urls = await Promise.all(files.map((file) => uploadImage(file, CUSTOMER_PREFIX)));
      res.status(201).json({ urls });
    } catch (error) {
      console.error("Return photo upload error:", error);
      res.status(500).json({ error: "Could not upload that photo" });
    }
  });
});

router.delete("/", authenticate, requireAdmin, async (req, res) => {
  const result = deleteSchema.safeParse(req.body);
  if (!result.success) {
    res.status(400).json({ error: "A valid image url is required" });
    return;
  }

  if (!isStorageConfigured()) {
    res.status(503).json({ error: "Image storage is not configured on the server" });
    return;
  }

  try {
    const removed = await deleteImage(result.data.url);
    res.json({ removed });
  } catch (error) {
    console.error("Image delete error:", error);
    res.status(500).json({ error: "Could not delete image" });
  }
});

router.get("/config", authenticate, requireAdmin, (_req, res) => {
  res.json({ enabled: isStorageConfigured(), maxFileSize: MAX_FILE_SIZE, maxFiles: MAX_FILES });
});

export default router;
