const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs'); // pure-JS bcrypt — no native build step needed on most hosts
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

// attachSession is defined further down (near the other user-account
// code) but referenced here so every route — public or protected —
// gets req.sessionUserId populated up front.
app.use((req, res, next) => attachSession(req, res, next));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================
// COURSE ACCESS — Airtable is the source of truth for which codes
// unlock which lesson(s). Purchases happen manually via Gumroad; you
// send the buyer a PDF/link with their code, they redeem it here.
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
// PROFILE SLUGS — clean public URLs like /u/priya-142 instead of
// /profile.html?id=recXXXXXXXXXXXXXX. The slug is generated once at
// signup time and saved to a "Slug" field on the CommunityProfiles
// row, so add that field yourself in Airtable (Text, optional):
//   Slug (text — lowercase letters/digits/hyphens, unique per row)
//
// It's built from two pieces: the person's name, slugified, plus a
// small number that makes it unique even if two people share a
// name. That number comes from an Airtable Autonumber field — add
// this one too:
//   Seq (Autonumber)
// Autonumber fields are assigned by Airtable itself the instant a
// row is created, are guaranteed unique, and need no extra lookup
// or retry-on-collision logic on this end — this code just reads
// back whatever number Airtable already assigned.
//
// Existing hand-created rows (made before this feature existed)
// won't have a Slug until you type one into Airtable by hand for
// them — same "you fill it in yourself" philosophy as every other
// CommunityProfiles field. Until you do, that row simply has no
// clean link yet; its old ?id= link still works either way.
// ============================================================
const PROFILE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/; // 1-60 chars, no leading/trailing hyphen

// Turns a display name into the "priya" part of "priya-142". Strips
// accents, lowercases, collapses anything that isn't a letter/digit
// into a single hyphen, and trims stray hyphens off each end. Never
// returns an empty string — falls back to "user" so a name made
// entirely of emoji/symbols still produces a usable slug.
function slugifyName(name) {
  const base = String(name || '')
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '') // strip accents: "José" -> "Jose"
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
  return base || 'user';
}

// Builds the full slug for a freshly-created CommunityProfiles
// record. Prefers the Airtable-assigned Seq autonumber (clean, e.g.
// "priya-142"); if that field hasn't been added to the base yet,
// falls back to a chunk of the record ID so slug creation never
// breaks signup even before you've set Seq up.
function buildProfileSlug(name, record) {
  const seq = record && record.fields && record.fields.Seq;
  const suffix = (typeof seq === 'number' && Number.isFinite(seq))
    ? String(seq)
    : String(record.id || '').replace(/^rec/, '').slice(-6).toLowerCase();
  return `${slugifyName(name)}-${suffix}`;
}

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
// restart). Blunts brute-force guessing (unlock codes, login
// passwords, signup spam) without locking out someone retyping a
// typo a few times. Each caller keeps its own bucket by passing a
// distinct Map, so unlock/login/signup limits don't interfere.
function isRateLimited(bucket, ip, maxPerHour) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const hits = (bucket.get(ip) || []).filter(t => t > hourAgo);
  hits.push(now);
  bucket.set(ip, hits);
  return hits.length > maxPerHour;
}

const unlockRateLimit = new Map(); // ip -> [timestamps]
const UNLOCK_MAX_PER_HOUR = 20;
function isUnlockRateLimited(ip) {
  return isRateLimited(unlockRateLimit, ip, UNLOCK_MAX_PER_HOUR);
}

const loginRateLimit = new Map();
const LOGIN_MAX_PER_HOUR = 20;
function isLoginRateLimited(ip) {
  return isRateLimited(loginRateLimit, ip, LOGIN_MAX_PER_HOUR);
}

const signupRateLimit = new Map();
const SIGNUP_MAX_PER_HOUR = 10;
function isSignupRateLimited(ip) {
  return isRateLimited(signupRateLimit, ip, SIGNUP_MAX_PER_HOUR);
}

