const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();

// Only your own frontend(s) may call this API from a browser. Set
// ALLOWED_ORIGINS in your environment to a comma-separated list of the
// domains you actually serve the site from, e.g.:
//   ALLOWED_ORIGINS=https://hookit.online,https://www.hookit.online
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Requests with no Origin header (server-to-server, curl) aren't
    // browser-based CORS requests — let them through.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  // Needed so the browser will send/receive the unlock cookie —
  // without this, the httpOnly cookie set by /api/unlock would never
  // reach the browser on a cross-origin request.
  credentials: true
}));
app.use(express.json());

// COOKIE_SECRET signs the unlock cookie so it can't be forged or edited
// client-side. Set a long random string for this in your environment —
// changing it later invalidates everyone's existing unlock cookie.
const COOKIE_SECRET = process.env.COOKIE_SECRET;
if (!COOKIE_SECRET) {
  console.warn('WARNING: COOKIE_SECRET is not set. Set it in your environment before deploying — unlock cookies will not be secure without it.');
}
app.use(cookieParser(COOKIE_SECRET || 'dev-only-insecure-secret-change-me'));

// Serve static files from /public (site pages, assets — NOT lessons)
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// COURSE ACCESS — Airtable is the source of truth for which codes
// unlock which lesson(s). Purchases happen manually via Ko-fi; you
// send the buyer a PDF with their code, they redeem it here.
//
// Requires three env vars (see .env / your host's dashboard):
//   AIRTABLE_API_KEY          — Personal Access Token from airtable.com
//   AIRTABLE_BASE_ID          — the base's ID (starts with "app...")
//   AIRTABLE_ACCESS_TABLE_NAME — defaults to "CourseAccess"
//
// Table needs three fields: Code (text), Scope (text — either a
// single lesson slug like "s01-l01" / "hanlingo", a comma-separated
// list of slugs for a bundle, or "ALL" for that course's master
// code), and Course (text — "jp" or "kr", see COURSES below). Older
// rows saved before the Course field existed are treated as "jp" so
// every code issued before this change keeps working unchanged.
// ============================================================
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_ACCESS_TABLE_NAME = process.env.AIRTABLE_ACCESS_TABLE_NAME || 'CourseAccess';
const AIRTABLE_ACCESS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_ACCESS_TABLE_NAME)}`;

const COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years — one-time purchase, no expiry pressure

// Only lowercase letters, digits, and hyphens. Guards both the
// cookie contents and the :slug route param before either touches
// the filesystem. Covers both slug styles in use: Japanese "sNN-lNN"
// and Korean filename-derived slugs like "korean-grammar".
const SLUG_RE = /^[a-z0-9-]+$/;

// ============================================================
// COURSES — one entry per product line. Each gets its own signed
// cookie and its own protected-files directory, so unlocking Korean
// lessons never grants access to Japanese ones (or vice versa).
// "jp" is kept as the default/legacy course so the existing JLPT N5
// roadmap and any codes already issued for it keep working exactly
// as before, with no query-string or request-body changes required
// on that page.
// ============================================================
const COURSES = {
  jp: {
    cookieName: 'hkl_n5_access',
    protectedDir: path.join(__dirname, 'protected-lessons'),
    toFilename: (slug) => `jlpt-n5-${slug}.html`,
    roadmapRedirect: process.env.ROADMAP_REDIRECT_PATH || '/jlptn5roadmap.html'
  },
  kr: {
    cookieName: 'hkl_kr_access',
    protectedDir: path.join(__dirname, 'protected-lessons-kr'),
    // Korean lesson pages link to their own companion workbook with a
    // plain relative href (e.g. "korean-numbers-workbook.html"), so
    // slugs are kept as the bare filename stem — that way those
    // in-page relative links resolve straight to this same /lesson/kr/
    // route without any rewriting.
    toFilename: (slug) => `${slug}.html`,
    roadmapRedirect: process.env.KR_ROADMAP_REDIRECT_PATH || '/roadmap.html'
  }
};

function normalizeCourseId(raw) {
  const id = String(raw || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(COURSES, id) ? id : 'jp';
}

// Reads and verifies the signed cookie for a given course, returning
// the learner's current unlock state for it. Anything missing,
// tampered with, or malformed is treated as "nothing unlocked" rather
// than an error — a bad cookie should never crash the request.
function getUnlocked(req, course) {
  const raw = req.signedCookies && req.signedCookies[course.cookieName];
  if (!raw) return { all: false, slugs: [] };
  try {
    const parsed = JSON.parse(raw);
    const slugs = Array.isArray(parsed.slugs)
      ? parsed.slugs.filter(s => typeof s === 'string' && SLUG_RE.test(s))
      : [];
    return { all: !!parsed.all, slugs };
  } catch {
    return { all: false, slugs: [] };
  }
}

function isUnlocked(unlocked, slug) {
  return unlocked.all || unlocked.slugs.includes(slug);
}

function setUnlockedCookie(res, course, unlocked) {
  res.cookie(course.cookieName, JSON.stringify(unlocked), {
    signed: true,
    httpOnly: true, // JS can't read this directly — that's what /api/my-access is for
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/'
  });
}

// Very small in-memory rate limiter — best-effort only (resets on
// restart). Blunts brute-force code guessing without locking out a
// real customer retyping a typo'd code a few times.
const unlockRateLimit = new Map(); // ip -> [timestamps]
const UNLOCK_MAX_PER_HOUR = 20;
function isUnlockRateLimited(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const hits = (unlockRateLimit.get(ip) || []).filter(t => t > hourAgo);
  hits.push(now);
  unlockRateLimit.set(ip, hits);
  return hits.length > UNLOCK_MAX_PER_HOUR;
}

// GET /api/my-access?course=kr|jp — tells the frontend what's already
// unlocked for that course via the existing cookie, so the roadmap
// page can render already-bought lessons as directly openable on
// load without prompting for a code. course defaults to "jp" when
// omitted, so the existing JLPT N5 roadmap needs no changes.
app.get('/api/my-access', (req, res) => {
  const courseId = normalizeCourseId(req.query.course);
  const course = COURSES[courseId];
  const unlocked = getUnlocked(req, course);
  res.json({ course: courseId, all: unlocked.all, slugs: unlocked.slugs });
});

// POST /api/unlock — takes {code, course}, looks the code up in
// Airtable, and on a match adds its scope to whatever the learner
// already has unlocked for that course (redeeming a second code
// stacks rather than replaces). course defaults to "jp" when
// omitted, matching the previous single-course behavior.
app.post('/api/unlock', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Access storage is not configured yet.' });
  }

  const courseId = normalizeCourseId(req.body && req.body.course);
  const course = COURSES[courseId];

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isUnlockRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts — please try again in a bit.' });
  }

  const rawCode = String((req.body && req.body.code) || '').trim();
  if (!rawCode) {
    return res.status(400).json({ error: 'Please enter a code.' });
  }
  const safeCode = rawCode.slice(0, 100);
  // Airtable formula string — escape single quotes so a code can't
  // break out of the LOWER({Code})='...' filter.
  const escapedCode = safeCode.toLowerCase().replace(/'/g, "\\'");

  try {
    const params = new URLSearchParams({
      filterByFormula: `LOWER({Code})='${escapedCode}'`,
      maxRecords: '1'
    });
    const airtableRes = await fetch(`${AIRTABLE_ACCESS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      console.error('Airtable access lookup failed:', errText);
      return res.status(502).json({ error: 'Failed to check that code — please try again.' });
    }
    const data = await airtableRes.json();
    const rec = data.records && data.records[0];
    if (!rec || !rec.fields || !rec.fields.Scope) {
      return res.status(404).json({ error: 'That code was not recognized.' });
    }

    // A code belongs to exactly one course. Rows saved before the
    // Course field existed default to "jp" so every code issued
    // before this change keeps working unchanged. A code redeemed
    // against the wrong course (e.g. a Korean code typed into the
    // Japanese roadmap) is treated the same as an unrecognized code.
    const recCourseId = normalizeCourseId(rec.fields.Course);
    if (recCourseId !== courseId) {
      return res.status(404).json({ error: 'That code was not recognized.' });
    }

    const scopeRaw = String(rec.fields.Scope).trim();
    const existing = getUnlocked(req, course);

    let newUnlocked;
    if (existing.all || scopeRaw.toUpperCase() === 'ALL') {
      newUnlocked = { all: true, slugs: [] };
    } else {
      const newSlugs = scopeRaw
        .split(',')
        .map(s => s.trim().toLowerCase())
        .filter(s => SLUG_RE.test(s));
      newUnlocked = { all: false, slugs: Array.from(new Set([...existing.slugs, ...newSlugs])) };
    }

    setUnlockedCookie(res, course, newUnlocked);
    res.json({
      ok: true,
      course: courseId,
      unlocked: newUnlocked.all ? 'ALL' : scopeRaw, // what THIS code unlocked
      all: newUnlocked.all,
      slugs: newUnlocked.slugs
    });
  } catch (err) {
    console.error('Unlock error:', err);
    res.status(500).json({ error: 'Something went wrong checking that code.' });
  }
});

