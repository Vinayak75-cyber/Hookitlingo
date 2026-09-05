const express = require('express');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs'); // pure-JS bcrypt - no native build step needed on most hosts
const crypto = require('crypto'); // built into Node - used for password-reset tokens
const { Resend } = require('resend'); // npm install resend - sends the password-reset email
require('dotenv').config();
// Image upload (Cloudflare R2) - split into its own file/router
// purely for readability; still runs in this same process, not a
// separate server. See routes/upload.js and lib/r2.js.
const uploadRouter = require('./routes/upload');
const deleteRouter = require('./routes/delete');
const { deleteImageFromR2 } = require('./lib/r2');
const paymentRouter = require('./routes/payment');

const app = express();

// Render sits exactly one reverse-proxy hop in front of this app, so
// trust exactly one hop of X-Forwarded-For. This makes Express parse
// that header itself and populate req.ip with the real client IP,
// while ignoring any X-Forwarded-For value a client tries to inject
// before it reaches that first trusted hop. If you ever put
// something like Cloudflare in front of Render too, this needs to
// become 2, not 1.
app.set('trust proxy', 1);

// Only your own frontend(s) may call this API from a browser. Set
// ALLOWED_ORIGINS in your environment to a comma-separated list of the
// domains you actually serve the site from, e.g.:
//   ALLOWED_ORIGINS=https://hookit.online,https://www.hookit.online
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Requests with no Origin header (server-to-server, curl) aren't
    // browser-based CORS requests - let them through.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  },
  // Needed so the browser will send/receive the unlock cookie -
  // without this, the httpOnly cookie set by /api/unlock would never
  // reach the browser on a cross-origin request.
  credentials: true
}));
app.use(express.json());

// COOKIE_SECRET signs the unlock cookie so it can't be forged or edited
// client-side. Set a long random string for this in your environment -
// changing it later invalidates everyone's existing unlock cookie.
const COOKIE_SECRET = process.env.COOKIE_SECRET;
if (!COOKIE_SECRET) {
  console.warn('WARNING: COOKIE_SECRET is not set. Set it in your environment before deploying, unlock cookies will not be secure without it.');
}
app.use(cookieParser(COOKIE_SECRET || 'dev-only-insecure-secret-change-me'));

// attachSession is defined further down (near the other user-account
// code) but referenced here, BEFORE static files and every other
// route, so req.sessionUserId is already populated by the time the
// course-gated hub routes below (or anything else) needs it.
app.use((req, res, next) => attachSession(req, res, next));

// COURSE-GATED PAGES - registered before express.static on purpose.
// A static-file match short-circuits the request and never reaches
// middleware registered after it, so these routes have to come first
// to have any say over the listed files. guardHubPage() is defined
// further down (near fetchUserRecord) but, same as attachSession,
// hoisting means it's safe to reference here.
//
// This is every course-specific entry page currently referenced
// elsewhere in this codebase: the hub itself, the learner/teacher
// directory listing pages (see listingPage() in signup.html), and
// each course's roadmap page (see COURSES further down - the literal
// defaults here match those, since COURSES isn't defined yet at this
// point in the file). If you add another course-specific page later
// (e.g. a workbook page), add its path to the matching array below.
const COURSE_GATED_PAGES = {
  jp: [
    '/japanese-hub.html',
    '/japanese-learners.html',
    '/japanese-teachers.html',
    process.env.ROADMAP_REDIRECT_PATH || '/jlptn5roadmap.html',
    '/roadmapjp.html'
  ],
  kr: [
    '/korean-hub.html',
    '/korean-learners.html',
    '/korean-teachers.html',
    process.env.KR_ROADMAP_REDIRECT_PATH || '/roadmap.html'
  ]
};
Object.entries(COURSE_GATED_PAGES).forEach(([courseId, gatedPaths]) => {
  gatedPaths.forEach((gatedPath) => {
    app.get(gatedPath, (req, res, next) => guardHubPage(courseId, req, res, next));
  });
});

// Serve static files from /public (site pages, assets - NOT lessons)
app.use(express.static(path.join(__dirname, 'public')));

// POST /api/upload-image - see routes/upload.js for the route itself
// and lib/r2.js for the Cloudflare R2 client it uploads through.
app.use(uploadRouter);

// DELETE /api/delete-image - see routes/delete.js and lib/r2.js
app.use(deleteRouter);

// POST /api/paypal/* - see routes/payment.js
app.use(paymentRouter);

const { verifyPayPalOrderCompleted, computeOrderTotal } = paymentRouter;

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// TEMPORARY - verifies the trust proxy fix is working on Render.
// Remove this route once you've confirmed req.ip can't be spoofed
// (see the curl commands you were given for how to test it) - it
// leaks visitor IPs to anyone who requests it.
app.get('/api/debug-ip', (req, res) => {
  res.json({ ip: req.ip, xff: req.headers['x-forwarded-for'] });
});

