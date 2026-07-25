import { createClient, SupabaseClient } from "@supabase/supabase-js";
import crypto from "crypto";
import path from "path";

const BUCKET = process.env.SUPABASE_BUCKET || "product-images";

let client: SupabaseClient | null = null;

export function isStorageConfigured(): boolean {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function getClient(): SupabaseClient {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !serviceKey) {
    throw new Error("Supabase storage is not configured");
  }

  if (!client) {
    client = createClient(url, serviceKey, { auth: { persistSession: false } });
  }

  return client;
}

function buildObjectPath(originalName: string): string {
  const extension = (path.extname(originalName) || ".jpg").toLowerCase();
  const base = path
    .basename(originalName, path.extname(originalName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  const folder = new Date().toISOString().slice(0, 7);
  return `${folder}/${base || "image"}-${crypto.randomUUID().slice(0, 8)}${extension}`;
}

export async function uploadImage(file: {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
}): Promise<string> {
  const supabase = getClient();
  const objectPath = buildObjectPath(file.originalname);

  const { error } = await supabase.storage.from(BUCKET).upload(objectPath, file.buffer, {
    contentType: file.mimetype,
    cacheControl: "31536000",
    upsert: false,
  });

  if (error) {
    throw new Error(error.message);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(objectPath);
  return data.publicUrl;
}

/** Returns the object path when the URL points at our own bucket, otherwise null. */
export function objectPathFromUrl(url: string): string | null {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const objectPath = url.slice(index + marker.length);
  return objectPath ? decodeURIComponent(objectPath) : null;
}

export async function deleteImage(url: string): Promise<boolean> {
  const objectPath = objectPathFromUrl(url);
  if (!objectPath) return false;

  const { error } = await getClient().storage.from(BUCKET).remove([objectPath]);
  if (error) {
    throw new Error(error.message);
  }

  return true;
}
