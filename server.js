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
const NP_API_KEY = process.env.NP_API_KEY;
const NP_IPN_SECRET = process.env.NP_IPN_SECRET;
const NP_BASE = 'https://api.nowpayments.io/v1';

// ── FIREBASE ADMIN ──
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ── LIVE NGN RATE (refreshed every 15 minutes) ──
let liveUsdToNgn = 1360; // fallback

async function refreshNgnRate() {
  const sources = [
    async () => {
      const res = await fetch('https://open.er-api.com/v6/latest/USD', { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      if (data.rates?.NGN && data.rates.NGN > 1000) return data.rates.NGN;
    },
    async () => {
      const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      if (data.rates?.NGN && data.rates.NGN > 1000) return data.rates.NGN;
    },
    async () => {
      const res = await fetch('https://api.coinbase.com/v2/exchange-rates?currency=USD', { signal: AbortSignal.timeout(6000) });
      const data = await res.json();
      const rate = parseFloat(data.data?.rates?.NGN);
      if (rate > 1000) return rate;
    }
  ];

  for (const source of sources) {
    try {
      const rate = await source();
      if (rate && rate > 1000 && rate < 5000) {
        liveUsdToNgn = rate;
        console.log(`💱 NGN rate updated: $1 = ₦${rate.toFixed(0)}`);
        return;
      }
    } catch (e) { continue; }
  }
  console.log(`💱 Rate fetch failed, keeping: $1 = ₦${liveUsdToNgn.toFixed(0)}`);
}

// Refresh rate on startup and every 15 minutes
refreshNgnRate();
setInterval(refreshNgnRate, 15 * 60 * 1000);

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

// ── HELPER: Sort object keys (required for NOWPayments signature) ──
function sortObjectKeys(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(sortObjectKeys);
  return Object.keys(obj).sort().reduce((sorted, key) => {
    sorted[key] = sortObjectKeys(obj[key]);
    return sorted;
  }, {});
}

// ────────────────────────────────────────────────
// ROUTE 1: GET /api/currencies
// ────────────────────────────────────────────────
app.get('/api/currencies', async (req, res) => {
  try {
    const data = await npFetch('/currencies?fixed_rate=false');
    const currencies = data.currencies || [];
    res.json({ success: true, currencies });
  } catch (err) {
    console.error('GET /api/currencies error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE 2: GET /api/currency-info/:currency
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

    const payment = await npFetch('/payment', 'POST', {
      price_amount: amountUsd,
      price_currency: 'usd',
      pay_currency: currency.toLowerCase(),
      order_id: `crediplex_${userId}_${Date.now()}`,
      order_description: `Crediplex deposit for user ${userId}`,
      ipn_callback_url: `${process.env.SERVER_URL || 'https://crediplex-production.up.railway.app'}/webhook/nowpayments`
    });

    const depositRef = db.collection('deposits').doc(payment.payment_id.toString());
    await depositRef.set({
      depositId: payment.payment_id.toString(),
      userId,
      amountUsd,
      coin: currency.toLowerCase(),
      payAmount: payment.pay_amount,
      payAddress: payment.pay_address,
      network: payment.network || currency.toLowerCase(),
      paymentId: payment.payment_id.toString(),
      status: 'pending',
      credited: false,
      ngnRateAtCreation: liveUsdToNgn,
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
// ────────────────────────────────────────────────
app.post('/webhook/nowpayments', async (req, res) => {
  try {
    const receivedSig = req.headers['x-nowpayments-sig'];
    if (!receivedSig) {
      console.warn('Webhook received with no signature — rejected');
      return res.status(401).json({ error: 'No signature' });
    }

    const rawBody = req.body;
    const payload = JSON.parse(rawBody.toString());

    const sortedPayload = JSON.stringify(sortObjectKeys(payload));
    const expectedSig = crypto
      .createHmac('sha512', NP_IPN_SECRET)
      .update(sortedPayload)
      .digest('hex');

    if (receivedSig !== expectedSig) {
      console.warn('Webhook signature mismatch — rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }

    const { payment_id, payment_status, price_amount, order_id } = payload;
    const paymentIdStr = payment_id.toString();

    console.log(`Webhook: payment ${paymentIdStr} — status: ${payment_status}`);

    const successStatuses = ['finished', 'confirmed'];
    if (!successStatuses.includes(payment_status)) {
      await db.collection('deposits').doc(paymentIdStr).update({ status: payment_status }).catch(() => {});
      return res.json({ received: true });
    }

    // ── CREDIT WALLET ──
    const depositRef = db.collection('deposits').doc(paymentIdStr);

    await db.runTransaction(async (tx) => {
      const depositSnap = await tx.get(depositRef);

      if (!depositSnap.exists) {
        throw new Error(`Deposit ${paymentIdStr} not found`);
      }

      const deposit = depositSnap.data();

      if (deposit.credited === true) {
        console.log(`Payment ${paymentIdStr} already credited — skipping`);
        return;
      }

      const userId = deposit.userId;
      const amountUsd = deposit.amountUsd;

      // Use the rate at time of deposit creation if available, else use current live rate
      const rateToUse = deposit.ngnRateAtCreation || liveUsdToNgn;
      const amountNgn = Math.floor(amountUsd * rateToUse);

      const userRef = db.collection('users').doc(userId);
      const userSnap = await tx.get(userRef);

      if (!userSnap.exists) {
        throw new Error(`User ${userId} not found`);
      }

      const currentBalance = userSnap.data().balance || 0;
      const newBalance = currentBalance + amountNgn;

      tx.update(depositRef, {
        status: 'finished',
        credited: true,
        creditedAt: admin.firestore.FieldValue.serverTimestamp(),
        amountNgnCredited: amountNgn,
        ngnRateUsed: rateToUse
      });

      tx.update(userRef, {
        balance: newBalance,
        totalDeposited: admin.firestore.FieldValue.increment(amountUsd)
      });

      const txRef = db.collection('transactions').doc();
      tx.set(txRef, {
        uid: userId,
        type: 'deposit',
        amount: amountNgn,
        note: `Crypto deposit: $${amountUsd} via ${deposit.coin.toUpperCase()} → ₦${amountNgn.toLocaleString()} (rate: ₦${rateToUse.toFixed(0)}/$)`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      console.log(`✅ Credited ₦${amountNgn} to user ${userId} (rate: ₦${rateToUse.toFixed(0)}/$)`);
    });

    res.json({ received: true });

  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE 6: POST /api/payout
// Auto-send crypto withdrawal to user wallet
// Body: { withdrawalId, userId, amountUsd, address, currency }
// ────────────────────────────────────────────────
app.post('/api/payout', async (req, res) => {
  try {
    const { withdrawalId, userId, amountUsd, address, currency } = req.body;

    if (!withdrawalId || !userId || !amountUsd || !address || !currency) {
      return res.status(400).json({ success: false, error: 'Missing required fields.' });
    }

    // Check withdrawal exists and is still pending
    const wdRef = db.collection('withdrawals').doc(withdrawalId);
    const wdSnap = await wdRef.get();

    if (!wdSnap.exists) {
      return res.status(404).json({ success: false, error: 'Withdrawal not found.' });
    }

    const wd = wdSnap.data();

    if (wd.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Withdrawal already ${wd.status}.` });
    }

    if (wd.userId !== userId) {
      return res.status(403).json({ success: false, error: 'User mismatch.' });
    }

    // Check user has enough balance
    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();

    if (!userSnap.exists) {
      return res.status(404).json({ success: false, error: 'User not found.' });
    }

    const user = userSnap.data();
    const amountNgn = Math.floor(amountUsd * liveUsdToNgn);

    if ((user.balance || 0) < amountNgn) {
      return res.status(400).json({ success: false, error: 'Insufficient balance.' });
    }

    // Mark as processing immediately to prevent double-spend
    await wdRef.update({ status: 'processing', processingAt: admin.firestore.FieldValue.serverTimestamp() });
    await userRef.update({ balance: admin.firestore.FieldValue.increment(-amountNgn) });

    // Send payout via NOWPayments
    let payoutResult;
    try {
      payoutResult = await npFetch('/payout', 'POST', {
        ipn_callback_url: `${process.env.SERVER_URL || 'https://crediplex-production.up.railway.app'}/webhook/payout`,
        withdrawals: [
          {
            address,
            currency: currency.toLowerCase(),
            amount: amountUsd,
            ipn_callback_url: `${process.env.SERVER_URL || 'https://crediplex-production.up.railway.app'}/webhook/payout`
          }
        ]
      });
    } catch (payoutErr) {
      // Payout failed — refund the user and revert withdrawal
      console.error('Payout API error:', payoutErr.message);
      await userRef.update({ balance: admin.firestore.FieldValue.increment(amountNgn) });
      await wdRef.update({ status: 'pending', processingError: payoutErr.message });
      return res.status(500).json({ success: false, error: 'Payout failed: ' + payoutErr.message });
    }

    const payoutId = payoutResult?.id || payoutResult?.withdrawals?.[0]?.id || 'unknown';

    // Update withdrawal as approved
    await wdRef.update({
      status: 'approved',
      approvedAt: admin.firestore.FieldValue.serverTimestamp(),
      payoutId,
      amountNgnDeducted: amountNgn,
      ngnRateUsed: liveUsdToNgn,
      autoProcessed: true
    });

    // Log transaction
    await db.collection('transactions').add({
      uid: userId,
      type: 'withdrawal',
      amount: -amountNgn,
      note: `Auto withdrawal: $${amountUsd} → ${address.substring(0, 12)}... via ${currency.toUpperCase()} (rate: ₦${liveUsdToNgn.toFixed(0)}/$)`,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`✅ Payout sent: $${amountUsd} ${currency.toUpperCase()} to ${address} for user ${userId}`);

    res.json({
      success: true,
      payoutId,
      amountUsd,
      currency,
      address,
      amountNgnDeducted: amountNgn,
      rate: liveUsdToNgn
    });

  } catch (err) {
    console.error('POST /api/payout error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE 7: POST /webhook/payout
// NOWPayments payout status updates
// ────────────────────────────────────────────────
app.post('/webhook/payout', async (req, res) => {
  try {
    const payload = req.body;
    const { id, status, withdrawal_id } = payload;
    console.log(`Payout webhook: ${id} — status: ${status}`);

    // Find matching withdrawal by payoutId
    const wdQuery = await db.collection('withdrawals')
      .where('payoutId', '==', id?.toString() || withdrawal_id?.toString() || '')
      .limit(1)
      .get();

    if (!wdQuery.empty) {
      await wdQuery.docs[0].ref.update({ payoutStatus: status, lastUpdated: admin.firestore.FieldValue.serverTimestamp() });
    }

    res.json({ received: true });
  } catch (err) {
    console.error('Payout webhook error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ────────────────────────────────────────────────
// ROUTE 8: GET /api/live-rate
// Returns the current NGN/USD rate the server is using
// ────────────────────────────────────────────────
app.get('/api/live-rate', async (req, res) => {
  res.json({ success: true, usdToNgn: liveUsdToNgn });
});

// ── START SERVER ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Crediplex server running on port ${PORT}`);
});
