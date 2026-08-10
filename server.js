const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Certificates need to render Hangul (and, for some courses, mixed Latin
// text). pdfkit's built-in fonts only cover WinAnsi/Latin-1, so Korean
// characters would come out as garbled mojibake without this. Loaded once
// at startup and reused per request, rather than re-reading the ~10MB file
// from disk on every certificate download.
const CERT_FONT = fs.readFileSync(path.join(__dirname, 'fonts', 'NotoSansKR.ttf'));

const app = express();

// Only your own frontend(s) may call this API from a browser. Set
// ALLOWED_ORIGINS in your environment to a comma-separated list of the
// domains you actually serve the site from, e.g.:
//   ALLOWED_ORIGINS=https://hookitlingo.com,https://www.hookitlingo.com
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:3000')
  .split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin: function (origin, callback) {
    // Requests with no Origin header (server-to-server, curl, Razorpay
    // webhooks) aren't browser-based CORS requests — let them through.
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    return callback(new Error('Not allowed by CORS'));
  }
}));
app.use(express.json());

// Serve static files from /public
app.use(express.static(path.join(__dirname, 'public')));

// Initialize Razorpay
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET_KEY
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Create order — locks amount, prevents tampering
app.post('/api/create-order', async (req, res) => {
  const { amount, purpose } = req.body; // amount in paise; purpose e.g. 'certificate'
  
  if (!amount || amount < 100) { // minimum ₹1
    return res.status(400).json({ error: 'Invalid amount' });
  }
  
  try {
    const order = await razorpay.orders.create({
      amount: amount,
      currency: 'INR',
      receipt: 'hkl_' + Date.now(),
      notes: purpose ? { purpose } : undefined
    });
    
    res.json({
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error('Order creation failed:', err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

// Verify payment signature — prevents fake success
app.post('/api/verify-payment', async (req, res) => {
  const crypto = require('crypto');
  const { orderId, paymentId, signature, name } = req.body;
  
  if (!orderId || !paymentId || !signature) {
    return res.status(400).json({ error: 'Missing parameters' });
  }
  
  const body = orderId + '|' + paymentId;
  const expected = crypto
    .createHmac('sha256', process.env.RAZORPAY_SECRET_KEY)
    .update(body)
    .digest('hex');
  
  if (expected !== signature) {
    return res.status(400).json({ verified: false, error: 'Invalid signature' });
  }

  res.json({ verified: true, paymentId });
});

// Certificate PDF — free for everyone, no payment required. Still
// server-generated (not a static file) so the learner's name and course
// are always filled in correctly.
const CERT_COURSES = {
  hanlingo: {
    name: 'Hangeul',
    description: 'the Hangeul interactive beginner course, demonstrating the ability to read, pronounce, and write the Korean alphabet.'
  },
  grammar: {
    name: 'Korean Grammar Part 1: Sentence Building',
    description: 'Korean Grammar Part 1: Sentence Building (SOV + Predicates), demonstrating the ability to build, question, and negate basic Korean sentences unaided.'
  },
  numbers: {
    name: 'Korean Grammar Part 3: Numbers, Counters & Time',
    description: 'Korean Grammar Part 3: Numbers, Counters & Time, demonstrating fluent, correct use of both Sino-Korean and Native Korean number systems, counter words, telling time, dates, and money.'
  },
  particles: {
    name: 'Korean Grammar Part 2: Particles',
    description: 'Korean Grammar Part 2: Particles, demonstrating fluent, correct use of 이/가, 은/는, 을/를, 에, 에서, 도, and 만 in original sentences.'
  },
  verbs: {
    name: 'Verb Tenses & Conjugation',
    description: "Verb Tenses & Conjugation, demonstrating fluent, correct use of present, past, and future tense, negation, and Korean's major irregular verb patterns."
  },
  kana: {
    name: 'Kana Foundations',
    description: 'the Kana Foundations course, mastering hiragana, katakana, and their sound modifiers.'
  }
};

app.get('/api/certificate', async (req, res) => {
  const { name, course } = req.query;

  if (!course || !CERT_COURSES[course]) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }

  try {
    // Name comes straight from the request now — there's no payment to
    // lock it against. Control characters are stripped for safety; the
    // font below covers Latin, Hangul, and most other scripts.
    const rawName = String(name || '').slice(0, 80).trim();
    const safeName = rawName.replace(/[\x00-\x1F\x7F]/g, '').trim() || 'Hookitlingo Learner';
    const courseInfo = CERT_COURSES[course];

    // Generate fully in memory first — nothing is sent to the browser until
    // the whole document is built without error, so a failure here can never
    // reach the client as a half-written, unopenable file.
    const pdfBuffer = await new Promise((resolve, reject) => {
      const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 50 });
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      try {
        doc.registerFont('NotoKR', CERT_FONT);
        doc.font('NotoKR');

        doc.rect(24, 24, doc.page.width - 48, doc.page.height - 48).lineWidth(2).stroke('#c8546f');
        doc.rect(34, 34, doc.page.width - 68, doc.page.height - 68).lineWidth(0.75).stroke('#d9ab5c');

        doc.fontSize(12).fillColor('#8f7a91')
          .text(`HOOKITLINGO  ·  ${courseInfo.name.toUpperCase()}`, 50, 70, { align: 'center', width: doc.page.width - 100 });

        doc.moveDown(1.4);
        doc.fontSize(30).fillColor('#1c1420')
          .text('Certificate of Completion', { align: 'center' });

        doc.moveDown(1.2);
        doc.fontSize(14).fillColor('#3a2530').text('This certifies that', { align: 'center' });

        doc.moveDown(0.5);
        doc.fontSize(28).fillColor('#c8546f').text(safeName, { align: 'center' });

        doc.moveDown(1);
        doc.fontSize(13).fillColor('#3a2530').text(
          `has successfully completed ${courseInfo.description}`,
          { align: 'center', width: doc.page.width - 200 }
        );

        doc.moveDown(2.5);
        doc.fontSize(10).fillColor('#8f7a91')
          .text(`Issued ${new Date().toLocaleDateString()}`, { align: 'center' });

        doc.end();
      } catch (drawErr) {
        reject(drawErr);
      }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="hookitlingo-${course}-certificate.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);

  } catch (err) {
    console.error('Certificate generation failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to generate certificate' });
    }
  }
});

// Workbook unlock check — same "ask Razorpay directly" pattern as the
// certificate above, but there's no file to generate here: this just
// answers yes/no on whether a given paymentId legitimately paid for a
// given workbook, so the frontend knows it's safe to remove the page
// lock. Because it's a pure check (not a download), it isn't rate-limited
// the way certificate downloads are — the frontend calls it on every
// page load to re-verify before showing unlocked content.
//
// Server-controlled whitelist — same idea as CERT_COURSES: a payment for
// one workbook's purpose tag can never unlock a different workbook,
// because the purpose is set on the order before payment and checked
// against this exact list, not against whatever the client sends. New
// workbooks (e.g. a future verbs workbook) just add a line here.
const WORKBOOK_PRICE_PAISE = 9900; // ₹99 — keep in sync with each workbook's frontend
const WORKBOOK_PRODUCTS = {
  hanlingo: { purpose: 'workbook-hanlingo' },
  numbers: { purpose: 'workbook-numbers' },
  particles: { purpose: 'workbook-particles' },
  grammar: { purpose: 'workbook-grammar' },
  verbs: { purpose: 'workbook-verbs' }
};

app.get('/api/workbook-access', async (req, res) => {
  const { paymentId } = req.query;
  // Defaults to 'hanlingo' so the original workbook.html (which predates
  // this whitelist and doesn't send a product param) keeps working.
  const product = req.query.product || 'hanlingo';

  if (!paymentId) {
    return res.status(400).json({ unlocked: false, error: 'Missing paymentId' });
  }
  if (!WORKBOOK_PRODUCTS[product]) {
    return res.status(400).json({ unlocked: false, error: 'Unknown workbook product' });
  }

  try {
    const payment = await razorpay.payments.fetch(paymentId);

    const basicsOk =
      payment &&
      payment.status === 'captured' &&
      payment.currency === 'INR' &&
      payment.amount === WORKBOOK_PRICE_PAISE &&
      payment.order_id;

    if (!basicsOk) {
      return res.status(403).json({ unlocked: false, error: 'No verified workbook payment found for this ID' });
    }

    // As with the certificate, the purpose tag lives on the order (set
    // at creation time, before payment) — this is what stops a payment
    // for one product from unlocking a different one.
    const order = await razorpay.orders.fetch(payment.order_id);
    const isValid = order && order.notes && order.notes.purpose === WORKBOOK_PRODUCTS[product].purpose;

    if (!isValid) {
      return res.status(403).json({ unlocked: false, error: 'No verified workbook payment found for this ID' });
    }

    res.json({ unlocked: true });
  } catch (err) {
    console.error('Workbook access check failed:', err);
    res.status(500).json({ unlocked: false, error: 'Failed to verify payment' });
  }
});

// ============================================================
// FEEDBACK — stored in Airtable, not a database we run ourselves.
// Airtable is the single source of truth here, same spirit as
// using Razorpay directly for payments above: no local file, no
// disk dependency, nothing to lose on a Render restart/redeploy.
//
// Requires three env vars (see .env / Render dashboard):
//   AIRTABLE_API_KEY   — Personal Access Token from airtable.com
//   AIRTABLE_BASE_ID   — the base's ID (starts with "app...")
//   AIRTABLE_TABLE_NAME — e.g. "Feedback"
// ============================================================
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_TABLE_NAME = process.env.AIRTABLE_TABLE_NAME || 'Feedback';
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_TABLE_NAME)}`;

// Very small in-memory rate limiter — best-effort only (resets on
// restart), same tradeoff already accepted for certDownloadCounts
// above. Purpose here is just to blunt naive spam bots, not to be
// airtight; Airtable itself is the durable store either way.
const feedbackRateLimit = new Map(); // ip -> [timestamps]
const FEEDBACK_MAX_PER_HOUR = 5;

function isRateLimited(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const hits = (feedbackRateLimit.get(ip) || []).filter(t => t > hourAgo);
  hits.push(now);
  feedbackRateLimit.set(ip, hits);
  return hits.length > FEEDBACK_MAX_PER_HOUR;
}

// ============================================================
// SUPPORTER WALL — reads from a second Airtable table ("Supporters"
// by default). Entries are added by hand in the Airtable UI for now
// (each sale's name/tier/message copied over from the Gumroad sale
// notification + their custom-field answers) — no POST endpoint
// here on purpose, since write access stays manual until/unless a
// Gumroad webhook is wired up later. Same base/API key as Feedback,
// just a different table.
//   AIRTABLE_SUPPORTERS_TABLE_NAME — e.g. "Supporters" (optional,
//   defaults to "Supporters")
// ============================================================
const AIRTABLE_SUPPORTERS_TABLE_NAME = process.env.AIRTABLE_SUPPORTERS_TABLE_NAME || 'Supporters';
const AIRTABLE_SUPPORTERS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_SUPPORTERS_TABLE_NAME)}`;

app.get('/api/supporters', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Supporter wall storage is not configured yet.' });
  }
  try {
    const url = `${AIRTABLE_SUPPORTERS_URL}?pageSize=100&sort[0][field]=Created&sort[0][direction]=desc`;
    const airtableRes = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      console.error('Airtable supporters list failed:', errText);
      return res.status(502).json({ error: 'Failed to load supporters' });
    }
    const data = await airtableRes.json();
    const items = (data.records || []).map(r => ({
      id: r.id,
      name: r.fields.Name || 'A Supporter',
      tier: (r.fields.Tier || 'supporter').toLowerCase(), // "supporter" | "founding" | "patron"
      message: r.fields.Message || '',
      created: r.fields.Created || r.createdTime
    }));
    res.json({ items });
  } catch (err) {
    console.error('Supporters list error:', err);
    res.status(500).json({ error: 'Failed to load supporters' });
  }
});

