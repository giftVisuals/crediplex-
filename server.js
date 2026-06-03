const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();

// ── RAW BODY FOR WEBHOOK SIGNATURE VERIFICATION ──
app.use('/webhook/nowpayments', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(cors({ origin: '*' }));

// ── NOWPAYMENTS CONFIG ──
const NP_API_KEY = 'AFF7GM5-C8Q49QR-K0BB1Q6-V3XPHD5';
const NP_IPN_SECRET = 'cysKayY7v5nv9ZSquk2GFD95G83iWV7Y';
const NP_BASE = 'https://api.nowpayments.io/v1';

// ── FIREBASE ADMIN ──
// Place your Firebase service account JSON file in the same folder
// and name it: serviceAccountKey.json
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ── HELPER: Call NOWPayments API ──
async function npFetch(path, method = 'GET', body = null) {
  const options = {
    method,
    headers: {
      'x-api-key': NP_API_KEY,
      'Content-Type': 'application/json'
    }
  };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${NP_BASE}${path}`, options);
  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.message || `NOWPayments error: ${res.status}`);
  }
  return data;
}

// ────────────────────────────────────────────────
// ROUTE 1: GET /api/currencies
// Returns all supported currencies from NOWPayments
// ────────────────────────────────────────────────
app.get('/api/currencies', async (req, res) => {
  try {
    const data = await npFetch('/currencies?fixed_rate=false');

    // data.currencies is an array of coin strings like ["btc", "eth", "usdt", ...]
    const currencies = data.currencies || [];

    // Also fetch minimum amounts for each (we'll do this lazily per coin)
    res.json({ success: true, currencies });
  } catch (err) {
    console.error('GET /api/currencies error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE 2: GET /api/currency-info/:currency
// Returns minimum deposit amount for a specific coin
// ────────────────────────────────────────────────
app.get('/api/currency-info/:currency', async (req, res) => {
  try {
    const { currency } = req.params;
    const data = await npFetch(`/min-amount?currency_from=${currency}&currency_to=${currency}&fiat_equivalent=usd`);
    res.json({ success: true, minAmount: data.min_amount || 0 });
  } catch (err) {
    console.error('GET /api/currency-info error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE 3: POST /api/create-payment
// Creates a NOWPayments payment invoice
// Body: { userId, amountUsd, currency }
// ────────────────────────────────────────────────
app.post('/api/create-payment', async (req, res) => {
  try {
    const { userId, amountUsd, currency } = req.body;

    if (!userId || !amountUsd || !currency) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    if (amountUsd < 1) {
      return res.status(400).json({ success: false, error: 'Minimum deposit is $1.' });
    }

    // Create payment with NOWPayments
    const payment = await npFetch('/payment', 'POST', {
      price_amount: amountUsd,
      price_currency: 'usd',
      pay_currency: currency.toLowerCase(),
      order_id: `crediplex_${userId}_${Date.now()}`,
      order_description: `Crediplex deposit for user ${userId}`,
      ipn_callback_url: `${process.env.SERVER_URL || 'https://your-server.com'}/webhook/nowpayments`
    });

    // Save deposit record to Firestore
    const depositRef = db.collection('deposits').doc(payment.payment_id.toString());
    await depositRef.set({
      depositId: payment.payment_id.toString(),
      userId,
      amountUsd: amountUsd,
      coin: currency.toLowerCase(),
      payAmount: payment.pay_amount,
      payAddress: payment.pay_address,
      network: payment.network || currency.toLowerCase(),
      paymentId: payment.payment_id.toString(),
      status: 'pending',
      credited: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      paymentId: payment.payment_id.toString(),
      payAddress: payment.pay_address,
      payAmount: payment.pay_amount,
      payCurrency: payment.pay_currency,
      network: payment.network || currency.toLowerCase(),
      amountUsd,
      status: payment.payment_status
    });

  } catch (err) {
    console.error('POST /api/create-payment error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE 4: GET /api/payment-status/:paymentId
// Checks current status of a payment
// ────────────────────────────────────────────────
app.get('/api/payment-status/:paymentId', async (req, res) => {
  try {
    const { paymentId } = req.params;
    const data = await npFetch(`/payment/${paymentId}`);
    res.json({ success: true, status: data.payment_status, data });
  } catch (err) {
    console.error('GET /api/payment-status error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE 5: POST /webhook/nowpayments
// NOWPayments sends payment updates here
// ────────────────────────────────────────────────
app.post('/webhook/nowpayments', async (req, res) => {
  try {
    // ── VERIFY SIGNATURE ──
    const receivedSig = req.headers['x-nowpayments-sig'];
    if (!receivedSig) {
      console.warn('Webhook received with no signature — rejected');
      return res.status(401).json({ error: 'No signature' });
    }

    // NOWPayments signs the sorted payload with HMAC SHA-512
    const rawBody = req.body; // Buffer because we used express.raw()
    const payload = JSON.parse(rawBody.toString());

    // Sort keys alphabetically and stringify
    const sortedPayload = JSON.stringify(sortObjectKeys(payload));
    const expectedSig = crypto
      .createHmac('sha512', NP_IPN_SECRET)
      .update(sortedPayload)
      .digest('hex');

    if (receivedSig !== expectedSig) {
      console.warn('Webhook signature mismatch — rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    // ── PROCESS PAYMENT ──
    const { payment_id, payment_status, price_amount, order_id } = payload;
    const paymentIdStr = payment_id.toString();

    console.log(`Webhook received: payment ${paymentIdStr} — status: ${payment_status}`);

    // Only credit on "finished" or "confirmed"
    const successStatuses = ['finished', 'confirmed'];
    if (!successStatuses.includes(payment_status)) {
      // Update status in Firestore but don't credit yet
      const depositRef = db.collection('deposits').doc(paymentIdStr);
      await depositRef.update({ status: payment_status });
      return res.json({ received: true });
    }

    // ── CREDIT WALLET (with duplicate prevention) ──
    const depositRef = db.collection('deposits').doc(paymentIdStr);

    await db.runTransaction(async (tx) => {
      const depositSnap = await tx.get(depositRef);

      if (!depositSnap.exists) {
        throw new Error(`Deposit ${paymentIdStr} not found in Firestore`);
      }

      const deposit = depositSnap.data();

      // ── DUPLICATE PREVENTION ──
      if (deposit.credited === true) {
        console.log(`Payment ${paymentIdStr} already credited — skipping`);
        return;
      }

      const userId = deposit.userId;
      const amountUsd = deposit.amountUsd;

      // Convert USD to NGN (use live rate — here we store USD value directly)
      // Crediplex stores balances in NGN internally
      // We'll credit in NGN at a fixed rate you can update
      const NGN_RATE = 1600; // $1 = ₦1600 — update this as needed
      const amountNgn = Math.floor(amountUsd * NGN_RATE);

      const userRef = db.collection('users').doc(userId);
      const userSnap = await tx.get(userRef);

      if (!userSnap.exists) {
        throw new Error(`User ${userId} not found`);
      }

      const currentBalance = userSnap.data().balance || 0;
      const newBalance = currentBalance + amountNgn;

      // Update deposit status
      tx.update(depositRef, {
        status: 'finished',
        credited: true,
        creditedAt: admin.firestore.FieldValue.serverTimestamp(),
        amountNgnCredited: amountNgn
      });

      // Credit user wallet
      tx.update(userRef, {
        balance: newBalance,
        totalDeposited: admin.firestore.FieldValue.increment(amountUsd)
      });

      // Create wallet transaction record
      const txRef = db.collection('walletTransactions').doc();
      tx.set(txRef, {
        userId,
        type: 'deposit',
        amountUsd,
        amountNgn,
        balanceAfter: newBalance,
        reference: paymentIdStr,
        coin: deposit.coin,
        network: deposit.network,
        status: 'completed',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      // Also add to transactions collection (your existing collection)
      const crediplexTxRef = db.collection('transactions').doc();
      tx.set(crediplexTxRef, {
        uid: userId,
        type: 'deposit',
        amount: amountNgn,
        note: `Crypto deposit: $${amountUsd} via ${deposit.coin.toUpperCase()} — credited ₦${amountNgn.toLocaleString()}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ Credited ₦${amountNgn} to user ${userId} for payment ${paymentIdStr}`);
    });

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── HELPER: Sort object keys alphabetically (required for NOWPayments signature) ──
function sortObjectKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  return Object.keys(obj).sort().reduce((sorted, key) => {
    sorted[key] = sortObjectKeys(obj[key]);
    return sorted;
  }, {});
}

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Crediplex server running on port ${PORT}`);
});