// ============================================================
// PROTECTED LESSON FILES
// Lesson HTML lives outside /public (in each course's own directory
// — see COURSES above) so it can only ever be reached through this
// route, which checks that course's unlock cookie first.
// ============================================================
function serveLesson(courseId, rawSlug, req, res) {
  const course = COURSES[courseId];
  const slug = String(rawSlug || '').toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return res.redirect(course.roadmapRedirect);
  }

  const unlocked = getUnlocked(req, course);
  if (!isUnlocked(unlocked, slug)) {
    return res.redirect(course.roadmapRedirect);
  }

  const filePath = path.join(course.protectedDir, course.toFilename(slug));
  // Belt-and-suspenders: confirm the resolved path is still inside
  // the course's protected directory before serving, even though
  // SLUG_RE already blocks path traversal characters like . and /.
  if (!filePath.startsWith(course.protectedDir + path.sep) || !fs.existsSync(filePath)) {
    return res.redirect(course.roadmapRedirect);
  }

  res.sendFile(filePath);
}

// New, explicit form: /lesson/kr/<slug>, /lesson/jp/<slug>, etc.
app.get('/lesson/:course/:slug', (req, res) => {
  const courseId = normalizeCourseId(req.params.course);
  serveLesson(courseId, req.params.slug, req, res);
});

// Legacy form kept for backward compatibility: any existing links
// or bookmarks to /lesson/<slug> (from before Korean support was
// added) keep resolving against the Japanese course, exactly as
// before.
app.get('/lesson/:slug', (req, res) => {
  serveLesson('jp', req.params.slug, req, res);
});

// Catch-all: serve index.html for any unknown route (SPA behavior).
// Using app.use (not app.get('*', ...)) here on purpose — Express 5
// changed wildcard route-string syntax, and a plain middleware
// catch-all works the same way on both Express 4 and 5.
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hookit server running on port ${PORT}`);
});