// COURSE ACCESS - Airtable is the source of truth for which codes
// unlock which lesson(s). Purchases happen manually via Gumroad; you
// send the buyer a PDF/link with their code, they redeem it here.
//
// Requires three env vars (see .env / your host's dashboard):
//   AIRTABLE_API_KEY          - Personal Access Token from airtable.com
//   AIRTABLE_BASE_ID          - the base's ID (starts with "app...")
//   AIRTABLE_ACCESS_TABLE_NAME - defaults to "CourseAccess"
//
// Table needs three fields: Code (text), Scope (text - either a
// single lesson slug like "s01-l01" / "hanlingo", a comma-separated
// list of slugs for a bundle, or "ALL" for that course's master
// code), and Course (text - "jp" or "kr", see COURSES below). Older
// rows saved before the Course field existed are treated as "jp" so
// every code issued before this change keeps working unchanged.
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_ACCESS_TABLE_NAME = process.env.AIRTABLE_ACCESS_TABLE_NAME || 'CourseAccess';
const AIRTABLE_ACCESS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_ACCESS_TABLE_NAME)}`;

const COOKIE_MAX_AGE_MS = 10 * 365 * 24 * 60 * 60 * 1000; // ~10 years - one-time purchase, no expiry pressure

// Only lowercase letters, digits, and hyphens. Guards both the
// cookie contents and the :slug route param before either touches
// the filesystem. Covers both slug styles in use: Japanese "sNN-lNN"
// and Korean filename-derived slugs like "korean-grammar".
const SLUG_RE = /^[a-z0-9-]+$/;

// PROFILE SLUGS - clean public URLs like /u/priya-142 instead of
// /profile.html?id=recXXXXXXXXXXXXXX. The slug is generated once at
// signup time and saved to a "Slug" field on the CommunityProfiles
// row, so add that field yourself in Airtable (Text, optional):
//   Slug (text - lowercase letters/digits/hyphens, unique per row)
//
// It's built from two pieces: the person's name, slugified, plus a
// small number that makes it unique even if two people share a
// name. That number comes from an Airtable Autonumber field - add
// this one too:
//   Seq (Autonumber)
// Autonumber fields are assigned by Airtable itself the instant a
// row is created, are guaranteed unique, and need no extra lookup
// or retry-on-collision logic on this end - this code just reads
// back whatever number Airtable already assigned.
//
// Existing hand-created rows (made before this feature existed)
// won't have a Slug until you type one into Airtable by hand for
// them - same "you fill it in yourself" philosophy as every other
// CommunityProfiles field. Until you do, that row simply has no
// clean link yet; its old ?id= link still works either way.
const PROFILE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/; // 1-60 chars, no leading/trailing hyphen

// Turns a display name into the "priya" part of "priya-142". Strips
// accents, lowercases, collapses anything that isn't a letter/digit
// into a single hyphen, and trims stray hyphens off each end. Never
// returns an empty string - falls back to "user" so a name made
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

// COURSES - one entry per product line. Each gets its own signed
// cookie and its own protected-files directory, so unlocking Korean
// lessons never grants access to Japanese ones (or vice versa).
// "jp" is kept as the default/legacy course so the existing JLPT N5
// roadmap and any codes already issued for it keep working exactly
// as before, with no query-string or request-body changes required
// on that page.
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
    // slugs are kept as the bare filename stem - that way those
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
// than an error - a bad cookie should never crash the request.
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
    httpOnly: true, // JS can't read this directly - that's what /api/my-access is for
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: COOKIE_MAX_AGE_MS,
    path: '/'
  });
}

// Very small in-memory rate limiter - best-effort only (resets on
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
  return req.ip || req.socket.remoteAddress || 'unknown';
}

// ACCOUNT-BASED LESSON ACCESS - an Approved account grants full
// ("all") access to lessons in that account's own Course, same as
// redeeming an "ALL" code would, but without needing one. This sits
// alongside the existing cookie-based unlock, not in place of it: a
// logged-out visitor who redeemed a code still keeps working exactly
// as before, and an approved account works even with no code cookie
// at all.
//
// isApprovedForCourse() is called on every lesson-page load, so it's
// backed by a short in-memory cache (60s) to avoid hitting Airtable
// on every request - worst case, a fresh approval takes up to a
// minute to actually unlock lessons for that user, which is fine for
// this use case.
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

// GET /api/my-access?course=kr|jp - tells the frontend what's already
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

// POST /api/unlock - takes {code, course}, looks the code up in
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
    return res.status(429).json({ error: 'Too many attempts, please try again in a bit.' });
  }

  const rawCode = String((req.body && req.body.code) || '').trim();
  if (!rawCode) {
    return res.status(400).json({ error: 'Please enter a code.' });
  }
  const safeCode = rawCode.slice(0, 100);
  // Airtable formula string - escape single quotes so a code can't
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
      return res.status(502).json({ error: 'Failed to check that code, please try again.' });
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
    res.status(500).json({ error: "Couldn't check that code, please try again." });
  }
});

// COMMUNITY DIRECTORY TABLE - everything in this table is entered
// by hand in Airtable's own interface. There is no signup form or
// endpoint that writes to it automatically - you create a row
// yourself for each person once you've spoken to them and they've
// paid, and you only ever add someone once they're ready to go
// public.
//
// Requires one more env var alongside the ones above:
//   AIRTABLE_COMMUNITY_TABLE_NAME - defaults to "CommunityProfiles"
//
// Create a table in your Airtable base with these fields. Most are
// filled in by hand, but two - Email and PasswordHash - are now
// written automatically by /api/signup below, so add them to the
// table but never type into them yourself:
//   Name (text), Type (text: "learner" or "teacher"),
//   Course (text: "jp" or "kr"), Country (text), Tagline (text),
//   ImageURL (text - the public R2 URL for their photo),
//   Interests (Multiple select - see the INTEREST_OPTIONS list
//   below for the exact option names to create; must match
//   character-for-character since Airtable multi-select choices
//   are case- and text-sensitive),
//   Instagram, Discord, WhatsApp, Website1, Website1Label, Website2,
//   Website2Label, Website3, Website3Label, Twitter, Facebook,
//   TikTok, YouTube, Telegram, LINE, Email (text, all optional -
//   see the field-by-field notes below for what to paste into each),
//   Status (single select: "Pending", "Approved", "Rejected"),
//   PasswordHash (text - a bcrypt hash, never a plaintext password;
//   only /api/signup ever writes this field, and no API response
//   ever includes it), Slug (text - auto-filled by /api/signup, see
//   the "PROFILE SLUGS" block below for details), Seq (Autonumber -
//   also see "PROFILE SLUGS"; add this field FIRST so Slug generation
//   has a number to read on the very next signup),
//   PayPalOrderID (text - the captured PayPal order ID, also used
//   to stop one payment being replayed into two accounts),
//   PaymentStatus (single select: "Paid" - only value written today,
//   room to add "Refunded" etc. later if you add refund handling),
//   AmountPaidUSD (Number - the amount PayPal actually captured, in
//   case it's ever reconciled against the Settings price later).
//
// Email doing double duty: it's both a contact link shown on
// approved profiles (see the field notes below) AND the account
// login identifier for self-signups. That's fine - one row is one
// person either way - just know that turning Email into a login
// means it must stay unique per row. /api/signup checks for an
// existing row with the same email before creating a new one, but
// Airtable itself doesn't enforce uniqueness, so avoid hand-creating
// two rows with the same address.
//
// What to put in each optional link field (the frontend builds the
// actual clickable URL from whatever's here, so keep these as plain
// handles/numbers, not full profile URLs, except where noted):
//   Instagram - handle, with or without "@" (e.g. "hookitlingo")
//   Discord   - an invite link/code (e.g. "discord.gg/abc123").
//               A bare username/tag can be stored for display but
//               Discord no longer supports linking directly to a
//               profile from just a username, so it won't be
//               clickable in that case.
//   WhatsApp  - phone number, any formatting (e.g. "+91 8459444524")
//   Website1, Website2, Website3 - up to three bare domains or full
//               URLs (e.g. "hookit.online"). All optional; a learner
//               only needs to fill in as many as they have.
//   Website1Label, Website2Label, Website3Label - the button text
//               shown on that website's glass-bar link on the public
//               profile page (e.g. "My Portfolio"). Optional; if left
//               blank the button falls back to "Website 1" / "Website
//               2" / "Website 3". Only meaningful when the matching
//               WebsiteN field above is also filled in.
//   Twitter   - handle, with or without "@" (posts to x.com)
//   Facebook  - page/profile handle or full facebook.com URL
//   TikTok    - handle, with or without "@"
//   YouTube   - channel handle, with or without "@", or a full URL
//   Telegram  - username, with or without "@"
//   LINE      - personal LINE ID (used to build a line.me/ti/p/ link)
//   Email     - a plain email address. Not shown as its own icon -
//               it's used to make the "Get in touch" button link
//               straight to a mailto:, before falling back to
//               WhatsApp/Telegram/etc. if Email is left blank.
//
// Interests - a Multiple select field capped at 5 choices per
// person (enforced in code below, not by Airtable itself). The
// allowed options are the INTEREST_OPTIONS list further down this
// file, also served publicly at GET /api/interest-options so
// signup.html and edit-profile.html can build their chip pickers
// from it instead of hardcoding their own copy. Create the Airtable
// field's choices to match INTEREST_OPTIONS exactly before anyone
// signs up or edits their profile - Airtable itself isn't wired up
// to this list, so it's the one place that still has to be kept in
// sync by hand, and a write containing an option Airtable doesn't
// recognize yet will fail.
//
// Only rows with Status = "Approved" are ever returned by
// /api/directory below, so a row sits invisible on the public site
// until you flip that field yourself.
const AIRTABLE_COMMUNITY_TABLE_NAME = process.env.AIRTABLE_COMMUNITY_TABLE_NAME || 'CommunityProfiles';
const AIRTABLE_COMMUNITY_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_COMMUNITY_TABLE_NAME)}`;

