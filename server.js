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

  // Lock the certificate name onto the order right now, at the one moment
  // we've just cryptographically confirmed this payment is real. From here
  // on, /api/certificate always prints THIS name — never whatever a later
  // request happens to pass in — so a valid or leaked paymentId can't be
  // reused to print a different name.
  try {
    const order = await razorpay.orders.fetch(orderId);
    const safeName = String(name || '').slice(0, 80).trim();
    await razorpay.orders.edit(orderId, {
      notes: { ...(order.notes || {}), certName: safeName }
    });
  } catch (err) {
    console.error('Failed to lock certificate name on order:', err);
    // Don't fail the whole verification over this — the certificate
    // endpoint falls back to a generic name if certName never got set.
  }

  res.json({ verified: true, paymentId });
});

// Certificate PDF — no database needed. Razorpay is the single source of
// truth: we ask Razorpay directly whether this exact payment was captured,
// for the exact certificate price, and tagged for this exact course's
// purpose. The PDF bytes do not exist anywhere until all checks pass.
const CERT_PRICE_PAISE = 9900; // ₹99 — keep in sync with the frontend

// Server-controlled whitelist — a payment for one course's certificate can
// never unlock a different course's certificate, because the purpose tag
// (set at order-creation time, before payment) is course-specific and is
// checked against this exact list, not against whatever the client sends.
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
  }
};

// Caps how many times one payment can be redeemed for a PDF. In-memory, so
// it resets on a server restart — that's an acceptable grace window here,
// since it can only ever grant a few extra downloads of something someone
// already legitimately paid for, never a free one. If you later run
// multiple server instances behind a load balancer, move this to Redis or
// a small DB table so the count is shared across instances.
const MAX_CERT_DOWNLOADS = 3;
const certDownloadCounts = new Map();

app.get('/api/certificate', async (req, res) => {
  const { paymentId, name, course } = req.query;

  if (!paymentId || !course || !CERT_COURSES[course]) {
    return res.status(400).json({ error: 'Missing or invalid parameters' });
  }

  try {
    const payment = await razorpay.payments.fetch(paymentId);

    const basicsOk =
      payment &&
      payment.status === 'captured' &&
      payment.currency === 'INR' &&
      payment.amount === CERT_PRICE_PAISE &&
      payment.order_id;

    if (!basicsOk) {
      return res.status(403).json({ error: 'No verified certificate payment found for this ID' });
    }

    // The purpose tag was set on the ORDER at creation time, before payment —
    // Razorpay does not copy order notes onto the payment entity, so we must
    // check the order's notes here, not payment.notes (which is always empty).
    const order = await razorpay.orders.fetch(payment.order_id);
    const isValid = order && order.notes && order.notes.purpose === `certificate-${course}`;

    if (!isValid) {
      return res.status(403).json({ error: 'No verified certificate payment found for this ID' });
    }

    const downloadsSoFar = certDownloadCounts.get(paymentId) || 0;
    if (downloadsSoFar >= MAX_CERT_DOWNLOADS) {
      return res.status(429).json({ error: 'This certificate has already been downloaded the maximum number of times. Contact support if you need another copy.' });
    }

    // The name itself comes from what was locked onto the order at verified
    // payment time — never from this request's query string — so a valid
    // paymentId can't be replayed with a different name. Control characters
    // are stripped for safety; the font below covers Latin, Hangul, and
    // most other scripts, so we no longer need to strip non-Latin text.
    const rawName = String(order.notes.certName || name || '').slice(0, 80).trim();
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
          .text(`Issued ${new Date().toLocaleDateString()}  ·  Payment ID: ${paymentId}`, { align: 'center' });

        doc.end();
      } catch (drawErr) {
        reject(drawErr);
      }
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="hookitlingo-${course}-certificate.pdf"`);
    res.setHeader('Content-Length', pdfBuffer.length);
    res.end(pdfBuffer);

    certDownloadCounts.set(paymentId, downloadsSoFar + 1);

  } catch (err) {
    console.error('Certificate generation failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to verify payment or generate certificate' });
    }
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