function getClientIp(req) {
  return req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
}

// ============================================================
// ACCOUNT-BASED LESSON ACCESS — an Approved account grants full
// ("all") access to lessons in that account's own Course, same as
// redeeming an "ALL" code would, but without needing one. This sits
// alongside the existing cookie-based unlock, not in place of it: a
// logged-out visitor who redeemed a code still keeps working exactly
// as before, and an approved account works even with no code cookie
// at all.
//
// isApprovedForCourse() is called on every lesson-page load, so it's
// backed by a short in-memory cache (60s) to avoid hitting Airtable
// on every request — worst case, a fresh approval takes up to a
// minute to actually unlock lessons for that user, which is fine for
// this use case.
// ============================================================
const accountApprovalCache = new Map(); // userId -> { courseId, approved, expiresAt }
const ACCOUNT_APPROVAL_CACHE_MS = 60 * 1000;

async function isApprovedForCourse(userId, courseId) {
  const cached = accountApprovalCache.get(userId);
  if (cached && cached.expiresAt > Date.now() && cached.courseId === courseId) {
    return cached.approved;
  }
  const record = await fetchUserRecord(userId);
  const approved = !!(
    record &&
    record.fields &&
    record.fields.Status === 'Approved' &&
    normalizeCourseId(record.fields.Course) === courseId
  );
  accountApprovalCache.set(userId, { courseId, approved, expiresAt: Date.now() + ACCOUNT_APPROVAL_CACHE_MS });
  return approved;
}