// ============================================================
// JLPT LICENSE KEY UNLOCK (manual key distribution model)
//
// Flow this supports (decided deliberately over the Payhip-API
// or auto-email route): keys are pre-generated in bulk per
// product and sit in an Airtable table with a blank Email field.
// When a sale comes in on Payhip, the buyer's email is copied
// from the Payhip notification and hand-typed into an open row
// of the matching product's rows. There is NO endpoint here that
// lets a client attach an email to a key. That row is the only
// thing this endpoint ever checks.
//
// Seven Payhip products feed into the same table:
//   "N5 Access Key"      -> Plan = "n5"          (N5 only)
//   "N4 Access Key"      -> Plan = "n4"          (N4 only)
//   "N3 Access Key"      -> Plan = "n3"          (N3 only)
//   "N2 Access Key"      -> Plan = "n2"          (N2 only)
//   "N1 Access Key"      -> Plan = "n1"          (N1 only)
//   "N5-N3 Access Key"   -> Plan = "n5-n3"       (N5 through N3 bundle)
//   "N5-N1 Access Key"   -> Plan = "all-access"  (every JLPT level)
//
// Requires (in addition to AIRTABLE_API_KEY / AIRTABLE_BASE_ID
// above):
//   AIRTABLE_LICENSE_TABLE_NAME — e.g. "Keys" (optional, defaults
//     to "Keys")
//   JWT_SECRET — long random string, required. Without it this
//     whole feature refuses to run rather than sign tokens with a
//     guessable/empty secret.
//
// "Keys" table needs these fields:
//   Key             (text)      — the license key
//   Email           (email)     — filled in by hand per sale, blank until then
//   Plan            (text)      — one of VALID_PLANS below, set when the
//                                 batch of keys for that product is generated
//   RedemptionCount (number)    — how many times this key has been
//                                 successfully verified; used as a
//                                 soft device cap so a shared key
//                                 doesn't unlock unlimited devices
//   FirstRedeemed   (date/text) — set on first successful verify
// ============================================================
const AIRTABLE_LICENSE_TABLE_NAME = process.env.AIRTABLE_LICENSE_TABLE_NAME || 'Keys';
const AIRTABLE_LICENSE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_LICENSE_TABLE_NAME)}`;
const JWT_SECRET = process.env.JWT_SECRET;

// The only valid values for a key's Plan field. Anything else
// on a record is treated as misconfigured and rejected, rather
// than guessed at.
const VALID_PLANS = ['n5', 'n4', 'n3', 'n2', 'n1', 'n5-n3', 'all-access'];

// Which plan(s) unlock which course. "n5-n3" covers N5 through N3;
// "all-access" covers every current and future JLPT level by
// design, so new levels beyond N1 only need a line added here
// (and to LESSON_FILES further down).
const COURSE_PLAN_ACCESS = {
  'jlpt-n5': ['n5', 'n5-n3', 'all-access'],
  'jlpt-n4': ['n4', 'n5-n3', 'all-access'],
  'jlpt-n3': ['n3', 'n5-n3', 'all-access'],
  'jlpt-n2': ['n2', 'all-access'],
  'jlpt-n1': ['n1', 'all-access'],
};

const LICENSE_MAX_REDEMPTIONS = parseInt(process.env.LICENSE_MAX_REDEMPTIONS || '3', 10); // soft device cap
const LICENSE_TOKEN_TTL = '3650d'; // ~10 years, one-time purchase, not a subscription

// Same best-effort in-memory limiter pattern as Feedback/Early
// Access above. Kept deliberately tight here: this endpoint is a
// lookup against a small keyspace, so it's the one most worth
// throttling against brute-force guessing.
const licenseRateLimit = new Map();
const LICENSE_MAX_PER_HOUR = 10;
function isLicenseRateLimited(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const hits = (licenseRateLimit.get(ip) || []).filter(t => t > hourAgo);
  hits.push(now);
  licenseRateLimit.set(ip, hits);
  return hits.length > LICENSE_MAX_PER_HOUR;
}

app.post('/api/license/unlock', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'License storage is not configured yet.' });
  }
  if (!JWT_SECRET) {
    console.error('JWT_SECRET is not set — refusing to mint license tokens.');
    return res.status(500).json({ error: 'Unlock is not configured yet.' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isLicenseRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts — please try again later.' });
  }

  const { email, licenseKey } = req.body || {};
  const safeEmail = String(email || '').trim().slice(0, 200).toLowerCase();
  const safeKey = String(licenseKey || '').trim().slice(0, 100);

  if (!EMAIL_RE.test(safeEmail) || !safeKey) {
    return res.status(400).json({ error: 'Please enter a valid email and license key.' });
  }

  try {
    // Exact match on BOTH fields — a correct key with the wrong
    // email (or vice versa) is treated identically to a wrong key,
    // on purpose, so this can't be used to test whether an email
    // is registered at all.
    const escapedEmail = safeEmail.replace(/'/g, "\\'");
    const escapedKey = safeKey.replace(/'/g, "\\'");
    const records = await airtableListAll(
      AIRTABLE_LICENSE_URL,
      `AND(LOWER({Email})='${escapedEmail}', {Key}='${escapedKey}')`
    );

    if (records.length === 0) {
      return res.status(401).json({ error: 'Invalid email or license key.' });
    }

    const record = records[0];
    const plan = record.fields.Plan;

    if (!VALID_PLANS.includes(plan)) {
      console.error(`License record ${record.id} has an invalid or missing Plan field: ${plan}`);
      return res.status(500).json({ error: 'This key is not set up correctly yet. Please contact us.' });
    }

    const redemptionCount = Number(record.fields.RedemptionCount || 0);

    if (redemptionCount >= LICENSE_MAX_REDEMPTIONS) {
      return res.status(403).json({
        error: 'This key has reached its device limit. Contact us if you need another activation.'
      });
    }

    // Best-effort increment — a rare race between two near-simultaneous
    // requests could under-count by one, which only ever makes the cap
    // slightly more permissive, never less. Acceptable for a soft cap
    // enforced against a small, manually-distributed keyspace.
    const patchRes = await fetch(`${AIRTABLE_LICENSE_URL}/${record.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          RedemptionCount: redemptionCount + 1,
          FirstRedeemed: record.fields.FirstRedeemed || new Date().toISOString()
        }
      })
    });
    if (!patchRes.ok) {
      const errText = await patchRes.text();
      console.error('Airtable license redemption update failed:', errText);
      // Don't block the buyer over a bookkeeping write failing —
      // still issue the token, just log it for manual follow-up.
    }

    const token = jwt.sign(
      { email: safeEmail, kid: record.id, plan },
      JWT_SECRET,
      { expiresIn: LICENSE_TOKEN_TTL }
    );

    res.json({ success: true, token, plan });
  } catch (err) {
    console.error('License unlock error:', err);
    res.status(500).json({ error: 'Something went wrong verifying your key. Please try again.' });
  }
});

