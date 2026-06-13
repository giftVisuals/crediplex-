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
  const headers = {
    'x-api-key': NP_API_KEY,
    'Content-Type': 'application/json'
  };
  // /payout endpoint requires Bearer JWT token
  const options = { method, headers };
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

    // Retry up to 3 times — Firestore write from client may not be committed yet
    let wdSnap = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      wdSnap = await wdRef.get();
      if (wdSnap.exists) break;
      await new Promise(r => setTimeout(r, 800));
    }

    if (!wdSnap || !wdSnap.exists) {
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
    const amountNgn = Math.floor(amountUsd * liveUsdToNgn);
    // Skip balance re-check — frontend already validated and we trust the withdrawal doc
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
// ────────────────────────────────────────────────
// POLYMARKET AUTO-RESOLUTION POLLER
// Runs every 60 seconds, resolves markets server-side
// ────────────────────────────────────────────────

const PROXY_URLS = [
  url => `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
];

async function fetchWithProxy(url) {
  for (const proxy of PROXY_URLS) {
    try {
      const res = await fetch(proxy(url), {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(8000)
      });
      if (!res.ok) continue;
      const raw = await res.json();
      let data = raw;
      if (raw.contents) {
        try { data = JSON.parse(raw.contents); } catch (e) { continue; }
      }
      if (data) return data;
    } catch (e) { continue; }
  }
  return null;
}

async function resolvePolymarketMarkets() {
  try {
    // Fetch all active markets that have a polymarketId
    const now = admin.firestore.Timestamp.now();
    const marketsSnap = await db.collection('markets')
      .where('status', '==', 'active')
      .where('deadline', '<=', now)
      .get();

    const polyMarkets = marketsSnap.docs.filter(d => d.data().polymarketId);
    if (!polyMarkets.length) return;

    console.log(`🔍 Checking ${polyMarkets.length} Polymarket markets for resolution...`);

    for (const mktDoc of polyMarkets) {
      const m = { id: mktDoc.id, ...mktDoc.data() };

      try {
        // Direct fetch (Railway has no CORS restriction)
        let data = null;
        try {
          const res = await fetch(
            `https://gamma-api.polymarket.com/markets/${m.polymarketId}`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (res.ok) data = await res.json();
        } catch (e) {}

        // Fallback to proxy
        if (!data) {
          data = await fetchWithProxy(`https://gamma-api.polymarket.com/markets/${m.polymarketId}`);
        }

        if (!data) continue;

        const isResolved = data.resolved === true || data.closed === true;
        if (!isResolved) continue;

        // Determine winner
        let winner = null;
        let outcomesArr = ['Yes', 'No'];
        try { outcomesArr = JSON.parse(data.outcomes || '["Yes","No"]'); } catch (e) {}

        // Method 1: resolutionResult field
        if (data.resolutionResult) {
          const rr = data.resolutionResult;
          const matchedOutcome = outcomesArr.find(
            o => o.toLowerCase() === rr.toLowerCase()
          );
          if (matchedOutcome) winner = matchedOutcome.toUpperCase();
          else winner = rr.toLowerCase().includes('yes') ? 'YES' : 'NO';
        }

        // Method 2: outcome prices (winning side = ~1.0)
        if (!winner) {
          try {
            const prices = JSON.parse(data.outcomePrices || '[]');
            const winIdx = prices.findIndex(p => parseFloat(p) >= 0.99);
            if (winIdx >= 0 && outcomesArr[winIdx]) {
              winner = outcomesArr[winIdx].toUpperCase();
            }
          } catch (e) {}
        }

        // Method 3: highest price
        if (!winner) {
          try {
            const prices = JSON.parse(data.outcomePrices || '[]').map(p => parseFloat(p));
            const maxIdx = prices.indexOf(Math.max(...prices));
            if (maxIdx >= 0 && outcomesArr[maxIdx]) winner = outcomesArr[maxIdx].toUpperCase();
          } catch (e) {}
        }

        if (!winner) continue;

        // Get all pending bets for this market
        const betsSnap = await db.collection('bets')
          .where('marketId', '==', m.id)
          .where('status', '==', 'pending')
          .get();

        const yesPool = m.yesPool || 0;
        const noPool = m.noPool || 0;
        let totalPool = yesPool + noPool;
        let winningSidePool = winner === 'YES' ? yesPool : noPool;

        // Handle multi-outcome pools
        if (outcomesArr.length > 2) {
          totalPool = m.totalPool || 0;
          if (!totalPool) {
            Object.keys(m)
              .filter(k => k.startsWith('pool_'))
              .forEach(k => { totalPool += Number(m[k] || 0); });
          }
          const matchedOutcome = outcomesArr.find(o =>
            o.toLowerCase() === winner.toLowerCase() ||
            o.toLowerCase().includes(winner.toLowerCase()) ||
            winner.toLowerCase().includes(o.toLowerCase())
          ) || winner;
          const winKey = 'pool_' + matchedOutcome.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
          winningSidePool = Number(m[winKey] || 0);
          winner = matchedOutcome.toUpperCase();
        }

        // Run payout transaction
        await db.runTransaction(async tx => {
          const mktRef = db.collection('markets').doc(m.id);
          const mktNow = await tx.get(mktRef);
          if (mktNow.data().status !== 'active') return; // already resolved

          for (const betDoc of betsSnap.docs) {
            const b = betDoc.data();
            const betRef = db.collection('bets').doc(betDoc.id);
            const betSide = (b.side || '').toUpperCase();

            if (betSide === winner) {
              const winAmt = winningSidePool > 0
                ? Math.floor((totalPool * 0.90 / winningSidePool) * Number(b.amount || 0))
                : Number(b.amount || 0);
              const profit = winAmt - Number(b.amount || 0);

              if (b.isBonus) {
                // Bonus bet: only 5% of profit to withdrawal wallet
                const bonusPayout = Math.floor(profit * 0.05);
                tx.update(betRef, { status: 'won', winAmount: bonusPayout });
                tx.update(db.collection('users').doc(b.uid), {
                  balance: admin.firestore.FieldValue.increment(bonusPayout),
                  wins: admin.firestore.FieldValue.increment(1),
                  profit: admin.firestore.FieldValue.increment(bonusPayout)
                });
              } else {
                tx.update(betRef, { status: 'won', winAmount: winAmt });
                tx.update(db.collection('users').doc(b.uid), {
                  balance: admin.firestore.FieldValue.increment(winAmt),
                  wins: admin.firestore.FieldValue.increment(1),
                  profit: admin.firestore.FieldValue.increment(profit)
                });
              }

              const txRef = db.collection('transactions').doc();
              tx.set(txRef, {
                uid: b.uid,
                type: 'win_payout',
                amount: winAmt,
                note: `Won: ${(m.question || '').substring(0, 60)}`,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
              });

            } else {
              // Loser
              tx.update(betRef, { status: 'lost' });
              tx.update(db.collection('users').doc(b.uid), {
                losses: admin.firestore.FieldValue.increment(1),
                profit: admin.firestore.FieldValue.increment(-Number(b.amount || 0))
              });
            }
          }

          tx.update(mktRef, {
            status: 'resolved',
            result: winner,
            resolvedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });

        console.log(`✅ Resolved: "${(m.question || '').substring(0, 50)}" → ${winner} (${betsSnap.size} bets paid)`);

      } catch (err) {
        console.error(`❌ Error resolving market ${m.id}:`, err.message);
      }
    }

  } catch (err) {
    console.error('resolvePolymarketMarkets error:', err.message);
  }
}

