// ============================================================
// CLOUDFLARE R2 — image storage for profile photos.
//
// R2 is S3-API-compatible, so we talk to it with the standard AWS
// S3 SDK pointed at R2's endpoint instead of AWS's. This module is
// the ONE place that knows about R2; routes/upload.js calls
// uploadImageToR2() and doesn't need to know anything about S3,
// credentials, or bucket names.
//
// Required env vars (see the setup guide for how to get each one):
//   R2_ACCOUNT_ID        — your Cloudflare account ID
//   R2_ACCESS_KEY_ID     — from an R2 API token
//   R2_SECRET_ACCESS_KEY — from the same R2 API token
//   R2_BUCKET_NAME        — the bucket you created for these images
//   R2_PUBLIC_URL_BASE    — the base URL used to READ files back
//                            (either the bucket's r2.dev dev
//                            subdomain, or a custom domain you've
//                            connected to the bucket). No trailing
//                            slash needed — this file strips one if
//                            present.
//
// If any of these are missing, uploads are simply disabled (the
// route returns a clear 500 instead of crashing the server), so a
// deploy without R2 configured yet doesn't break signup/edit-profile
// — people just can't upload a photo until it's set up.
// ============================================================
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const crypto = require('crypto');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME;
const R2_PUBLIC_URL_BASE = (process.env.R2_PUBLIC_URL_BASE || '').replace(/\/+$/, '');

const r2Configured = !!(
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET_NAME && R2_PUBLIC_URL_BASE
);

const s3 = r2Configured
  ? new S3Client({
      region: 'auto', // R2 doesn't use AWS regions; the SDK requires something here, "auto" is R2's documented value
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY
      }
    })
  : null;

// Whitelist, not a blacklist — anything not listed here is rejected
// upstream in routes/upload.js before this function is even called.
const ALLOWED_MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif'
};

// Uploads one image buffer to R2 and returns its public URL.
// keyPrefix groups objects under a "folder" (R2/S3 don't have real
// folders — it's just a prefix in the key name) so profile photos
// are easy to find/browse separately from anything else you might
// store in the same bucket later.
async function uploadImageToR2(buffer, mimetype, keyPrefix = 'profile-photos') {
  if (!r2Configured) {
    throw new Error('R2 is not configured.');
  }
  const ext = ALLOWED_MIME_TO_EXT[mimetype];
  if (!ext) {
    throw new Error('Unsupported image type.');
  }
  // Random, unguessable filename — avoids collisions and avoids
  // leaking anything about the uploader from the filename itself.
  const key = `${keyPrefix}/${Date.now()}-${crypto.randomBytes(10).toString('hex')}.${ext}`;

  await s3.send(new PutObjectCommand({
    Bucket: R2_BUCKET_NAME,
    Key: key,
    Body: buffer,
    ContentType: mimetype
    // No ACL field here on purpose — R2 doesn't support per-object
    // ACLs the way S3 does. Public read access is granted at the
    // bucket/domain level instead (see the setup guide's step on
    // enabling public access).
  }));

  return `${R2_PUBLIC_URL_BASE}/${key}`;
}

module.exports = { uploadImageToR2, r2Configured, ALLOWED_MIME_TO_EXT };