// ============================================================
// PROTECTED LESSON DELIVERY (all JLPT levels)
//
// Paid lesson HTML files must live outside /public (this repo
// keeps them in /protected) so they are never reachable by a
// direct static URL. This route is the ONLY way to reach them,
// and it always re-checks the JWT server-side. A tampered
// "unlocked" state in the browser's devtools cannot produce real
// content here; only a token this server itself signed can.
//
// Slugs are resolved through this whitelist rather than trusting
// the URL directly, the same pattern already used for
// CERT_COURSES / WORKBOOK_PRODUCTS above. This is what actually
// blocks path traversal (e.g. "../../.env"), not just validation.
// Add a line here whenever a new paid lesson goes live, and add a
// new top-level key (e.g. "jlpt-n4": {...}) once that course
// launches. COURSE_PLAN_ACCESS above already knows an all-access
// key should unlock it; this map just needs the actual filenames.
// ============================================================
const PROTECTED_DIR = path.join(__dirname, 'protected');
const LESSON_FILES = {
  'jlpt-n5': {
    's03-l01': 'jlpt-n5-s03-l01.html',
    's04-l01': 'jlpt-n5-s04-l01.html',
    's04-l02': 'jlpt-n5-s04-l02.html',
    's05-l01': 'jlpt-n5-s05-l01.html',
    's06-l01': 'jlpt-n5-s06-l01.html',
    's07-l01': 'jlpt-n5-s07-l01.html',
    's08-l01': 'jlpt-n5-s08-l01.html',
    's08-l02': 'jlpt-n5-s08-l02.html',
    's09-l01': 'jlpt-n5-s09-l01.html',
    's10-l01': 'jlpt-n5-s10-l01.html',
    's11-l01': 'jlpt-n5-s11-l01.html',
    // s12-l01 and all of Section 13 go here once their status
    // flips from 'soon' to 'done' on the frontend.
  }
  // 'jlpt-n4': { ... } — add when N4 launches, filenames only.
};