// Start the poller — runs every 15 minutes
console.log('⏱️ Polymarket resolution poller started (every 15min)');
setInterval(resolvePolymarketMarkets, 15 * 60 * 1000);
// Also run immediately on server start
setTimeout(resolvePolymarketMarkets, 5000);
// ─── COPY TRADE POLLER + TELEGRAM ────────────────────────────
const { pollAllCopyRelations } = require('./copytrader');

app.post('/api/telegram-test', async (req, res) => {
  const { chatId, username } = req.body;
  if (!chatId) return res.json({ success: false });
  await sendTelegramMessage(chatId,
    `👋 <b>Hi ${username}!</b>\n\nYour Telegram is now linked to Crediplex.\n\nYou'll get a message here every time a copy trade is auto-placed for you. 🎯`
  );
  res.json({ success: true });
});

setTimeout(() => pollAllCopyRelations(db, admin), 30 * 1000);
setInterval(() => pollAllCopyRelations(db, admin), 5 * 60 * 1000);
console.log('🔄 Copy trade poller started (every 5 min)');
// ─── AUTO POLYMARKET SYNC (every 2 minutes) ───────────────────
async function autoSyncPolymarketMarkets() {
  console.log('🔄 Auto-syncing Polymarket markets...');
  let imported = 0;
  let updated = 0;
  let page = 0;
  const batchSize = 100;

  try {
    // Pre-load existing polymarket IDs
    const existingSnap = await db.collection('markets').where('source', '==', 'polymarket').get();
    const existingPmIds = {};
    existingSnap.forEach(d => {
      const pmId = d.data().polymarketId;
      if (pmId) existingPmIds[pmId] = d;
    });

    while (true) {
      const url = `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=${batchSize}&offset=${page * batchSize}&order=volume_24hr&ascending=false`;

      let data = null;
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
        if (res.ok) data = await res.json();
      } catch (e) {
        data = await fetchWithProxy(url);
      }

      if (!data || !Array.isArray(data) || data.length === 0) break;

      // Flatten events → markets (THIS IS THE FIX for multi-outcome)
      const allMarkets = [];
      for (const event of data) {
        if (event.markets && Array.isArray(event.markets)) {
          for (const m of event.markets) {
            if (!m.question) m.question = event.title || event.question;
            if (!m.image) m.image = event.image;
            if (!m.endDate) m.endDate = event.endDate;
            if (!m.tags) m.tags = event.tags;
            allMarkets.push(m);
          }
        } else if (event.question) {
          allMarkets.push(event);
        }
      }

      const writes = [];

      for (const pm of allMarkets) {
        if (!pm.question) continue;
        if (pm.closed === true || pm.active === false) continue;

        const pmId = String(pm.id || pm.conditionId || '');
        if (!pmId) continue;

        // Parse deadline
        let deadline = null;
        if (pm.endDate || pm.end_date_iso) {
          const d = new Date(pm.endDate || pm.end_date_iso);
          if (isNaN(d.getTime())) continue;
          if (d < new Date()) continue;
          deadline = admin.firestore.Timestamp.fromDate(d);
        } else {
          deadline = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
        }

        // Parse outcomes (KEY FIX: preserve ALL outcomes from Polymarket)
        let outcomesArr = ['Yes', 'No'];
        try {
          const parsed = JSON.parse(pm.outcomes || '[]');
          if (Array.isArray(parsed) && parsed.length >= 2) outcomesArr = parsed;
        } catch (e) {}

        // Parse outcome prices
        let outcomePricesArr = [];
        try {
          outcomePricesArr = JSON.parse(pm.outcomePrices || '[]').map(p => parseFloat(p));
        } catch (e) {}

        // Yes odds (first outcome price)
        let yesOdds = 50;
        if (outcomePricesArr[0]) yesOdds = Math.round(outcomePricesArr[0] * 100);

        // Tags and category
        let pmTags = [];
        try {
          if (pm.tags) pmTags = Array.isArray(pm.tags) ? pm.tags.map(t => typeof t === 'string' ? t : (t.slug || t.name || '')) : [];
        } catch (e) {}

        const category = detectCategoryAdmin(pm.question, pmTags);
        const imageUrl = pm.image || pm.icon || '';

        const existingDoc = existingPmIds[pmId];

        if (existingDoc) {
          const existing = existingDoc.data();
          if (existing.status === 'active') {
            const updateData = {
              polymarketYesOdds: yesOdds,
              polymarketVolume: pm.volume || 0,
              deadline,
              outcomes: JSON.stringify(outcomesArr),
              outcomePrices: JSON.stringify(outcomePricesArr),
              outcomeCount: outcomesArr.length,
              question: pm.question,
            };
            if (imageUrl) updateData.imageUrl = imageUrl;
            writes.push(existingDoc.ref.update(updateData));
            updated++;
          }
          continue;
        }

        // Build pool keys for ALL outcomes
        const poolsObj = { yesPool: 0, noPool: 0, totalPool: 0 };
        outcomesArr.forEach(o => {
          const key = 'pool_' + o.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
          poolsObj[key] = 0;
        });

        const slug = slugifyServer(pm.question) + '-' + pmId.substring(0, 6);

        writes.push(
          db.collection('markets').add({
            question: pm.question,
            description: pm.description || '',
            category,
            status: 'active',
            yesPool: 0,
            noPool: 0,
            imageUrl,
            polymarketId: pmId,
            polymarketSlug: pm.slug || '',
            polymarketVolume: pm.volume || 0,
            polymarketYesOdds: yesOdds,
            deadline,
            outcomes: JSON.stringify(outcomesArr),
            outcomePrices: JSON.stringify(outcomePricesArr),
            outcomeCount: outcomesArr.length,
            ...poolsObj,
            slug,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'polymarket',
          })
        );
        imported++;
      }

      // Execute writes in parallel
      if (writes.length > 0) {
        await Promise.all(writes);
      }

      if (data.length < batchSize) break;
      page++;
      if (page >= 20) break;
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`✅ Auto-sync done: ${imported} new, ${updated} updated`);
  } catch (err) {
    console.error('autoSyncPolymarketMarkets error:', err.message);
  }
}

