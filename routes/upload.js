// ============================================================
// IMAGE UPLOAD ROUTE — POST /api/upload-image
//
// Kept in its own file (and mounted into server.js as a router)
// purely for readability as the app grows — it's still the same
// single Express process as everything else, not a second server.
//
// Accepts one image file (multipart/form-data, field name "image"),
// uploads it to R2 via lib/r2.js, and returns { ok: true, url }.
// Nothing here touches Airtable — the caller (signup.html or
// edit-profile.html) is responsible for sending that URL along as
// `imageUrl` to /api/signup or PUT /api/profile, same as it does
// today for a pasted URL.
//
// Deliberately no login requirement: signup.html needs to upload a
// photo BEFORE an account exists, so this can't be gated behind a
// session the way PUT /api/profile is. Instead it's protected by:
//   - per-IP rate limiting (mirrors the pattern used for signup/
//     login/unlock elsewhere in server.js)
//   - a strict file-type whitelist (JPG/PNG/WEBP/GIF only)
//   - a 5MB size cap
// ============================================================
const express = require('express');
const multer = require('multer');
const { uploadImageToR2, r2Configured, ALLOWED_MIME_TO_EXT } = require('../lib/r2');

const router = express.Router();

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB

const upload = multer({
  storage: multer.memoryStorage(), // small images, short-lived — no need to touch disk
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME_TO_EXT[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new Error('Only JPG, PNG, WEBP, or GIF images are allowed.'));
    }
  }
});

const uploadRateLimit = new Map(); // ip -> [timestamps]
const UPLOAD_MAX_PER_HOUR = 20;
function isUploadRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const timestamps = (uploadRateLimit.get(ip) || []).filter(t => t > windowStart);
  timestamps.push(now);
  uploadRateLimit.set(ip, timestamps);
  return timestamps.length > UPLOAD_MAX_PER_HOUR;
}
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

router.post('/api/upload-image', (req, res) => {
  if (!r2Configured) {
    return res.status(500).json({ error: 'Image uploads are not configured yet.' });
  }
  if (isUploadRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many uploads — please try again in a bit.' });
  }

  upload.single('image')(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE'
        ? 'Image must be under 5MB.'
        : (err.message || 'Could not process that image.');
      return res.status(400).json({ error: message });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'Please choose an image to upload.' });
    }

    try {
      const url = await uploadImageToR2(req.file.buffer, req.file.mimetype);
      res.json({ ok: true, url });
    } catch (uploadErr) {
      console.error('R2 upload failed:', uploadErr);
      res.status(502).json({ error: 'Something went wrong uploading your image. Please try again.' });
    }
  });
});

module.exports = router;