app.get('/api/lesson/:course/:slug', (req, res) => {
  if (!JWT_SECRET) {
    console.error('JWT_SECRET is not set — refusing to serve protected lessons.');
    return res.status(500).json({ error: 'Lesson delivery is not configured yet.' });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) {
    return res.status(401).json({ error: 'Missing access token.' });
  }

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired access token.' });
  }

  const { course, slug } = req.params;
  const allowedPlans = COURSE_PLAN_ACCESS[course];
  if (!allowedPlans) {
    return res.status(404).json({ error: 'Course not found.' });
  }
  if (!allowedPlans.includes(payload.plan)) {
    return res.status(403).json({ error: 'Your plan does not include this course.' });
  }

  const courseFiles = LESSON_FILES[course];
  const filename = courseFiles && courseFiles[slug];
  if (!filename) {
    return res.status(404).json({ error: 'Lesson not found.' });
  }

  const filePath = path.join(PROTECTED_DIR, course, filename);
  res.set('Cache-Control', 'private, no-store');
  res.type('html');
  res.sendFile(filePath, (err) => {
    if (err) {
      console.error('Protected lesson send failed:', err);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to load lesson.' });
      }
    }
  });
});

// List feedback — newest first, capped so the page never has to
// deal with an unbounded response.
app.get('/api/feedback', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Feedback storage is not configured yet.' });
  }
  try {
    const url = `${AIRTABLE_URL}?pageSize=100&sort[0][field]=Created&sort[0][direction]=desc`;
    const airtableRes = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      console.error('Airtable list failed:', errText);
      return res.status(502).json({ error: 'Failed to load feedback' });
    }
    const data = await airtableRes.json();
    const items = (data.records || []).map(r => ({
      id: r.id,
      name: r.fields.Name || 'Anonymous',
      message: r.fields.Message || '',
      rating: r.fields.Rating || 5,
      created: r.fields.Created || r.createdTime
    }));
    res.json({ items });
  } catch (err) {
    console.error('Feedback list error:', err);
    res.status(500).json({ error: 'Failed to load feedback' });
  }
});