function slugifyServer(text) {
  return (text || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .substring(0, 60);
}

function detectCategoryAdmin(question, tags) {
  const q = (question || '').toLowerCase();
  const t = (tags || []).join(' ').toLowerCase();
  const combined = q + ' ' + t;
  if (t.includes('sports') || t.includes('nba') || t.includes('nfl') || t.includes('soccer') || t.includes('tennis') || t.includes('golf') || t.includes('mma') || t.includes('cricket') || t.includes('esports')) return 'Sports';
  if (t.includes('election')) return 'Election';
  if (t.includes('politics') || t.includes('political')) return 'Politics';
  if (t.includes('crypto') || t.includes('bitcoin') || t.includes('ethereum') || t.includes('defi')) return 'Crypto';
  if (t.includes('tech') || t.includes('ai') || t.includes('technology')) return 'Tech';
  if (t.includes('culture') || t.includes('entertainment')) return 'Culture';
  if (t.includes('economic') || t.includes('economy')) return 'Economic';
  if (t.includes('business') || t.includes('financial')) return 'Business';
  if (t.includes('geopolitical') || t.includes('world')) return 'Geopolitical';
  if (combined.includes('bitcoin') || combined.includes(' btc') || combined.includes('ethereum') || combined.includes('crypto')) return 'Crypto';
  if (combined.includes('election') || combined.includes('ballot')) return 'Election';
  if (combined.includes('war') || combined.includes('ceasefire') || combined.includes('nato') || combined.includes('ukraine') || combined.includes('israel') || combined.includes('gaza')) return 'Geopolitical';
  if (combined.includes('president') || combined.includes('senate') || combined.includes('congress') || combined.includes('minister') || combined.includes('parliament')) return 'Politics';
  if (combined.includes('gdp') || combined.includes('inflation') || combined.includes('interest rate') || combined.includes('recession')) return 'Economic';
  if (combined.includes('stock') || combined.includes('ipo') || combined.includes('nasdaq') || combined.includes('earnings')) return 'Business';
  if (combined.includes('ai ') || combined.includes('artificial intelligence') || combined.includes('openai') || combined.includes('apple') || combined.includes('google') || combined.includes('microsoft')) return 'Tech';
  if (combined.includes('oscar') || combined.includes('grammy') || combined.includes('movie') || combined.includes('award') || combined.includes('celebrity')) return 'Culture';
  if (combined.includes('nba') || combined.includes('nfl') || combined.includes('nhl') || combined.includes('soccer') || combined.includes('football') || combined.includes('champion') || combined.includes('world cup') || combined.includes('super bowl') || combined.includes('tennis') || combined.includes('golf') || combined.includes('mma') || combined.includes('cricket') || combined.includes('arsenal') || combined.includes('manchester') || combined.includes('playoff')) return 'Sports';
  if (combined.includes('weather') || combined.includes('hurricane') || combined.includes('earthquake')) return 'Weather';
  if (combined.includes('politics') || combined.includes('political') || combined.includes('policy')) return 'Politics';
  return 'Others';
}

// Run sync on startup (after 10s) then every 2 minutes
setTimeout(autoSyncPolymarketMarkets, 30 * 1000);
setInterval(autoSyncPolymarketMarkets, 30 * 60 * 1000);
console.log('🔄 Auto Polymarket sync started (every 30 min)');
// ─── TELEGRAM BOT COMMAND HANDLER ────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function sendTelegramMessage(chatId, text, extra = {}) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', ...extra })
    });
  } catch (e) { console.log('Telegram send error:', e.message); }
}

