// routes/payment.js
// PayPal Checkout for the signup fee - order creation + capture.
// Mirrors the style of routes/upload.js: a small router mounted
// alongside the rest of the app in server.js.
//
// Requires these env vars (see .env.example / your host's dashboard):
//   PAYPAL_CLIENT_ID     - from your PayPal REST app (developer.paypal.com)
//   PAYPAL_CLIENT_SECRET - from the same REST app, keep this secret
//   PAYPAL_ENV           - "sandbox" or "live" (defaults to "sandbox")
//   AIRTABLE_SETTINGS_TABLE_NAME - defaults to "Settings"
// (AIRTABLE_API_KEY / AIRTABLE_BASE_ID are already set for the rest
// of the app in server.js and are reused here.)
//
// The signup PRICE itself is deliberately not an env var - it lives
// in Airtable (Settings table, SignupPriceUSD field) so it can be
// changed at any time, by anyone who can edit the base, with no
// redeploy. See getSignupPrice() below.
//
// IMPORTANT: the browser never gets to say how much to charge. The
// amount is always looked up server-side, both when the order is
// created AND re-verified independently before /api/signup (in
// server.js) ever writes a row to Airtable.

const express = require('express');
const router = express.Router();

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_ENV = (process.env.PAYPAL_ENV || 'sandbox').toLowerCase();
const PAYPAL_API_BASE = PAYPAL_ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_SETTINGS_TABLE_NAME = process.env.AIRTABLE_SETTINGS_TABLE_NAME || 'Settings';
const AIRTABLE_SETTINGS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_SETTINGS_TABLE_NAME)}`;
const AIRTABLE_COUPONS_TABLE_NAME = process.env.AIRTABLE_COUPONS_TABLE_NAME || 'Coupons';
const AIRTABLE_COUPONS_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(AIRTABLE_COUPONS_TABLE_NAME)}`;

// Used only if Airtable has no Settings row yet, or is briefly
// unreachable - so checkout never hard-fails just because someone
// hasn't created the row yet.
const DEFAULT_SIGNUP_PRICE_USD = 9.99;

// Flat fee added on top of the (possibly discounted) item price for
// every PAID transaction. Not an env var on purpose - same reasoning
// as DEFAULT_SIGNUP_PRICE_USD staying out of the price lookup: this
// is cheap enough to just edit here and redeploy if it ever changes.
const PROCESSING_FEE_USD = 0.99;

// SIGNUP PRICE - read from Airtable so you can change it any time
// without touching code or redeploying.
//
// Add a "Settings" table to your Airtable base with ONE row and a
// Number field called:
//   SignupPriceUSD  (Number, e.g. 9.99)
// Whatever that field says is what gets charged on the next
// checkout (cached for 60s so every button click doesn't hit
// Airtable).
let priceCache = { value: null, at: 0 };
const PRICE_CACHE_MS = 60 * 1000;