// Submit feedback — validated and size-capped before it ever
// reaches Airtable.
app.post('/api/feedback', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Feedback storage is not configured yet.' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many submissions — please try again later.' });
  }

  const { name, message, rating, hp } = req.body || {};

  // Honeypot: a real user never fills this hidden field; a bot
  // filling out every field usually will.
  if (hp) {
    return res.json({ ok: true }); // pretend success, do nothing
  }

  const safeName = String(name || '').trim().slice(0, 60) || 'Anonymous';
  const safeMessage = String(message || '').trim().slice(0, 600);
  const safeRating = Math.min(5, Math.max(1, parseInt(rating, 10) || 5));

  if (safeMessage.length < 3) {
    return res.status(400).json({ error: 'Please write a little more before submitting.' });
  }

  try {
    const airtableRes = await fetch(AIRTABLE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        records: [{
          fields: {
            Name: safeName,
            Message: safeMessage,
            Rating: safeRating,
            Created: new Date().toISOString()
          }
        }]
      })
    });

    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      console.error('Airtable create failed:', errText);
      return res.status(502).json({ error: 'Failed to save feedback' });
    }

    const data = await airtableRes.json();
    const rec = data.records[0];
    res.json({
      ok: true,
      item: {
        id: rec.id,
        name: rec.fields.Name,
        message: rec.fields.Message,
        rating: rec.fields.Rating,
        created: rec.fields.Created
      }
    });
  } catch (err) {
    console.error('Feedback submit error:', err);
    res.status(500).json({ error: 'Failed to save feedback' });
  }
});