// ─── VERIFICATION CODE SYSTEM ─────────────────────────────────
// POST /api/generate-verify-code
// Frontend calls this → we store a 6-digit code in Firestore linked to userId
app.post('/api/generate-verify-code', async (req, res) => {
  try {
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'Missing userId' });

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await db.collection('telegramVerifyCodes').doc(userId).set({
      code,
      userId,
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      used: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({ success: true, code });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ─── POLYMARKET FETCH HELPERS ─────────────────────────────────
async function fetchPolymarketTrader(addressOrUsername) {
  const isAddress = addressOrUsername.startsWith('0x');
  const urls = isAddress
    ? [
        `https://gamma-api.polymarket.com/profiles?address=${addressOrUsername}`,
        `https://data-api.polymarket.com/profiles?user=${addressOrUsername}`
      ]
    : [
        `https://gamma-api.polymarket.com/profiles?name=${encodeURIComponent(addressOrUsername)}`,
        `https://gamma-api.polymarket.com/profiles?search=${encodeURIComponent(addressOrUsername)}`
      ];

  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      const profile = Array.isArray(data) ? data[0] : data;
      if (profile && (profile.address || profile.proxyWallet)) return profile;
    } catch (e) { continue; }
  }
  return null;
}

async function fetchPolymarketPositions(address) {
  const urls = [
    `https://data-api.polymarket.com/positions?user=${address}&limit=10`,
    `https://gamma-api.polymarket.com/positions?user=${address}&limit=10`
  ];
  for (const url of urls) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const data = await res.json();
      if (Array.isArray(data) && data.length) return data;
      if (data.positions) return data.positions;
    } catch (e) { continue; }
  }
  return [];
}