// GET /api/my-access?course=kr|jp — tells the frontend what's already
// unlocked for that course, whether via the existing code-redemption
// cookie or (new) via a logged-in Approved account, so the roadmap
// page can render already-unlocked lessons as directly openable on
// load. course defaults to "jp" when omitted, so the existing JLPT
// N5 roadmap needs no changes.
app.get('/api/my-access', async (req, res) => {
  const courseId = normalizeCourseId(req.query.course);
  const course = COURSES[courseId];
  const unlocked = getUnlocked(req, course);

  if (!unlocked.all && req.sessionUserId) {
    const approved = await isApprovedForCourse(req.sessionUserId, courseId);
    if (approved) {
      return res.json({ course: courseId, all: true, slugs: [], source: 'account' });
    }
  }

  res.json({ course: courseId, all: unlocked.all, slugs: unlocked.slugs, source: unlocked.all ? 'code' : 'none' });
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
// COMMUNITY DIRECTORY TABLE — everything in this table is entered
// by hand in Airtable's own interface. There is no signup form or
// endpoint that writes to it automatically — you create a row
// yourself for each person once you've spoken to them and they've
// paid, and you only ever add someone once they're ready to go
// public.
//
// Requires one more env var alongside the ones above:
//   AIRTABLE_COMMUNITY_TABLE_NAME — defaults to "CommunityProfiles"
//
// Create a table in your Airtable base with these fields. Most are
// filled in by hand, but two — Email and PasswordHash — are now
// written automatically by /api/signup below, so add them to the
// table but never type into them yourself:
//   Name (text), Type (text: "learner" or "teacher"),
//   Course (text: "jp" or "kr"), Country (text), Tagline (text),
//   ImageURL (text — the public R2 URL for their photo),
//   Instagram, Discord, WhatsApp, Website1, Website1Label, Website2,
//   Website2Label, Website3, Website3Label, Twitter, Facebook,
//   TikTok, YouTube, Telegram, LINE, Email (text, all optional —
//   see the field-by-field notes below for what to paste into each),
//   Status (single select: "Pending", "Approved", "Rejected"),
//   PasswordHash (text — a bcrypt hash, never a plaintext password;
//   only /api/signup ever writes this field, and no API response
//   ever includes it), Slug (text — auto-filled by /api/signup, see
//   the "PROFILE SLUGS" block below for details), Seq (Autonumber —
//   also see "PROFILE SLUGS"; add this field FIRST so Slug generation
//   has a number to read on the very next signup).
//
// Email doing double duty: it's both a contact link shown on
// approved profiles (see the field notes below) AND the account
// login identifier for self-signups. That's fine — one row is one
// person either way — just know that turning Email into a login
// means it must stay unique per row. /api/signup checks for an
// existing row with the same email before creating a new one, but
// Airtable itself doesn't enforce uniqueness, so avoid hand-creating
// two rows with the same address.
//
// What to put in each optional link field (the frontend builds the
// actual clickable URL from whatever's here, so keep these as plain
// handles/numbers, not full profile URLs, except where noted):
//   Instagram — handle, with or without "@" (e.g. "hookitlingo")
//   Discord   — an invite link/code (e.g. "discord.gg/abc123").
//               A bare username/tag can be stored for display but
//               Discord no longer supports linking directly to a
//               profile from just a username, so it won't be
//               clickable in that case.
//   WhatsApp  — phone number, any formatting (e.g. "+91 8459444524")
//   Website1, Website2, Website3 — up to three bare domains or full
//               URLs (e.g. "hookit.online"). All optional; a learner
//               only needs to fill in as many as they have.
//   Website1Label, Website2Label, Website3Label — the button text
//               shown on that website's glass-bar link on the public
//               profile page (e.g. "My Portfolio"). Optional; if left
//               blank the button falls back to "Website 1" / "Website
//               2" / "Website 3". Only meaningful when the matching
//               WebsiteN field above is also filled in.
//   Twitter   — handle, with or without "@" (posts to x.com)
//   Facebook  — page/profile handle or full facebook.com URL
//   TikTok    — handle, with or without "@"
//   YouTube   — channel handle, with or without "@", or a full URL
//   Telegram  — username, with or without "@"
//   LINE      — personal LINE ID (used to build a line.me/ti/p/ link)
//   Email     — a plain email address. Not shown as its own icon —
//               it's used to make the "Get in touch" button link
//               straight to a mailto:, before falling back to
//               WhatsApp/Telegram/etc. if Email is left blank.
//
// Only rows with Status = "Approved" are ever returned by
// /api/directory below, so a row sits invisible on the public site
// until you flip that field yourself.
// ============================================================
const AIRTABLE_COMMUNITY_TABLE_NAME = process.env.AIRTABLE_COMMUNITY_TABLE_NAME || 'CommunityProfiles';
const AIRTABLE_COMMUNITY_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_COMMUNITY_TABLE_NAME)}`;

// ============================================================
// USER ACCOUNTS — separate from the course-unlock cookie above.
// A logged-in user IS a CommunityProfiles row (their Airtable
// record ID doubles as their unique user ID — no separate ID
// generation needed), identified going forward by a second,
// independent signed cookie so having one type of access never
// implies the other.
// ============================================================
const USER_SESSION_COOKIE = 'hkl_user_session';
const USER_SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AIRTABLE_RECORD_ID_RE = /^rec[A-Za-z0-9]+$/;
const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 10;

function setUserSessionCookie(res, userId) {
  res.cookie(USER_SESSION_COOKIE, JSON.stringify({ userId }), {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: USER_SESSION_MAX_AGE_MS,
    path: '/'
  });
}

function clearUserSessionCookie(res) {
  res.clearCookie(USER_SESSION_COOKIE, { path: '/' });
}

// Reads and verifies the signed session cookie, returning the
// logged-in user's Airtable record ID or null. Anything missing,
// tampered with, or malformed is treated as "not logged in" rather
// than an error, same philosophy as getUnlocked() above.
function getSessionUserId(req) {
  const raw = req.signedCookies && req.signedCookies[USER_SESSION_COOKIE];
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed.userId !== 'string' || !AIRTABLE_RECORD_ID_RE.test(parsed.userId)) return null;
    return parsed.userId;
  } catch {
    return null;
  }
}

// Fetches a CommunityProfiles record by ID directly from Airtable.
// Returns null (never throws) if it doesn't exist or the request
// fails, so callers can treat "no such user" and "Airtable hiccup"
// the same way: as "not logged in" rather than a crash.
async function fetchUserRecord(userId) {
  try {
    const recRes = await fetch(`${AIRTABLE_COMMUNITY_URL}/${encodeURIComponent(userId)}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!recRes.ok) return null;
    return await recRes.json();
  } catch {
    return null;
  }
}