async function getSignupPrice() {
  const now = Date.now();
  if (priceCache.value !== null && (now - priceCache.at) < PRICE_CACHE_MS) {
    return priceCache.value;
  }
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) {
    return DEFAULT_SIGNUP_PRICE_USD;
  }
  try {
    const params = new URLSearchParams({ maxRecords: '1' });
    const res = await fetch(`${AIRTABLE_SETTINGS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!res.ok) {
      console.error('getSignupPrice: Airtable read failed:', await res.text());
      return priceCache.value !== null ? priceCache.value : DEFAULT_SIGNUP_PRICE_USD;
    }
    const data = await res.json();
    const row = data.records && data.records[0];
    const raw = row && row.fields && row.fields.SignupPriceUSD;
    const price = Number(raw);
    const value = (Number.isFinite(price) && price > 0) ? price : DEFAULT_SIGNUP_PRICE_USD;
    priceCache = { value, at: now };
    return value;
  } catch (err) {
    console.error('getSignupPrice error:', err);
    return priceCache.value !== null ? priceCache.value : DEFAULT_SIGNUP_PRICE_USD;
  }
}

// COUPONS - read from Airtable so codes can be created/disabled any
// time without touching code or redeploying, same philosophy as
// getSignupPrice() above.
//
// Add a "Coupons" table to your Airtable base with one row per code:
//   Code           (Single line text - e.g. "LAUNCH50")
//   DiscountType   (Single select: "percent" or "fixed")
//   DiscountValue  (Number - e.g. 20 for 20% off, or 5 for $5 off)
//   Active         (Checkbox - flip off to disable a code instantly)
//
// A coupon is looked up fresh on every call (no cache, unlike the
// price) since codes are applied one at a time and get checked at
// most a few times per signup - not worth the staleness risk of a
// 60s cache here.
async function getCoupon(rawCode) {
  const code = String(rawCode || '').trim();
  if (!code) return null;
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return null;

  const escaped = code.replace(/'/g, "\\'");
  try {
    const params = new URLSearchParams({
      filterByFormula: `AND(UPPER({Code})=UPPER('${escaped}'), {Active}=1)`,
      maxRecords: '1'
    });
    const res = await fetch(`${AIRTABLE_COUPONS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    if (!res.ok) {
      console.error('getCoupon: Airtable read failed:', await res.text());
      return null;
    }
    const data = await res.json();
    const row = data.records && data.records[0];
    if (!row) return null;

    const fields = row.fields || {};
    const discountType = String(fields.DiscountType || '').toLowerCase() === 'fixed' ? 'fixed' : 'percent';
    const rawValue = Number(fields.DiscountValue);
    const discountValue = (Number.isFinite(rawValue) && rawValue >= 0) ? rawValue : 0;
    return { code: code.toUpperCase(), discountType, discountValue };
  } catch (err) {
    console.error('getCoupon error:', err);
    return null;
  }
}

// Applies a coupon (percent or fixed) to a base price. Never goes
// below $0 - a fixed-amount coupon bigger than the price just zeroes
// it out rather than going negative.
function applyCouponDiscount(basePrice, coupon) {
  if (!coupon) return basePrice;
  const raw = coupon.discountType === 'fixed'
    ? basePrice - coupon.discountValue
    : basePrice - (basePrice * (coupon.discountValue / 100));
  return Math.round(Math.max(0, raw) * 100) / 100;
}

// computeOrderTotal - the single source of truth for what a signup
// actually costs, given an optional coupon code. Called fresh, from
// scratch, every time an amount matters (create-order, /api/signup,
// and the coupon-preview endpoint below) - nothing about price ever
// comes from the client.
//
// The $0.99 processing fee applies to every PAID transaction. If a
// coupon brings the item price itself to $0, the fee is waived too
// and the whole thing becomes a free signup that skips PayPal
// entirely (free: true) - see /api/signup in server.js.
async function computeOrderTotal(rawCouponCode) {
  const couponCode = String(rawCouponCode || '').trim();
  const basePrice = await getSignupPrice();

  let coupon = null;
  if (couponCode) {
    coupon = await getCoupon(couponCode);
    if (!coupon) {
      return { error: 'That coupon code is invalid or has expired.' };
    }
  }

  const itemPrice = applyCouponDiscount(basePrice, coupon);
  const free = itemPrice <= 0;
  const fee = free ? 0 : PROCESSING_FEE_USD;
  const total = Math.round((itemPrice + fee) * 100) / 100;

  return { basePrice, coupon, itemPrice, fee, total, free };
}

// PAYPAL AUTH - client-credentials grant. Cached until shortly
// before PayPal's own expiry (tokens are typically valid ~9 hours),
// so most requests reuse the same token instead of re-authing.
let tokenCache = { value: null, expiresAt: 0 };

async function getPayPalAccessToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.expiresAt) return tokenCache.value;

  const basic = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${PAYPAL_API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials'
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`PayPal auth failed: ${errText}`);
  }
  const data = await res.json();
  tokenCache = {
    value: data.access_token,
    // knock 60s off whatever PayPal reports so we never use a token
    // that's about to expire mid-request
    expiresAt: now + (Math.max(0, (data.expires_in || 300) - 60) * 1000)
  };
  return tokenCache.value;
}

// GET /api/paypal/config - public. Tells signup.html which client ID
// + currency to load the PayPal SDK with, and the current price to
// display. This is display-only; the actual charge amount is always
// decided server-side in /api/paypal/create-order below.
router.get('/api/paypal/config', async (req, res) => {
  if (!PAYPAL_CLIENT_ID) {
    return res.status(500).json({ error: 'Payments are not configured yet.' });
  }
  try {
    const order = await computeOrderTotal(null); // no coupon - base price + fee
    res.json({
      clientId: PAYPAL_CLIENT_ID,
      currency: 'USD',
      price: order.itemPrice, // kept for backward compatibility with existing frontend code
      fee: order.fee,
      total: order.total
    });
  } catch (err) {
    console.error('GET /api/paypal/config error:', err);
    res.status(500).json({ error: 'Payments are not configured yet.' });
  }
});

// POST /api/validate-coupon - body: {code}. Public preview endpoint
// only: tells signup.html what a code is worth (and whether it makes
// signup free) so the page can show the right total and buttons
// BEFORE any order or payment exists. Nothing is charged here, and
// nothing here is trusted later - create-order and /api/signup both
// call computeOrderTotal() again themselves from scratch.
router.post('/api/validate-coupon', async (req, res) => {
  const code = String((req.body && req.body.code) || '').trim();
  if (!code) {
    return res.status(400).json({ error: 'Please enter a coupon code.' });
  }
  try {
    const order = await computeOrderTotal(code);
    if (order.error) {
      return res.status(404).json({ error: order.error });
    }
    res.json({
      valid: true,
      code: order.coupon.code,
      discountType: order.coupon.discountType,
      discountValue: order.coupon.discountValue,
      itemPrice: order.itemPrice,
      fee: order.fee,
      total: order.total,
      free: order.free
    });
  } catch (err) {
    console.error('POST /api/validate-coupon error:', err);
    res.status(500).json({ error: 'Could not validate that coupon. Please try again.' });
  }
});