async function fetchPolymarketMarket(query) {
async function fetchPolymarketMarket(query) {
  const isUrl = query.startsWith('http');
  let searchTerm = query;
  if (isUrl) {
    const match = query.match(/\/event\/([^/?]+)/);
    if (match) searchTerm = match[1].replace(/-/g, ' ');
  }
  try {
    const res = await fetch(
      `https://gamma-api.polymarket.com/markets?active=true&limit=20&search=${encodeURIComponent(searchTerm)}&order=volume&ascending=false`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || !data.length) return null;

    // Score each result by keyword match quality
    const queryWords = searchTerm.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const scored = data.map(m => {
      const q = (m.question || '').toLowerCase();
      let score = 0;
      queryWords.forEach(word => {
        if (q.includes(word)) score += 10;
        if (q.startsWith(word)) score += 5;
      });
      // Bonus for volume
      score += Math.log10((m.volume || 1));
      return { market: m, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored[0].market;
  } catch (e) { return null; }
}

// ─── TELEGRAM WEBHOOK ─────────────────────────────────────────
app.post('/api/telegram-webhook', async (req, res) => {
  res.json({ ok: true }); // Always respond fast to Telegram

  try {
    const message = req.body?.message || req.body?.edited_message;
    if (!message) return;

    const chatId = message.chat?.id;
    const text = (message.text || '').trim();
    const username = message.from?.username || message.from?.first_name || 'User';

    if (!text.startsWith('/')) return;

    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase().split('@')[0]; // strip @BotName
    const args = parts.slice(1).join(' ').trim();

    // ── /start ──
    if (command === '/start') {
      // Check if args is a verify code (6 digits)
      if (/^\d{6}$/.test(args)) {
        // Link account via code
        const codesSnap = await db.collection('telegramVerifyCodes')
          .where('code', '==', args)
          .where('used', '==', false)
          .limit(1)
          .get();

        if (codesSnap.empty) {
          await sendTelegramMessage(chatId,
            '❌ <b>Invalid or expired code.</b>\n\nGenerate a new code from the Crediplex app under Copy Trade → Link Bot.'
          );
          return;
        }

        const codeDoc = codesSnap.docs[0];
        const codeData = codeDoc.data();

        // Check expiry
        if (codeData.expiresAt.toDate() < new Date()) {
          await sendTelegramMessage(chatId,
            '⏰ <b>Code expired.</b>\n\nGenerate a new code from the Crediplex app.'
          );
          return;
        }

        const userId = codeData.userId;

        // Mark code as used
        await codeDoc.ref.update({ used: true });

        // Save chatId to user
        await db.collection('users').doc(userId).update({ telegramChatId: chatId.toString() });

        // Get username
        const userSnap = await db.collection('users').doc(userId).get();
        const crediplexUsername = userSnap.exists ? userSnap.data().username : 'User';

        await sendTelegramMessage(chatId,
          `✅ <b>Account linked successfully!</b>\n\n` +
          `Welcome, <b>${crediplexUsername}</b>! 🎉\n\n` +
          `You'll now receive notifications here whenever a copy trade is placed for you.\n\n` +
          `Use /help to see all available commands.`
        );
        return;
      }

      // Normal /start
      await sendTelegramMessage(chatId,
        `👋 <b>Welcome to Crediplex Bot!</b>\n\n` +
        `🎯 Predict markets. Copy top traders. Win big.\n\n` +
        `<b>Commands:</b>\n` +
        `/market — Search a prediction market\n` +
        `/wallet — Look up a trader's stats\n` +
        `/pnl — Detailed P&L breakdown\n` +
        `/track — Track a market for alerts\n` +
        `/untrack — Stop tracking a market\n` +
        `/help — Support & info\n\n` +
        `To link your Crediplex account, go to <b>Copy Trade → Link Bot</b> in the app.`,
        {
          reply_markup: JSON.stringify({
            inline_keyboard: [[
              { text: '🚀 Open Crediplex', url: 'https://crediplex.name.ng' }
            ]]
          })
        }
      );
      return;
    }

    // ── /help ──
    if (command === '/help') {
      await sendTelegramMessage(chatId,
        `📞 <b>Crediplex Support</b>\n\n` +
        `📧 Email: care@crediplex.name.ng\n` +
        `🌐 Website: crediplex.name.ng\n\n` +
        `<b>All Commands:</b>\n` +
        `/market &lt;keyword or link&gt; — Find a market\n` +
        `/wallet &lt;address or username&gt; — Trader stats\n` +
        `/pnl &lt;address or username&gt; — P&L breakdown\n` +
        `/track &lt;address or username&gt; — Track a wallet\n` +
        `/untrack — Stop tracking a wallet\n\n` +
        `💬 For account issues, email us directly.`,
        {
          reply_markup: JSON.stringify({
            inline_keyboard: [[
              { text: '🌐 crediplex.name.ng', url: 'https://crediplex.name.ng' },
              { text: '📧 Email Support', url: 'mailto:care@crediplex.name.ng' }
            ]]
          })
        }
      );
      return;
    }

    // ── /market ──
    if (command === '/market') {
      if (!args) {
        await sendTelegramMessage(chatId,
          `📊 <b>Usage:</b> /market &lt;keyword or link&gt;\n\n` +
          `<b>Examples:</b>\n` +
          `/market bitcoin 150k\n` +
          `/market trump tariffs\n` +
          `/market https://polymarket.com/event/bitcoin-150k`
        );
        return;
      }

      await sendTelegramMessage(chatId, '🔍 Searching...');

      // Try Crediplex markets first
      let found = null;
      try {
        const snap = await db.collection('markets')
          .where('status', '==', 'active')
          .get();
        const lower = args.toLowerCase();
        const matches = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(m => m.question.toLowerCase().includes(lower))
          .sort((a, b) => ((b.yesPool || 0) + (b.noPool || 0)) - ((a.yesPool || 0) + (a.noPool || 0)));
        if (matches.length) found = matches[0];
      } catch (e) {}

      if (found) {
        const total = (found.yesPool || 0) + (found.noPool || 0);
        const yp = total > 0 ? Math.round((found.yesPool || 0) / total * 100) : 50;
        const slug = found.slug || found.id;
        await sendTelegramMessage(chatId,
          `📊 <b>${found.question}</b>\n\n` +
          `🟢 Yes: ${yp}%  🔴 No: ${100 - yp}%\n` +
          `💰 Pool: ₦${Number(total).toLocaleString()}\n` +
          `📂 Category: ${found.category || 'Others'}\n` +
          `🕐 Status: ${found.status}`,
          {
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: '🎯 Bet on Crediplex', url: `https://crediplex.name.ng/market/${slug}` }
              ]]
            })
          }
        );
        return;
      }

      // Try Polymarket
      const pmMarket = await fetchPolymarketMarket(args);
      if (pmMarket) {
        let yesOdds = 50;
        try {
          const prices = JSON.parse(pmMarket.outcomePrices || '[]');
          if (prices[0]) yesOdds = Math.round(parseFloat(prices[0]) * 100);
        } catch (e) {}

        const volume = pmMarket.volume ? `$${Number(pmMarket.volume).toLocaleString('en-US', { maximumFractionDigits: 0 })}` : 'N/A';
        const pmUrl = pmMarket.slug ? `https://polymarket.com/event/${pmMarket.slug}` : 'https://polymarket.com';

        await sendTelegramMessage(chatId,
          `📊 <b>${pmMarket.question}</b>\n\n` +
          `🟢 Yes: ${yesOdds}%  🔴 No: ${100 - yesOdds}%\n` +
          `💰 Volume: ${volume}\n` +
          `🌍 Source: Polymarket\n` +
          `📂 Category: ${pmMarket.category || 'Others'}`,
          {
            reply_markup: JSON.stringify({
              inline_keyboard: [[
                { text: '🎯 Trade on Crediplex', url: 'https://crediplex.name.ng/markets' },
                { text: '🌍 View on Polymarket', url: pmUrl }
              ]]
            })
          }
        );
        return;
      }

      await sendTelegramMessage(chatId, '❌ No market found for that search. Try different keywords.');
      return;
    }

    // ── /wallet ──
    if (command === '/wallet') {
      if (!args) {
        await sendTelegramMessage(chatId,
          `💼 <b>Usage:</b> /wallet &lt;address or username&gt;\n\n` +
          `<b>Examples:</b>\n` +
          `/wallet 0x56687bf447db...\n` +
          `/wallet Theo4`
        );
        return;
      }

      await sendTelegramMessage(chatId, '🔍 Looking up trader...');
      await handleWalletCommand(chatId, args);
      return;
    }

    // ── /pnl ──
    if (command === '/pnl') {
      if (!args) {
        await sendTelegramMessage(chatId,
          `📈 <b>Usage:</b> /pnl &lt;address or username&gt;\n\n` +
          `<b>Examples:</b>\n` +
          `/pnl 0x56687bf447db...\n` +
          `/pnl Theo4`
        );
        return;
      }

      await sendTelegramMessage(chatId, '🔍 Fetching P&L breakdown...');
      await handlePnlCommand(chatId, args);
      return;
    }

    // ── /track ──
    if (command === '/track') {
      if (!args) {
        await sendTelegramMessage(chatId,
          `📍 <b>Usage:</b> /track &lt;address or username&gt;\n\n` +
          `<b>Example:</b>\n` +
          `/track 0x56687bf447db...\n` +
          `/track Theo4\n\n` +
          `You'll get notified when this wallet makes a trade.`
        );
        return;
      }

      // Resolve to address
      let address = args;
      if (!args.startsWith('0x')) {
        const profile = await fetchPolymarketTrader(args);
        if (!profile) {
          await sendTelegramMessage(chatId, `❌ Trader <b>${args}</b> not found on Polymarket.`);
          return;
        }
        address = profile.proxyWallet || profile.address;
      }

      // Save to tracked_wallets collection
      await db.collection('telegramTrackedWallets').doc(`${chatId}_${address}`).set({
        chatId: chatId.toString(),
        address,
        query: args,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await sendTelegramMessage(chatId,
        `✅ <b>Now tracking:</b>\n<code>${address}</code>\n\n` +
        `You'll be notified of new trades.\n` +
        `Use /untrack to stop.`
      );
      return;
    }

    // ── /untrack ──
    if (command === '/untrack') {
      const snap = await db.collection('telegramTrackedWallets')
        .where('chatId', '==', chatId.toString())
        .get();

      if (snap.empty) {
        await sendTelegramMessage(chatId, `ℹ️ You're not tracking any wallets.`);
        return;
      }

      const wallets = snap.docs.map(d => d.data());

      // Show list with inline buttons
      const buttons = wallets.map(w => [{
        text: `❌ ${w.query || w.address.substring(0, 16) + '...'}`,
        callback_data: `untrack_${w.address}`
      }]);

      await sendTelegramMessage(chatId,
        `📍 <b>Your tracked wallets:</b>\nTap to untrack:`,
        {
          reply_markup: JSON.stringify({ inline_keyboard: buttons })
        }
      );
      return;
    }

    // ── Unknown command ──
    await sendTelegramMessage(chatId,
      `❓ Unknown command. Use /help to see all commands.`
    );

  } catch (err) {
    console.error('Telegram webhook error:', err.message);
  }
});

// ─── CALLBACK QUERY HANDLER (inline button taps) ──────────────
app.post('/api/telegram-callback', async (req, res) => {
  res.json({ ok: true });
  try {
    const query = req.body?.callback_query;
    if (!query) return;

    const chatId = query.message?.chat?.id;
    const data = query.data;

    // Answer the callback to remove loading spinner
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: query.id })
    });

    if (data?.startsWith('untrack_')) {
      const address = data.replace('untrack_', '');
      await db.collection('telegramTrackedWallets').doc(`${chatId}_${address}`).delete();
      await sendTelegramMessage(chatId,
        `✅ Stopped tracking <code>${address.substring(0, 20)}...</code>`
      );
    }
  } catch (e) { console.log('Callback error:', e.message); }
});