// Express middleware: populates req.sessionUserId when a valid
// session cookie is present. Never blocks the request itself —
// routes that require login check req.sessionUserId themselves, so
// this can sit in front of both public and protected routes.
function attachSession(req, res, next) {
  req.sessionUserId = getSessionUserId(req);
  next();
}

// ============================================================
// PUBLIC DIRECTORY — the "Connect with Learners / Teachers" pages
// read from here. Public, no auth needed, but only ever returns
// rows you've personally set Status to "Approved" on, and only a
// safe subset of fields.
//
// GET /api/directory?course=jp&type=learner  -> list mode
// GET /api/directory?id=recXXXXXXXXXXXXXX     -> single profile
// ============================================================
function toPublicProfile(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    slug: f.Slug || '',
    name: f.Name || '',
    type: f.Type || '',
    course: f.Course || '',
    country: f.Country || '',
    tagline: f.Tagline || '',
    about: f.Bio || '',
    imageUrl: f.ImageURL || '',
    links: {
      instagram: f.Instagram || '',
      discord: f.Discord || '',
      whatsapp: f.WhatsApp || '',
      website1: f.Website1 || '',
      website1Label: f.Website1Label || '',
      website2: f.Website2 || '',
      website2Label: f.Website2Label || '',
      website3: f.Website3 || '',
      website3Label: f.Website3Label || '',
      twitter: f.Twitter || '',
      facebook: f.Facebook || '',
      tiktok: f.TikTok || '',
      youtube: f.YouTube || '',
      telegram: f.Telegram || '',
      line: f.LINE || '',
      email: f.Email || ''
    }
  };
}

