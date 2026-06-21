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
let _existingPmIdsCache = null;
let _pmCacheBuiltAt = 0;

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
              const rawWinAmt = winningSidePool > 0
                ? Math.floor((totalPool * 0.90 / winningSidePool) * Number(b.amount || 0))
                : Number(b.amount || 0);
              const rawProfit = rawWinAmt - Number(b.amount || 0);
              const profitPct = Number(b.amount || 0) > 0 ? (rawProfit / Number(b.amount || 0)) * 100 : 0;
              const extraFee = profitPct >= 15 ? Math.floor(rawProfit * 0.10) : 0;
              const winAmt = rawWinAmt - extraFee;
              const profit = winAmt - Number(b.amount || 0);

              if (extraFee > 0) {
                const adminUid = 'WEw1TEQXJhZhmls7ppb4D0zxMv62';
                tx.update(db.collection('users').doc(adminUid), {
                  balance: admin.firestore.FieldValue.increment(extraFee)
                });
                const feeTxRef = db.collection('transactions').doc();
                tx.set(feeTxRef, {
                  uid: adminUid,
                  type: 'platform_fee',
                  amount: extraFee,
                  fromUser: b.uid,
                  marketId: m.id,
                  note: 'Platform fee from bet win (profit ≥ 15%)',
                  createdAt: admin.firestore.FieldValue.serverTimestamp()
                });
              }

              if (b.isBonus) {
                // Bonus bet: only 5% of net profit to withdrawal wallet
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

setTimeout(() => pollAllCopyRelations(db, admin), 60 * 1000);
setInterval(() => pollAllCopyRelations(db, admin), 20 * 60 * 1000);
console.log('🔄 Copy trade poller started (every 20 min)');
// ─── AUTO POLYMARKET SYNC (every 2 minutes) ───────────────────
async function autoSyncPolymarketMarkets() {
  console.log('🔄 Auto-syncing Polymarket markets...');
  let imported = 0;
  let updated = 0;
  let page = 0;
  const batchSize = 100;

  try {
    // Only re-read the whole markets collection once every 6 hours — otherwise reuse memory cache
    const cacheAge = Date.now() - _pmCacheBuiltAt;
    if (!_existingPmIdsCache || cacheAge > 6 * 60 * 60 * 1000) {
      const existingSnap = await db.collection('markets').where('source', '==', 'polymarket').get();
      _existingPmIdsCache = {};
      existingSnap.forEach(d => {
        const pmId = d.data().polymarketId;
        if (pmId) _existingPmIdsCache[pmId] = d;
      });
      _pmCacheBuiltAt = Date.now();
      console.log(`📦 Rebuilt Polymarket ID cache: ${Object.keys(_existingPmIdsCache).length} markets`);
    }
    const existingPmIds = _existingPmIdsCache;

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

      // Group multi-candidate events (>1 sub-market) into ONE multi-outcome market.
      // Keep single-market events as normal binary markets.
      const allMarkets = [];
      let _multiOutcomeCount = 0;
      for (const event of data) {
        if (event.markets && Array.isArray(event.markets) && event.markets.length > 1) {
          _multiOutcomeCount++;
          const activeSubMarkets = event.markets.filter(m => m.active !== false && m.closed !== true);
          if (!activeSubMarkets.length) continue;
          const outcomes = activeSubMarkets.map(m => m.groupItemTitle || m.question || 'Option');
          const outcomePrices = activeSubMarkets.map(m => {
            try { const p = JSON.parse(m.outcomePrices || '[]'); return parseFloat(p[0] || 0.5); }
            catch(e){ return 0.5; }
          });
          allMarkets.push({
            id: event.id,
            conditionId: event.id,
            question: event.title || event.question,
            image: event.image,
            endDate: event.endDate,
            tags: event.tags,
            volume: event.volume,
            active: event.active,
            closed: event.closed,
            outcomes: JSON.stringify(outcomes),
            outcomePrices: JSON.stringify(outcomePrices)
          });
        } else if (event.markets && Array.isArray(event.markets) && event.markets.length === 1) {
          const m = event.markets[0];
          if (!m.question) m.question = event.title || event.question;
          if (!m.image) m.image = event.image;
          if (!m.endDate) m.endDate = event.endDate;
          if (!m.tags) m.tags = event.tags;
          allMarkets.push(m);
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
            const hasActivity = (existing.yesPool || 0) + (existing.noPool || 0) + (existing.totalPool || 0) > 0;
            const updateData = {
              polymarketYesOdds: yesOdds,
              deadline,
            };
            if (!hasActivity) {
              updateData.polymarketVolume = pm.volume || 0;
              updateData.outcomes = JSON.stringify(outcomesArr);
              updateData.outcomePrices = JSON.stringify(outcomePricesArr);
              updateData.outcomeCount = outcomesArr.length;
              updateData.question = pm.question;
              if (imageUrl) updateData.imageUrl = imageUrl;
            }
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
        
_existingPmIdsCache[pmId] = true; // remember it so we don't re-import it before the next cache rebuild

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
      if (page >= 5) break;
      await new Promise(r => setTimeout(r, 200));
    }

    console.log(`✅ Auto-sync done: ${imported} new, ${updated} updated, ${typeof _multiOutcomeCount !== 'undefined' ? _multiOutcomeCount : 0} multi-outcome events detected`);
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
  if (combined.includes('election') || combined.includes('ballot') || combined.includes('presidential election') || combined.includes('primary')) return 'Election';
  if (combined.includes('nigeria') || combined.includes('kenya') || combined.includes('ghana') || combined.includes('south africa') || combined.includes('ethiopia') || combined.includes('egypt') || combined.includes('uganda') || combined.includes('tanzania') || combined.includes('senegal') || combined.includes('cameroon') || combined.includes('zimbabwe') || combined.includes('rwanda') || combined.includes('algeria') || combined.includes('morocco') || combined.includes('tinubu') || combined.includes('obi ')) return 'Politics';
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
setTimeout(autoSyncPolymarketMarkets, 60 * 1000);
setInterval(autoSyncPolymarketMarkets, 60 * 60 * 1000);
console.log('🔄 Auto Polymarket sync started (every 60 min)');
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
// When user starts the bot, bot generates a code and stores it linked to chatId
// User then pastes that code into Crediplex app to link account

// POST /api/verify-telegram-code
// Called by frontend with { userId, code }
app.post('/api/verify-telegram-code', async (req, res) => {
  try {
    const { userId, code } = req.body;
    if (!userId || !code) return res.status(400).json({ success: false, error: 'Missing fields' });

    const snap = await db.collection('telegramVerifyCodes')
      .where('code', '==', code.trim())
      .where('used', '==', false)
      .limit(1)
      .get();

    if (snap.empty) return res.json({ success: false, error: 'Invalid or expired code' });

    const codeDoc = snap.docs[0];
    const codeData = codeDoc.data();

    if (codeData.expiresAt.toDate() < new Date()) {
      return res.json({ success: false, error: 'Code expired. Start the bot again to get a new code.' });
    }

    const chatId = codeData.chatId;

    // Mark code as used
    await codeDoc.ref.update({ used: true, linkedUserId: userId });

    // Save chatId to user document
    await db.collection('users').doc(userId).update({ telegramChatId: chatId.toString() });

    // Get user info to send welcome message
    const userSnap = await db.collection('users').doc(userId).get();
    const crediplexUsername = userSnap.exists ? userSnap.data().username : 'User';

    // Send confirmation to Telegram
    await sendTelegramMessage(chatId,
      `✅ <b>Account linked successfully!</b>\n\n` +
      `Welcome, <b>${crediplexUsername}</b>! 🎉\n\n` +
      `You'll now receive notifications here whenever a copy trade is placed for you.\n\n` +
      `Use /help to see all available commands.`
    );

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy endpoint kept for compatibility
app.post('/api/generate-verify-code', async (req, res) => {
  res.json({ success: false, error: 'Use the Telegram bot /start command to get your code instead.' });
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
    // Handle callback_query (button taps) inline
    if (req.body?.callback_query) {
      const cbQuery = req.body.callback_query;
      const cbChatId = cbQuery.message?.chat?.id;
      const cbData = cbQuery.data;
      const cbUsername = cbQuery.from?.username || cbQuery.from?.first_name || 'User';

      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cbQuery.id })
      });

      if (cbData?.startsWith('untrack_') && cbData !== 'untrack_all') {
        const addr = cbData.replace('untrack_', '');
        await db.collection('telegramTrackedWallets').doc(`${cbChatId}_${addr}`).delete().catch(() => {});
        await sendTelegramMessage(cbChatId, `✅ Stopped tracking <code>${addr.substring(0, 14)}...</code>`);
      } else if (cbData === 'untrack_all') {
        const snap = await db.collection('telegramTrackedWallets').where('chatId', '==', cbChatId.toString()).get();
        await Promise.all(snap.docs.map(d => d.ref.delete()));
        await sendTelegramMessage(cbChatId, `✅ Stopped tracking all wallets.`);
      } else if (cbData?.startsWith('skip_copy_')) {
        await sendTelegramMessage(cbChatId, `✅ You'll be notified of new trades but no auto-copy.\n\nUse /untrack to stop at any time.`);
      } else if (cbData?.startsWith('copy_') && cbData?.endsWith('_custom')) {
        const addr = cbData.replace('copy_', '').replace('_custom', '');
        await db.collection('telegramPendingInput').doc(cbChatId.toString()).set({
          type: 'custom_copy_amount', address: addr,
          chatId: cbChatId.toString(),
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await sendTelegramMessage(cbChatId, `✏️ <b>Custom amount</b>\n\nType the ₦ amount you want to stake per trade.\n\nExample: <code>3000</code>`);
      } else if (cbData?.startsWith('copy_')) {
        const parts = cbData.split('_');
        const amount = parseInt(parts[parts.length - 1]);
        const addr = parts.slice(1, parts.length - 1).join('_');
        if (!amount || amount < 100) { await sendTelegramMessage(cbChatId, `❌ Minimum is ₦100.`); return; }
        const userSnap = await db.collection('users').where('telegramChatId', '==', cbChatId.toString()).limit(1).get();
        if (userSnap.empty) { await sendTelegramMessage(cbChatId, `❌ Link your account first. Use /start.`); return; }
        const userId = userSnap.docs[0].id;
        const userData = userSnap.docs[0].data();
        const trackedSnap = await db.collection('telegramTrackedWallets').doc(`${cbChatId}_${addr}`).get();
        const traderName = trackedSnap.exists ? (trackedSnap.data().traderName || addr) : addr;
        const existingQ = await db.collection('copyRelations').where('copierId', '==', userId).where('traderId', '==', addr).limit(1).get();
        if (!existingQ.empty) {
          await existingQ.docs[0].ref.update({ fixedBetAmount: amount, copyMode: 'fixed', multiplier: 1, isPolymarket: true });
        } else {
          await db.collection('copyRelations').add({
            copierId: userId, traderId: addr, copierName: userData.username || 'User',
            traderName, traderImg: '', multiplier: 1, fixedBetAmount: amount,
            copyMode: 'fixed', maxPerTrade: 0, isPolymarket: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        }
        await sendTelegramMessage(cbChatId, `✅ Auto-copy set! Staking ₦${amount.toLocaleString()} per trade when <b>${traderName}</b> trades.\n\nUse /untrack to stop.`);
      }
      return;
    }

    const message = req.body?.message || req.body?.edited_message;
    if (!message) return;

    const chatId = message.chat?.id;
    const text = (message.text || '').trim();
    const username = message.from?.username || message.from?.first_name || 'User';

    if (!text.startsWith('/')) {
      // Check if user has a pending input waiting (e.g. custom copy amount)
      await handlePendingInput(chatId, text);
      return;
    }

    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase().split('@')[0]; // strip @BotName
    const args = parts.slice(1).join(' ').trim();

    // ── /market ──
    if (command === '/market') {
      if (!args) {
        await sendTelegramMessage(chatId,
          `📊 <b>Usage:</b> /market &lt;search term&gt;\n\n` +
          `<b>Examples:</b>\n` +
          `/market world cup\n` +
          `/market bitcoin\n` +
          `/market trump\n` +
          `/market nigeria election`
        );
        return;
      }

      await sendTelegramMessage(chatId, '🔍 Searching markets...');

      const lower = args.toLowerCase();
      const queryWords = lower.split(/\s+/).filter(w => w.length > 1);

      // Search Crediplex markets (already synced from Polymarket)
      let results = [];
      try {
        const snap = await db.collection('markets').where('status', '==', 'active').get();
        results = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .map(m => {
            const q = (m.question || '').toLowerCase();
            let score = 0;
            queryWords.forEach(word => {
              if (q.includes(word)) score += 10;
            });
            score += Math.log10(((m.yesPool || 0) + (m.noPool || 0) + (m.polymarketVolume || 0)) + 1);
            return { ...m, _score: score };
          })
          .filter(m => m._score > 0)
          .sort((a, b) => b._score - a._score)
          .slice(0, 5);
      } catch (e) {}

      if (results.length === 0) {
        // Direct Polymarket search as fallback
        try {
          const pmRes = await fetch(
            `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&search=${encodeURIComponent(args)}&order=volume&ascending=false`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (pmRes.ok) {
            const pmData = await pmRes.json();
            if (Array.isArray(pmData) && pmData.length) {
              for (const pm of pmData.slice(0, 5)) {
                let yesOdds = 50;
                try {
                  const prices = JSON.parse(pm.outcomePrices || '[]');
                  if (prices[0]) yesOdds = Math.round(parseFloat(prices[0]) * 100);
                } catch (e) {}
                results.push({
                  question: pm.question,
                  yesOdds,
                  noOdds: 100 - yesOdds,
                  volume: pm.volume || 0,
                  isPm: true,
                  pmUrl: pm.slug ? `https://polymarket.com/event/${pm.slug}` : 'https://polymarket.com',
                  category: pm.category || 'Others'
                });
              }
            }
          }
        } catch (e) {}
      }

      if (!results.length) {
        await sendTelegramMessage(chatId, `❌ No markets found for "<b>${args}</b>". Try different keywords.`);
        return;
      }

      // Show top result in detail + list others
      const top = results[0];
      const total = (top.yesPool || 0) + (top.noPool || 0);
      const yp = top.yesOdds || (total > 0 ? Math.round((top.yesPool || 0) / total * 100) : 50);
      const slug = top.slug || top.id;
      const volume = top.isPm
        ? `$${Number(top.volume || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        : `₦${Number(total).toLocaleString()}`;

      let msg = `📊 <b>${top.question}</b>\n\n` +
        `🟢 Yes: ${yp}%   🔴 No: ${100 - yp}%\n` +
        `💰 Volume: ${volume}\n` +
        `📂 ${top.category || 'Others'}\n`;

      // Show up to 4 other results
      if (results.length > 1) {
        msg += `\n<b>Related markets:</b>\n`;
        results.slice(1, 5).forEach((m, i) => {
          const t2 = (m.yesPool || 0) + (m.noPool || 0);
          const yp2 = m.yesOdds || (t2 > 0 ? Math.round((m.yesPool || 0) / t2 * 100) : 50);
          msg += `${i + 2}. ${(m.question || '').substring(0, 55)}…  [${yp2}% Yes]\n`;
        });
      }

      const buttons = [];
      if (top.isPm) {
        buttons.push([
          { text: '🎯 Trade on Crediplex', url: 'https://crediplex.name.ng/markets' },
          { text: '🌍 Polymarket', url: top.pmUrl }
        ]);
      } else {
        buttons.push([{ text: '🎯 Bet Now on Crediplex', url: `https://crediplex.name.ng/market/${slug}` }]);
      }

      await sendTelegramMessage(chatId, msg, {
        reply_markup: JSON.stringify({ inline_keyboard: buttons })
      });
      return;
    }
// ── /start ──
    if (command === '/start') {
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      await db.collection('telegramVerifyCodes').add({
        code,
        chatId: chatId.toString(),
        used: false,
        expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await sendTelegramMessage(chatId,
        `👋 <b>Welcome to Crediplex!</b>\n\n` +
        `Your verification code:\n\n<code>${code}</code>\n\n` +
        `Paste this into Crediplex (Settings → Telegram) within 10 minutes to link your account.\n\n` +
        `Use /help to see all commands.`
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
        `/market &lt;keyword&gt; — Search a prediction market\n` +
        `/wallet &lt;address or username&gt; — Trader stats\n` +
        `/pnl &lt;address or username&gt; — P&L breakdown\n` +
        `/track &lt;address or username&gt; — Track & copy a wallet\n` +
        `/untrack — Manage wallets you're tracking\n\n` +
        `💬 For account issues, email us directly.`,
        {
          reply_markup: JSON.stringify({
            inline_keyboard: [
              [{ text: '🌐 crediplex.name.ng', url: 'https://crediplex.name.ng' }],
              [{ text: '📧 care@crediplex.name.ng', url: 'mailto:care@crediplex.name.ng' }]
            ]
          })
        }
      );
      return;
    }

    // ── /market ──
    if (command === '/market') {
      if (!args) {
        await sendTelegramMessage(chatId,
          `📊 <b>Usage:</b> /market &lt;search term&gt;\n\n` +
          `<b>Examples:</b>\n` +
          `/market world cup\n` +
          `/market bitcoin\n` +
          `/market trump\n` +
          `/market nigeria election`
        );
        return;
      }

      await sendTelegramMessage(chatId, '🔍 Searching markets...');

      const lower = args.toLowerCase();
      const queryWords = lower.split(/\s+/).filter(w => w.length > 1);

      // Search Crediplex markets (already synced from Polymarket)
      let results = [];
      try {
        const snap = await db.collection('markets').where('status', '==', 'active').get();
        results = snap.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .map(m => {
            const q = (m.question || '').toLowerCase();
            let score = 0;
            queryWords.forEach(word => {
              if (q.includes(word)) score += 10;
            });
            score += Math.log10(((m.yesPool || 0) + (m.noPool || 0) + (m.polymarketVolume || 0)) + 1);
            return { ...m, _score: score };
          })
          .filter(m => m._score > 0)
          .sort((a, b) => b._score - a._score)
          .slice(0, 5);
      } catch (e) {}

      if (results.length === 0) {
        // Direct Polymarket search as fallback
        try {
          const pmRes = await fetch(
            `https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=5&search=${encodeURIComponent(args)}&order=volume&ascending=false`,
            { signal: AbortSignal.timeout(10000) }
          );
          if (pmRes.ok) {
            const pmData = await pmRes.json();
            if (Array.isArray(pmData) && pmData.length) {
              for (const pm of pmData.slice(0, 5)) {
                let yesOdds = 50;
                try {
                  const prices = JSON.parse(pm.outcomePrices || '[]');
                  if (prices[0]) yesOdds = Math.round(parseFloat(prices[0]) * 100);
                } catch (e) {}
                results.push({
                  question: pm.question,
                  yesOdds,
                  noOdds: 100 - yesOdds,
                  volume: pm.volume || 0,
                  isPm: true,
                  pmUrl: pm.slug ? `https://polymarket.com/event/${pm.slug}` : 'https://polymarket.com',
                  category: pm.category || 'Others'
                });
              }
            }
          }
        } catch (e) {}
      }

      if (!results.length) {
        await sendTelegramMessage(chatId, `❌ No markets found for "<b>${args}</b>". Try different keywords.`);
        return;
      }

      // Show top result in detail + list others
      const top = results[0];
      const total = (top.yesPool || 0) + (top.noPool || 0);
      const yp = top.yesOdds || (total > 0 ? Math.round((top.yesPool || 0) / total * 100) : 50);
      const slug = top.slug || top.id;
      const volume = top.isPm
        ? `$${Number(top.volume || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`
        : `₦${Number(total).toLocaleString()}`;

      let msg = `📊 <b>${top.question}</b>\n\n` +
        `🟢 Yes: ${yp}%   🔴 No: ${100 - yp}%\n` +
        `💰 Volume: ${volume}\n` +
        `📂 ${top.category || 'Others'}\n`;

      // Show up to 4 other results
      if (results.length > 1) {
        msg += `\n<b>Related markets:</b>\n`;
        results.slice(1, 5).forEach((m, i) => {
          const t2 = (m.yesPool || 0) + (m.noPool || 0);
          const yp2 = m.yesOdds || (t2 > 0 ? Math.round((m.yesPool || 0) / t2 * 100) : 50);
          msg += `${i + 2}. ${(m.question || '').substring(0, 55)}…  [${yp2}% Yes]\n`;
        });
      }

      const buttons = [];
      if (top.isPm) {
        buttons.push([
          { text: '🎯 Trade on Crediplex', url: 'https://crediplex.name.ng/markets' },
          { text: '🌍 Polymarket', url: top.pmUrl }
        ]);
      } else {
        buttons.push([{ text: '🎯 Bet Now on Crediplex', url: `https://crediplex.name.ng/market/${slug}` }]);
      }

      await sendTelegramMessage(chatId, msg, {
        reply_markup: JSON.stringify({ inline_keyboard: buttons })
      });
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
          `📍 <b>Usage:</b> /track &lt;0x address or username&gt;\n\n` +
          `<b>Examples:</b>\n` +
          `/track 0x56687bf447db...\n` +
          `/track Theo4\n\n` +
          `You'll get notified when this wallet makes a trade, and can choose to copy them.`
        );
        return;
      }

      await sendTelegramMessage(chatId, '🔍 Looking up trader on Polymarket...');

      // Resolve to address
      let address = args;
      let traderName = args;
      let profile = null;

      if (!args.startsWith('0x')) {
        profile = await fetchPolymarketTrader(args);
        if (!profile) {
          await sendTelegramMessage(chatId, `❌ Trader "<b>${args}</b>" not found on Polymarket.\n\nTry using their full 0x wallet address.`);
          return;
        }
        address = profile.proxyWallet || profile.address;
        traderName = profile.name || profile.pseudonym || args;
      } else {
        // Fetch profile for the address
        profile = await fetchPolymarketTrader(args);
        if (profile) traderName = profile.name || profile.pseudonym || args;
      }

      if (!address) {
        await sendTelegramMessage(chatId, `❌ Could not resolve wallet address for "<b>${args}</b>".`);
        return;
      }

      const profit = parseFloat(profile?.profitAndLoss || profile?.pnl || 0);
      const volume = parseFloat(profile?.volume || 0);
      const totalTrades = profile?.numTrades || 0;
      const profitSign = profit >= 0 ? '+' : '';
      const profitEmoji = profit >= 0 ? '🟢' : '🔴';
      const shortAddr = address.substring(0, 10) + '...' + address.substring(address.length - 6);

      // Save to tracked_wallets collection
      await db.collection('telegramTrackedWallets').doc(`${chatId}_${address}`).set({
        chatId: chatId.toString(),
        address,
        traderName,
        query: args,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      await sendTelegramMessage(chatId,
        `✅ <b>Now tracking: ${traderName}</b>\n` +
        `<code>${shortAddr}</code>\n\n` +
        `💰 All-time P&L: ${profitSign}$${Math.abs(profit).toLocaleString('en-US', { maximumFractionDigits: 0 })} ${profitEmoji}\n` +
        `📊 Volume: $${(volume / 1000).toFixed(1)}K\n` +
        `🔢 Trades: ${totalTrades}\n\n` +
        `You'll be notified of new trades.\n\n` +
        `<b>Want to auto-copy this trader?</b>\nChoose your copy amount:`,
        {
          reply_markup: JSON.stringify({
            inline_keyboard: [
              [
                { text: '₦500/trade', callback_data: `copy_${address}_500` },
                { text: '₦1,000/trade', callback_data: `copy_${address}_1000` },
                { text: '₦2,500/trade', callback_data: `copy_${address}_2500` }
              ],
              [
                { text: '₦5,000/trade', callback_data: `copy_${address}_5000` },
                { text: '✏️ Custom amount', callback_data: `copy_${address}_custom` }
              ],
              [
                { text: '⏭️ Skip — just notify me', callback_data: `skip_copy_${address}` }
              ]
            ]
          })
        }
      );
      return;
    }

    // ── /untrack ──
    if (command === '/untrack') {
      const snap = await db.collection('telegramTrackedWallets')
        .where('chatId', '==', chatId.toString())
        .get();

      if (snap.empty) {
        await sendTelegramMessage(chatId,
          `ℹ️ You're not tracking any wallets.\n\nUse /track &lt;address or username&gt; to start.`
        );
        return;
      }

      const wallets = snap.docs.map(d => ({ docId: d.id, ...d.data() }));

      const buttons = wallets.map(w => [{
        text: `❌ Untrack ${w.traderName || w.query || (w.address.substring(0, 12) + '...')}`,
        callback_data: `untrack_${w.address}`
      }]);

      buttons.push([{ text: '❌ Untrack ALL', callback_data: 'untrack_all' }]);

      let msg = `📍 <b>You're tracking ${wallets.length} wallet${wallets.length > 1 ? 's' : ''}:</b>\n\n`;
      wallets.forEach((w, i) => {
        const short = w.address.substring(0, 10) + '...' + w.address.substring(w.address.length - 6);
        msg += `${i + 1}. <b>${w.traderName || w.query || 'Trader'}</b>\n   <code>${short}</code>\n`;
      });
      msg += `\nTap a button below to untrack:`;

      await sendTelegramMessage(chatId, msg, {
        reply_markup: JSON.stringify({ inline_keyboard: buttons })
      });
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
    const username = query.from?.username || query.from?.first_name || 'User';

    // Answer the callback to remove loading spinner
    await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ callback_query_id: query.id })
    });

    // ── Untrack single wallet ──
    if (data?.startsWith('untrack_') && data !== 'untrack_all') {
      const address = data.replace('untrack_', '');
      await db.collection('telegramTrackedWallets').doc(`${chatId}_${address}`).delete();
      // Also remove any copy relations for this chatId+address
      await sendTelegramMessage(chatId,
        `✅ Stopped tracking <code>${address.substring(0, 14)}...</code>`
      );
      return;
    }

    // ── Untrack all ──
    if (data === 'untrack_all') {
      const snap = await db.collection('telegramTrackedWallets')
        .where('chatId', '==', chatId.toString()).get();
      const deletes = snap.docs.map(d => d.ref.delete());
      await Promise.all(deletes);
      await sendTelegramMessage(chatId, `✅ Stopped tracking all wallets.`);
      return;
    }

    // ── Skip copy (just track, no copy) ──
    if (data?.startsWith('skip_copy_')) {
      await sendTelegramMessage(chatId,
        `✅ Got it! You'll get notified of new trades but no auto-copy.\n\nUse /untrack to stop at any time.`
      );
      return;
    }

    // ── Custom copy amount prompt ──
    if (data?.startsWith('copy_') && data?.endsWith('_custom')) {
      const address = data.replace('copy_', '').replace('_custom', '');
      // Store pending custom request
      await db.collection('telegramPendingInput').doc(chatId.toString()).set({
        type: 'custom_copy_amount',
        address,
        chatId: chatId.toString(),
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      await sendTelegramMessage(chatId,
        `✏️ <b>Custom copy amount</b>\n\nReply with the amount in Naira (₦) you want to stake per trade.\n\nExample: <code>3000</code>`
      );
      return;
    }

    // ── Set copy amount ──
    if (data?.startsWith('copy_')) {
      const parts = data.split('_');
      const amount = parseInt(parts[parts.length - 1]);
      const address = parts.slice(1, parts.length - 1).join('_');

      if (!amount || amount < 100) {
        await sendTelegramMessage(chatId, `❌ Invalid amount. Minimum is ₦100.`);
        return;
      }

      // Find the user linked to this chatId
      const userSnap = await db.collection('users')
        .where('telegramChatId', '==', chatId.toString()).limit(1).get();

      if (userSnap.empty) {
        await sendTelegramMessage(chatId,
          `❌ Your Telegram is not linked to a Crediplex account yet.\n\nUse /start to get your link code.`
        );
        return;
      }

      const userId = userSnap.docs[0].id;
      const userData = userSnap.docs[0].data();

      // Get trader name from tracked wallets
      const trackedSnap = await db.collection('telegramTrackedWallets')
        .doc(`${chatId}_${address}`).get();
      const traderName = trackedSnap.exists ? (trackedSnap.data().traderName || address) : address;

      // Create copy relation in Firestore
      const existingQ = await db.collection('copyRelations')
        .where('copierId', '==', userId)
        .where('traderId', '==', address)
        .limit(1).get();

      if (!existingQ.empty) {
        // Update existing
        await existingQ.docs[0].ref.update({
          fixedBetAmount: amount,
          copyMode: 'fixed',
          multiplier: 1,
          maxPerTrade: 0,
          isPolymarket: true,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        await db.collection('copyRelations').add({
          copierId: userId,
          traderId: address,
          copierName: userData.username || 'User',
          traderName,
          traderImg: '',
          multiplier: 1,
          fixedBetAmount: amount,
          copyMode: 'fixed',
          maxPerTrade: 0,
          isPolymarket: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      await sendTelegramMessage(chatId,
        `✅ <b>Copy trading set up!</b>\n\n` +
        `You'll automatically stake <b>₦${amount.toLocaleString()}</b> per trade when <b>${traderName}</b> makes a move.\n\n` +
        `Use /untrack to stop at any time.`
      );
      return;
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
  let name, profit, volume, totalTrades, wr, address;

  // Try Crediplex first
  try {
    const snap = await db.collection('users').where('username', '==', query).limit(1).get();
    if (!snap.empty) {
      const u = snap.docs[0].data();
      const betsSnap = await db.collection('bets')
        .where('uid', '==', snap.docs[0].id)
        .where('status', 'in', ['won', 'lost'])
        .orderBy('createdAt', 'asc')
        .get();

      const bets = betsSnap.docs.map(d => d.data());
      const won = bets.filter(b => b.status === 'won');
      const lost = bets.filter(b => b.status === 'lost');
      const totalProfit = won.reduce((s, b) => s + ((b.winAmount || 0) - (b.amount || 0)), 0)
        - lost.reduce((s, b) => s + (b.amount || 0), 0);
      const winRate = bets.length > 0 ? Math.round(won.length / bets.length * 100) : 0;
      const profitSign = totalProfit >= 0 ? '+' : '';
      const profitEmoji = totalProfit >= 0 ? '📈' : '📉';

      // Build cumulative P&L string (text chart)
      let cumulative = 0;
      const chartPoints = bets.map(b => {
        if (b.status === 'won') cumulative += (b.winAmount || 0) - (b.amount || 0);
        else cumulative -= (b.amount || 0);
        return cumulative;
      });

      const maxPt = Math.max(...chartPoints, 0);
      const minPt = Math.min(...chartPoints, 0);
      const chartRows = 5;
      const chartCols = Math.min(chartPoints.length, 20);
      const step = Math.floor(chartPoints.length / chartCols) || 1;
      const sampled = [];
      for (let i = 0; i < chartPoints.length; i += step) sampled.push(chartPoints[i]);
      sampled.push(chartPoints[chartPoints.length - 1]);

      const range = maxPt - minPt || 1;
      let textChart = '';
      for (let row = chartRows - 1; row >= 0; row--) {
        const threshold = minPt + (range / chartRows) * row;
        textChart += sampled.map(v => v >= threshold ? '█' : '░').join('') + '\n';
      }

      await sendTelegramMessage(chatId,
        `${profitEmoji} <b>P&L — ${u.username}</b> [Crediplex]\n\n` +
        `<pre>${textChart}</pre>` +
        `💰 Total P&L: <b>${profitSign}₦${Math.abs(totalProfit).toLocaleString()}</b>\n` +
        `✅ Won: ${won.length}  ❌ Lost: ${lost.length}\n` +
        `📊 Closed bets: ${bets.length}\n` +
        `🎯 Win Rate: ${winRate}%`,
        {
          reply_markup: JSON.stringify({
            inline_keyboard: [[
              { text: '📊 View on Crediplex', url: 'https://crediplex.name.ng/portfolio' }
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
    await sendTelegramMessage(chatId, `❌ Trader <b>${query}</b> not found.\n\nTry their full 0x wallet address.`);
    return;
  }

  name = profile.name || profile.pseudonym || query;
  profit = parseFloat(profile.profitAndLoss || profile.pnl || 0);
  volume = parseFloat(profile.volume || 0);
  totalTrades = profile.numTrades || 0;
  wr = profile.winRate ? Math.round(parseFloat(profile.winRate) * 100) : null;
  address = profile.proxyWallet || profile.address || '';

  const profitSign = profit >= 0 ? '+' : '';
  const profitEmoji = profit >= 0 ? '📈' : '📉';

  // Fetch positions for extra context
  const positions = await fetchPolymarketPositions(address);
  const openCount = positions.filter(p => (p.size || p.currentValue || 0) > 0).length;

  await sendTelegramMessage(chatId,
    `${profitEmoji} <b>P&L — ${name}</b> [Polymarket]\n\n` +
    `💰 All-time P&L: <b>${profitSign}$${Math.abs(profit).toLocaleString('en-US', { maximumFractionDigits: 0 })}</b>\n` +
    `📊 Total Volume: $${(volume / 1000).toFixed(1)}K\n` +
    `🔢 Total Trades: ${totalTrades}\n` +
    (wr !== null ? `🎯 Win Rate: ${wr}%\n` : '') +
    `📍 Open Positions: ${openCount}\n\n` +
    `<i>Use /track ${query} to copy this trader</i>`,
    {
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: '🎯 Copy This Trader', callback_data: `track_prompt_${address}` },
          { text: '📊 View on Crediplex', url: 'https://crediplex.name.ng/copy-trade' }
        ]]
      })
    }
  );
}

// ─── HANDLE CUSTOM COPY AMOUNT TEXT INPUT ────────────────────
// When user types a number after being asked for custom copy amount
async function handlePendingInput(chatId, text) {
  try {
    const pendingSnap = await db.collection('telegramPendingInput').doc(chatId.toString()).get();
    if (!pendingSnap.exists) return false;

    const pending = pendingSnap.data();
    await pendingSnap.ref.delete();

    if (pending.type === 'custom_copy_amount') {
      const amount = parseInt(text.replace(/[^0-9]/g, ''));
      if (!amount || amount < 100) {
        await sendTelegramMessage(chatId, `❌ Please enter a valid amount (minimum ₦100).\n\nExample: <code>3000</code>`);
        return true;
      }

      const userSnap = await db.collection('users')
        .where('telegramChatId', '==', chatId.toString()).limit(1).get();

      if (userSnap.empty) {
        await sendTelegramMessage(chatId,
          `❌ Your Telegram is not linked yet. Use /start to link your account.`
        );
        return true;
      }

      const userId = userSnap.docs[0].id;
      const userData = userSnap.docs[0].data();
      const address = pending.address;

      const trackedSnap = await db.collection('telegramTrackedWallets')
        .doc(`${chatId}_${address}`).get();
      const traderName = trackedSnap.exists ? (trackedSnap.data().traderName || address) : address;

      const existingQ = await db.collection('copyRelations')
        .where('copierId', '==', userId)
        .where('traderId', '==', address)
        .limit(1).get();

      if (!existingQ.empty) {
        await existingQ.docs[0].ref.update({
          fixedBetAmount: amount, copyMode: 'fixed', multiplier: 1, maxPerTrade: 0, isPolymarket: true
        });
      } else {
        await db.collection('copyRelations').add({
          copierId: userId, traderId: address,
          copierName: userData.username || 'User',
          traderName, traderImg: '',
          multiplier: 1, fixedBetAmount: amount, copyMode: 'fixed',
          maxPerTrade: 0, isPolymarket: true,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      await sendTelegramMessage(chatId,
        `✅ <b>Set!</b> You'll stake <b>₦${amount.toLocaleString()}</b> per trade when <b>${traderName}</b> makes a move.\n\nUse /untrack to stop.`
      );
      return true;
    }
    return false;
  } catch (e) { return false; }
}

// ─── REGISTER TELEGRAM WEBHOOK ON STARTUP ────────────────────
async function registerTelegramWebhook() {
  const serverUrl = process.env.SERVER_URL || 'https://crediplex-production.up.railway.app';
  try {
    // Single webhook handles both messages AND callback_queries
    const res = await fetch(`${TELEGRAM_API}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: `${serverUrl}/api/telegram-webhook`,
        allowed_updates: ['message', 'callback_query', 'edited_message']
      })
    });
    const data = await res.json();
    console.log('✅ Telegram webhook registered:', data.description || data.result);
  } catch (e) {
    console.log('❌ Telegram webhook registration failed:', e.message);
  }
}

setTimeout(registerTelegramWebhook, 3000);

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Crediplex API', version: '2.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Crediplex server running on port ${PORT}`);
});