// ─── WALLET COMMAND HANDLER ───────────────────────────────────
async function handleWalletCommand(chatId, query) {
  // Try Crediplex first
  try {
    const usersSnap = await db.collection('users')
      .where('username', '==', query)
      .limit(1)
      .get();

    if (!usersSnap.empty) {
      const u = usersSnap.docs[0].data();
      const wr = u.totalBets > 0 ? Math.round((u.wins || 0) / u.totalBets * 100) : 0;
      const profitSign = (u.profit || 0) >= 0 ? '+' : '';
      const profitEmoji = (u.profit || 0) >= 0 ? '🟢' : '🔴';

      await sendTelegramMessage(chatId,
        `👤 <b>${u.username}</b>  [Crediplex]\n\n` +
        `💰 P&L: ${profitSign}₦${Math.abs(u.profit || 0).toLocaleString()} ${profitEmoji}\n` +
        `📊 Total Bets: ${u.totalBets || 0}\n` +
        `✅ Wins: ${u.wins || 0}  ❌ Losses: ${u.losses || 0}\n` +
        `🎯 Win Rate: ${wr}%\n` +
        `💵 Balance: ₦${(u.balance || 0).toLocaleString()}`,
        {
          reply_markup: JSON.stringify({
            inline_keyboard: [[
              { text: '📈 View on Crediplex', url: 'https://crediplex.name.ng/copy-trade' }
            ]]
          })
        }
      );
      return;
    }
  } catch (e) {}

  // Try Polymarket
  const profile = await fetchPolymarketTrader(query);
  if (!profile) {
    await sendTelegramMessage(chatId,
      `❌ Trader <b>${query}</b> not found.\n\nTry using their full 0x wallet address.`
    );
    return;
  }

  const name = profile.name || profile.pseudonym || profile.username ||
    (profile.address ? profile.address.substring(0, 8) + '...' : query);
  const profit = parseFloat(profile.profitAndLoss || profile.pnl || profile.profit || 0);
  const volume = parseFloat(profile.volume || profile.totalVolume || 0);
  const totalTrades = profile.numTrades || profile.numPositions || 0;
  const profitSign = profit >= 0 ? '+' : '';
  const profitEmoji = profit >= 0 ? '🟢' : '🔴';
  const address = profile.proxyWallet || profile.address || '';

  const positions = await fetchPolymarketPositions(address);
  const openPositions = positions.filter(p => p.size > 0 || p.currentValue > 0);

  let biggestWins = '';
  if (profile.biggestWins || profile.topPositions) {
    const wins = profile.biggestWins || profile.topPositions || [];
    biggestWins = wins.slice(0, 3).map(w => {
      const title = (w.title || w.market || '').substring(0, 45);
      const pnl = w.pnl || w.profit || 0;
      return `  ${title}…  ${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(0)}`;
    }).join('\n');
  }

  const weekPnl = parseFloat(profile.weekPnl || profile.profitAndLoss7d || 0);
  const weekSign = weekPnl >= 0 ? '+' : '';
  const weekEmoji = weekPnl >= 0 ? '🟢' : '🔴';

  await sendTelegramMessage(chatId,
    `🟢 <b>${name}</b>\n` +
    `📅 Trades: ${totalTrades}\n\n` +
    `💰 All-time PnL    ${profitSign}$${Math.abs(profit).toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
    `📊 Volume          $${(volume / 1000).toFixed(1)}K\n` +
    (weekPnl !== 0 ? `📈 This week       ${weekSign}$${Math.abs(weekPnl).toFixed(0)} ${weekEmoji}\n` : '') +
    (biggestWins ? `\n🏆 <b>Biggest wins:</b>\n${biggestWins}\n` : '') +
    `\n📍 ${openPositions.length} open position${openPositions.length !== 1 ? 's' : ''}\n` +
    `<i>Powered by Crediplex</i>`,
    {
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: '📊 See Positions', callback_data: `positions_${address}` },
          { text: '🎯 Copy Trade', url: `https://crediplex.name.ng/copy-trade` }
        ]]
      })
    }
  );
}

