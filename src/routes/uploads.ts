import { Router } from "express";
import multer from "multer";
import { z } from "zod";
import { authenticate, requireAdmin } from "../middleware/auth";
import { deleteImage, isStorageConfigured, uploadImage } from "../lib/storage";

const router = Router();

const MAX_FILE_SIZE = 5 * 1024 * 1024;
const MAX_FILES = 8;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      cb(new Error("Only JPEG, PNG, WebP, AVIF or GIF images are allowed"));
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
          ? "Each image must be smaller than 5 MB"
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