// POST /api/paypal/create-order - body: {} (no amount taken from the
// client on purpose). Creates a PayPal order for whatever the
// CURRENT Airtable price is and returns its order ID for the JS SDK
// to render a checkout with.
router.post('/api/paypal/create-order', async (req, res) => {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Payments are not configured yet.' });
  }
  const couponCode = String((req.body && req.body.couponCode) || '').trim();
  try {
    const orderTotal = await computeOrderTotal(couponCode || null);
    if (orderTotal.error) {
      return res.status(404).json({ error: orderTotal.error });
    }
    if (orderTotal.free) {
      // A coupon that zeroes out the price skips PayPal entirely -
      // signup.html should be calling /api/signup directly in that
      // case, never this endpoint. This is just a defensive guard
      // in case it's hit anyway (stale page state, direct API call).
      return res.status(400).json({ error: 'This coupon makes signup free - no payment needed. Please refresh and try again.' });
    }
    const accessToken = await getPayPalAccessToken();
    const orderRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: orderTotal.coupon
            ? `Hookitlingo community signup (coupon ${orderTotal.coupon.code})`
            : 'Hookitlingo community signup',
          amount: { currency_code: 'USD', value: orderTotal.total.toFixed(2) }
        }]
      })
    });
    if (!orderRes.ok) {
      const errText = await orderRes.text();
      console.error('PayPal create-order failed:', errText);
      return res.status(502).json({ error: 'Could not start PayPal checkout. Please try again.' });
    }
    const order = await orderRes.json();
    res.json({ id: order.id });
  } catch (err) {
    console.error('PayPal create-order error:', err);
    res.status(500).json({ error: 'Could not start PayPal checkout. Please try again.' });
  }
});

// POST /api/paypal/capture-order - body: {orderID}. Actually takes
// the buyer's money (captures the order they just approved) and
// returns a receipt for the UI. NOTE: this endpoint's response is a
// convenience for signup.html only - /api/signup (server.js)
// independently re-verifies the order with PayPal itself before it
// ever writes a row to Airtable, so a forged/replayed call here
// can't be used to fake an account.
router.post('/api/paypal/capture-order', async (req, res) => {
  if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
    return res.status(500).json({ error: 'Payments are not configured yet.' });
  }
  const orderID = String((req.body && req.body.orderID) || '').trim();
  if (!orderID) {
    return res.status(400).json({ error: 'Missing PayPal order ID.' });
  }
  try {
    const accessToken = await getPayPalAccessToken();
    const captureRes = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderID)}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      }
    });
    const captureData = await captureRes.json();
    if (!captureRes.ok || captureData.status !== 'COMPLETED') {
      console.error('PayPal capture failed:', JSON.stringify(captureData));
      return res.status(402).json({ error: 'Payment could not be completed. Please try again.' });
    }
    res.json({ ok: true, orderID: captureData.id, status: captureData.status });
  } catch (err) {
    console.error('PayPal capture-order error:', err);
    res.status(500).json({ error: 'Payment could not be completed. Please try again.' });
  }
});

// verifyPayPalOrderCompleted - called from /api/signup in server.js.
// Independently asks PayPal about an order ID rather than trusting
// anything the browser claims. Returns { ok:false } for anything
// that isn't a genuinely COMPLETED order.
async function verifyPayPalOrderCompleted(orderID) {
  try {
    const accessToken = await getPayPalAccessToken();
    const res = await fetch(`${PAYPAL_API_BASE}/v2/checkout/orders/${encodeURIComponent(orderID)}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!res.ok) return { ok: false };
    const order = await res.json();
    if (order.status !== 'COMPLETED') return { ok: false };

    const purchaseUnit = order.purchase_units && order.purchase_units[0];
    const capture = purchaseUnit
      && purchaseUnit.payments
      && purchaseUnit.payments.captures
      && purchaseUnit.payments.captures[0];
    if (!capture || capture.status !== 'COMPLETED') return { ok: false };

    const amount = Number(capture.amount && capture.amount.value);
    const payerEmail = (order.payer && order.payer.email_address) || null;
    return { ok: true, captureId: capture.id, amount: Number.isFinite(amount) ? amount : null, payerEmail };
  } catch (err) {
    console.error('verifyPayPalOrderCompleted error:', err);
    return { ok: false };
  }
}

module.exports = router;
module.exports.getSignupPrice = getSignupPrice;
module.exports.verifyPayPalOrderCompleted = verifyPayPalOrderCompleted;
module.exports.computeOrderTotal = computeOrderTotal;
module.exports.PROCESSING_FEE_USD = PROCESSING_FEE_USD;