// USER ACCOUNTS - separate from the course-unlock cookie above.
// A logged-in user IS a CommunityProfiles row (their Airtable
// record ID doubles as their unique user ID - no separate ID
// generation needed), identified going forward by a second,
// independent signed cookie so having one type of access never
// implies the other.
const USER_SESSION_COOKIE = 'hkl_user_session';
const USER_SESSION_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // ~6 months
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const AIRTABLE_RECORD_ID_RE = /^rec[A-Za-z0-9]+$/;
const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_ROUNDS = 10;

// PASSWORD RESET - "forgot password" flow. Two Airtable fields on
// CommunityProfiles, alongside the existing Email/PasswordHash, need
// to be added by hand (same philosophy as every other field in this
// table):
//   ResetTokenHash   (text - a sha256 hash of the reset token, never
//                      the raw token itself)
//   ResetTokenExpiry (text - an ISO timestamp; the token is only
//                      valid before this)
//
// Flow: /api/forgot-password generates a random token, stores its
// HASH (so a leaked Airtable export can't be used to reset anyone's
// password) with a short expiry, and emails the RAW token as a link
// via Resend. /api/reset-password hashes whatever token it's given
// and looks for a matching, unexpired row.
//
// Requires two env vars:
//   RESEND_API_KEY   - from resend.com
//   RESEND_FROM_EMAIL - a "from" address on a domain you've verified
//                        with Resend, e.g. 'Hookitlingo <noreply@hookit.online>'
// SITE_URL (defaults to https://hookit.online) is used to build the
// link that goes in the email.
const RESET_TOKEN_BYTES = 32;
const RESET_TOKEN_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour
const SITE_URL = (process.env.SITE_URL || 'https://hookit.online').replace(/\/+$/, '');
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'Hookitlingo <noreply@hookit.online>';
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
if (!RESEND_API_KEY) {
  console.warn('WARNING: RESEND_API_KEY is not set. Password-reset emails will not be sent.');
}

// Raw token -> sha256 hex digest. We only ever store/compare the
// hash, so a database leak alone can't be used to reset an account.
function hashResetToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

function buildResetEmailHtml(resetUrl) {
  return `
    <div style="font-family:sans-serif; max-width:480px; margin:0 auto; color:#3a2530;">
      <h2 style="font-family:Georgia,serif;">Reset your Hookitlingo password</h2>
      <p>We got a request to reset the password for this account. Click the button below to choose a new one. This link expires in 1 hour.</p>
      <p style="text-align:center; margin:28px 0;">
        <a href="${resetUrl}" style="background:#5fa688; color:#fff; padding:12px 24px; border-radius:10px; text-decoration:none; font-weight:bold; display:inline-block;">Reset Password</a>
      </p>
      <p style="color:#79576a; font-size:.9em;">If you didn't request this, you can safely ignore this email. Your password won't change.</p>
      <p style="color:#a98a9c; font-size:.8em;">If the button doesn't work, copy and paste this link: ${resetUrl}</p>
    </div>
  `;
}

const forgotPasswordRateLimit = new Map();
const FORGOT_PASSWORD_MAX_PER_HOUR = 5;
function isForgotPasswordRateLimited(ip) {
  return isRateLimited(forgotPasswordRateLimit, ip, FORGOT_PASSWORD_MAX_PER_HOUR);
}

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
// session cookie is present. Never blocks the request itself -
// routes that require login check req.sessionUserId themselves, so
// this can sit in front of both public and protected routes.
function attachSession(req, res, next) {
  req.sessionUserId = getSessionUserId(req);
  next();
}

// COURSE-GATED PAGES - the hub, roadmap, and learner/teacher listing
// pages are the "front door" for each course. If someone is already
// logged into an account for the OTHER course, the real file is
// never even read off disk - guardHubPage() (registered ahead of
// express.static, see COURSE_GATED_PAGES above) intercepts the
// request first and sends back a small interstitial instead, telling
// them to log out to switch. Since this runs before the static
// middleware and reads the account straight from Airtable, there's no
// client-side check here to defeat via dev tools - the actual page
// HTML simply never leaves the server for a mismatched request.
//
// A logged-out visitor, or someone logged into an account for the
// SAME course, always falls through untouched (next() hands off to
// express.static, which serves the real file exactly as before).
const COURSE_LABELS = { jp: 'Japanese', kr: 'Korean' };