// ============================================================
// EARLY ACCESS — tiered waitlist, same Airtable-as-source-of-truth
// pattern as Feedback/Supporters above. This is the pre-launch
// demand-validation mechanic: four price tiers ($50/$65/$80/$100),
// 500 spots each. Once a tier fills, new registrants are
// auto-bumped into the next open tier rather than rejected — the
// scarcity is real (spots genuinely run out) but nobody hits a
// dead end.
//
//   AIRTABLE_EARLY_ACCESS_TABLE_NAME — e.g. "EarlyAccess" (optional,
//   defaults to "EarlyAccess"). Same base/API key as Feedback.
//
// Table needs three fields: Email (text), Tier (text, one of the
// values in EARLY_ACCESS_TIERS below), Created (date/text).
// ============================================================
const AIRTABLE_EARLY_ACCESS_TABLE_NAME = process.env.AIRTABLE_EARLY_ACCESS_TABLE_NAME || 'EarlyAccess';
const AIRTABLE_EARLY_ACCESS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_EARLY_ACCESS_TABLE_NAME)}`;

// Ordered low-to-high — this order is also the bump order: if a
// registrant's chosen tier is full, they move to the next entry
// in this array, and so on until an open tier is found.
const EARLY_ACCESS_TIERS = ['50', '65', '80', '100'];
const EARLY_ACCESS_CAP = 500;

// Fetches every record from an Airtable table/view, following
// pagination automatically. Used for both the public counts
// endpoint and the duplicate-email check below. Capped at 50
// pages (5000 records) as a hard safety stop — well beyond
// anything this waitlist will ever hold (4 tiers x 500 cap).
async function airtableListAll(baseUrl, filterByFormula) {
  const records = [];
  let offset;
  let pages = 0;
  do {
    const params = new URLSearchParams({ pageSize: '100' });
    if (filterByFormula) params.set('filterByFormula', filterByFormula);
    if (offset) params.set('offset', offset);
    const res = await fetch(`${baseUrl}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Airtable list failed: ${errText}`);
    }
    const data = await res.json();
    records.push(...(data.records || []));
    offset = data.offset;
    pages++;
  } while (offset && pages < 50);
  return records;
}

// Short-lived in-memory cache for tier counts — best-effort only
// (resets on restart, same tradeoff already accepted elsewhere in
// this file), just here to stop the fill bars from re-fetching the
// whole table on every single page load.
let earlyAccessCountsCache = { data: null, fetchedAt: 0 };
const EARLY_ACCESS_COUNTS_TTL_MS = 15 * 1000;

async function getEarlyAccessCounts(forceRefresh) {
  const now = Date.now();
  if (!forceRefresh && earlyAccessCountsCache.data && (now - earlyAccessCountsCache.fetchedAt) < EARLY_ACCESS_COUNTS_TTL_MS) {
    return earlyAccessCountsCache.data;
  }
  const records = await airtableListAll(AIRTABLE_EARLY_ACCESS_URL);
  const counts = {};
  EARLY_ACCESS_TIERS.forEach(t => { counts[t] = 0; });
  for (const r of records) {
    const tier = r.fields && r.fields.Tier;
    if (tier && Object.prototype.hasOwnProperty.call(counts, tier)) {
      counts[tier]++;
    }
  }
  earlyAccessCountsCache = { data: counts, fetchedAt: now };
  return counts;
}

app.get('/api/early-access/counts', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Early access storage is not configured yet.' });
  }
  try {
    const counts = await getEarlyAccessCounts(false);
    res.json({ counts, cap: EARLY_ACCESS_CAP, tiers: EARLY_ACCESS_TIERS });
  } catch (err) {
    console.error('Early access counts error:', err);
    res.status(500).json({ error: 'Failed to load early access counts' });
  }
});

// Very small in-memory rate limiter — same best-effort spirit as
// the feedback one above.
const earlyAccessRateLimit = new Map();
const EARLY_ACCESS_MAX_PER_HOUR = 5;
function isEarlyAccessRateLimited(ip) {
  const now = Date.now();
  const hourAgo = now - 60 * 60 * 1000;
  const hits = (earlyAccessRateLimit.get(ip) || []).filter(t => t > hourAgo);
  hits.push(now);
  earlyAccessRateLimit.set(ip, hits);
  return hits.length > EARLY_ACCESS_MAX_PER_HOUR;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.post('/api/early-access', async (req, res) => {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return res.status(500).json({ error: 'Early access storage is not configured yet.' });
  }

  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  if (isEarlyAccessRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many attempts — please try again later.' });
  }

  const { email, tier, hp } = req.body || {};

  // Honeypot, same pattern as feedback.
  if (hp) {
    return res.json({ ok: true });
  }

  const safeEmail = String(email || '').trim().slice(0, 200).toLowerCase();
  if (!EMAIL_RE.test(safeEmail)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }
  if (!tier || !EARLY_ACCESS_TIERS.includes(String(tier))) {
    return res.status(400).json({ error: 'Please select a valid tier.' });
  }
  const requestedTier = String(tier);

  try {
    // Duplicate check — one registration per email, regardless of
    // tier, so someone can't game the fill bars by re-registering.
    const escapedEmail = safeEmail.replace(/'/g, "\\'");
    const existing = await airtableListAll(
      AIRTABLE_EARLY_ACCESS_URL,
      `LOWER({Email})='${escapedEmail}'`
    );
    if (existing.length > 0) {
      const existingTier = existing[0].fields && existing[0].fields.Tier;
      return res.status(409).json({
        error: `This email is already registered${existingTier ? ` in the $${existingTier} tier` : ''}.`
      });
    }

    // Bump logic: walk the tier order starting at the requested
    // tier; take the first one that isn't full yet.
    const counts = await getEarlyAccessCounts(true); // fresh read — this decision needs to be current
    const startIndex = EARLY_ACCESS_TIERS.indexOf(requestedTier);
    let assignedTier = null;
    for (let i = startIndex; i < EARLY_ACCESS_TIERS.length; i++) {
      const t = EARLY_ACCESS_TIERS[i];
      if ((counts[t] || 0) < EARLY_ACCESS_CAP) {
        assignedTier = t;
        break;
      }
    }

    if (!assignedTier) {
      return res.status(409).json({ error: 'All tiers are currently full. Please check back soon.' });
    }

    const airtableRes = await fetch(AIRTABLE_EARLY_ACCESS_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${AIRTABLE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        // typecast lets Airtable convert our string ("50") into
        // whatever type the Tier column actually is — Number,
        // Single Select, etc — instead of rejecting it outright.
        // Safe here because assignedTier only ever comes from the
        // EARLY_ACCESS_TIERS whitelist, never from user input directly.
        typecast: true,
        records: [{
          fields: {
            Email: safeEmail,
            Tier: assignedTier,
            Created: new Date().toISOString()
          }
        }]
      })
    });

    if (!airtableRes.ok) {
      const errText = await airtableRes.text();
      console.error('Airtable early-access create failed:', errText);
      return res.status(502).json({ error: 'Failed to save your registration' });
    }

    // Invalidate the cache so the very next counts fetch reflects
    // this registration immediately rather than waiting out the TTL.
    earlyAccessCountsCache = { data: null, fetchedAt: 0 };

    res.json({
      ok: true,
      tier: assignedTier,
      bumped: assignedTier !== requestedTier,
      requestedTier
    });
  } catch (err) {
    console.error('Early access register error:', err);
    res.status(500).json({ error: 'Failed to save your registration' });
  }
});

// Catch-all: serve index.html for any unknown route (SPA behavior)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hookitlingo server running on port ${PORT}`);
});