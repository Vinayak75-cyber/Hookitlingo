const express = require('express');
const Razorpay = require('razorpay');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const PDFDocument = require('pdfkit');
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

// Catch-all: serve index.html for any unknown route (SPA behavior)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Hookitlingo server running on port ${PORT}`);
});