function renderCourseLockedPage(blockedCourseId, yourCourseId) {
  const blockedLabel = COURSE_LABELS[blockedCourseId];
  const yourLabel = COURSE_LABELS[yourCourseId];
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Log out to switch courses | Hookitlingo</title>
<style>
  body{margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:#1c1420; color:#f6ecec; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; padding:20px;}
  .card{max-width:420px; background:#26192b; border:1px solid #4a3550; border-radius:16px; padding:32px 28px; text-align:center; box-shadow:0 30px 70px rgba(0,0,0,.4);}
  .icon{font-size:2.4em; margin-bottom:10px;}
  h1{font-size:1.25em; margin:0 0 12px; font-weight:600;}
  p{color:#c7b2c4; font-size:.95em; line-height:1.6; margin:0 0 22px;}
  .actions{display:flex; gap:10px; justify-content:center; flex-wrap:wrap;}
  button, a.btn{border-radius:999px; padding:11px 20px; font-size:.88em; font-weight:700; border:1px solid transparent; cursor:pointer; text-decoration:none; display:inline-block; font-family:inherit;}
  .btn-yes{background:linear-gradient(135deg,#e58aa2,#d9ab5c); color:#fff;}
  .btn-yes:hover{filter:brightness(1.07);}
  .btn-no{background:#2f2035; border-color:#4a3550; color:#c7b2c4;}
  .btn-no:hover{color:#f6ecec;}
</style>
</head>
<body>
  <div class="card">
    <div class="icon">🌸</div>
    <h1>You're signed in to your ${yourLabel} account</h1>
    <p>To browse the ${blockedLabel} course, log out of your ${yourLabel} account first, one account is only ever linked to one course at a time.</p>
    <div class="actions">
      <button class="btn-yes" id="logoutBtn">Log out</button>
      <a class="btn" style="background:#2f2035;border:1px solid #4a3550;color:#c7b2c4;" href="/">Back to home</a>
    </div>
  </div>
  <script>
    document.getElementById('logoutBtn').onclick = async function(){
      try { await fetch('/api/logout', { method: 'POST', credentials: 'include' }); } catch (e) {}
      window.location.href = '/';
    };
  </script>
</body>
</html>`;
}

async function guardHubPage(courseId, req, res, next) {
  if (req.sessionUserId) {
    const record = await fetchUserRecord(req.sessionUserId);
    const userCourse = record && record.fields ? normalizeCourseId(record.fields.Course) : null;
    if (userCourse && userCourse !== courseId) {
      return res.send(renderCourseLockedPage(courseId, userCourse));
    }
  }
  next();
}

// PUBLIC DIRECTORY - the "Connect with Learners / Teachers" pages
// read from here. Public, no auth needed, but only ever returns
// rows you've personally set Status to "Approved" on, and only a
// safe subset of fields.
//
// GET /api/directory?course=jp&type=learner  -> list mode
// GET /api/directory?id=recXXXXXXXXXXXXXX     -> single profile
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
    interests: Array.isArray(f.Interests) ? f.Interests : [],
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
    // Single-profile mode - browsing the grid stays public, but
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
      // Approved profiles are public - anyone with the link can view
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

// ACCOUNTS - signup, login, logout, and "who am I". Every account
// is a CommunityProfiles row created with Status "Pending", so a new
// signup goes through the exact same manual-approval step your
// hand-entered rows already go through - you just flip Status to
// Approved in Airtable once you've looked them over, and the same
// row starts appearing in /api/directory automatically.

// POST /api/signup - {name, email, password, course?, type?,
// country?, tagline?, about?, imageUrl?, links?{...}}. The signup
// page collects the full profile (not just login details) so the
// row is ready to review the moment it lands in Airtable.
app.post('/api/signup', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Accounts are not configured yet.' });
  }
  if (isSignupRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many signup attempts, please try again in a bit.' });
  }

  const name = String((req.body && req.body.name) || '').trim().slice(0, 100);
  const emailRaw = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  const courseId = normalizeCourseId(req.body && req.body.course);
  const type = (req.body && req.body.type === 'teacher') ? 'teacher' : 'learner';
  const paypalOrderId = String((req.body && req.body.paypalOrderId) || '').trim();
  const couponCode = String((req.body && req.body.couponCode) || '').trim();

  // Optional profile fields - the signup page collects the full
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
  const interests = sanitizeInterests(body.interests);
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
  if (interests.length > MAX_INTERESTS) {
    return res.status(400).json({ error: `Please select up to ${MAX_INTERESTS} interests.` });
  }
  if (!imageUrl) {
    return res.status(400).json({ error: 'Please upload a profile picture.' });
  }
  if (!profileLinks.Instagram) {
    return res.status(400).json({ error: 'Instagram is required, please add your Instagram handle.' });
  }

  // Recompute what this signup actually costs, from scratch,
  // server-side - never trust a price the client displayed. A
  // coupon that zeroes out the item price makes this a FREE signup
  // (order.free === true), which skips the PayPal requirement below
  // entirely; any other coupon (or no coupon) still needs a real
  // PayPal payment covering order.total (item price + $0.99 fee).
  const order = await computeOrderTotal(couponCode || null);
  if (order.error) {
    return res.status(400).json({ error: order.error });
  }
  if (!order.free && !paypalOrderId) {
    return res.status(402).json({ error: 'Payment is required to create an account. Please complete PayPal checkout first.' });
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
      return res.status(502).json({ error: "Couldn't create your account, please try again." });
    }
    const dupeData = await dupeRes.json();
    const dupeRecord = dupeData.records && dupeData.records[0];
    if (dupeRecord) {
      // Same message either way that the email is taken, but if the
      // existing account belongs to the OTHER course, say so - that's
      // a more useful next step than a generic "log in instead" when
      // logging in wouldn't actually get them into the course they
      // were just trying to join.
      const existingCourseId = normalizeCourseId(dupeRecord.fields && dupeRecord.fields.Course);
      if (existingCourseId === courseId) {
        return res.status(409).json({ error: 'An account with that email already exists. Try logging in instead.' });
      }
      return res.status(409).json({
        error: `This email is already registered with our ${COURSE_LABELS[existingCourseId]} course. Please use a different email to sign up for ${COURSE_LABELS[courseId]}.`
      });
    }

    // payment stays this default for the FREE path (coupon zeroed out
    // the total, so there's no PayPal order at all) - Airtable still
    // gets a real "how much did this person pay" value ($0) either
    // way, from order.total rather than from anything PayPal reports.
    let payment = { ok: true, captureId: null, amount: order.total, payerEmail: null };

    if (!order.free) {
      // Reject a PayPal order ID that's already been used to create a
      // profile. Without this, capturing one payment and replaying the
      // same orderID could be used to spin up multiple accounts off a
      // single payment.
      const escapedOrderId = paypalOrderId.replace(/'/g, "\\'");
      const orderDupeParams = new URLSearchParams({
        filterByFormula: `{PayPalOrderID}='${escapedOrderId}'`,
        maxRecords: '1'
      });
      const orderDupeRes = await fetch(`${AIRTABLE_COMMUNITY_URL}?${orderDupeParams.toString()}`, {
        headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
      });
      if (!orderDupeRes.ok) {
        const errText = await orderDupeRes.text();
        console.error('Airtable signup PayPal-order dupe-check failed:', errText);
        return res.status(502).json({ error: "Couldn't create your account, please try again." });
      }
      const orderDupeData = await orderDupeRes.json();
      if (orderDupeData.records && orderDupeData.records[0]) {
        return res.status(409).json({ error: 'This payment has already been used to create an account.' });
      }

      // Never trust the browser's say-so that payment succeeded - ask
      // PayPal about this order ID directly. Only a genuinely COMPLETED
      // capture lets a row get written below.
      payment = await verifyPayPalOrderCompleted(paypalOrderId);
      if (!payment.ok) {
        return res.status(402).json({ error: 'We could not verify your PayPal payment. Please try checkout again.' });
      }
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
          Interests: interests,
          ...profileLinks,
          Status: 'Pending',
          PayPalOrderID: order.free ? '' : paypalOrderId,
          PaymentStatus: order.free ? 'Free (Coupon)' : 'Paid',
          AmountPaidUSD: payment.amount,
          CouponCode: order.coupon ? order.coupon.code : ''
        }
      })
    });
    if (!createRes.ok) {
      const errText = await createRes.text();
      console.error('Airtable signup create failed:', errText);
      return res.status(502).json({ error: "Couldn't create your account, please try again." });
    }
    let record = await createRes.json();

    // Give the new row a clean, shareable slug (e.g. "priya-142") now
    // that Airtable has assigned it a Seq autonumber. Best-effort: if
    // this second write fails for any reason, signup itself still
    // succeeded - the row just falls back to its old ?id= link until
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

    // Log the new user straight in (as Pending) - they don't need to
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
    res.status(500).json({ error: "Couldn't create your account, please try again." });
  }
});

// POST /api/login - {email, password}
app.post('/api/login', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Accounts are not configured yet.' });
  }
  if (isLoginRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many login attempts, please try again in a bit.' });
  }

  const emailRaw = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!emailRaw || !password) {
    return res.status(400).json({ error: 'Please enter your email and password.' });
  }
  const escapedEmail = emailRaw.replace(/'/g, "\\'");

  // Same generic message for "no such email" and "wrong password" -
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
      return res.status(502).json({ error: "Couldn't log you in, please try again." });
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
    res.status(500).json({ error: "Couldn't log you in, please try again." });
  }
});

// POST /api/forgot-password - {email}. Always returns the same
// generic success message whether or not the email is registered,
// so this endpoint can't be used to check who has an account.
app.post('/api/forgot-password', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Accounts are not configured yet.' });
  }
  if (isForgotPasswordRateLimited(getClientIp(req))) {
    return res.status(429).json({ error: 'Too many attempts, please try again in a bit.' });
  }

  const emailRaw = String((req.body && req.body.email) || '').trim().toLowerCase();
  const genericMsg = { ok: true, message: 'If an account exists for that email, we\'ve sent a password reset link.' };

  if (!EMAIL_RE.test(emailRaw)) {
    // Still a 400 here (bad input, not a privacy leak) - but the
    // message never confirms/denies the email is registered.
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const escapedEmail = emailRaw.replace(/'/g, "\\'");

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
      console.error('Airtable forgot-password lookup failed:', errText);
      // Don't leak the failure mode to the client - just act as if
      // nothing was found, same generic response either way.
      return res.json(genericMsg);
    }
    const data = await lookupRes.json();
    const record = data.records && data.records[0];
    if (!record) {
      return res.json(genericMsg);
    }

    const rawToken = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
    const tokenHash = hashResetToken(rawToken);
    const expiry = new Date(Date.now() + RESET_TOKEN_MAX_AGE_MS).toISOString();

    const patchRes = await fetch(`${AIRTABLE_COMMUNITY_URL}/${encodeURIComponent(record.id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ fields: { ResetTokenHash: tokenHash, ResetTokenExpiry: expiry } })
    });
    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('Airtable reset-token save failed:', errText);
      return res.json(genericMsg);
    }

    if (resend) {
      const resetUrl = `${SITE_URL}/reset-password.html?token=${rawToken}`;
      try {
        await resend.emails.send({
          from: RESEND_FROM_EMAIL,
          to: emailRaw,
          subject: 'Reset your Hookitlingo password',
          html: buildResetEmailHtml(resetUrl)
        });
      } catch (emailErr) {
        // Token is saved either way - log it, but still tell the user
        // the generic success message (don't reveal delivery details).
        console.error('Resend send failed:', emailErr);
      }
    } else {
      console.warn('Skipped sending reset email - RESEND_API_KEY not set.');
    }

    res.json(genericMsg);
  } catch (err) {
    console.error('Forgot-password error:', err);
    res.json(genericMsg);
  }
});

// POST /api/reset-password - {token, password}. Looks up the token
// by its hash, checks it hasn't expired, and (if valid) overwrites
// PasswordHash and clears the reset fields so the token is one-time-use.
app.post('/api/reset-password', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Accounts are not configured yet.' });
  }

  const rawToken = String((req.body && req.body.token) || '').trim();
  const password = String((req.body && req.body.password) || '');
  const invalidMsg = { error: 'This reset link is invalid or has expired. Please request a new one.' };

  if (!rawToken) {
    return res.status(400).json(invalidMsg);
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
  }

  const tokenHash = hashResetToken(rawToken);

  try {
    const params = new URLSearchParams({
      filterByFormula: `{ResetTokenHash}='${tokenHash}'`,
      maxRecords: '1'
    });
    const lookupRes = await fetch(`${AIRTABLE_COMMUNITY_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!lookupRes.ok) {
      const errText = await lookupRes.text();
      console.error('Airtable reset-token lookup failed:', errText);
      return res.status(502).json({ error: "Couldn't reset your password, please try again." });
    }
    const data = await lookupRes.json();
    const record = data.records && data.records[0];
    const expiryRaw = record && record.fields && record.fields.ResetTokenExpiry;
    const expiryOk = expiryRaw && new Date(expiryRaw).getTime() > Date.now();

    if (!record || !expiryOk) {
      return res.status(400).json(invalidMsg);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const updateRes = await fetch(`${AIRTABLE_COMMUNITY_URL}/${encodeURIComponent(record.id)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      // Clearing the token fields makes the link one-time-use - a
      // second attempt with the same token will find no match above.
      body: JSON.stringify({ fields: { PasswordHash: passwordHash, ResetTokenHash: '', ResetTokenExpiry: '' } })
    });
    if (!updateRes.ok) {
      const errText = await updateRes.text();
      console.error('Airtable password update failed:', errText);
      return res.status(502).json({ error: "Couldn't reset your password, please try again." });
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Reset-password error:', err);
    res.status(500).json({ error: "Couldn't reset your password, please try again." });
  }
});

// POST /api/logout
app.post('/api/logout', (req, res) => {
  clearUserSessionCookie(res);
  res.json({ ok: true });
});

// GET /api/me - tells the frontend who's logged in (for the profile
// icon, the "pending approval" state, and gating lesson unlock).
// Never returns PasswordHash.
app.get('/api/me', async (req, res) => {
  if (!req.sessionUserId) {
    return res.json({ loggedIn: false });
  }
  const record = await fetchUserRecord(req.sessionUserId);
  if (!record || !record.fields) {
    // Session points at a row that's gone (deleted in Airtable) -
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

// PROFILE SELF-EDIT - a logged-in user updating their own row.
// Deliberately narrow: only the display fields below can be
// changed. Email (their login identifier), Password, Status, Type,
// and Course are never touched here - changing those needs its own
// flow with its own safeguards, not a generic "edit profile" form.
//
// Every successful edit resets Status back to "Pending", even for
// an already-Approved profile. That's intentional, not a bug: the
// site's whole pitch is "every profile personally reviewed, no
// bots" - letting someone silently rewrite an already-reviewed
// profile would quietly break that promise. It does mean a small
// typo fix costs another review cycle; if that trade-off feels
// wrong once real users hit it, this is the one line to change.
function cleanStr(val, maxLen) {
  return String(val || '').trim().slice(0, maxLen);
}

// Social platforms share one combined cap (MAX_SOCIAL_LINKS) - unlike
// the three dedicated Website slots, there's no per-platform limit,
// just a ceiling on how many of these nine can be filled in at once.
// Shared by /api/signup and PUT /api/profile so the rule can't be
// bypassed by hitting one endpoint instead of the other.
const SOCIAL_LINK_KEYS = ['instagram', 'discord', 'whatsapp', 'twitter', 'facebook', 'tiktok', 'youtube', 'telegram', 'line'];
const MAX_SOCIAL_LINKS = 6;
function countFilledSocialLinks(links) {
  return SOCIAL_LINK_KEYS.reduce((count, key) => count + (cleanStr(links[key], 200) ? 1 : 0), 0);
}

// Interests & Hobbies - a fixed pick-list (not free text) so it maps
// cleanly onto an Airtable Multiple select field. This is the ONE
// place in the codebase this list is defined - signup.html and
// edit-profile.html fetch it from GET /api/interest-options below
// rather than hardcoding their own copy. The Airtable field's
// choices still have to be kept in sync with this list by hand,
// since Airtable itself doesn't read from here.
const INTEREST_OPTIONS = [
  'Anime & Manga', 'K-Pop', 'K-Dramas', 'J-Dramas & J-Pop', 'Gaming',
  'Cooking & Baking', 'Traveling', 'Photography', 'Reading', 'Movies & TV',
  'Music', 'Art & Drawing', 'Fitness & Sports', 'Yoga', 'Hiking & Outdoors',
  'Fashion', 'Calligraphy', 'Dance', 'Board Games', 'Martial Arts',
  'Coding & Tech', 'Podcasts', 'Cosplay', 'Language Exchange'
];
const MAX_INTERESTS = 5;
// Drops anything that isn't one of the known options (defends against
// a tampered request sending arbitrary strings Airtable would reject)
// and dedupes, but does NOT silently truncate over the cap - callers
// check .length against MAX_INTERESTS themselves and return a 400,
// same pattern as countFilledSocialLinks/MAX_SOCIAL_LINKS above.
function sanitizeInterests(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return [...new Set(arr.filter(v => INTEREST_OPTIONS.includes(v)))];
}

// Public, no auth needed - lets signup.html and edit-profile.html
// fetch the pick-list at page-load instead of hardcoding their own
// copy. This makes server.js the ONE place that needs editing when
// the list changes (plus the Airtable field's choices, which still
// has to be updated by hand - Airtable doesn't expose an API for
// that here). Before this endpoint existed, the same 24 strings were
// duplicated three times over and could silently drift out of sync.
app.get('/api/interest-options', (req, res) => {
  res.json({ options: INTEREST_OPTIONS, max: MAX_INTERESTS });
});

app.put('/api/profile', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Accounts are not configured yet.' });
  }
  if (!req.sessionUserId) {
    return res.status(401).json({ error: 'Please log in to edit your profile.' });
  }

  // Pulled up front, before touching anything else in the request -
  // this is what decides whether editing is even allowed right now,
  // so there's no point validating the rest of the form first. A
  // Pending profile hasn't been reviewed yet, so it can't be edited
  // until that first review happens (an Approved or Rejected profile
  // can always be edited). This is the actual, only place that rule
  // is enforced - the edit page hides its form for a Pending account
  // too, but that's just for a better look and feel. Someone calling
  // this endpoint straight from dev tools still hits this same check
  // and gets turned away the same way.
  const existingRecord = await fetchUserRecord(req.sessionUserId);
  if (!existingRecord || !existingRecord.fields) {
    return res.status(401).json({ error: 'Please log in to edit your profile.' });
  }
  if (existingRecord.fields.Status === 'Pending') {
    return res.status(403).json({ error: 'Your profile is still awaiting its first review, so it can\'t be edited yet.' });
  }

  const body = req.body || {};
  const links = body.links || {};
  const name = cleanStr(body.name, 100);
  const interests = sanitizeInterests(body.interests);
  const imageUrl = cleanStr(body.imageUrl, 500);
  const instagram = cleanStr(links.instagram, 100);
  if (!name) {
    return res.status(400).json({ error: 'Please enter your name.' });
  }
  if (countFilledSocialLinks(links) > MAX_SOCIAL_LINKS) {
    return res.status(400).json({ error: `Please limit yourself to ${MAX_SOCIAL_LINKS} social links.` });
  }
  if (interests.length > MAX_INTERESTS) {
    return res.status(400).json({ error: `Please select up to ${MAX_INTERESTS} interests.` });
  }
  if (!imageUrl) {
    return res.status(400).json({ error: 'Please upload your profile picture.' });
  }
  if (!instagram) {
    return res.status(400).json({ error: 'Instagram is required, please add your Instagram handle.' });
  }

  // The old photo (if any) this save is about to replace - see the R2
  // cleanup after the write succeeds below.
  const oldImageUrl = existingRecord.fields.ImageURL || '';

  const fields = {
    Name: name,
    Country: cleanStr(body.country, 60),
    Tagline: cleanStr(body.tagline, 140),
    Bio: cleanStr(body.about, 1000),
    ImageURL: imageUrl,
    Interests: interests,
    Instagram: instagram,
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
    // Status is intentionally left out of this update - editing a
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
      return res.status(502).json({ error: "Couldn't save your profile, please try again." });
    }
    const record = await updateRes.json();

    // The lesson-unlock cache may still say "Approved" from before
    // this edit reset Status to Pending - drop it so access reflects
    // the change immediately rather than up to 60s later.
    accountApprovalCache.delete(req.sessionUserId);

    // The profile is already saved at this point, so a photo was
    // definitely swapped out for a new one - clean up the old one in
    // R2 now so it doesn't just sit there taking up storage forever.
    // Best-effort: this runs after the response the user cares about
    // has already succeeded, so a cleanup failure here shouldn't turn
    // into an error for them, it just means that one old file gets
    // left behind until it's cleaned up some other way.
    if (oldImageUrl && oldImageUrl !== imageUrl) {
      deleteImageFromR2(oldImageUrl).catch(err => {
        console.error('R2 cleanup of replaced photo failed:', err);
      });
    }

    res.json({
      ok: true,
      id: record.id,
      name: record.fields.Name || '',
      status: record.fields.Status || 'Pending',
      profile: toPublicProfile(record)
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: "Couldn't save your profile, please try again." });
  }
});

// TEACHER ANNOUNCEMENTS - a single, temporary announcement a
// logged-in teacher can post from the edit-profile page. It shows up
// in an "Announcements" section on their own course's teacher
// listing page (japanese-teachers.html / korean-teachers.html) until
// the chosen duration elapses, then it simply stops being returned by
// GET /api/announcements below. There's no cron job deleting rows -
// expiry is just a time filter applied at read time (via an Airtable
// formula comparing ExpiresAt to NOW()), which is simpler and can
// never drift out of sync with a separate cleanup job.
//
// One active announcement per teacher: posting a new one replaces
// whatever they already had live rather than stacking up a feed. If
// you'd rather allow several at once later, drop the "find existing
// row" step in POST /api/announcements below and just always create
// a new row instead of patching one.
//
// Create a table in your Airtable base named exactly as below (or
// point AIRTABLE_ANNOUNCEMENTS_TABLE_NAME at whatever you name it)
// with these fields:
//   TeacherId     (text - the CommunityProfiles record ID of the
//                  teacher who posted it; never shown to the public)
//   TeacherName   (text - cached at post time so the public listing
//                  page doesn't need a second lookup per card)
//   Course        (text - "jp" or "kr")
//   ImageURL      (text - the public R2 URL, same upload flow as a
//                  profile photo, via the existing POST
//                  /api/upload-image)
//   Text          (long text - capped at 150 words, enforced below)
//   ButtonText    (text - the label the teacher chose for their button)
//   ButtonLink    (text - the URL the button opens)
//   DurationHours (number - one of 12/18/24/30/36/42/48)
//   ExpiresAt     (Date field, WITH "include a time field" turned on
//                  - computed here at post time, never typed in by
//                  hand. Must be a real Date field, not text, for the
//                  IS_AFTER(...) formula below to work.)
const AIRTABLE_ANNOUNCEMENTS_TABLE_NAME = process.env.AIRTABLE_ANNOUNCEMENTS_TABLE_NAME || 'TeachersAnnouncements';
const AIRTABLE_ANNOUNCEMENTS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_ANNOUNCEMENTS_TABLE_NAME)}`;

// The fixed duration slots the edit-profile page lets a teacher pick
// from. Kept as a whitelist here (not just validated client-side) so
// a tampered request can't set an arbitrary/huge duration.
const ANNOUNCEMENT_DURATIONS_HOURS = [12, 18, 24, 30, 36, 42, 48];
const ANNOUNCEMENT_MAX_WORDS = 150;
const ANNOUNCEMENT_MAX_TEXT_CHARS = 1500; // generous backstop alongside the word-count check below

function countWords(str) {
  const trimmed = String(str || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function toPublicAnnouncement(record) {
  const f = record.fields || {};
  return {
    id: record.id,
    teacherName: f.TeacherName || '',
    course: f.Course || '',
    imageUrl: f.ImageURL || '',
    text: f.Text || '',
    buttonText: f.ButtonText || '',
    buttonLink: f.ButtonLink || '',
    durationHours: f.DurationHours || null,
    expiresAt: f.ExpiresAt || null
  };
}

// Shared by every announcement route below: confirms there's a
// logged-in session AND that the account's Type is "teacher". On
// failure it sends the error response itself and returns null, so
// callers just do `const teacher = await requireTeacherRecord(req,
// res); if (!teacher) return;`. On success it returns the fetched
// record so callers don't need to look it up a second time.
async function requireTeacherRecord(req, res) {
  if (!req.sessionUserId) {
    res.status(401).json({ error: 'Please log in to manage announcements.' });
    return null;
  }
  const record = await fetchUserRecord(req.sessionUserId);
  if (!record || !record.fields) {
    res.status(401).json({ error: 'Please log in to manage announcements.' });
    return null;
  }
  if (record.fields.Type !== 'teacher') {
    res.status(403).json({ error: 'Only teacher accounts can post announcements.' });
    return null;
  }
  return record;
}

// GET /api/my-announcement - the teacher's own current announcement
// (even if already expired), so edit-profile.html can show what's
// live, prefill the form for editing, or show "no announcement yet".
app.get('/api/my-announcement', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Announcements are not configured yet.' });
  }
  const teacher = await requireTeacherRecord(req, res);
  if (!teacher) return;

  try {
    const params = new URLSearchParams({
      filterByFormula: `{TeacherId}='${teacher.id}'`,
      maxRecords: '1'
    });
    const listRes = await fetch(`${AIRTABLE_ANNOUNCEMENTS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!listRes.ok) {
      const errText = await listRes.text();
      console.error('Airtable my-announcement lookup failed:', errText);
      return res.status(502).json({ error: 'Failed to load your announcement. Please try again.' });
    }
    const data = await listRes.json();
    const record = data.records && data.records[0];
    if (!record) return res.json({ announcement: null });

    const expired = !record.fields.ExpiresAt || new Date(record.fields.ExpiresAt).getTime() <= Date.now();
    res.json({ announcement: toPublicAnnouncement(record), expired });
  } catch (err) {
    console.error('My-announcement error:', err);
    res.status(500).json({ error: 'Failed to load your announcement. Please try again.' });
  }
});

// POST /api/announcements - create or replace the logged-in
// teacher's announcement. Body: {imageUrl, text, buttonText,
// buttonLink, durationHours}. Course is taken from the teacher's own
// account, never from the request body - a teacher can only ever
// post into their own course's listing page.
app.post('/api/announcements', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Announcements are not configured yet.' });
  }
  const teacher = await requireTeacherRecord(req, res);
  if (!teacher) return;

  const body = req.body || {};
  const imageUrl = cleanStr(body.imageUrl, 500);
  const text = cleanStr(body.text, ANNOUNCEMENT_MAX_TEXT_CHARS);
  const buttonText = cleanStr(body.buttonText, 40);
  const buttonLink = cleanStr(body.buttonLink, 300);
  const durationHours = Number(body.durationHours);

  if (!imageUrl) {
    return res.status(400).json({ error: 'Please add an image for your announcement.' });
  }
  if (!text) {
    return res.status(400).json({ error: 'Please add some text for your announcement.' });
  }
  if (countWords(text) > ANNOUNCEMENT_MAX_WORDS) {
    return res.status(400).json({ error: `Please keep your announcement text to ${ANNOUNCEMENT_MAX_WORDS} words or fewer.` });
  }
  if (!buttonText) {
    return res.status(400).json({ error: 'Please add text for your button.' });
  }
  if (!buttonLink) {
    return res.status(400).json({ error: 'Please add a link for your button.' });
  }
  if (!ANNOUNCEMENT_DURATIONS_HOURS.includes(durationHours)) {
    return res.status(400).json({ error: 'Please choose a valid duration.' });
  }

  const courseId = normalizeCourseId(teacher.fields.Course);
  const expiresAt = new Date(Date.now() + durationHours * 60 * 60 * 1000).toISOString();

  const fields = {
    TeacherId: teacher.id,
    TeacherName: teacher.fields.Name || '',
    Course: courseId,
    ImageURL: imageUrl,
    Text: text,
    ButtonText: buttonText,
    ButtonLink: buttonLink,
    DurationHours: durationHours,
    ExpiresAt: expiresAt
  };

  try {
    // Replace any existing announcement from this teacher rather than
    // letting them pile up - look for one first.
    const findParams = new URLSearchParams({
      filterByFormula: `{TeacherId}='${teacher.id}'`,
      maxRecords: '1'
    });
    const findRes = await fetch(`${AIRTABLE_ANNOUNCEMENTS_URL}?${findParams.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    const findData = findRes.ok ? await findRes.json() : { records: [] };
    const existing = findData.records && findData.records[0];

    const saveRes = existing
      ? await fetch(`${AIRTABLE_ANNOUNCEMENTS_URL}/${encodeURIComponent(existing.id)}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields })
        })
      : await fetch(AIRTABLE_ANNOUNCEMENTS_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ fields })
        });

    if (!saveRes.ok) {
      const errText = await saveRes.text();
      console.error('Airtable announcement save failed:', errText);
      return res.status(502).json({ error: "Couldn't save your announcement, please try again." });
    }
    const record = await saveRes.json();
    res.json({ ok: true, announcement: toPublicAnnouncement(record) });
  } catch (err) {
    console.error('Announcement save error:', err);
    res.status(500).json({ error: "Couldn't save your announcement, please try again." });
  }
});

// DELETE /api/announcements - lets a teacher take their announcement
// down early, before its duration runs out.
app.delete('/api/announcements', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Announcements are not configured yet.' });
  }
  const teacher = await requireTeacherRecord(req, res);
  if (!teacher) return;

  try {
    const params = new URLSearchParams({
      filterByFormula: `{TeacherId}='${teacher.id}'`,
      maxRecords: '1'
    });
    const findRes = await fetch(`${AIRTABLE_ANNOUNCEMENTS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!findRes.ok) {
      return res.status(502).json({ error: "Couldn't remove your announcement, please try again." });
    }
    const data = await findRes.json();
    const existing = data.records && data.records[0];
    if (!existing) return res.json({ ok: true });

    const delRes = await fetch(`${AIRTABLE_ANNOUNCEMENTS_URL}/${encodeURIComponent(existing.id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!delRes.ok) {
      const errText = await delRes.text();
      console.error('Airtable announcement delete failed:', errText);
      return res.status(502).json({ error: "Couldn't remove your announcement, please try again." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('Announcement delete error:', err);
    res.status(500).json({ error: "Couldn't remove your announcement, please try again." });
  }
});

// GET /api/announcements?course=jp|kr - public, no auth needed. Only
// ever returns announcements that haven't expired yet - the NOW()
// comparison happens inside the Airtable formula itself, so an
// expired row never even crosses the wire. Used by
// japanese-teachers.html / korean-teachers.html's "Announcements"
// section.
app.get('/api/announcements', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Announcements are not configured yet.' });
  }
  const courseId = normalizeCourseId(req.query.course);

  try {
    const filterByFormula = `AND({Course}='${courseId}', IS_AFTER({ExpiresAt}, NOW()))`;
    const params = new URLSearchParams({
      filterByFormula,
      pageSize: '100',
      'sort[0][field]': 'ExpiresAt',
      'sort[0][direction]': 'desc'
    });
    const listRes = await fetch(`${AIRTABLE_ANNOUNCEMENTS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!listRes.ok) {
      const errText = await listRes.text();
      console.error('Airtable announcements list failed:', errText);
      return res.status(502).json({ error: 'Failed to load announcements. Please try again.' });
    }
    const data = await listRes.json();
    const announcements = (data.records || []).map(toPublicAnnouncement);
    res.json({ announcements });
  } catch (err) {
    console.error('Announcements list error:', err);
    res.status(500).json({ error: 'Failed to load announcements. Please try again.' });
  }
});

// PROTECTED LESSON FILES
// Lesson HTML lives outside /public (in each course's own directory
// - see COURSES above) so it can only ever be reached through this
// route, which checks that course's unlock cookie first, then (new)
// falls back to an Approved account for that course.
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

// CLEAN PROFILE URLS - /u/priya-142 instead of
// /profile.html?id=recXXXXXXXXXXXXXX&type=teacher. This route just
// serves the same profile.html shell; profile.html's own script
// reads the slug back out of the URL path and calls
// /api/directory?slug=... itself (see the matching change there).
// Kept under /u/ rather than the bare root so it can never collide
// with /api, /lesson, static assets, or any other top-level route.
app.get('/u/:slug', (req, res) => {
  const slug = String(req.params.slug || '').trim().toLowerCase();
  if (!PROFILE_SLUG_RE.test(slug)) {
    return res.redirect('/');
  }
  res.sendFile(path.join(__dirname, 'public', 'profile.html'));
});

// Catch-all: serve index.html for any unknown route (SPA behavior).
// Using app.use (not app.get('*', ...)) here on purpose - Express 5
// changed wildcard route-string syntax, and a plain middleware
// catch-all works the same way on both Express 4 and 5.
app.use((req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hookit server running on port ${PORT}`);
});