// ─── PNL COMMAND HANDLER ──────────────────────────────────────
async function handlePnlCommand(chatId, query) {
  const profile = await fetchPolymarketTrader(query);
  if (!profile) {
    // Try Crediplex
    try {
      const snap = await db.collection('users').where('username', '==', query).limit(1).get();
      if (!snap.empty) {
        const u = snap.docs[0].data();
        const betsSnap = await db.collection('bets')
          .where('uid', '==', snap.docs[0].id)
          .where('status', 'in', ['won', 'lost'])
          .get();

        const bets = betsSnap.docs.map(d => d.data());
        const won = bets.filter(b => b.status === 'won');
        const lost = bets.filter(b => b.status === 'lost');
        const totalProfit = won.reduce((s, b) => s + ((b.winAmount || 0) - (b.amount || 0)), 0)
          - lost.reduce((s, b) => s + (b.amount || 0), 0);

        await sendTelegramMessage(chatId,
          `📈 <b>P&L Breakdown — ${u.username}</b> [Crediplex]\n\n` +
          `💰 Total P&L: ${totalProfit >= 0 ? '+' : ''}₦${Math.abs(totalProfit).toLocaleString()}\n` +
          `✅ Winning bets: ${won.length}\n` +
          `❌ Losing bets: ${lost.length}\n` +
          `📊 Total closed: ${bets.length}\n` +
          `🎯 Win rate: ${bets.length > 0 ? Math.round(won.length / bets.length * 100) : 0}%`
        );
        return;
      }
    } catch (e) {}

    await sendTelegramMessage(chatId,
      `❌ Trader <b>${query}</b> not found.`
    );
    return;
  }

  const name = profile.name || profile.pseudonym || query;
  const profit = parseFloat(profile.profitAndLoss || profile.pnl || 0);
  const volume = parseFloat(profile.volume || 0);
  const totalTrades = profile.numTrades || 0;
  const wr = profile.winRate ? Math.round(parseFloat(profile.winRate) * 100) : null;

  // Build last-14-day breakdown if available
  const profitSign = profit >= 0 ? '+' : '';
  const profitEmoji = profit >= 0 ? '📈' : '📉';

  await sendTelegramMessage(chatId,
    `${profitEmoji} <b>P&L Breakdown — ${name}</b>\n\n` +
    `💰 All-time P&L: ${profitSign}$${Math.abs(profit).toLocaleString('en-US', { maximumFractionDigits: 0 })}\n` +
    `📊 Total Volume: $${(volume / 1000).toFixed(1)}K\n` +
    `🔢 Total Trades: ${totalTrades}\n` +
    (wr !== null ? `🎯 Win Rate: ${wr}%\n` : '') +
    `\n<i>Full chart available on Crediplex</i>`,
    {
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: '📊 Full Profile', url: `https://crediplex.name.ng/copy-trade` }
        ]]
      })
    }
  );
}

// ─── REGISTER TELEGRAM WEBHOOK ON STARTUP ────────────────────
async function registerTelegramWebhook() {
  const serverUrl = process.env.SERVER_URL || 'https://crediplex-production.up.railway.app';
  try {
    const res = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${serverUrl}/api/telegram-webhook`,
        allowed_updates: ['message', 'callback_query']
      })
    });
    const data = await res.json();
    console.log('✅ Telegram webhook registered:', data.description || data.result);
  } catch (e) {
    console.log('❌ Telegram webhook registration failed:', e.message);
  }
}

setTimeout(registerTelegramWebhook, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Crediplex server running on port ${PORT}`);
});