app.get('/api/directory', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Directory is not configured yet.' });
  }

  try {
    // Single-profile mode — browsing the grid stays public, but
    // opening one specific profile requires being logged in. Checked
    // here (not just hidden in the frontend) since the frontend check
    // is trivial to bypass and this is the actual data boundary.
    // Two ways in: the new clean ?slug= (what /u/:slug uses) or the
    // legacy ?id= (kept working for any link already shared/bookmarked).
    if (req.query.slug || req.query.id) {
      let record = null;

      if (req.query.slug) {
        const rawSlug = String(req.query.slug).trim().toLowerCase();
        if (PROFILE_SLUG_RE.test(rawSlug)) {
          const escapedSlug = rawSlug.replace(/'/g, "\\'");
          const params = new URLSearchParams({
            filterByFormula: `LOWER({Slug})='${escapedSlug}'`,
            maxRecords: '1'
          });
          const lookupRes = await fetch(`${AIRTABLE_COMMUNITY_URL}?${params.toString()}`, {
            headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
          });
          if (lookupRes.ok) {
            const lookupData = await lookupRes.json();
            record = (lookupData.records && lookupData.records[0]) || null;
          }
        }
      } else {
        const recordId = String(req.query.id);
        const recRes = await fetch(`${AIRTABLE_COMMUNITY_URL}/${encodeURIComponent(recordId)}`, {
          headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
        });
        if (recRes.ok) record = await recRes.json();
      }

      if (!record) {
        return res.status(404).json({ error: 'Profile not found.' });
      }
      const isOwner = req.sessionUserId === record.id;
      const isApproved = !!(record.fields && record.fields.Status === 'Approved');
      // Approved profiles are public — anyone with the link can view
      // them, logged in or not, so this URL is safe to paste in a bio.
      // Only a non-Approved row is still gated: the owner can preview
      // their own Pending/Rejected profile (the "Preview" link on the
      // edit-profile page), but a logged-out visitor hitting one gets
      // sent to log in first, and anyone else just gets a 404.
      if (!record.fields || (!isApproved && !isOwner)) {
        if (!isApproved && !req.sessionUserId) {
          return res.status(401).json({ error: 'Please log in to view this profile.', loginRequired: true });
        }
        return res.status(404).json({ error: 'Profile not found.' });
      }
      return res.json({ profile: toPublicProfile(record), isOwner, status: record.fields.Status });
    }

    // List mode
    const courseId = req.query.course ? normalizeCourseId(req.query.course) : null;
    const type = (req.query.type === 'teacher' || req.query.type === 'learner') ? req.query.type : null;

    const clauses = [`{Status}='Approved'`];
    if (courseId) clauses.push(`{Course}='${courseId}'`);
    if (type) clauses.push(`{Type}='${type}'`);
    const filterByFormula = clauses.length > 1 ? `AND(${clauses.join(',')})` : clauses[0];

    const params = new URLSearchParams({ filterByFormula, pageSize: '100' });
    const listRes = await fetch(`${AIRTABLE_COMMUNITY_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!listRes.ok) {
      const errText = await listRes.text();
      console.error('Airtable directory list failed:', errText);
      return res.status(502).json({ error: 'Failed to load the directory. Please try again.' });
    }
    const data = await listRes.json();
    const profiles = (data.records || []).map(toPublicProfile);
    res.json({ profiles });
  } catch (err) {
    console.error('Directory error:', err);
    res.status(500).json({ error: 'Failed to load the directory. Please try again.' });
  }
});

// ============================================================
// ACCOUNTS — signup, login, logout, and "who am I". Every account
// is a CommunityProfiles row created with Status "Pending", so a new
// signup goes through the exact same manual-approval step your
// hand-entered rows already go through — you just flip Status to
// Approved in Airtable once you've looked them over, and the same
// row starts appearing in /api/directory automatically.
// ============================================================

// POST /api/signup — {name, email, password, course?, type?,
// country?, tagline?, about?, imageUrl?, links?{...}}. The signup
// page collects the full profile (not just login details) so the
// row is ready to review the moment it lands in Airtable.
app.post('/api/signup', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Accounts are not configured yet.' });
  }
  if (isSignupRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many signup attempts — please try again in a bit.' });
  }

  const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
  const emailRaw = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const courseId = normalizeCourseId(req.body && req.body.course);
  const type = (req.body && req.body.type === 'teacher') ? 'teacher' : 'learner';

  // Optional profile fields — the signup page collects the full
  // profile up front (same fields as the edit-profile form) so a
  // reviewer sees a complete card immediately, rather than a bare
  // name/email row that only gets filled in later. All optional:
  // missing ones just save as blank, same as a hand-created row.
  const body = req.body || {};
  const links = body.links || {};
  const country = cleanStr(body.country, 60);
  const tagline = cleanStr(body.tagline, 140);
  const about = cleanStr(body.about, 1000);
  const imageUrl = cleanStr(body.imageUrl, 500);
  const profileLinks = {
    Instagram: cleanStr(links.instagram, 100),
    Discord: cleanStr(links.discord, 100),
    WhatsApp: cleanStr(links.whatsapp, 40),
    Website1: cleanStr(links.website1, 200),
    Website1Label: cleanStr(links.website1Label, 40),
    Website2: cleanStr(links.website2, 200),
    Website2Label: cleanStr(links.website2Label, 40),
    Website3: cleanStr(links.website3, 200),
    Website3Label: cleanStr(links.website3Label, 40),
    Twitter: cleanStr(links.twitter, 100),
    Facebook: cleanStr(links.facebook, 100),
    TikTok: cleanStr(links.tiktok, 100),
    YouTube: cleanStr(links.youtube, 100),
    Telegram: cleanStr(links.telegram, 100),
    LINE: cleanStr(links.line, 100)
  };

  if (!name) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (!EMAIL_RE.test(emailRaw)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }
  if (countFilledSocialLinks(links) > MAX_SOCIAL_LINKS) {
    return res.status(400).json({ error: `Please limit yourself to ${MAX_SOCIAL_LINKS} social links.` });
  }

  const escapedEmail = emailRaw.replace(/'/g, "\\'");

  try {
    // Reject duplicate emails. Airtable itself won't enforce
    // uniqueness, so this check is the only thing stopping two
    // accounts from sharing a login.
    const dupeParams = new URLSearchParams({
      filterByFormula: `LOWER({Email})='${escapedEmail}'`,
      maxRecords: '1'
    });
    const dupeRes = await fetch(`${AIRTABLE_COMMUNITY_URL}?${dupeParams.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!dupeRes.ok) {
      const errText = await dupeRes.text();
      console.error('Airtable signup dupe-check failed:', errText);
      return res.status(502).json({ error: 'Something went wrong creating your account. Please try again.' });
    }
    const dupeData = await dupeRes.json();
    if (dupeData.records && dupeData.records.length > 0) {
      return res.status(409).json({ error: 'An account with that email already exists. Try logging in instead.' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const createRes = await fetch(AIRTABLE_COMMUNITY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          Name: name,
          Email: emailRaw,
          PasswordHash: passwordHash,
          Type: type,
          Course: courseId,
          Country: country,
          Tagline: tagline,
          Bio: about,
          ImageURL: imageUrl,
          ...profileLinks,
          Status: 'Pending'
        }
      })
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error('Airtable signup create failed:', errText);
      return res.status(502).json({ error: 'Something went wrong creating your account. Please try again.' });
    }
    let record = await createRes.json();

    // Give the new row a clean, shareable slug (e.g. "priya-142") now
    // that Airtable has assigned it a Seq autonumber. Best-effort: if
    // this second write fails for any reason, signup itself still
    // succeeded — the row just falls back to its old ?id= link until
    // a retry or a manually-typed Slug fixes it up.
    const slug = buildProfileSlug(name, record);
    try {
      const slugRes = await fetch(`${AIRTABLE_COMMUNITY_URL}/${encodeURIComponent(record.id)}`, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${AIRTABLE_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fields: { Slug: slug } })
      });
      if (slugRes.ok) {
        record = await slugRes.json();
      } else {
        console.error('Slug save failed:', await slugRes.text());
      }
    } catch (slugErr) {
      console.error('Slug save error:', slugErr);
    }

    // Log the new user straight in (as Pending) — they don't need to
    // re-login once you approve them, their existing session just
    // starts reflecting Approved on its next /api/me check.
    setUserSessionCookie(res, record.id);
    res.status(201).json({
      ok: true,
      id: record.id,
      name,
      status: 'Pending',
      slug: record.fields.Slug || slug,
      profile: toPublicProfile(record)
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Something went wrong creating your account. Please try again.' });
  }
});

