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

/**
 * Anything a customer uploaded lives under here.
 *
 * Kept apart from the catalogue on purpose: these arrive from the public side of
 * the site, so being able to list, audit or prune them in one place matters, and
 * a URL claiming to be evidence on a return can be checked against this prefix
 * rather than trusted.
 */
export const CUSTOMER_PREFIX = "returns";

function buildObjectPath(originalName: string, prefix?: string): string {
  const extension = (path.extname(originalName) || ".jpg").toLowerCase();
  const base = path
    .basename(originalName, path.extname(originalName))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);

  const folder = new Date().toISOString().slice(0, 7);
  const name = `${base || "image"}-${crypto.randomUUID().slice(0, 8)}${extension}`;
  return prefix ? `${prefix}/${folder}/${name}` : `${folder}/${name}`;
}

export async function uploadImage(
  file: {
    buffer: Buffer;
    originalname: string;
    mimetype: string;
  },
  prefix?: string
): Promise<string> {
  const supabase = getClient();
  const objectPath = buildObjectPath(file.originalname, prefix);

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

/**
 * Returns the object path when the URL points at our own bucket, otherwise null.
 *
 * The host is checked, not just the path. Searching the string for the bucket
 * marker accepts `https://anywhere.example/storage/v1/object/public/<bucket>/x.jpg`,
 * because the marker is in there — just not at the start, and not on our domain.
 * That is the whole check isCustomerUpload rests on, so it is parsed properly and
 * matched against the origin we actually upload to.
 *
 * Fails closed when SUPABASE_URL is unset: no configured bucket means no URL can
 * be ours, and refusing is the safe half.
 */
export function objectPathFromUrl(url: string): string | null {
  const base = process.env.SUPABASE_URL;
  if (!base) return null;

  let target: URL;
  let ours: URL;
  try {
    target = new URL(url);
    ours = new URL(base);
  } catch {
    return null;
  }

  if (target.origin !== ours.origin) return null;

  const prefix = `/storage/v1/object/public/${BUCKET}/`;
  if (!target.pathname.startsWith(prefix)) return null;

  const objectPath = target.pathname.slice(prefix.length);
  return objectPath ? decodeURIComponent(objectPath) : null;
}

/**
 * Whether this URL is a customer upload of ours.
 *
 * What a return request stores is decided by the browser, so without this an
 * admin opening the queue would render whatever URL someone chose to send.
 */
export function isCustomerUpload(url: string): boolean {
  const objectPath = objectPathFromUrl(url);
  return objectPath !== null && objectPath.startsWith(`${CUSTOMER_PREFIX}/`);
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
