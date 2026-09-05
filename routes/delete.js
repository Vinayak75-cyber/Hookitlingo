// DELETE-IMAGE ROUTE - DELETE /api/delete-image
//
// Cleans up a photo in R2 that's no longer needed: someone removed
// it with the X button before saving, replaced it with a different
// file, or saved a new one over an old one already on their profile.
// Without this, every one of those cases just leaves the old file
// sitting in the bucket forever, which is what actually drives up R2
// storage costs over time.
//
// Takes { url } and deletes that one object, but only if it's really
// one of ours - see extractOwnedKey() in lib/r2.js. Deliberately
// forgiving: an unknown, already-deleted, or missing URL is treated
// as "nothing to do" rather than an error, since the caller's own
// state (input cleared, profile saved) is what actually matters, not
// whether R2 happened to still have that file.
//
// Same no-login-required shape as upload-image, since signup.html
// needs to remove a photo it just uploaded before an account exists
// to be logged into. Protected the same way: per-IP rate limiting
// plus the owned-key check above.
const express = require('express');
const { deleteImageFromR2, r2Configured } = require('../lib/r2');

const router = express.Router();

const deleteRateLimit = new Map(); // ip -> [timestamps]
const DELETE_MAX_PER_HOUR = 40;
function isDeleteRateLimited(ip) {
  const now = Date.now();
  const windowStart = now - 60 * 60 * 1000;
  const timestamps = (deleteRateLimit.get(ip) || []).filter(t => t > windowStart);
  timestamps.push(now);
  deleteRateLimit.set(ip, timestamps);
  return timestamps.length > DELETE_MAX_PER_HOUR;
}
function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

router.delete('/api/delete-image', express.json(), async (req, res) => {
  if (!r2Configured) {
    return res.status(500).json({ error: 'Image uploads are not configured yet.' });
  }
  if (isDeleteRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many requests, please try again in a bit.' });
  }

  const url = (req.body && req.body.url) ? String(req.body.url) : '';
  try {
    await deleteImageFromR2(url);
    // Always ok: whether a matching object was found and removed or
    // not, the end state the caller wants (that URL is gone) holds.
    res.json({ ok: true });
  } catch (err) {
    console.error('R2 delete failed:', err);
    // Non-fatal to the caller on purpose - a failed cleanup shouldn't
    // block someone from saving their profile or picking a new photo.
    res.json({ ok: true });
  }
});

module.exports = router;