// POST /api/login — {email, password}
app.post('/api/login', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Accounts are not configured yet.' });
  }
  if (isLoginRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many login attempts — please try again in a bit.' });
  }

  const emailRaw = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!emailRaw || !password) {
    return res.status(400).json({ error: 'Please enter your email and password.' });
  }
  const escapedEmail = emailRaw.replace(/'/g, "\\'");

  // Same generic message for "no such email" and "wrong password" —
  // distinguishing them lets an attacker enumerate real accounts.
  const invalidMsg = { error: 'Invalid email or password.' };

  try {
    const params = new URLSearchParams({
      filterByFormula: `LOWER({Email})='${escapedEmail}'`,
      maxRecords: '1'
    });
    const lookupRes = await fetch(`${AIRTABLE_COMMUNITY_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!lookupRes.ok) {
      const errText = await lookupRes.text();
      console.error('Airtable login lookup failed:', errText);
      return res.status(502).json({ error: 'Something went wrong logging you in. Please try again.' });
    }
    const data = await lookupRes.json();
    const record = data.records && data.records[0];
    if (!record || !record.fields || !record.fields.PasswordHash) {
      return res.status(401).json(invalidMsg);
    }

    const matches = await bcrypt.compare(password, record.fields.PasswordHash);
    if (!matches) {
      return res.status(401).json(invalidMsg);
    }

    setUserSessionCookie(res, record.id);
    res.json({
      ok: true,
      id: record.id,
      name: record.fields.Name || '',
      status: record.fields.Status || 'Pending'
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Something went wrong logging you in. Please try again.' });
  }
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  clearUserSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/me — tells the frontend who's logged in (for the profile
// icon, the "pending approval" state, and gating lesson unlock).
// Never returns PasswordHash.
app.get('/api/me', async (req, res) => {
  if (!req.sessionUserId) {
    return res.json({ loggedIn: false });
  }
  const record = await fetchUserRecord(req.sessionUserId);
  if (!record || !record.fields) {
    // Session points at a row that's gone (deleted in Airtable) —
    // clear the stale cookie rather than leaving the frontend stuck.
    clearUserSessionCookie(res);
    return res.json({ loggedIn: false });
  }
  res.json({
    loggedIn: true,
    id: record.id,
    name: record.fields.Name || '',
    email: record.fields.Email || '',
    status: record.fields.Status || 'Pending',
    profile: toPublicProfile(record)
  });
});

// ============================================================
// PROFILE SELF-EDIT — a logged-in user updating their own row.
// Deliberately narrow: only the display fields below can be
// changed. Email (their login identifier), Password, Status, Type,
// and Course are never touched here — changing those needs its own
// flow with its own safeguards, not a generic "edit profile" form.
//
// Every successful edit resets Status back to "Pending", even for
// an already-Approved profile. That's intentional, not a bug: the
// site's whole pitch is "every profile personally reviewed, no
// bots" — letting someone silently rewrite an already-reviewed
// profile would quietly break that promise. It does mean a small
// typo fix costs another review cycle; if that trade-off feels
// wrong once real users hit it, this is the one line to change.
// ============================================================
function cleanStr(val, maxLen) {
  return String(val || '').trim().slice(0, maxLen);
}

// Social platforms share one combined cap (MAX_SOCIAL_LINKS) — unlike
// the three dedicated Website slots, there's no per-platform limit,
// just a ceiling on how many of these nine can be filled in at once.
// Shared by /api/signup and PUT /api/profile so the rule can't be
// bypassed by hitting one endpoint instead of the other.
const SOCIAL_LINK_KEYS = ['instagram', 'discord', 'whatsapp', 'twitter', 'facebook', 'tiktok', 'youtube', 'telegram', 'line'];
const MAX_SOCIAL_LINKS = 6;
function countFilledSocialLinks(links) {
  return SOCIAL_LINK_KEYS.reduce((count, key) => count + (cleanStr(links[key], 200) ? 1 : 0), 0);
}

app.put('/api/profile', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Accounts are not configured yet.' });
  }
  if (!req.sessionUserId) {
    return res.status(401).json({ error: 'Please log in to edit your profile.' });
  }

  const body = req.body || {};
  const links = body.links || {};
  const name = cleanStr(body.name, 100);
  if (!name) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (countFilledSocialLinks(links) > MAX_SOCIAL_LINKS) {
    return res.status(400).json({ error: `Please limit yourself to ${MAX_SOCIAL_LINKS} social links.` });
  }

  const fields = {
    Name: name,
    Country: cleanStr(body.country, 60),
    Tagline: cleanStr(body.tagline, 140),
    Bio: cleanStr(body.about, 1000),
    ImageURL: cleanStr(body.imageUrl, 500),
    Instagram: cleanStr(links.instagram, 100),
    Discord: cleanStr(links.discord, 100),
    WhatsApp: cleanStr(links.whatsapp, 40),
    Website1: cleanStr(links.website1, 200),
    Website1Label: cleanStr(links.website1Label, 40),
    Website2: cleanStr(links.website2, 200),
    Website2Label: cleanStr(links.website2Label, 40),
    Website3: cleanStr(links.website3, 200),
    Website3Label: cleanStr(links.website3Label, 40),
    Twitter: cleanStr(links.twitter, 100),
    Facebook: cleanStr(links.facebook, 100),
    TikTok: cleanStr(links.tiktok, 100),
    YouTube: cleanStr(links.youtube, 100),
    Telegram: cleanStr(links.telegram, 100),
    LINE: cleanStr(links.line, 100)
    // Status is intentionally left out of this update — editing a
    // profile no longer resets it to Pending. Once a profile is
    // Approved, it stays Approved (and stays live) through further
    // edits; a Pending or Rejected profile stays exactly that until
    // you change it by hand in Airtable. PATCH only touches the
    // fields listed here, so leaving Status out means Airtable
    // simply keeps whatever value is already on the row.
  };

  try {
    const updateRes = await fetch(`${AIRTABLE_COMMUNITY_URL}/${encodeURIComponent(req.sessionUserId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields })
    });
    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('Airtable profile update failed:', errText);
      return res.status(502).json({ error: 'Something went wrong saving your profile. Please try again.' });
    }
    const record = await updateRes.json();

    // The lesson-unlock cache may still say "Approved" from before
    // this edit reset Status to Pending — drop it so access reflects
    // the change immediately rather than up to 60s later.
    accountApprovalCache.delete(req.sessionUserId);

    res.json({
      ok: true,
      id: record.id,
      name: record.fields.Name || '',
      status: record.fields.Status || 'Pending',
      profile: toPublicProfile(record)
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Something went wrong saving your profile. Please try again.' });
  }
});

// ============================================================
// PROTECTED LESSON FILES
// Lesson HTML lives outside /public (in each course's own directory
// — see COURSES above) so it can only ever be reached through this
// route, which checks that course's unlock cookie first, then (new)
// falls back to an Approved account for that course.
// ============================================================
async function serveLesson(courseId, rawSlug, req, res) {
  const course = COURSES[courseId];
  const slug = String(rawSlug || '').toLowerCase();
  if (!SLUG_RE.test(slug)) {
    return res.redirect(course.roadmapRedirect);
  }

  const unlocked = getUnlocked(req, course);
  let hasAccess = isUnlocked(unlocked, slug);
  if (!hasAccess && req.sessionUserId) {
    hasAccess = await isApprovedForCourse(req.sessionUserId, courseId);
  }
  if (!hasAccess) {
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
app.get('/lesson/:course/:slug', async (req, res) => {
  const courseId = normalizeCourseId(req.params.course);
  await serveLesson(courseId, req.params.slug, req, res);
});

// Legacy form kept for backward compatibility: any existing links
// or bookmarks to /lesson/<slug> (from before Korean support was
// added) keep resolving against the Japanese course, exactly as
// before.
app.get('/lesson/:slug', async (req, res) => {
  await serveLesson('jp', req.params.slug, req, res);
});

// ============================================================
// CLEAN PROFILE URLS — /u/priya-142 instead of
// /profile.html?id=recXXXXXXXXXXXXXX&type=teacher. This route just
// serves the same profile.html shell; profile.html's own script
// reads the slug back out of the URL path and calls
// /api/directory?slug=... itself (see the matching change there).
// Kept under /u/ rather than the bare root so it can never collide
// with /api, /lesson, static assets, or any other top-level route.
// ============================================================
app.get('/u/:slug', (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!PROFILE_SLUG_RE.test(slug)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
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
