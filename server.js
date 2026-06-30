const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const admin = require('firebase-admin');
const compression = require('compression');

const app = express();
app.use(compression()); // gzip all JSON responses — reduces bandwidth 60-80%

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
      // Notify user of pending/confirming status
      if (['waiting', 'confirming', 'sending'].includes(payment_status)) {
        try {
          const depSnap = await db.collection('deposits').doc(paymentIdStr).get();
          if (depSnap.exists) {
            const dep = depSnap.data();
            const userSnap = await db.collection('users').doc(dep.userId).get();
            const tgId = userSnap.exists ? userSnap.data().telegramChatId : null;
            if (tgId) {
              const statusMsg = payment_status === 'waiting' ? '⏳ Waiting for your payment...' : payment_status === 'confirming' ? '🔄 Payment received! Waiting for network confirmation...' : '📤 Payment confirmed, processing...';
              sendTelegramMessage(tgId,
                `${statusMsg}\n\n` +
                `Amount: <b>$${dep.amountUsd}</b> via <b>${(dep.coin||'').toUpperCase()}</b>\n\n` +
                `You'll get another message once your wallet is credited. Sit tight! 🙏`
              ).catch(()=>{});
            }
          }
        } catch(e) {}
      }
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
      // Notify user on Telegram (0 extra reads — userSnap already fetched above)
      const tgChatId = userSnap.data().telegramChatId;
      if (tgChatId) {
        sendTelegramMessage(tgChatId,
          `✅ <b>Deposit Confirmed!</b>\n\n` +
          `<b>$${amountUsd}</b> crypto deposit received.\n` +
          `<b>₦${amountNgn.toLocaleString('en-NG')}</b> has been credited to your wallet.\n\n` +
          `Rate used: ₦${rateToUse.toFixed(0)}/$`,
          { reply_markup: { inline_keyboard: [[{ text: '💰 Check Balance', callback_data: 'balance' }, { text: '📈 Bet Now', url: 'https://crediplex.name.ng' }]] }}
        ).catch(()=>{});
      }
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

    const userRef = db.collection('users').doc(userId);
    const amountNgn = Math.floor(amountUsd * liveUsdToNgn);
    // Verify balance before deducting to prevent overdraft
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ success: false, error: 'User not found.' });
    if ((userSnap.data().balance || 0) < amountNgn) {
      await wdRef.update({ status: 'failed', failReason: 'Insufficient balance at processing time' });
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
    // Notify user on Telegram (userSnap already fetched above — 0 extra reads)
    try {
      const tgId = userSnap.data().telegramChatId;
      if (tgId) {
        sendTelegramMessage(tgId,
          `💸 <b>Withdrawal Sent!</b>\n\n` +
          `<b>$${amountUsd}</b> (₦${amountNgn.toLocaleString('en-NG')}) is on its way.\n\n` +
          `Coin: <b>${currency.toUpperCase()}</b>\n` +
          `Address: <code>${address.substring(0,16)}...</code>\n` +
          `Rate used: ₦${liveUsdToNgn.toFixed(0)}/$\n\n` +
          `Usually arrives within 10–30 minutes. 🚀`,
          { reply_markup: { inline_keyboard: [[{ text: '💰 Check Balance', callback_data: 'balance' }]] }}
        ).catch(()=>{});
      }
    } catch(e) {}

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
    // Use in-memory cache first (0 Firestore reads). Only fall back if cache is empty.
    const now = Date.now();
    let candidates = [];

    if (_marketsCache.length) {
      // Filter cache for Polymarket markets past deadline
      candidates = _marketsCache
        .filter(m => m.source === 'polymarket' && m.status === 'active')
        .filter(m => {
          const dl = m.deadline?.toDate ? m.deadline.toDate() : (m.deadline?._seconds ? new Date(m.deadline._seconds * 1000) : null);
          return dl && dl <= new Date();
        })
        .map(m => ({ id: m.id, data: () => m, ...m })); // shape compatible with mktDoc.data()
    } else {
      // Cache empty — fall back to Firestore (rare)
      const nowTs = admin.firestore.Timestamp.now();
      const marketsSnap = await db.collection('markets')
        .where('status', '==', 'active')
        .where('deadline', '<=', nowTs)
        .get();
      candidates = marketsSnap.docs.filter(d => d.data().polymarketId);
    }

    const polyMarkets = candidates.filter(d => {
      const data = typeof d.data === 'function' ? d.data() : d;
      return data.polymarketId;
    });
    if (!polyMarkets.length) return;

    console.log(`🔍 Checking ${polyMarkets.length} Polymarket markets for resolution (from cache)...`);

    for (const mktDoc of polyMarkets) {
      const m = typeof mktDoc.data === 'function'
        ? { id: mktDoc.id, ...mktDoc.data() }
        : { ...mktDoc };

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
          // Exact match first, then partial, then price-based for multi-outcome
        let matchedOutcome = outcomesArr.find(o => o.toLowerCase() === winner.toLowerCase());
        if (!matchedOutcome) matchedOutcome = outcomesArr.find(o => o.toLowerCase().includes(winner.toLowerCase()));
        if (!matchedOutcome) matchedOutcome = outcomesArr.find(o => winner.toLowerCase().includes(o.toLowerCase()));
        // Final fallback: use highest outcomePrices index
        if (!matchedOutcome) {
          try {
            const prices = JSON.parse(data.outcomePrices || '[]').map(p => parseFloat(p));
            const maxIdx = prices.indexOf(Math.max(...prices));
            if (maxIdx >= 0 && outcomesArr[maxIdx]) matchedOutcome = outcomesArr[maxIdx];
          } catch(e) {}
        }
        if (!matchedOutcome) matchedOutcome = winner;
          const winKey = 'pool_' + matchedOutcome.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
          winningSidePool = Number(m[winKey] || 0);
          winner = matchedOutcome.toUpperCase();
        }

        // Run payout transaction
        await db.runTransaction(async tx => {
          const mktRef = db.collection('markets').doc(m.id);
          const mktNow = await tx.get(mktRef);
          if (mktNow.data().status !== 'active') return; // already resolved

          const ADMIN_UID = 'WEw1TEQXJhZhmls7ppb4D0zxMv62';

          // Flat 10% of entire pool goes to admin wallet
          const platformFee = Math.floor(totalPool * 0.10);
          const payoutPool = totalPool - platformFee; // 90% shared among winners

          for (const betDoc of betsSnap.docs) {
            const b = betDoc.data();
            const betRef = db.collection('bets').doc(betDoc.id);
            const betSide = (b.side || '').toUpperCase();

            if (betSide === winner) {
              const winAmt = winningSidePool > 0
                ? Math.floor((payoutPool / winningSidePool) * Number(b.amount || 0))
                : Number(b.amount || 0);
              const profit = winAmt - Number(b.amount || 0);

              if (b.isBonus) {
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
              tx.update(betRef, { status: 'lost' });
              tx.update(db.collection('users').doc(b.uid), {
                losses: admin.firestore.FieldValue.increment(1),
                profit: admin.firestore.FieldValue.increment(-Number(b.amount || 0))
              });
            }
          }

          // Credit flat 10% platform fee to admin wallet
          if (platformFee > 0) {
            tx.update(db.collection('users').doc(ADMIN_UID), {
              balance: admin.firestore.FieldValue.increment(platformFee)
            });
            const feeTxRef = db.collection('transactions').doc();
            tx.set(feeTxRef, {
              uid: ADMIN_UID,
              type: 'platform_fee',
              amount: platformFee,
              marketId: m.id,
              note: `10% fee: "${(m.question || '').substring(0, 50)}" → ${winner} (pool: ${totalPool})`,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }

          tx.update(mktRef, {
            status: 'resolved',
            result: winner,
            resolvedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });

        console.log(`✅ Resolved: \"${(m.question || '').substring(0, 50)}\" → ${winner} (${betsSnap.size} bets paid)`);
        // Send push notifications to all bettors
        try {
          // Batch all user reads in parallel instead of sequential
const userReads = betsSnap.docs.map(b => db.collection('users').doc(b.data().uid).get());
const userSnaps = await Promise.all(userReads);
const userMap = {};
userSnaps.forEach(snap => { if(snap.exists) userMap[snap.id] = snap.data(); });

for(const b of betsSnap.docs){
  const bet = b.data();
  const userData = userMap[bet.uid];
  if(!userData) continue;
  const isWinner = bet.side === winner;
  const fcmToken = userData?.fcmToken;
  const tgId = userData?.telegramChatId;
  const shortQ = (m.question||'').substring(0,60);
  if(isWinner){
    const amt = bet.isBonus ? Math.floor(((bet.winAmount||0))) : (bet.winAmount||0);
    const staked = bet.amount || 0;
    const profit = amt - staked;
    const newBal = (userData.balance || 0) + amt;
    if(fcmToken) await sendFcmToToken(fcmToken, '🎉 You Won!', `+₦${amt.toLocaleString()} credited on "${shortQ}"`);
    if(tgId) await sendTelegramCertificate(tgId, {
      username: userData.username,
      isWinner: true,
      marketTitle: m.question,
      side: bet.side,
      staked,
      payout: amt,
      profit,
      newBalance: newBal,
      marketSlug: m.slug
    });
  } else {
    const staked = bet.amount || 0;
    const newBal = userData.balance || 0;
    if(fcmToken) await sendFcmToToken(fcmToken, '😔 Bet Lost', `Your ${bet.side} bet on "${shortQ}" didn't win.`);
    if(tgId) await sendTelegramCertificate(tgId, {
      username: userData.username,
      isWinner: false,
      marketTitle: m.question,
      side: bet.side,
      staked,
      payout: 0,
      profit: 0,
      newBalance: newBal,
      marketSlug: m.slug
    });
  }
}
        } catch(notifErr){ console.error('Notification error:', notifErr.message); }

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
setTimeout(resolvePolymarketMarkets, 90000);

// ─── CREDIPLEX MARKET AUTO-RESOLVER ──────────────────────────
// Runs every 30 minutes. Checks all admin-created markets past deadline.
// Uses Google News + Groq AI (95% confidence threshold).
// If not sure → notifies admin on Telegram instead of guessing.

const SERPER_API_KEY = process.env.SERPER_API_KEY; // add this to Railway env vars

async function searchGoogleNews(query) {
  // Uses Serper.dev — free 2,500 searches/month. Add SERPER_API_KEY to Railway.
  try {
    const res = await fetch('https://google.serper.dev/news', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-KEY': SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: 8, gl: 'ng', hl: 'en' }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.news || []).map(n => `${n.title} — ${n.snippet} (${n.source}, ${n.date})`);
  } catch (e) {
    console.error('Google News search error:', e.message);
    return [];
  }
}

async function getCryptoPrice(coinSymbol) {
  // CoinGecko free API — no key needed
  const coinIds = {
    bitcoin: 'bitcoin', btc: 'bitcoin',
    ethereum: 'ethereum', eth: 'ethereum',
    solana: 'solana', sol: 'solana',
    bnb: 'binancecoin',
    xrp: 'ripple', ripple: 'ripple',
    usdt: 'tether', usdc: 'usd-coin',
    dogecoin: 'dogecoin', doge: 'dogecoin',
    cardano: 'cardano', ada: 'cardano',
    polygon: 'matic-network', matic: 'matic-network',
    pepe: 'pepe', shiba: 'shiba-inu', shib: 'shiba-inu',
  };
  const id = coinIds[coinSymbol.toLowerCase()];
  if (!id) return null;
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await res.json();
    return data[id]?.usd || null;
  } catch (e) { return null; }
}

function detectCoinFromQuestion(question) {
  const q = question.toLowerCase();
  const coins = ['bitcoin','btc','ethereum','eth','solana','sol','bnb','xrp','ripple',
    'dogecoin','doge','cardano','ada','polygon','matic','pepe','shiba','shib'];
  for (const coin of coins) {
    if (q.includes(coin)) return coin;
  }
  return null;
}

function detectPriceFromQuestion(question) {
  // Extract a price target like "$100k", "$50,000", "100k", "200,000"
  const q = question.toLowerCase();
  const match = q.match(/\$?([\d,]+\.?\d*)\s*k?\b/);
  if (!match) return null;
  let num = parseFloat(match[1].replace(/,/g, ''));
  if (q.includes('k') && num < 10000) num = num * 1000;
  return num;
}

function isCryptoMarket(question, category) {
  if (category === 'Crypto') return true;
  const q = question.toLowerCase();
  return q.includes('bitcoin') || q.includes(' btc') || q.includes('ethereum') ||
    q.includes(' eth') || q.includes('solana') || q.includes('crypto') ||
    q.includes('coin') || q.includes('token');
}

async function askGroqForResolution(question, outcomes, newsSnippets, extraContext = '') {
  // Ask Groq to decide winner + confidence. Must be very strict.
  const outcomesStr = outcomes.join(', ');
  const newsStr = newsSnippets.length
    ? newsSnippets.slice(0, 6).join('\n')
    : 'No news found.';

  const prompt = `You are a market resolution AI for Crediplex, a Nigerian prediction market platform.

MARKET QUESTION: "${question}"
POSSIBLE OUTCOMES: ${outcomesStr}
${extraContext ? 'EXTRA CONTEXT: ' + extraContext + '\n' : ''}
RECENT NEWS/DATA:
${newsStr}

Your job:
1. Read the news carefully and determine the winning outcome.
2. Only choose an outcome if you are EXTREMELY confident based on verified, factual sources.
3. Give a confidence score from 0 to 100.
4. If ANY doubt exists, give confidence below 95.

Respond ONLY in this exact JSON format (no other text):
{"winner": "EXACT_OUTCOME_OR_NULL", "confidence": 0-100, "reason": "one sentence explanation"}

Rules:
- winner must EXACTLY match one of the possible outcomes, or be null if unsure
- confidence 95+ means you are certain from reliable news sources
- confidence below 95 means admin should manually check
- For YES/NO markets: winner is "YES" or "NO"
- Never guess. Rather return null than be wrong.`;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 200,
        temperature: 0.1, // very low = more factual, less creative
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: AbortSignal.timeout(30000)
    });
    const data = await res.json();
    const text = (data.choices?.[0]?.message?.content || '').trim();
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch (e) {
    console.error('Groq resolution error:', e.message);
    return null;
  }
}

async function resolveCrediplexMarket(m, winner, reason) {
  // Shared payout logic — same as Polymarket resolver
  const betsSnap = await db.collection('bets')
    .where('marketId', '==', m.id)
    .where('status', '==', 'pending')
    .get();

  let outcomesArr = ['Yes', 'No'];
  try { outcomesArr = JSON.parse(m.outcomes || '[]'); } catch (e) {}

  const isBinary = outcomesArr.length === 2;
  let totalPool = 0, winningSidePool = 0;

  if (isBinary) {
    totalPool = (m.yesPool || 0) + (m.noPool || 0);
    winningSidePool = winner.toUpperCase() === 'YES' ? (m.yesPool || 0) : (m.noPool || 0);
  } else {
    outcomesArr.forEach(o => {
      const key = 'pool_' + o.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
      totalPool += Number(m[key] || 0);
    });
    if (m.totalPool && Number(m.totalPool) > 0) totalPool = Number(m.totalPool);
    const winKey = 'pool_' + winner.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    winningSidePool = Number(m[winKey] || 0);
  }

  const ADMIN_UID = 'WEw1TEQXJhZhmls7ppb4D0zxMv62';
  const platformFee = Math.floor(totalPool * 0.10);
  const payoutPool = totalPool - platformFee;

  await db.runTransaction(async tx => {
    const mktRef = db.collection('markets').doc(m.id);
    const mktNow = await tx.get(mktRef);
    if (mktNow.data().status !== 'active') return; // already resolved

    for (const betDoc of betsSnap.docs) {
      const b = betDoc.data();
      const betRef = db.collection('bets').doc(betDoc.id);
      const betSide = (b.side || '').toUpperCase();
      const isWinner = betSide === winner.toUpperCase();

      if (isWinner) {
        const winAmt = winningSidePool > 0
          ? Math.floor((payoutPool / winningSidePool) * Number(b.amount || 0))
          : Number(b.amount || 0);
        const profit = winAmt - Number(b.amount || 0);
        if (b.isBonus) {
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
          uid: b.uid, type: 'win_payout', amount: winAmt,
          note: `Won: ${(m.question || '').substring(0, 60)}`,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } else {
        tx.update(betRef, { status: 'lost' });
        tx.update(db.collection('users').doc(b.uid), {
          losses: admin.firestore.FieldValue.increment(1),
          profit: admin.firestore.FieldValue.increment(-Number(b.amount || 0))
        });
      }
    }

    if (platformFee > 0) {
      tx.update(db.collection('users').doc(ADMIN_UID), {
        balance: admin.firestore.FieldValue.increment(platformFee)
      });
      const feeTxRef = db.collection('transactions').doc();
      tx.set(feeTxRef, {
        uid: ADMIN_UID, type: 'platform_fee', amount: platformFee,
        marketId: m.id,
        note: `10% fee: auto-resolved → ${winner}`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    tx.update(mktRef, {
      status: 'resolved',
      result: winner.toUpperCase(),
      resolvedBy: 'auto',
      resolveReason: reason,
      resolvedAt: admin.firestore.FieldValue.serverTimestamp()
    });
  });

  // Notify bettors
  try {
    const userReads = betsSnap.docs.map(b => db.collection('users').doc(b.data().uid).get());
    const userSnaps = await Promise.all(userReads);
    const userMap = {};
    userSnaps.forEach(snap => { if (snap.exists) userMap[snap.id] = snap.data(); });
    for (const b of betsSnap.docs) {
      const bet = b.data();
      const userData = userMap[bet.uid];
      if (!userData) continue;
      const isWinner = (bet.side || '').toUpperCase() === winner.toUpperCase();
      const tgId = userData.telegramChatId;
      const fcmToken = userData.fcmToken;
      const shortQ = (m.question || '').substring(0, 60);
      if (isWinner) {
        const amt = bet.winAmount || 0;
        if (fcmToken) sendFcmToToken(fcmToken, '🎉 You Won!', `+₦${amt.toLocaleString()} credited on "${shortQ}"`).catch(() => {});
        if (tgId) sendTelegramCertificate(tgId, {
          username: userData.username, isWinner: true,
          marketTitle: m.question, side: bet.side,
          staked: bet.amount || 0, payout: amt,
          profit: amt - (bet.amount || 0),
          newBalance: (userData.balance || 0) + amt,
          marketSlug: m.slug
        }).catch(() => {});
      } else {
        if (fcmToken) sendFcmToToken(fcmToken, '😔 Bet Lost', `Your ${bet.side} bet on "${shortQ}" didn't win.`).catch(() => {});
        if (tgId) sendTelegramCertificate(tgId, {
          username: userData.username, isWinner: false,
          marketTitle: m.question, side: bet.side,
          staked: bet.amount || 0, payout: 0, profit: 0,
          newBalance: userData.balance || 0,
          marketSlug: m.slug
        }).catch(() => {});
      }
    }
  } catch (e) { console.error('Bettor notification error:', e.message); }
}

async function notifyAdminForManualResolution(m, reason) {
  const fmt = n => '₦' + Number(n || 0).toLocaleString('en-NG');
  const totalPool = (m.yesPool || 0) + (m.noPool || 0) + (m.totalPool || 0);
  let outcomesArr = ['Yes', 'No'];
  try { outcomesArr = JSON.parse(m.outcomes || '[]'); } catch (e) {}

  await sendTelegramMessage(ADMIN_TG_ID,
    `⚠️ <b>Manual Resolution Needed</b>\n\n` +
    `🏷️ <b>${(m.category || 'General').toUpperCase()}</b> Market\n` +
    `❓ <b>${m.question}</b>\n\n` +
    `📊 Outcomes: ${outcomesArr.join(' / ')}\n` +
    `💰 Total Pool: <b>${fmt(totalPool)}</b>\n` +
    `📅 Deadline: Passed\n\n` +
    `🤖 AI Reason: <i>${reason}</i>\n\n` +
    `Please go to the admin panel and resolve this market manually.`,
    { reply_markup: { inline_keyboard: [
      [{ text: '🛠️ Open Admin Panel', url: 'https://crediplex.name.ng/admin.html' }]
    ]}}
  ).catch(() => {});
  console.log(`📩 Admin notified for manual resolution: "${(m.question || '').substring(0, 50)}"`);
}

async function resolveCrediplexMarkets() {
  try {
    const now = new Date();

    // Get all expired active Crediplex (non-Polymarket, non-Telegram) markets
    let candidates = [];
    if (_marketsCache.length) {
      candidates = _marketsCache.filter(m => {
        if (m.source === 'polymarket') return false; // handled by resolvePolymarketMarkets
        if (m.category === 'Telegram') return false; // handled by pollTelegramChannelMarkets
        if (m.status !== 'active') return false;
        const dl = m.deadline?._seconds
          ? new Date(m.deadline._seconds * 1000)
          : m.deadline?.toDate ? m.deadline.toDate() : null;
        return dl && dl <= now;
      });
    } else {
      const nowTs = admin.firestore.Timestamp.now();
      const snap = await db.collection('markets')
        .where('status', '==', 'active')
        .where('source', '==', 'crediplex')
        .where('deadline', '<=', nowTs)
        .get();
      candidates = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      candidates = candidates.filter(m => m.category !== 'Telegram');
    }

    if (!candidates.length) return;
    console.log(`🔍 Crediplex auto-resolver: checking ${candidates.length} expired markets...`);

    for (const m of candidates) {
      try {
        console.log(`\n🔎 Processing: "${(m.question || '').substring(0, 60)}"`);
        let outcomesArr = ['Yes', 'No'];
        try { outcomesArr = JSON.parse(m.outcomes || '[]'); } catch (e) {}

        // ── CRYPTO MARKETS ──
        if (isCryptoMarket(m.question, m.category)) {
          const coin = detectCoinFromQuestion(m.question);
          const targetPrice = detectPriceFromQuestion(m.question);
          let extraContext = '';

          if (coin) {
            const currentPrice = await getCryptoPrice(coin);
            if (currentPrice) {
              extraContext = `Current ${coin.toUpperCase()} price: $${currentPrice.toLocaleString()}`;
              if (targetPrice) {
                extraContext += `. Target price in question: $${targetPrice.toLocaleString()}`;
              }
            }
          }

          // Also search Google News for crypto context
          const newsResults = await searchGoogleNews(`${m.question} result 2025`);
          const groqResult = await askGroqForResolution(m.question, outcomesArr, newsResults, extraContext);

          if (groqResult && groqResult.confidence >= 95 && groqResult.winner) {
            console.log(`✅ Crypto auto-resolve: "${groqResult.winner}" (${groqResult.confidence}% confidence)`);
            await resolveCrediplexMarket(m, groqResult.winner, groqResult.reason);
            await sendTelegramMessage(ADMIN_TG_ID,
              `✅ <b>Crypto Market Auto-Resolved!</b>\n\n` +
              `❓ ${m.question}\n` +
              `🏆 Winner: <b>${groqResult.winner}</b>\n` +
              `🤖 Confidence: <b>${groqResult.confidence}%</b>\n` +
              `📝 Reason: ${groqResult.reason}`
            ).catch(() => {});
          } else {
            const reason = groqResult
              ? `AI confidence too low (${groqResult.confidence}%): ${groqResult.reason}`
              : 'AI could not determine result';
            await notifyAdminForManualResolution(m, reason);
          }

        // ── POLITICS / ELECTION / NIGERIA / GEOPOLITICAL MARKETS ──
        } else if (['Politics', 'Election', 'Nigeria', 'Geopolitical'].includes(m.category)) {
          // Search Google News with multiple queries for thorough research
          const queries = [
            m.question,
            `${m.question} result winner announced`,
            `${m.question} official result 2025 Nigeria`,
          ];
          let allNews = [];
          for (const q of queries) {
            const results = await searchGoogleNews(q);
            allNews = [...allNews, ...results];
            await new Promise(r => setTimeout(r, 500)); // small delay between searches
          }
          // Deduplicate
          allNews = [...new Set(allNews)];

          const groqResult = await askGroqForResolution(m.question, outcomesArr, allNews);

          if (groqResult && groqResult.confidence >= 95 && groqResult.winner) {
            console.log(`✅ Politics auto-resolve: "${groqResult.winner}" (${groqResult.confidence}% confidence)`);
            await resolveCrediplexMarket(m, groqResult.winner, groqResult.reason);
            await sendTelegramMessage(ADMIN_TG_ID,
              `✅ <b>Market Auto-Resolved!</b>\n\n` +
              `🏷️ ${m.category}\n` +
              `❓ ${m.question}\n` +
              `🏆 Winner: <b>${groqResult.winner}</b>\n` +
              `🤖 Confidence: <b>${groqResult.confidence}%</b>\n` +
              `📝 Reason: ${groqResult.reason}`
            ).catch(() => {});
          } else {
            const reason = groqResult
              ? `AI confidence too low (${groqResult.confidence}%): ${groqResult.reason}`
              : 'AI could not determine result from news';
            await notifyAdminForManualResolution(m, reason);
          }

        // ── ALL OTHER MARKETS (Sports, Business, Culture, etc.) ──
        } else {
          const newsResults = await searchGoogleNews(`${m.question} result outcome`);
          const groqResult = await askGroqForResolution(m.question, outcomesArr, newsResults);

          if (groqResult && groqResult.confidence >= 95 && groqResult.winner) {
            console.log(`✅ General auto-resolve: "${groqResult.winner}" (${groqResult.confidence}% confidence)`);
            await resolveCrediplexMarket(m, groqResult.winner, groqResult.reason);
            await sendTelegramMessage(ADMIN_TG_ID,
              `✅ <b>Market Auto-Resolved!</b>\n\n` +
              `🏷️ ${m.category || 'General'}\n` +
              `❓ ${m.question}\n` +
              `🏆 Winner: <b>${groqResult.winner}</b>\n` +
              `🤖 Confidence: <b>${groqResult.confidence}%</b>\n` +
              `📝 Reason: ${groqResult.reason}`
            ).catch(() => {});
          } else {
            const reason = groqResult
              ? `AI confidence too low (${groqResult.confidence}%): ${groqResult.reason}`
              : 'AI could not determine result';
            await notifyAdminForManualResolution(m, reason);
          }
        }

        // Small delay between markets to avoid API rate limits
        await new Promise(r => setTimeout(r, 2000));

      } catch (err) {
        console.error(`❌ Error processing market ${m.id}:`, err.message);
        await notifyAdminForManualResolution(m, `Server error: ${err.message}`).catch(() => {});
      }
    }

  } catch (err) {
    console.error('resolveCrediplexMarkets error:', err.message);
  }
}

// Run every 30 minutes
console.log('🤖 Crediplex auto-resolver started (every 30min)');
setInterval(resolveCrediplexMarkets, 30 * 60 * 1000);
// First run 5 minutes after server start (let cache warm up first)
setTimeout(resolveCrediplexMarkets, 5 * 60 * 1000);
// ─── COPY TRADE POLLER + TELEGRAM ────────────────────────────
const pollAllCopyRelations = async () => {};
app.post('/api/telegram-test', async (req, res) => {
  const { chatId, username } = req.body;
  if (!chatId) return res.json({ success: false });
  await sendTelegramMessage(chatId,
    `👋 <b>Hi ${username}!</b>\n\nYour Telegram is now linked to Crediplex.\n\nYou'll get a message here every time a copy trade is auto-placed for you, and other notifications. 🎯`
  );
  res.json({ success: true });
});

setTimeout(() => pollAllCopyRelations(db, admin), 60 * 1000);
setInterval(() => pollAllCopyRelations(db, admin), 3 * 60 * 1000);
console.log('🔄 Copy trade poller started (every 3 min)');
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

    const TOP_MARKET_LIMIT = 100; // Only sync top 100 by volume
    while (true) {
      if (page * batchSize >= TOP_MARKET_LIMIT) break; // Hard cap at 100 markets
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
            // Append to oddsHistory (keep last 48 entries)
          const existingHistory = existing.oddsHistory || [];
          existingHistory.push({ ts: Date.now(), yes: yesOdds });
          if (existingHistory.length > 48) existingHistory.splice(0, existingHistory.length - 48);

          const updateData = {
            polymarketYesOdds: yesOdds,
            deadline,
            oddsHistory: existingHistory,
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
      // No page cap — paginate until API returns empty
      await new Promise(r => setTimeout(r, 200));
      // Safety cap at 400 pages (40,000 markets) to avoid infinite loops
      if (page > 400) break;
    }

    // ── PRUNE: delete Polymarket markets not in current sync ──
    try {
      const allPmSnap = await db.collection('markets').where('source', '==', 'polymarket').get();
      const deleteWrites = [];
      allPmSnap.forEach(d => {
        const pmId = d.data().polymarketId;
        const hasActivity = (d.data().totalPool || 0) > 0;
        if (pmId && !_existingPmIdsCache[pmId] && !hasActivity) {
          deleteWrites.push(d.ref.delete());
        }
      });
      if (deleteWrites.length) {
        await Promise.all(deleteWrites);
        console.log(`🗑️ Pruned ${deleteWrites.length} stale Polymarket markets from Firestore`);
      }
    } catch (pruneErr) {
      console.error('Prune error:', pruneErr.message);
    }

    // ── CLOB PASS REMOVED — top 100 volume sync is sufficient ──
    try {
      let clobPage = 0;
      const clobSize = 500;
      while (false) { // DISABLED — was fetching up to 30,000 markets
        const clobUrl = `https://clob.polymarket.com/markets?next_cursor=${clobPage === 0 ? '' : String(clobPage * clobSize)}&limit=${clobSize}`;
        let clobData = null;
        try {
          const clobRes = await fetch(clobUrl, { signal: AbortSignal.timeout(12000) });
          if (clobRes.ok) {
            const raw = await clobRes.json();
            clobData = raw.data || raw;
          }
        } catch(e) {}
        if (!clobData || !Array.isArray(clobData) || !clobData.length) break;

        const clobWrites = [];
        for (const pm of clobData) {
          if (!pm.question) continue;
          if (pm.closed === true || pm.active === false || pm.archived === true) continue;
          const pmId = String(pm.condition_id || pm.id || '');
          if (!pmId || existingPmIds[pmId]) continue;

          let deadline = null;
          try {
            const d = new Date(pm.end_date_iso || pm.endDate || '');
            if (!isNaN(d.getTime()) && d > new Date()) {
              deadline = admin.firestore.Timestamp.fromDate(d);
            } else {
              deadline = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
            }
          } catch(e) {
            deadline = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
          }

          let outcomesArr = ['Yes', 'No'];
          try {
            const parsed = JSON.parse(pm.outcomes || '[]');
            if (Array.isArray(parsed) && parsed.length >= 2) outcomesArr = parsed;
          } catch(e) {}

          let outcomePricesArr = [];
          try {
            outcomePricesArr = JSON.parse(pm.outcomePrices || pm.outcome_prices || '[]').map(p => parseFloat(p));
          } catch(e) {}

          let yesOdds = 50;
          if (outcomePricesArr[0]) yesOdds = Math.round(outcomePricesArr[0] * 100);

          let pmTags = [];
          try {
            if (pm.tags) pmTags = Array.isArray(pm.tags) ? pm.tags.map(t => typeof t === 'string' ? t : (t.slug || t.name || '')) : [];
          } catch(e) {}

          const category = detectCategoryAdmin(pm.question, pmTags);
          const imageUrl = pm.image || pm.icon || '';
          const poolsObj = { yesPool: 0, noPool: 0, totalPool: 0 };
          outcomesArr.forEach(o => {
            const key = 'pool_' + o.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            poolsObj[key] = 0;
          });
          const slug = slugifyServer(pm.question) + '-' + pmId.substring(0, 6);
          _existingPmIdsCache[pmId] = true;

          clobWrites.push(db.collection('markets').add({
            question: pm.question,
            description: pm.description || '',
            category,
            status: 'active',
            yesPool: 0, noPool: 0,
            imageUrl,
            polymarketId: pmId,
            polymarketSlug: pm.market_slug || pm.slug || '',
            polymarketVolume: parseFloat(pm.volume || 0),
            polymarketYesOdds: yesOdds,
            deadline,
            outcomes: JSON.stringify(outcomesArr),
            outcomePrices: JSON.stringify(outcomePricesArr),
            outcomeCount: outcomesArr.length,
            ...poolsObj,
            slug,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'polymarket',
          }));
          imported++;
        }
        if (clobWrites.length) await Promise.all(clobWrites);
        if (clobData.length < clobSize) break;
        clobPage++;
        await new Promise(r => setTimeout(r, 300));
      }
      console.log(`✅ CLOB API pass done — total imported this run: ${imported}`);
    } catch(clobErr) {
      console.error('CLOB pass error:', clobErr.message);
    }

    // ── SECOND PASS: fetch by specific tags to catch markets missed in volume sort ──
    const tagFetches = [
      'soccer', 'football', 'afcon', 'premier-league', 'champions-league',
      'world-cup', 'nigeria', 'africa'
    ]; // Reduced: football + Nigeria/Africa only

    for (const tag of tagFetches) {
      try {
        const tagUrl = `https://gamma-api.polymarket.com/events?active=true&closed=false&limit=100&offset=0&tag=${tag}&order=volume_24hr&ascending=false`;
        let tagData = null;
        try {
          const tagRes = await fetch(tagUrl, { signal: AbortSignal.timeout(10000) });
          if (tagRes.ok) tagData = await tagRes.json();
        } catch (e) {
          tagData = await fetchWithProxy(tagUrl);
        }
        if (!tagData || !Array.isArray(tagData) || !tagData.length) continue;

        const tagMarkets = [];
        for (const event of tagData) {
          if (event.markets && Array.isArray(event.markets) && event.markets.length > 1) {
            const activeSubMarkets = event.markets.filter(m => m.active !== false && m.closed !== true);
            if (!activeSubMarkets.length) continue;
            const outcomes = activeSubMarkets.map(m => m.groupItemTitle || m.question || 'Option');
            const outcomePrices = activeSubMarkets.map(m => {
              try { const p = JSON.parse(m.outcomePrices || '[]'); return parseFloat(p[0] || 0.5); } catch(e){ return 0.5; }
            });
            tagMarkets.push({
              id: event.id, conditionId: event.id,
              question: event.title || event.question,
              image: event.image, endDate: event.endDate, tags: event.tags,
              volume: event.volume, active: event.active, closed: event.closed,
              outcomes: JSON.stringify(outcomes), outcomePrices: JSON.stringify(outcomePrices)
            });
          } else if (event.markets && Array.isArray(event.markets) && event.markets.length === 1) {
            const m = event.markets[0];
            if (!m.question) m.question = event.title || event.question;
            if (!m.image) m.image = event.image;
            if (!m.endDate) m.endDate = event.endDate;
            if (!m.tags) m.tags = event.tags;
            tagMarkets.push(m);
          } else if (event.question) {
            tagMarkets.push(event);
          }
        }

        const tagWrites = [];
        for (const pm of tagMarkets) {
          if (!pm.question || pm.closed === true || pm.active === false) continue;
          const pmId = String(pm.id || pm.conditionId || '');
          if (!pmId || existingPmIds[pmId]) continue; // already imported

          let deadline = null;
          if (pm.endDate || pm.end_date_iso) {
            const d = new Date(pm.endDate || pm.end_date_iso);
            if (isNaN(d.getTime()) || d < new Date()) continue;
            deadline = admin.firestore.Timestamp.fromDate(d);
          } else {
            deadline = admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000));
          }

          let outcomesArr = ['Yes', 'No'];
          try { const p = JSON.parse(pm.outcomes || '[]'); if (Array.isArray(p) && p.length >= 2) outcomesArr = p; } catch(e){}
          let outcomePricesArr = [];
          try { outcomePricesArr = JSON.parse(pm.outcomePrices || '[]').map(p => parseFloat(p)); } catch(e){}
          let yesOdds = 50;
          if (outcomePricesArr[0]) yesOdds = Math.round(outcomePricesArr[0] * 100);

          let pmTags = [];
          try { if (pm.tags) pmTags = Array.isArray(pm.tags) ? pm.tags.map(t => typeof t === 'string' ? t : (t.slug || t.name || '')) : []; } catch(e){}

          // Force correct category based on tag and question context
          const tagStr = pmTags.join(' ').toLowerCase();
          let category;
          if (tagStr.includes('world-cup') || tag === 'world-cup') {
            category = 'World Cup';
          } else if (tag === 'nigeria' || tag === 'africa' || tagStr.includes('nigeria')) {
            // Force Nigeria/Africa markets into Politics or Sports depending on content
            const q = (pm.question || '').toLowerCase();
            if (q.includes('goal') || q.includes('match') || q.includes('afcon') || q.includes('football') || q.includes('soccer') || q.includes('sport')) {
              category = 'Sports';
            } else {
              category = 'Politics';
            }
          } else if (tag === 'soccer' || tag === 'football' || tag === 'afcon' || tag === 'premier-league' || tag === 'champions-league') {
            const q = (pm.question || '').toLowerCase();
            category = (q.includes('world cup') || q.includes('fifa world cup')) ? 'World Cup' : 'Sports';
          } else {
            category = detectCategoryAdmin(pm.question, pmTags);
          }

          const imageUrl = pm.image || pm.icon || '';
          const poolsObj = { yesPool: 0, noPool: 0, totalPool: 0 };
          outcomesArr.forEach(o => {
            const key = 'pool_' + o.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
            poolsObj[key] = 0;
          });
          const slug = slugifyServer(pm.question) + '-' + pmId.substring(0, 6);
          _existingPmIdsCache[pmId] = true;

          tagWrites.push(db.collection('markets').add({
            question: pm.question, description: pm.description || '',
            category, status: 'active',
            yesPool: 0, noPool: 0, imageUrl,
            polymarketId: pmId, polymarketSlug: pm.slug || '',
            polymarketVolume: pm.volume || 0, polymarketYesOdds: yesOdds,
            deadline,
            outcomes: JSON.stringify(outcomesArr), outcomePrices: JSON.stringify(outcomePricesArr),
            outcomeCount: outcomesArr.length, ...poolsObj, slug,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            source: 'polymarket',
          }));
          imported++;
        }
        if (tagWrites.length) await Promise.all(tagWrites);
        await new Promise(r => setTimeout(r, 150));
      } catch (tagErr) {
        console.error(`Tag fetch error (${tag}):`, tagErr.message);
      }
    }

    console.log(`✅ Auto-sync done: ${imported} new, ${updated} updated`);
    // Only refresh cache if something actually changed
    if (imported > 0 || updated > 0) {
      await refreshMarketsCache();
    }
    // Check price alerts using fresh cache (no extra market reads)
    // Only check alerts every 30 minutes, not every sync
    if (!global._lastAlertCheck || Date.now() - global._lastAlertCheck > 30 * 60 * 1000) {
      global._lastAlertCheck = Date.now();
      checkPriceAlerts().catch(e=>console.error('Alert check failed:',e.message));
    }
  } catch (err) {
    console.error('autoSyncPolymarketMarkets error:', err.message);
  }
}

async function sendTelegramCertificate(tgId, certData) {
  try {
    const { username, isWinner, marketTitle, side, staked, payout, profit, newBalance, marketSlug } = certData;
    const profitPercent = staked > 0 ? Math.round(((payout - staked) / staked) * 100) : 0;
    const templateUrl = isWinner
      ? 'https://i.ibb.co/d4TBwC5W/file-0000000000d071fbb07e84143fc7c345.png'
      : 'https://i.ibb.co/38hNzYC/file-0000000048d871fba06bdeede9cd9349.png';
    const caption =
      `${isWinner ? '🏆' : '📉'} <b>Prediction Certificate</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `👤 <b>@${username}</b>\n` +
      `📊 <b>${(marketTitle||'').substring(0,60)}</b>\n\n` +
      `🎯 Position: <b>${side}</b> ${isWinner ? '✅' : '❌'}\n` +
      `💰 Staked: <b>₦${Number(staked).toLocaleString('en-NG')}</b>\n` +
      `${isWinner ? `🏅 Payout: <b>₦${Number(payout).toLocaleString('en-NG')}</b>\n💸 Profit: <b>+₦${Number(profit).toLocaleString('en-NG')}</b> (${profitPercent > 0 ? '+' : ''}${profitPercent}%)\n` : `📉 Result: <b>Lost</b>\n`}` +
      `💳 New Balance: <b>₦${Number(newBalance).toLocaleString('en-NG')}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `<i>Powered by <a href="https://crediplex.name.ng">crediplex.name.ng</a></i>`;
    const mktUrl = marketSlug ? `https://crediplex.name.ng/market/${marketSlug}` : 'https://crediplex.name.ng';
    await fetch(`${TELEGRAM_API}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: tgId,
        photo: templateUrl,
        caption,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: [[
          { text: isWinner ? '📈 Bet Again' : '💪 Try Again', url: mktUrl },
          { text: '💰 My Balance', callback_data: 'balance' }
        ]]}
      })
    });
  } catch(e) { console.error('sendTelegramCertificate error:', e.message); }
}

function marketUrl(market) {
  if (market && market.slug) return `https://crediplex.name.ng/market/${market.slug}`;
  return 'https://crediplex.name.ng';
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
  // Tags-first priority (most reliable signal)
  if (t.includes('world-cup') || t.includes('fifa-world-cup')) return 'World Cup';
  if (t.includes('entertainment')) return 'Entertainment';
  if (t.includes('election')) return 'Election';
  if (t.includes('politics') || t.includes('political')) return 'Politics';
  if (t.includes('crypto') || t.includes('bitcoin') || t.includes('ethereum') || t.includes('defi')) return 'Crypto';
  if (t.includes('tech') || t.includes('ai') || t.includes('technology')) return 'Tech';
  if (t.includes('sports') || t.includes('nba') || t.includes('nfl') || t.includes('soccer') || t.includes('tennis') || t.includes('golf') || t.includes('mma') || t.includes('cricket') || t.includes('esports')) return 'Sports';
  if (t.includes('culture')) return 'Culture';
  if (t.includes('economic') || t.includes('economy')) return 'Economic';
  if (t.includes('business') || t.includes('financial')) return 'Business';
  if (t.includes('geopolitical') || t.includes('world')) return 'Geopolitical';
  // Question-text fallback
  if (combined.includes('world cup') || combined.includes('fifa world cup') || combined.includes('fifa')) return 'World Cup';
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

// ─── ONE-TIME: relabel existing World Cup markets that were saved under 'Sports' ───
async function migrateWorldCupCategoryOnce() {
  try {
    const flagRef = db.collection('_meta').doc('wcCategoryMigration');
    const flagDoc = await flagRef.get();
    if (flagDoc.exists) return; // already done — never runs again
    const snap = await db.collection('markets').where('category', '==', 'Sports').get();
    const wcWords = ['world cup', 'fifa world cup', 'fifa'];
    const writes = [];
    snap.forEach(d => {
      const q = (d.data().question || '').toLowerCase();
      if (wcWords.some(w => q.includes(w))) writes.push(d.ref.update({ category: 'World Cup' }));
    });
    if (writes.length) await Promise.all(writes);
    await flagRef.set({ done: true, migratedCount: writes.length, at: admin.firestore.FieldValue.serverTimestamp() });
    console.log(`✅ World Cup category migration done: ${writes.length} markets relabeled`);
  } catch (e) {
    console.error('migrateWorldCupCategoryOnce error:', e.message);
  }
}
setTimeout(migrateWorldCupCategoryOnce, 60 * 1000);

// Run sync on startup (after 10s) then every 2 minutes
async function runSyncThenRefreshCache() {
  await autoSyncPolymarketMarkets();
  // refreshMarketsCache already called inside autoSyncPolymarketMarkets when needed
}
// Stagger startup: wait 3 minutes before first sync, then every 30 minutes
setTimeout(runSyncThenRefreshCache, 3 * 60 * 1000);
setInterval(runSyncThenRefreshCache, 30 * 60 * 1000);
console.log('🔄 Auto Polymarket sync started (every 30 min, first run after 3min)');

// ─── TELEGRAM CHANNEL POLLER ──────────────────────────────────
// Polls subscriber counts for Telegram prediction markets
// Uses Bot API (no admin needed) — stores snapshots in market doc
async function pollTelegramChannelMarkets() {
  _lastTgPollAt = Date.now();
  try {
    const now = admin.firestore.Timestamp.now();
    // Use memory cache instead of Firestore read
    const tgMarkets = _marketsCache.filter(m => m.category === 'Telegram' && m.status === 'active');
    const snap = {
      empty: tgMarkets.length === 0,
      docs: tgMarkets.map(m => ({ id: m.id, data: () => m, ref: db.collection('markets').doc(m.id) }))
    };

    if (snap.empty) return;
    console.log(`📊 Polling ${snap.docs.length} Telegram markets...`);

    for (const mDoc of snap.docs) {
      const m = mDoc.data();
      if (!m.telegramChannel) continue;

      try {
        // Fetch subscriber count via Bot API (free, no admin needed)
        const countRes = await fetch(
          `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getChatMembersCount?chat_id=@${m.telegramChannel}`,
          { signal: AbortSignal.timeout(8000) }
        );
        const countData = await countRes.json();
        if (!countData.ok) continue;
        const currentCount = countData.result;

        // Store snapshot (keep last 48 entries = 24h at 30-min intervals)
        const snapshots = m.subscriberSnapshots || [];
        snapshots.push({ count: currentCount, ts: Date.now() });
        if (snapshots.length > 48) snapshots.splice(0, snapshots.length - 48);

        const updateData = {
          currentSubscribers: currentCount,
          subscriberSnapshots: snapshots,
          lastPolledAt: admin.firestore.FieldValue.serverTimestamp()
        };

        // Auto-resolve check: subscriber-target markets
        if (m.resolveType === 'subscribers') {
          const target = Number(m.targetSubscribers || 0);
          const deadline = m.deadline?.toDate?.() || new Date(0);
          const isExpired = new Date() >= deadline;
          const subType = m.marketSubType || 'higher_than';

          // Multi-outcome: resolve to the closest milestone bracket at deadline
          let outcomesArr = [];
          try { outcomesArr = JSON.parse(m.outcomes || '[]'); } catch(e) {}
          const isMulti = outcomesArr.length > 2;

          if (isMulti) {
            // Only resolve at deadline
            if (isExpired) {
              // Find the highest milestone the channel has reached
              const milestones = outcomesArr.map(o => parseInt(o.replace(/[^0-9]/g,'')));
              let winner = outcomesArr[0]; // default: lowest bracket
              for (let i = milestones.length - 1; i >= 0; i--) {
                if (currentCount >= milestones[i]) { winner = outcomesArr[i]; break; }
              }
              updateData._autoResolve = winner;
            }
          } else if (target > 0) {
            if (subType === 'lower_than') {
              // YES = channel stays below target at deadline
              if (isExpired) {
                updateData._autoResolve = currentCount < target ? 'Yes' : 'No';
              }
            } else {
              // higher_than (default): YES = reaches/exceeds target
              if (currentCount >= target) {
                updateData._autoResolve = 'Yes';
              } else if (isExpired) {
                updateData._autoResolve = 'No';
              }
            }
          }
        }

        // Extract _autoResolve before saving — Firestore can't store keys starting with _
        const autoResolveWinner = updateData._autoResolve;
        delete updateData._autoResolve;

        await mDoc.ref.update(updateData);

        // Trigger resolution if needed
        if (autoResolveWinner) {
          await autoResolveTelegramMarket(mDoc.id, m, autoResolveWinner);
        }

      } catch (e) {
        console.log(`Telegram poll error for @${m.telegramChannel}:`, e.message);
      }
    }
  } catch (e) {
    console.error('pollTelegramChannelMarkets error:', e.message);
  }
}

async function autoResolveTelegramMarket(marketId, m, winner) {
  try {
    const betsSnap = await db.collection('bets')
      .where('marketId', '==', marketId)
      .where('status', '==', 'pending')
      .get();

    await db.runTransaction(async tx => {
      const mktRef = db.collection('markets').doc(marketId);
      const mktNow = await tx.get(mktRef);
      const mktData = mktNow.data();
      if (mktData.status !== 'active') return;

      const ADMIN_UID = 'WEw1TEQXJhZhmls7ppb4D0zxMv62';

      const yesPool = mktData.yesPool || 0;
      const noPool = mktData.noPool || 0;
      const totalPool = yesPool + noPool;
      const winningSidePool = winner.toLowerCase() === 'yes' ? yesPool : noPool;

      // Flat 10% of entire pool goes to admin wallet
      const platformFee = Math.floor(totalPool * 0.10);
      const payoutPool = totalPool - platformFee; // 90% shared among winners

      for (const betDoc of betsSnap.docs) {
        const b = betDoc.data();
        const betRef = db.collection('bets').doc(betDoc.id);
        const isWinner = (b.side || '').toLowerCase() === winner.toLowerCase();

        if (isWinner) {
          const winAmt = winningSidePool > 0
            ? Math.floor((payoutPool / winningSidePool) * Number(b.amount || 0))
            : Number(b.amount || 0);
          const netProfit = winAmt - Number(b.amount || 0);

          if (b.isBonus) {
            const bonusPayout = Math.floor(netProfit * 0.05);
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
              profit: admin.firestore.FieldValue.increment(netProfit)
            });
          }

          const txRef = db.collection('transactions').doc();
          tx.set(txRef, {
            uid: b.uid, type: 'win_payout', amount: winAmt,
            note: `Won Telegram market: ${(mktData.question || '').substring(0, 60)}`,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
        } else {
          tx.update(betRef, { status: 'lost' });
          tx.update(db.collection('users').doc(b.uid), {
            losses: admin.firestore.FieldValue.increment(1),
            profit: admin.firestore.FieldValue.increment(-Number(b.amount || 0))
          });
        }
      }

      // Credit flat 10% platform fee to admin wallet
      if (platformFee > 0) {
        tx.update(db.collection('users').doc(ADMIN_UID), {
          balance: admin.firestore.FieldValue.increment(platformFee)
        });
        const feeRef = db.collection('transactions').doc();
        tx.set(feeRef, {
          uid: ADMIN_UID,
          type: 'platform_fee',
          amount: platformFee,
          marketId,
          note: `10% fee: "${(mktData.question || '').substring(0, 50)}" → ${winner} (pool: ${totalPool})`,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      tx.update(mktRef, {
        status: 'resolved',
        result: winner,
        resolvedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    console.log(`✅ Auto-resolved Telegram market "${(m.question||'').substring(0,40)}" → ${winner} (${betsSnap.size} bets paid)`);
    // Send certificates to all bettors via Telegram
    try {
      const allUserReads = betsSnap.docs.map(b => db.collection('users').doc(b.data().uid).get());
      const allUserSnaps = await Promise.all(allUserReads);
      const allUserMap = {};
      allUserSnaps.forEach(s => { if(s.exists) allUserMap[s.id] = s.data(); });
      for(const betDoc of betsSnap.docs){
        const b = betDoc.data();
        const ud = allUserMap[b.uid];
        if(!ud || !ud.telegramChatId) continue;
        const isWin = (b.side||'').toLowerCase() === winner.toLowerCase();
        const winAmt = isWin ? (b.winAmount || 0) : 0;
        const profit = isWin ? winAmt - (b.amount||0) : 0;
        await sendTelegramCertificate(ud.telegramChatId, {
          username: ud.username,
          isWinner: isWin,
          marketTitle: m.question,
          side: b.side,
          staked: b.amount || 0,
          payout: winAmt,
          profit,
          newBalance: ud.balance || 0,
          marketSlug: m.slug
        });
      }
    } catch(certErr){ console.error('Telegram cert error:', certErr.message); }
  } catch (e) {
    console.error('autoResolveTelegramMarket error:', e.message);
  }
}

// Smart poll: 30min standard, 10min near-deadline, immediate on start
setTimeout(pollTelegramChannelMarkets, 120 * 1000); // first poll after 2 min
setInterval(pollTelegramChannelMarkets, 30 * 60 * 1000); // then every 30min

// Near-deadline poller: every 10 minutes for markets expiring within 6 hours
setInterval(async () => {
  try {
    const sixHoursFromNow = Date.now() + 6*60*60*1000;
    const nearDeadline = _marketsCache.filter(m =>
      m.category === 'Telegram' &&
      m.status === 'active' &&
      m.deadline &&
      (m.deadline._seconds ? m.deadline._seconds * 1000 : new Date(m.deadline).getTime()) <= sixHoursFromNow
    );
    // Only poll if there are near-deadline markets AND we haven't polled in the last 30 min standard cycle
    if(nearDeadline.length > 0 && Date.now() - _lastTgPollAt > 9 * 60 * 1000){
      console.log(`⏰ Near-deadline Telegram poll: ${nearDeadline.length} markets`);
      await pollTelegramChannelMarkets();
    }
  } catch(e){}
}, 10 * 60 * 1000);

console.log('📱 Telegram channel poller started (30min standard, 10min near-deadline)');
// ─── TELEGRAM BOT COMMAND HANDLER ────────────────────────────
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

// In-memory alert setup state (chatId -> { step, matches, chosenMarket, chosenOutcome })
const _alertState = {};

// In-memory deposit state
const _depositState = {};

// In-memory withdrawal state
const _withdrawState = {};

// In-memory bet state
const _betState = {};

// Verify PIN server-side
const _tgUserCache = {}; // chatId -> { data, id, ts }
const TG_USER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getUserByTgId(chatId) {
  const key = chatId.toString();
  const cached = _tgUserCache[key];
  if (cached && Date.now() - cached.ts < TG_USER_CACHE_TTL) {
    return { empty: false, docs: [{ id: cached.id, data: () => cached.data }] };
  }
  const snap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
  if (!snap.empty) {
    _tgUserCache[key] = { id: snap.docs[0].id, data: snap.docs[0].data(), ts: Date.now() };
  }
  return snap.empty ? null : snap.docs[0];
}

async function verifyUserPin(chatId, inputPin) {
  const snap = await db.collection('users').where('telegramChatId','==',chatId.toString()).limit(1).get();
  if (snap.empty) return { ok: false, error: 'No account linked.' };
  const u = snap.docs[0].data();
  if (!u.transactionPin) return { ok: false, error: 'no_pin', userId: snap.docs[0].id, userData: u };
  const expected = Buffer.from(snap.docs[0].id + ':' + inputPin).toString('base64');
  if (expected !== u.transactionPin) return { ok: false, error: 'wrong_pin', userId: snap.docs[0].id };
  return { ok: true, userId: snap.docs[0].id, userData: u };
}

// In-memory support conversation state (chatId -> { messages: [] })
const _supportState = {};

// Admin Telegram ID
const ADMIN_TG_ID = '6438544386';

// Groq AI helper (reusable)
async function askGroq(messages, maxTokens = 600) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
    body: JSON.stringify({ model: 'llama-3.1-8b-instant', max_tokens: maxTokens, messages })
  });
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

const CREDIPLEX_SUPPORT_PROMPT = `You are Crediplex Support AI, a professional and friendly customer support agent for Crediplex — a Nigerian prediction market platform where users bet real Naira on real-world events.

KEY FACTS ABOUT CREDIPLEX:
- Platform: crediplex.name.ng
- Users deposit via Crypto (NOWPayments — USDT, BTC, SOL, ETH, min $1) or Naira bank transfer (min ₦500)
- Withdrawals: crypto only via NOWPayments, processed within 10-30 minutes
- Currency: Nigerian Naira (₦) internally, USD for crypto
- Markets: Prediction markets synced from Polymarket + custom Telegram channel markets
- Bet types: YES/NO binary markets and multi-outcome markets
- Parlays: Users can combine multiple bets
- Copy trading: Users can copy top traders automatically
- Platform fee: 10% on winnings
- Referral program: Users earn bonus when referrals place first bet
- Bonus wallet: Separate from main wallet, used for referral rewards
- FCM push notifications + Telegram bot notifications supported
- Support email: care@crediplex.name.ng

RULES:
- Always be warm, professional, and concise
- For deposit issues: ask if they used crypto or bank transfer, check if they used their username as reference for bank transfer
- For withdrawal issues: confirm they entered correct crypto address and coin type
- For bet disputes: explain that markets resolve automatically based on real-world outcomes
- For account issues: ask them to use /start to relink Telegram
- For complex or unresolved issues: warmly redirect to care@crediplex.name.ng and emphasize the team responds within 24 hours
- NEVER make up information you don't know
- Keep responses under 200 words
- Do not use markdown formatting, just plain text with line breaks`;

// Rate limiter: max 1 command per 2 seconds per user
const _tgRateLimit = {};
function isTgRateLimited(chatId) {
  const now = Date.now();
  const last = _tgRateLimit[chatId] || 0;
  if (now - last < 2000) return true;
  _tgRateLimit[chatId] = now;
  return false;
}
// Clean rate limit map every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 60000;
  Object.keys(_tgRateLimit).forEach(k => { if (_tgRateLimit[k] < cutoff) delete _tgRateLimit[k]; });
}, 10 * 60 * 1000);

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
      `Use /help to see all available commands.`,
      { reply_markup: { inline_keyboard: [
        [{ text: '📋 Commands', callback_data: 'help' }, { text: '🚀 Open App', url: 'https://crediplex.name.ng' }]
      ]}}
    );
    // Notify referrer if new user was referred (1 read — only fires once per new user)
    try {
      const newUserData = userSnap.exists ? userSnap.data() : null;
      if (newUserData?.referredBy) {
        const referrerSnap = await db.collection('users').doc(newUserData.referredBy).get();
        if (referrerSnap.exists) {
          const ref = referrerSnap.data();
          if (ref.telegramChatId) {
            sendTelegramMessage(ref.telegramChatId,
              `👥 <b>New Referral!</b>\n\n` +
              `<b>${crediplexUsername}</b> just joined Crediplex using your link! 🎉\n\n` +
              `They need to place their first bet before your bonus is credited.\n` +
              `Keep sharing your link to earn more!`,
              { reply_markup: { inline_keyboard: [[{ text: '👥 My Referral Stats', callback_data: 'refer' }]] }}
            ).catch(()=>{});
          }
        }
      }
    } catch(e) {}

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Legacy endpoint kept for compatibility
app.post('/api/generate-verify-code', async (req, res) => {
  res.json({ success: false, error: 'Use the Telegram bot /start command to get your code instead.' });
});


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

async function setTelegramMenuButton() {
  try {
    await fetch(`${TELEGRAM_API}/setChatMenuButton`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        menu_button: { type: 'web_app', text: '🏠 Open Crediplex', web_app: { url: 'https://crediplex.name.ng' } }
      })
    });
    console.log('✅ Telegram menu button set');
  } catch(e) { console.log('Menu button error:', e.message); }
}
setTimeout(setTelegramMenuButton, 5000);

// ─── DAILY SUMMARY: 11:59 PM Nigeria time (UTC+1 = 22:59 UTC) ───
function scheduleDailySummary() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(22, 59, 0, 0); // 11:59 PM WAT
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  setTimeout(async () => {
    await sendDailySummary();
    setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`📅 Daily summary scheduled in ${Math.round(msUntil/60000)} minutes`);
}

async function sendDailySummary() {
  try {
    // 1 read: fetch all users with telegramChatId
    const usersSnap = await db.collection('users')
      .where('telegramChatId', '!=', '')
      .select('telegramChatId', 'username', 'balance', 'bonusBalance', 'totalBets', 'wins')
      .limit(500)
      .get();
    if (usersSnap.empty) return;

    // Markets resolving today — from cache, 0 reads
    const todayEnd = new Date(); todayEnd.setUTCHours(23,59,59,999);
    const todayStart = new Date(); todayStart.setUTCHours(0,0,0,0);
    const resolvingToday = _marketsCache.filter(m => {
      if (m.status !== 'active') return false;
      const dl = m.deadline?._seconds ? new Date(m.deadline._seconds*1000) : null;
      return dl && dl >= todayStart && dl <= todayEnd;
    }).slice(0, 3);

    const marketLines = resolvingToday.length
      ? `\n\n⏰ <b>Resolving Today:</b>\n` + resolvingToday.map(m => `• ${(m.question||'').substring(0,60)}`).join('\n')
      : '';

    for (const doc of usersSnap.docs) {
      const u = doc.data();
      if (!u.telegramChatId) continue;
      const fmt = n => '₦' + Number(n||0).toLocaleString('en-NG');
      const wr = u.totalBets > 0 ? Math.round((u.wins||0)/u.totalBets*100) : 0;
      sendTelegramMessage(u.telegramChatId,
        `🌙 <b>Crediplex Daily Summary</b>\n\n` +
        `👤 <b>${u.username}</b>\n` +
        `💰 Balance: <b>${fmt(u.balance)}</b>\n` +
        `🎁 Bonus: <b>${fmt(u.bonusBalance)}</b>\n` +
        `📊 Win Rate: <b>${wr}%</b> (${u.wins||0}/${u.totalBets||0} bets)` +
        marketLines +
        `\n\nGood night! 🌙`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📈 Place a Bet', url: 'https://crediplex.name.ng' }, { text: '💰 Balance', callback_data: 'balance' }]
        ]}}
      ).catch(()=>{});
      await new Promise(r => setTimeout(r, 50)); // 50ms gap between sends to avoid Telegram rate limits
    }
    console.log(`✅ Daily summary sent to ${usersSnap.size} users`);
  } catch(e) { console.error('Daily summary error:', e.message); }
}

scheduleDailySummary();

// ─── MORNING DIGEST: 7:00 AM Nigeria time (UTC+1 = 06:00 UTC) ───
function scheduleMorningDigest() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(6, 0, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  setTimeout(async () => {
    await sendMorningDigest();
    setInterval(sendMorningDigest, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`🌅 Morning digest scheduled in ${Math.round(msUntil/60000)} minutes`);
}

async function sendMorningDigest() {
  try {
    const usersSnap = await db.collection('users')
      .where('telegramChatId', '!=', '')
      .select('telegramChatId', 'username', 'balance', 'totalBets', 'wins')
      .limit(500)
      .get();
    if (usersSnap.empty) return;

    // Markets closing today — from cache, 0 reads
    const todayEnd = new Date(); todayEnd.setUTCHours(23, 59, 59, 999);
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const closingToday = _marketsCache.filter(m => {
      if (m.status !== 'active') return false;
      const dl = m.deadline?._seconds ? new Date(m.deadline._seconds * 1000) : null;
      return dl && dl >= todayStart && dl <= todayEnd;
    }).slice(0, 3);

    const closingLines = closingToday.length
      ? `\n\n⏰ <b>Closing Today — Act Fast:</b>\n` + closingToday.map(m => {
          const dl = new Date(m.deadline._seconds * 1000);
          const timeLeft = Math.round((dl - Date.now()) / 3600000);
          return `• ${(m.question||'').substring(0,55)} (<b>${timeLeft}h left</b>)`;
        }).join('\n')
      : '\n\n✅ No markets closing today — good time to explore new ones!';

    for (const doc of usersSnap.docs) {
      const u = doc.data();
      if (!u.telegramChatId) continue;
      const fmt = n => '₦' + Number(n||0).toLocaleString('en-NG');
      const wr = u.totalBets > 0 ? Math.round((u.wins||0)/u.totalBets*100) : 0;
      const greeting = `Good morning, <b>${u.username}</b>! 🌅`;
      sendTelegramMessage(u.telegramChatId,
        `☀️ <b>Crediplex Morning Digest</b>\n\n` +
        `${greeting}\n\n` +
        `💰 Balance: <b>${fmt(u.balance)}</b>\n` +
        `📊 Win Rate: <b>${wr}%</b> (${u.wins||0}/${u.totalBets||0} bets)` +
        closingLines +
        `\n\nMake today count! 🎯`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📊 View Markets', callback_data: 'markets' }, { text: '🎯 My Bets', callback_data: 'mybets' }],
          [{ text: '🚀 Open Crediplex', url: 'https://crediplex.name.ng' }]
        ]}}
      ).catch(()=>{});
      await new Promise(r => setTimeout(r, 50));
    }
    console.log(`✅ Morning digest sent to ${usersSnap.size} users`);
  } catch(e) { console.error('Morning digest error:', e.message); }
}

scheduleMorningDigest();

// ─── INACTIVITY RE-ENGAGEMENT (runs every 24h at 10am Nigeria time) ───
function scheduleInactivityCheck() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(9, 0, 0, 0); // 10am WAT = 9am UTC
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const msUntil = next - now;
  setTimeout(async () => {
    await runInactivityCheck();
    setInterval(runInactivityCheck, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`💤 Inactivity check scheduled in ${Math.round(msUntil/60000)} minutes`);
}

async function runInactivityCheck() {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const cutoff = admin.firestore.Timestamp.fromDate(sevenDaysAgo);
    // 1 read — fetch users who haven't bet in 7 days and have Telegram linked
    const snap = await db.collection('users')
      .where('telegramChatId', '!=', '')
      .where('lastBetAt', '<', cutoff)
      .select('telegramChatId', 'username', 'balance')
      .limit(200)
      .get();
    if (snap.empty) return;
    // Pick a trending market from cache to feature (0 reads)
    const trending = _marketsCache
      .filter(m => m.status === 'active')
      .sort((a,b) => (b.totalPool||b.polymarketVolume||0) - (a.totalPool||a.polymarketVolume||0))[0];
    const marketLine = trending
      ? `\n\n🔥 <b>Trending now:</b> ${(trending.question||'').substring(0,70)}\nYES: ${trending.polymarketYesOdds||50}% · NO: ${100-(trending.polymarketYesOdds||50)}%`
      : '';
    let sent = 0;
    for (const doc of snap.docs) {
      const u = doc.data();
      if (!u.telegramChatId) continue;
      sendTelegramMessage(u.telegramChatId,
        `👋 <b>Hey ${u.username}!</b>\n\nYou haven't placed a bet in a while. Markets are moving fast — don't miss out!${marketLine}\n\n<b>Your balance:</b> ₦${Number(u.balance||0).toLocaleString('en-NG')} ready to use 💰`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🎯 Place a Bet', callback_data: 'bet' }, { text: '📊 Markets', callback_data: 'markets' }],
          [{ text: '🚀 Open Crediplex', url: 'https://crediplex.name.ng' }]
        ]}}
      ).catch(()=>{});
      sent++;
      await new Promise(r => setTimeout(r, 80));
    }
    console.log(`💤 Inactivity messages sent: ${sent} users`);
  } catch(e) { console.error('Inactivity check error:', e.message); }
}

scheduleInactivityCheck();

// ─── TELEGRAM BOT WEBHOOK HANDLER ────────────────────────────
app.post('/api/telegram-webhook', async (req, res) => {
  res.sendStatus(200); // always ack immediately
  try {
    const update = req.body;
    // Handle inline button taps
    if (update.callback_query) {
      const cbq = update.callback_query;
      const chatId = cbq.message.chat.id;
      await fetch(`${TELEGRAM_API}/answerCallbackQuery`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: cbq.id })
      });
      // Re-use existing command logic by spoofing the text
      const fakeMsg = { chat: { id: chatId }, text: '/' + cbq.data };
      update.message = fakeMsg;
      // Also reset text for the lower handler to pick up
      if (cbq.data === 'balance') update.message.text = '/balance';
      if (cbq.data === 'portfolio') update.message.text = '/portfolio';
      if (cbq.data === 'refer') update.message.text = '/refer';
      if (cbq.data === 'deposit') update.message.text = '/deposit';
      if (cbq.data === 'deposit_crypto') update.message.text = '/deposit_crypto';
      if (cbq.data === 'deposit_naira') update.message.text = '/deposit_naira';
      if (cbq.data === 'help') update.message.text = '/help';
      if (cbq.data === 'setalert') update.message.text = '/setalert';
      if (cbq.data === 'support') update.message.text = '/support';
      if (cbq.data === 'support_end') update.message.text = '/support_end';
      if (cbq.data && cbq.data.startsWith('setalert_pick_')) {
        const marketId = cbq.data.replace('setalert_pick_', '');
        const mkt = _marketsCache.find(m => m.id === marketId);
        if (!mkt) { await sendTelegramMessage(chatId, `Market not found.`); return res.sendStatus(200); }
        const yp = mkt.yesPool||0; const np = mkt.noPool||0; const total = yp+np;
        const currentOdds = total > 0 ? Math.round(yp/total*100) : 50;
        _alertState[chatId.toString()] = { step: 'setalert_threshold', marketId, marketQuestion: mkt.question };
        await sendTelegramMessage(chatId,
          `📊 <b>${(mkt.question||'').substring(0,80)}</b>\n\n` +
          `Current YES odds: <b>${currentOdds}%</b>\n\n` +
          `Reply with the YES % you want to be alerted at (e.g. <b>70</b>):`,
          { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
        );
        return res.sendStatus(200);
      }
      if (cbq.data === 'alert_cancel') {
        delete _alertState[chatId.toString()];
        await sendTelegramMessage(chatId, `Alert cancelled.`);
        return res.sendStatus(200);
      }
      if (cbq.data === 'unsubscribe_confirm') update.message.text = '/unsubscribe_confirm';
      if (cbq.data.startsWith('dep_check_')) {
        const paymentId = cbq.data.replace('dep_check_', '');
        try {
          const r = await fetch(`${process.env.SERVER_URL || 'https://crediplex-production.up.railway.app'}/api/payment-status/${paymentId}`);
          const d = await r.json();
          const status = d.data?.payment_status || 'unknown';
          const statusMsg = status === 'finished' || status === 'confirmed'
            ? `✅ Payment confirmed! Your wallet has been credited.`
            : status === 'waiting' ? `⏳ Still waiting for your payment. Please send the exact amount.`
            : status === 'confirming' ? `🔄 Payment received! Waiting for network confirmation (~2 min).`
            : `⏳ Status: ${status}. Please wait a few minutes and check again.`;
          await sendTelegramMessage(chatId, statusMsg,
            { reply_markup: { inline_keyboard: [[{ text: '💰 Check Balance', callback_data: 'balance' }]] }}
          );
        } catch(e) { await sendTelegramMessage(chatId, `⚠️ Could not check status. Try /balance to see if it credited.`); }
        return;
      }
      if (cbq.data === 'lb_crediplex') update.message.text = '/lb_crediplex';
      if (cbq.data === 'withdraw') update.message.text = '/withdraw';
      if (cbq.data === 'bet') update.message.text = '/bet';
      if (cbq.data === 'cashout') update.message.text = '/cashout';
      if (cbq.data === 'stats') update.message.text = '/stats';
      if (cbq.data === 'copytrade') update.message.text = '/copytrade';
      if (cbq.data === 'lb_polymarket') update.message.text = '/lb_polymarket';
      if (cbq.data === 'markets_more') update.message.text = 'markets_more';
      if (cbq.data === 'admin_broadcast') update.message.text = '/admin_broadcast';
      if (cbq.data === 'admin_markets') update.message.text = '/admin_markets';
      if (cbq.data === 'admin_users') update.message.text = '/admin_users';
      if (cbq.data === 'news') update.message.text = '/news';
      if (cbq.data === 'mybets') update.message.text = '/mybets';
      if (cbq.data === 'leaderboard') update.message.text = '/leaderboard';
      if (cbq.data === 'markets') update.message.text = '/markets';
      if (cbq.data === 'alert') update.message.text = '/alert';
      if (cbq.data === 'alert_cancel') update.message.text = '/alert_cancel';

      // Market selection in alert flow
      if (cbq.data.startsWith('alertmkt_')) {
        const idx = parseInt(cbq.data.replace('alertmkt_', ''));
        const st = _alertState[chatId.toString()];
        if (!st || !st.matches) return;
        const chosen = st.matches[idx];
        if (!chosen) return;
        _alertState[chatId.toString()] = { step: 'awaiting_outcome', chosenMarket: chosen };
        // Build outcome buttons from market
        let outcomes = ['YES', 'NO'];
        try { const parsed = JSON.parse(chosen.outcomes || '[]'); if (parsed.length >= 2) outcomes = parsed.map(o => o.toUpperCase()); } catch(e) {}
        const buttons = outcomes.map((o, i) => [{ text: o, callback_data: `alertout_${i}_${o}` }]);
        buttons.push([{ text: '❌ Cancel', callback_data: 'alert_cancel' }]);
        await sendTelegramMessage(chatId,
          `✅ <b>${(chosen.question||'').substring(0,70)}</b>\n\nWhich outcome do you want to track?`,
          { reply_markup: { inline_keyboard: buttons }}
        );
        return;
      }

      // Withdrawal method callbacks
      if (cbq.data === 'wd_naira') { update.message = { chat:{id:chatId}, text:'/wd_naira' }; }
      if (cbq.data === 'wd_crypto') { update.message = { chat:{id:chatId}, text:'/wd_crypto' }; }

      // Withdrawal coin selected
      if (cbq.data.startsWith('wdcoin_')) {
        const coin = cbq.data.replace('wdcoin_','');
        const st = _withdrawState[chatId.toString()];
        if (!st) { await sendTelegramMessage(chatId,`⚠️ Session expired. Type /withdraw to start again.`); return; }
        _withdrawState[chatId.toString()] = { ...st, step:'crypto_amount', coin };
        const minAmt = coin==='btc' ? 0.0001 : 0.5;
        await sendTelegramMessage(chatId,
          `✅ Coin: <b>${coin.toUpperCase()}</b>\n\nHow much in USD? (Min $${minAmt})\nType amount e.g. <b>5</b>`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}
        ); return;
      }

      // Bet: market selected
      if (cbq.data.startsWith('bet_mkt_')) {
        const idx = parseInt(cbq.data.replace('bet_mkt_',''));
        const st = _betState[chatId.toString()];
        if (!st?.matches) { await sendTelegramMessage(chatId,`⚠️ Session expired. Type /bet to start again.`); return; }
        const chosen = st.matches[idx];
        if (!chosen) return;
        const yes = chosen.polymarketYesOdds || Math.round((chosen.yesPool||50)/((chosen.yesPool||50)+(chosen.noPool||50))*100);
        const no = 100-yes;
        const fmt$ = n => n>=1000?`$${(n/1000).toFixed(1)}K`:`$${n}`;
        const vol = fmt$(Math.round(chosen.polymarketVolume||chosen.totalPool||0));
        _betState[chatId.toString()] = { step:'awaiting_side', market: chosen };
        await sendTelegramMessage(chatId,
          `🎯 <b>${(chosen.question||'').substring(0,80)}</b>\n\n` +
          `YES: <b>${yes}%</b> · NO: <b>${no}%</b>\n` +
          `Volume: <b>${vol}</b>\n\n` +
          `Which side do you want to bet on?`,
          { reply_markup: { inline_keyboard: [
            [{ text: `✅ YES (${yes}%)`, callback_data: 'bet_side_YES' }, { text: `❌ NO (${no}%)`, callback_data: 'bet_side_NO' }],
            [{ text: '🔙 Back', callback_data: 'bet' }, { text: '❌ Cancel', callback_data: 'alert_cancel' }]
          ]}}
        ); return;
      }

      // Bet: side selected
      if (cbq.data.startsWith('bet_side_')) {
        const side = cbq.data.replace('bet_side_','');
        const st = _betState[chatId.toString()];
        if (!st?.market) { await sendTelegramMessage(chatId,`⚠️ Session expired. Type /bet to start again.`); return; }
        _betState[chatId.toString()] = { ...st, step:'awaiting_amount', side };
        const userSnap = await db.collection('users').where('telegramChatId','==',chatId.toString()).limit(1).get();
        const bal = userSnap.empty ? 0 : (userSnap.docs[0].data().balance||0);
        const fmt = n => '₦'+Number(n||0).toLocaleString('en-NG');
        await sendTelegramMessage(chatId,
          `✅ Side: <b>${side}</b>\n\nYour balance: <b>${fmt(bal)}</b>\n\nHow much do you want to bet? (Min ₦200)\nType amount e.g. <b>500</b>`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}
        ); return;
      }

      // Cashout confirm
      if (cbq.data.startsWith('co_')) {
        const parts = cbq.data.split('_');
        // co_betId_marketId_side_stakeAmount_cashoutVal
        const betId = parts[1];
        const marketId = parts[2];
        const side = parts[3];
        const stakeAmount = parseInt(parts[4]);
        const cashoutVal = parseInt(parts[5]);
        const fmt = n => '₦'+Number(n||0).toLocaleString('en-NG');
        _withdrawState[chatId.toString()] = { step:'cashout_pin', betId, marketId, side, stakeAmount, cashoutVal };
        await sendTelegramMessage(chatId,
          `💸 <b>Confirm Cashout</b>\n\n` +
          `Side: <b>${side}</b>\n` +
          `Staked: <b>${fmt(stakeAmount)}</b>\n` +
          `You receive: <b>${fmt(cashoutVal)}</b>\n\n` +
          `🔐 Enter your <b>4-digit PIN</b> to confirm:`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}
        ); return;
      }

      // Copy trade: trader picked
      if (cbq.data.startsWith('ct_pick_')) {
        const parts = cbq.data.replace('ct_pick_','').split('_');
        const traderId = parts[0];
        const traderName = parts.slice(1).join('_');
        _depositState[chatId.toString()] = { step: 'ct_awaiting_amount', traderId, traderName };
        await sendTelegramMessage(chatId,
          `✅ Copying: <b>${traderName}</b>\n\nChoose copy mode:`,
          { reply_markup: { inline_keyboard: [
            [{ text: '💰 Fixed Amount per trade', callback_data: `ct_mode_fixed_${traderId}_${traderName}` }],
            [{ text: '📊 Proportional (% of balance)', callback_data: `ct_mode_prop_${traderId}_${traderName}` }],
            [{ text: '❌ Cancel', callback_data: 'alert_cancel' }]
          ]}}
        );
        return;
      }

      // Copy trade: mode picked
      if (cbq.data.startsWith('ct_mode_')) {
        const parts = cbq.data.replace('ct_mode_','').split('_');
        const mode = parts[0]; // fixed or prop
        const traderId = parts[1];
        const traderName = parts.slice(2).join('_');
        _depositState[chatId.toString()] = { step: 'ct_awaiting_amount', traderId, traderName, mode };
        const hint = mode === 'fixed'
          ? `How much (₦) per trade?\n\nMin ₦200. Type amount e.g. <b>500</b>`
          : `What % of your balance per trade?\n\nType 1–50 e.g. <b>10</b> for 10%`;
        await sendTelegramMessage(chatId, `🔄 Mode: <b>${mode === 'fixed' ? 'Fixed Amount' : 'Proportional'}</b>\n\n${hint}`,
          { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
        );
        return;
      }

      // Coin selection for crypto deposit
      if (cbq.data.startsWith('coin_')) {
        const coin = cbq.data.replace('coin_', '');
        const st = _depositState[chatId.toString()];
        if (!st) { await sendTelegramMessage(chatId, `⚠️ Session expired. Type /deposit to start again.`); return; }
        _depositState[chatId.toString()] = { ...st, step: 'awaiting_amount', coin };
        const coinNames = { usdttrc20:'USDT (TRC20)', usdterc20:'USDT (ERC20)', btc:'Bitcoin', sol:'Solana', eth:'Ethereum', bnb:'BNB' };
        await sendTelegramMessage(chatId,
          `✅ Coin: <b>${coinNames[coin]||coin.toUpperCase()}</b>\n\nHow much do you want to deposit in USD?\n\nMinimum: <b>$1</b>\nType amount e.g. <b>10</b>`,
          { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
        );
        return;
      }

      // Outcome selection in alert flow
      if (cbq.data.startsWith('alertout_')) {
        const parts = cbq.data.split('_');
        const outcome = parts.slice(2).join('_');
        const st = _alertState[chatId.toString()];
        if (!st || !st.chosenMarket) return;
        _alertState[chatId.toString()] = { ...st, step: 'awaiting_threshold', chosenOutcome: outcome };
        await sendTelegramMessage(chatId,
          `🎯 Outcome: <b>${outcome}</b>\n\nAt what odds % should I alert you?\n\nType a number e.g. <b>70</b> (means alert when ${outcome} hits 70%)`,
          { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
        );
        return;
      }
    }

    const msg = update.message || update.edited_message;
    if (!msg) return;
    // Allow photo messages through for admin broadcast
    const hasText = !!msg.text;
    const hasPhoto = !!(msg.photo && msg.photo.length > 0);
    if (!hasText && !hasPhoto) return;
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim().toLowerCase();

    // Rate limit — skip for support replies so AI chat works smoothly
    const inSupportFlow = !!_supportState[chatId.toString()];
    if (!inSupportFlow && isTgRateLimited(chatId.toString())) return;

    if (text === '/cancel') {
      delete _alertState[chatId.toString()];
      await sendTelegramMessage(chatId,
        `✅ Cancelled. What would you like to do?`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📋 Commands', callback_data: 'help' }, { text: '🚀 Open App', url: 'https://crediplex.name.ng' }]
        ]}}
      );
      return;
    }

    if (text === '/news') {
      // Pick the highest-volume active market from cache (0 reads)
      const sorted = _marketsCache
        .filter(m => m.status === 'active')
        .sort((a, b) => (b.polymarketVolume || b.totalPool || 0) - (a.polymarketVolume || a.totalPool || 0))
        .slice(0, 3);
      if (!sorted.length) {
        await sendTelegramMessage(chatId, `📰 No markets available right now. Check back soon!`); return;
      }
      // Ask Claude AI to write a news-style blurb for each market
      try {
        const marketSummaries = sorted.map(m => {
          const odds = m.polymarketYesOdds || 50;
          return `Market: "${m.question}" | YES odds: ${odds}% | Volume: $${Math.round(m.polymarketVolume||0).toLocaleString()}`;
        }).join('\n');
        const aiRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            max_tokens: 400,
            messages: [{
              role: 'user',
              content: `You are a witty prediction market news writer for Crediplex, a Nigerian prediction market app. Write 3 short news-style blurbs (1-2 sentences each) for these trending markets. Each blurb should start with "🔥 TRENDING:" or "📰 NEW:" or "⚡ HOT:", mention what traders predict, and feel engaging and punchy. Do NOT use markdown. Just plain text with line breaks between each blurb.\n\n${marketSummaries}`
            }]
          })
        });
        const aiData = await aiRes.json();
        const newsText = aiData.choices?.[0]?.message?.content || '';
        // Build market link buttons for each market shown
        const marketButtons = sorted.map(m => [{
          text: `📊 ${(m.question||'').substring(0,40)}`,
          url: marketUrl(m)
        }]);
        marketButtons.push([{ text: '📈 All Markets', url: 'https://crediplex.name.ng' }, { text: '🔔 Set Alert', callback_data: 'alert' }]);
        await sendTelegramMessage(chatId,
          `📰 <b>Crediplex Market News</b>\n\n${newsText}\n\n<a href="https://crediplex.name.ng">Powered by Crediplex</a>`,
          { reply_markup: { inline_keyboard: marketButtons }}
        );
      } catch(aiErr) {
        // Fallback if AI fails — show raw market data
        const lines = sorted.map(m => {
          const odds = m.polymarketYesOdds || 50;
          return `🔥 <b>${(m.question||'').substring(0,70)}</b>\nTraders say YES: <b>${odds}%</b>`;
        }).join('\n\n');
        await sendTelegramMessage(chatId, `📰 <b>Trending Markets</b>\n\n${lines}`,
          { reply_markup: { inline_keyboard: [[{ text: '📈 View All', url: 'https://crediplex.name.ng' }]] }}
        );
      }
      return;
    }

    if (text.startsWith('/start')) {
      // Check if already linked
      const existingUser = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
      if (!existingUser.empty) {
        const u = existingUser.docs[0].data();
        await sendTelegramMessage(chatId,
          `👋 <b>Welcome back, ${u.username}!</b>\n\n` +
          `Your Crediplex account is already linked. ✅\n\n` +
          `Use /balance to check your wallet, /deposit to fund it, or /support for help.\n\n` +
          `Type /help to see all commands.`
        );
        return;
      }
      // generate verification code
      const code = Math.random().toString(36).substring(2, 8).toUpperCase();
      const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
      await db.collection('telegramVerifyCodes').add({ chatId: chatId.toString(), code, used: false, expiresAt: admin.firestore.Timestamp.fromDate(expiresAt) });
      await sendTelegramMessage(chatId,
        `👋 <b>Welcome to Crediplex!</b>\n\n` +
        `Your verification code is:\n\n<code>${code}</code>\n\n` +
        `Paste this in the Crediplex app under Settings → Link Telegram.\n\nCode expires in 10 minutes.`
      );
      return;
    }

    if (text === '/unsubscribe') {
      const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
      if (userSnap.empty) {
        await sendTelegramMessage(chatId, `⚠️ No Crediplex account is linked to this Telegram.`); return;
      }
      const u = userSnap.docs[0].data();
      await sendTelegramMessage(chatId,
        `⚠️ <b>Are you sure you want to unlink?</b>\n\n` +
        `Account: <b>${u.username}</b>\n\n` +
        `You will stop receiving:\n• Win/loss notifications\n• Deposit confirmations\n• Copy trade alerts\n• Daily summaries\n• Price alerts\n\n` +
        `This will NOT affect your Crediplex balance or bets.`,
        { reply_markup: { inline_keyboard: [
          [{ text: '✅ Yes, Unlink My Account', callback_data: 'unsubscribe_confirm' }],
          [{ text: '❌ No, Keep Notifications', callback_data: 'help' }]
        ]}}
      );
      return;
    }

    if (text === '/unsubscribe_confirm' || text === 'unsubscribe_confirm') {
      const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
      if (userSnap.empty) { await sendTelegramMessage(chatId, `⚠️ No account linked.`); return; }
      await userSnap.docs[0].ref.update({ telegramChatId: admin.firestore.FieldValue.delete() });
      await sendTelegramMessage(chatId,
        `✅ <b>Unlinked successfully.</b>\n\nYou won't receive notifications anymore.\n\nType /start anytime to re-link.`
      );
      return;
    }

    if (text === '/help') {
      await sendTelegramMessage(chatId,
        `📋 <b>Crediplex Bot Commands</b>\n\n` +
        `/balance — Check your wallet balance\n` +
        `/portfolio — See your bet stats\n` +
        `/deposit — Fund your wallet (crypto or bank)\n` +
        `/withdraw — Withdraw your funds\n` +
        `/support — Chat with AI support agent\n` +
        `/start — Link your Crediplex account\n` +
        `/help — Show this menu`,
        { reply_markup: { inline_keyboard: [
          [{ text: '💰 Balance', callback_data: 'balance' }, { text: '📊 Portfolio', callback_data: 'portfolio' }],
          [{ text: '💳 Deposit', callback_data: 'deposit' }, { text: '💸 Withdraw', callback_data: 'withdraw' }],
          [{ text: '🎧 Support', callback_data: 'support' }],
          [{ text: '🚀 Open Crediplex', url: 'https://crediplex.name.ng' }]
        ]}}
      );
      return;
    }

    if (text === '/refer' || text === '/referral') {
      const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
      if (userSnap.empty) {
        await sendTelegramMessage(chatId, `⚠️ No Crediplex account linked. Use /start to link your account.`);
        return;
      }
      const u = userSnap.docs[0].data();
      const refCode = u.referralCode || 'N/A';
      const refCount = u.referralCount || 0;
      const refVolume = u.referralVolume || 0;
      const rawTier = u.referralTier || 'bronze';
      const tierEmoji = rawTier==='diamond'?'💎':rawTier==='gold'?'🥇':rawTier==='silver'?'🥈':'🥉';
      const tierName = rawTier.charAt(0).toUpperCase() + rawTier.slice(1);
      // tier progress
      const nextTierMap = { bronze: { name:'Silver', need: 5 }, silver: { name:'Gold', need: 20 }, gold: { name:'Diamond', need: 50 }, diamond: null };
      const next = nextTierMap[rawTier];
      const progressLine = next
        ? `📈 Progress: <b>${refCount}/${next.need}</b> referrals to ${next.name}`
        : `🏆 You are at the highest tier!`;
      const refLink = `https://crediplex.name.ng?ref=${refCode}`;
      await sendTelegramMessage(chatId,
        `👥 <b>Your Referral Dashboard</b>\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `👤 <b>${u.username}</b>\n` +
        `${tierEmoji} Tier: <b>${tierName}</b>\n\n` +
        `👥 Total Referrals: <b>${refCount}</b>\n` +
        `💸 Volume Generated: <b>₦${Number(refVolume).toLocaleString('en-NG')}</b>\n` +
        `${progressLine}\n` +
        `━━━━━━━━━━━━━━━━━━\n` +
        `🔗 Your referral link:\n<code>${refLink}</code>\n\n` +
        `Share this link — when your friend signs up and places their first bet, you both earn a bonus! 🎁`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📤 Share My Link', url: `https://t.me/share/url?url=${encodeURIComponent(refLink)}&text=${encodeURIComponent('Join me on Crediplex — Nigeria\'s #1 Prediction Market! 🎯')}` }],
          [{ text: '📊 My Full Stats', callback_data: 'portfolio' }, { text: '💰 Balance', callback_data: 'balance' }]
        ]}}
      );
      return;
    }

    if (text === '/deposit') {
      // No Firestore reads needed — just ask method
      await sendTelegramMessage(chatId,
        `💳 <b>Fund Your Crediplex Wallet</b>\n\nHow would you like to deposit?`,
        { reply_markup: { inline_keyboard: [
          [{ text: '💵 Crypto (USD)', callback_data: 'deposit_crypto' }],
          [{ text: '🇳🇬 Bank Transfer (NGN)', callback_data: 'deposit_naira' }]
        ]}}
      );
      return;
    }

    if (text === '/deposit_crypto') {
      const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
      if (userSnap.empty) { await sendTelegramMessage(chatId, `⚠️ No Crediplex account linked. Use /start first.`); return; }
      _depositState[chatId.toString()] = { step: 'awaiting_coin', userId: userSnap.docs[0].id };
      await sendTelegramMessage(chatId,
        `💵 <b>Crypto Deposit</b>\n\nChoose your coin:`,
        { reply_markup: { inline_keyboard: [
          [{ text: '💵 USDT (TRC20)', callback_data: 'coin_usdttrc20' }, { text: '💵 USDT (ERC20)', callback_data: 'coin_usdterc20' }],
          [{ text: '₿ Bitcoin', callback_data: 'coin_btc' }, { text: '◎ Solana', callback_data: 'coin_sol' }],
          [{ text: 'Ξ Ethereum', callback_data: 'coin_eth' }, { text: '🔷 BNB', callback_data: 'coin_bnb' }],
          [{ text: '❌ Cancel', callback_data: 'alert_cancel' }]
        ]}}
      );
      return;
    }

    if (text === '/deposit_naira') {
      const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
      if (userSnap.empty) { await sendTelegramMessage(chatId, `⚠️ No Crediplex account linked. Use /start first.`); return; }
      const u = userSnap.docs[0].data();
      const NAIRA_ACCOUNT_NAME = process.env.NAIRA_ACCOUNT_NAME || 'Crediplex Payments';
      const NAIRA_ACCOUNT_NUMBER = process.env.NAIRA_ACCOUNT_NUMBER || '0000000000';
      const NAIRA_BANK_NAME = process.env.NAIRA_BANK_NAME || 'GTBank';
      _depositState[chatId.toString()] = { step: 'naira_awaiting_amount', userId: userSnap.docs[0].id, username: u.username };
      await sendTelegramMessage(chatId,
        `🇳🇬 <b>Naira Bank Transfer</b>\n\n` +
        `Transfer to:\n` +
        `🏦 Bank: <b>${NAIRA_BANK_NAME}</b>\n` +
        `👤 Name: <b>${NAIRA_ACCOUNT_NAME}</b>\n` +
        `💳 Account: <code>${NAIRA_ACCOUNT_NUMBER}</code>\n\n` +
        `⚠️ Use <b>${u.username}</b> as your transfer reference/narration.\n\n` +
        `How much are you sending? (Min ₦500)\nType the amount e.g. <b>5000</b>`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
      );
      return;
    }

    if (text === '/markets' || text.startsWith('/markets ')) {
      const keyword = text.replace('/markets','').trim().toLowerCase();
      // Only show Crediplex markets — exclude pure Polymarket mirrors with no local bets
      let pool = _marketsCache.filter(m => m.status === 'active' && (m.totalPool > 0 || m.source === 'crediplex' || m.createdBy));
      if (!pool.length) pool = _marketsCache.filter(m => m.status === 'active'); // fallback to all if none match
      if (keyword) pool = pool.filter(m => (m.question||'').toLowerCase().includes(keyword));
      pool = pool.sort((a,b) => (b.totalPool||b.polymarketVolume||0) - (a.totalPool||a.polymarketVolume||0));
      if (!pool.length) {
        await sendTelegramMessage(chatId,
          keyword ? `😕 No active markets found for "<b>${keyword}</b>".\n\nTry /markets without a keyword to see all.` : `⚠️ No active markets right now. Markets refresh every 30 minutes.`,
          { reply_markup: { inline_keyboard: [[{ text: '📈 View All Markets', url: 'https://crediplex.name.ng' }]] }}
        ); return;
      }
      const show = pool.slice(0, 3);
      const rest = pool.length - 3;
      const fmt$ = n => n >= 1000 ? `$${(n/1000).toFixed(1)}K` : `$${n}`;
      const lines = show.map((m, i) => {
        const yes = m.polymarketYesOdds || Math.round((m.yesPool||50)/((m.yesPool||50)+(m.noPool||50))*100);
        const no = 100 - yes;
        const vol = fmt$(Math.round(m.polymarketVolume || m.totalPool || 0));
        const liq = fmt$(Math.round(m.polymarketLiquidity || m.totalPool || 0));
        let line = `${i+1}. <b>${(m.question||'').substring(0,65)}</b>\n`;
        line += `   ├ Yes ${yes}¢ · No ${no}¢\n`;
        line += `   └ Vol ${vol} · Liq ${liq}`;
        return line;
      }).join('\n\n');
      const buttons = show.map((m, i) => ([{ text: `${i+1}. Bet on this market →`, url: marketUrl(m) }]));
      buttons.push([{ text: '🔍 View All Markets', url: 'https://crediplex.name.ng' }]);
      if (rest > 0) buttons.unshift([{ text: `+${rest} more markets`, callback_data: 'markets_more' }]);
      await sendTelegramMessage(chatId,
        `📊 <b>${keyword ? `Markets: "${keyword}"` : 'Top Live Markets'}</b>\n\n${lines}\n\n<i>Powered by Crediplex</i>`,
        { reply_markup: { inline_keyboard: buttons }}
      );
      return;
    }

    if (text === 'markets_more') {
      const pool = _marketsCache.filter(m => m.status === 'active').slice(3, 8);
      if (!pool.length) { await sendTelegramMessage(chatId, `No more markets.`); return; }
      const fmt$ = n => n >= 1000 ? `$${(n/1000).toFixed(1)}K` : `$${n}`;
      const lines = pool.map((m, i) => {
        const yes = m.polymarketYesOdds || 50;
        const vol = fmt$(Math.round(m.polymarketVolume || m.totalPool || 0));
        return `${i+4}. <b>${(m.question||'').substring(0,65)}</b>\n   ├ Yes ${yes}¢ · No ${100-yes}¢\n   └ Vol ${vol}`;
      }).join('\n\n');
      const moreButtons = pool.map((m, i) => ([{ text: `${i+4}. Bet on this →`, url: marketUrl(m) }]));
      moreButtons.push([{ text: '🔍 View All Markets', url: 'https://crediplex.name.ng' }]);
      await sendTelegramMessage(chatId, `📊 <b>More Markets</b>\n\n${lines}`,
        { reply_markup: { inline_keyboard: moreButtons }}
      );
      return;
    }

    if (text === '/mybets') {
      const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
      if (userSnap.empty) {
        await sendTelegramMessage(chatId, `⚠️ No Crediplex account linked. Use /start first.`); return;
      }
      const uid = userSnap.docs[0].id;
      const betsSnap = await db.collection('bets').where('uid', '==', uid).orderBy('createdAt', 'desc').limit(15).get();
      if (betsSnap.empty) {
        await sendTelegramMessage(chatId, `📭 You have no active bets right now.\n\n<a href="https://crediplex.name.ng">Place a bet →</a>`); return;
      }
      const marketMap = {};
      _marketsCache.forEach(m => { marketMap[m.id] = m; });
      const allBets = betsSnap.docs.map(d=>d.data());
      const pending = allBets.filter(b=>b.status==='pending');
      const won = allBets.filter(b=>b.status==='won').length;
      const lost = allBets.filter(b=>b.status==='lost').length;
      const lines = allBets.slice(0,10).map((b, i) => {
        const mkt = marketMap[b.marketId];
        const q = ((mkt && mkt.question) || 'Unknown market').substring(0, 55);
        const statusIcon = b.status==='won'?'✅':b.status==='lost'?'❌':'⏳';
        return `${i+1}. ${statusIcon} <b>${b.side}</b> — ₦${Number(b.amount||0).toLocaleString('en-NG')}\n   📌 <a href="${marketUrl(mkt||{})}">${q}</a>`;
      }).join('\n\n');
      await sendTelegramMessage(chatId,
        `🎯 <b>Your Recent Bets</b>\n⏳ ${pending.length} active · ✅ ${won} won · ❌ ${lost} lost\n\n${lines}`,
        { reply_markup: { inline_keyboard: [[{ text: '📈 View All on Crediplex', url: 'https://crediplex.name.ng' }]] }}
      );
      return;
    }

    // ── /alert AI flow ──
    if (text === '/alert') {
      // Store state in memory keyed by chatId
      _alertState[chatId.toString()] = { step: 'awaiting_keyword' };
      await sendTelegramMessage(chatId,
        `🔔 <b>Set a Price Alert</b>\n\nWhich market do you want to track?\n\nJust type a keyword (e.g. <i>Bitcoin</i>, <i>Nigeria</i>, <i>World Cup</i>)`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
      );
      return;
    }

    if (text === '/alert_cancel' || text === 'alert_cancel') {
      delete _alertState[chatId.toString()];
      await sendTelegramMessage(chatId, `✅ Alert setup cancelled.`); return;
    }

    if (text === '/leaderboard') {
      await sendTelegramMessage(chatId,
        `🏆 <b>Leaderboard</b>\n\nWhich leaderboard do you want to see?`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🌐 Crediplex Traders', callback_data: 'lb_crediplex' }],
          [{ text: '📊 Polymarket Traders', callback_data: 'lb_polymarket' }]
        ]}}
      );
      return;
    }

    if (text === '/withdraw') {
      const userSnap = await db.collection('users').where('telegramChatId','==',chatId.toString()).limit(1).get();
      if (userSnap.empty) { await sendTelegramMessage(chatId,`⚠️ No account linked. Use /start first.`); return; }
      const u = userSnap.docs[0].data();
      if (!u.transactionPin) {
        await sendTelegramMessage(chatId,
          `🔐 <b>Transaction PIN Required</b>\n\nYou need to set a Transaction PIN before withdrawing.\n\nGo to the Crediplex app → Menu → Transaction PIN to set it up.`,
          { reply_markup: { inline_keyboard: [[{ text: '🔐 Set PIN in App', url: 'https://crediplex.name.ng' }]] }}
        ); return;
      }
      const fmt = n => '₦' + Number(n||0).toLocaleString('en-NG');
      await sendTelegramMessage(chatId,
        `💸 <b>Withdraw Funds</b>\n\nBalance: <b>${fmt(u.balance)}</b>\n\nChoose withdrawal method:`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🏦 Naira Bank Transfer', callback_data: 'wd_naira' }],
          [{ text: '🌐 Crypto Withdrawal', callback_data: 'wd_crypto' }],
          [{ text: '❌ Cancel', callback_data: 'alert_cancel' }]
        ]}}
      );
      return;
    }

    if (text === '/wd_naira' || text === 'wd_naira') {
      const userSnap = await db.collection('users').where('telegramChatId','==',chatId.toString()).limit(1).get();
      if (userSnap.empty) return;
      const u = userSnap.docs[0].data();
      const fmt = n => '₦' + Number(n||0).toLocaleString('en-NG');
      _withdrawState[chatId.toString()] = { step: 'naira_amount', userId: userSnap.docs[0].id, username: u.username, balance: u.balance };
      await sendTelegramMessage(chatId,
        `🏦 <b>Naira Withdrawal</b>\n\nAvailable: <b>${fmt(u.balance)}</b>\n\nHow much do you want to withdraw? (Min ₦500)\nType the amount e.g. <b>5000</b>`,
        { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
      ); return;
    }

    if (text === '/wd_crypto' || text === 'wd_crypto') {
      const userSnap = await db.collection('users').where('telegramChatId','==',chatId.toString()).limit(1).get();
      if (userSnap.empty) return;
      const u = userSnap.docs[0].data();
      const balUsd = ((u.balance||0) / (global._liveNgnRate||1500)).toFixed(2);
      _withdrawState[chatId.toString()] = { step: 'crypto_coin', userId: userSnap.docs[0].id, username: u.username, balance: u.balance };
      await sendTelegramMessage(chatId,
        `🌐 <b>Crypto Withdrawal</b>\n\nAvailable: <b>≈$${balUsd} USD</b>\n\nChoose coin:`,
        { reply_markup: { inline_keyboard: [
          [{ text: '◎ Solana (SOL)', callback_data: 'wdcoin_sol' }],
          [{ text: '💵 USDT TRC20', callback_data: 'wdcoin_usdttrc20' }],
          [{ text: '₿ Bitcoin', callback_data: 'wdcoin_btc' }],
          [{ text: '❌ Cancel', callback_data: 'alert_cancel' }]
        ]}}
      ); return;
    }

    if (text === '/bet' || text.startsWith('/bet ')) {
      const keyword = text.replace('/bet','').trim().toLowerCase();
      if (!keyword) {
        _betState[chatId.toString()] = { step: 'awaiting_keyword' };
        await sendTelegramMessage(chatId,
          `🎯 <b>Place a Bet</b>\n\nWhich market do you want to bet on?\n\nType a keyword (e.g. <i>Bitcoin</i>, <i>Nigeria</i>, <i>Election</i>)`,
          { reply_markup: { inline_keyboard: [[{ text: '📊 Browse Markets', callback_data: 'markets' }, { text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
        ); return;
      }
      // Direct keyword search
      const matches = _marketsCache.filter(m =>
        m.status === 'active' && (m.question||'').toLowerCase().includes(keyword)
      ).slice(0, 5);
      if (!matches.length) {
        await sendTelegramMessage(chatId,
          `😕 No markets found for "<b>${keyword}</b>".\n\nTry a different keyword or use /markets to browse.`,
          { reply_markup: { inline_keyboard: [[{ text: '📊 All Markets', callback_data: 'markets' }]] }}
        ); return;
      }
      _betState[chatId.toString()] = { step: 'awaiting_market', matches };
      const buttons = matches.map((m,i) => {
        const yes = m.polymarketYesOdds || 50;
        return [{ text: `${(m.question||'').substring(0,50)} (YES ${yes}%)`, callback_data: `bet_mkt_${i}` }];
      });
      buttons.push([{ text: '❌ Cancel', callback_data: 'alert_cancel' }]);
      await sendTelegramMessage(chatId,
        `🔍 Found <b>${matches.length}</b> market(s). Pick one:`,
        { reply_markup: { inline_keyboard: buttons }}
      ); return;
    }

    if (text === '/cashout') {
      const userSnap = await db.collection('users').where('telegramChatId','==',chatId.toString()).limit(1).get();
      if (userSnap.empty) { await sendTelegramMessage(chatId,`⚠️ No account linked. Use /start first.`); return; }
      const uid = userSnap.docs[0].id;
      const betsSnap = await db.collection('bets').where('uid','==',uid).where('status','==','pending').orderBy('createdAt','desc').limit(8).get();
      if (betsSnap.empty) {
        await sendTelegramMessage(chatId,`📭 You have no active bets to cash out.`,
          { reply_markup: { inline_keyboard: [[{ text: '🎯 Place a Bet', callback_data: 'bet' }]] }}
        ); return;
      }
      const marketMap = {};
      _marketsCache.forEach(m => { marketMap[m.id] = m; });
      const fmt = n => '₦' + Number(n||0).toLocaleString('en-NG');
      const buttons = betsSnap.docs.map((d,i) => {
        const b = d.data();
        const mkt = marketMap[b.marketId];
        const yesPool = mkt?.yesPool||0; const noPool = mkt?.noPool||0;
        const totalPool = yesPool+noPool;
        const sidePool = b.side==='YES'?yesPool:noPool;
        let fairValue = b.amount;
        if(totalPool>0&&sidePool>0) fairValue = Math.floor((totalPool*0.90/sidePool)*b.amount*0.85);
        fairValue = Math.min(fairValue,b.amount*1.5);
        fairValue = Math.max(fairValue,b.amount*0.50);
        const cashoutVal = Math.floor(fairValue*0.90);
        const q = (mkt?.question||b.marketId||'').substring(0,35);
        return [{ text: `${b.side} · ${fmt(b.amount)} → ${fmt(cashoutVal)} · ${q}`, callback_data: `co_${d.id}_${b.marketId}_${b.side}_${b.amount}_${cashoutVal}` }];
      });
      buttons.push([{ text: '❌ Cancel', callback_data: 'alert_cancel' }]);
      await sendTelegramMessage(chatId,
        `💸 <b>Cashout a Bet</b>\n\nPick which bet to cash out:\n<i>(stake → cashout value)</i>`,
        { reply_markup: { inline_keyboard: buttons }}
      ); return;
    }

    if (text === '/stats') {
      const userSnap = await db.collection('users').where('telegramChatId','==',chatId.toString()).limit(1).get();
      if (userSnap.empty) { await sendTelegramMessage(chatId,`⚠️ No account linked. Use /start first.`); return; }
      const u = userSnap.docs[0].data();
      const fmt = n => '₦' + Number(n||0).toLocaleString('en-NG');
      const wr = u.totalBets>0 ? Math.round((u.wins||0)/u.totalBets*100) : 0;
      const profit = u.profit||0;
      const profitStr = profit>=0 ? `+${fmt(profit)}` : fmt(profit);
      const profitEmoji = profit>=0 ? '📈' : '📉';
      const streak = u.currentStreak||0;
      const streakEmoji = streak>=5?'🔥🔥':streak>=3?'🔥':'⚡';
      const tier = (u.referralTier||'bronze').toUpperCase();
      const tierEmoji = tier==='DIAMOND'?'💎':tier==='GOLD'?'🥇':tier==='SILVER'?'🥈':'🥉';
      const avgStake = u.totalBets>0 ? fmt(Math.round((u.totalStaked||0)/u.totalBets)) : '₦0';
      const biggestWin = fmt(u.biggestWin||0);
      await sendTelegramMessage(chatId,
        `📊 <b>${u.username}'s Full Stats</b>\n\n` +
        `💰 Balance: <b>${fmt(u.balance)}</b>\n` +
        `🎁 Bonus: <b>${fmt(u.bonusBalance)}</b>\n\n` +
        `🎯 Total Bets: <b>${u.totalBets||0}</b>\n` +
        `✅ Wins: <b>${u.wins||0}</b> · ❌ Losses: <b>${(u.totalBets||0)-(u.wins||0)}</b>\n` +
        `📊 Win Rate: <b>${wr}%</b>\n` +
        `${streakEmoji} Current Streak: <b>${streak}</b>\n` +
        `${profitEmoji} All-time P&L: <b>${profitStr}</b>\n` +
        `🏆 Biggest Win: <b>${biggestWin}</b>\n` +
        `💵 Avg Stake: <b>${avgStake}</b>\n\n` +
        `${tierEmoji} Referral Tier: <b>${tier}</b>\n` +
        `👥 Referrals: <b>${u.referralCount||0}</b>`,
        { reply_markup: { inline_keyboard: [
          [{ text: '🎯 Place a Bet', callback_data: 'bet' }, { text: '💰 Balance', callback_data: 'balance' }],
          [{ text: '📈 View on App', url: 'https://crediplex.name.ng' }]
        ]}}
      ); return;
    }

    if (text === '/copytrade') {
      // Show top traders to copy from cache (0 reads)
      const traders = _topTradersCache.slice(0, 5);
      if (!traders.length) {
        await sendTelegramMessage(chatId, `⚠️ No traders available yet. Try again shortly.`); return;
      }
      const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
      const lines = traders.map((u, i) => {
        const wr = u.winRate || 0;
        const profit = Number(u.profit || 0);
        return `${medals[i]} <b>${u.username}</b> — ${wr}% WR · ₦${profit.toLocaleString('en-NG')} profit`;
      }).join('\n');
      const buttons = traders.map((u, i) => [{ text: `${medals[i]} Copy ${u.username}`, callback_data: `ct_pick_${u.id}_${u.username}` }]);
      buttons.push([{ text: '❌ Cancel', callback_data: 'alert_cancel' }]);
      await sendTelegramMessage(chatId,
        `🔄 <b>Copy a Trader</b>\n\nPick a trader to copy:\n\n${lines}`,
        { reply_markup: { inline_keyboard: buttons }}
      );
      return;
    }

    if (text === '/lb_crediplex') {
      let top5 = _topTradersCache.slice(0, 5);
      if (!top5.length) {
        // fallback: fetch from Firestore (1 read)
        try {
          const snap = await db.collection('users').orderBy('profit','desc').limit(5).get();
          top5 = snap.docs.map(d=>({...d.data(), id: d.id})).filter(u=>u.totalBets>0);
        } catch(e) {}
      }
      if (!top5.length) {
        await sendTelegramMessage(chatId, `📭 No traders yet on Crediplex. Be the first to place a bet!`,
          { reply_markup: { inline_keyboard: [[{ text: '📈 Start Trading', url: 'https://crediplex.name.ng' }]] }}
        ); return;
      }
      const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
      const lines = top5.map((u, i) => {
        const profit = Number(u.profit || 0);
        const wr = u.totalBets > 0 ? Math.round((u.wins||0)/u.totalBets*100) : (u.winRate||0);
        const profitStr = profit >= 0 ? `+₦${profit.toLocaleString('en-NG')}` : `-₦${Math.abs(profit).toLocaleString('en-NG')}`;
        return `${medals[i]} <b>${u.username || 'User'}</b>\n   ${profitStr} profit · ${wr}% WR · ${u.totalBets||0} bets`;
      }).join('\n\n');
      await sendTelegramMessage(chatId,
        `🏆 <b>Top Crediplex Traders</b>\n\n${lines}`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📊 Polymarket Leaderboard', callback_data: 'lb_polymarket' }],
          [{ text: '🔄 Copy a Trader', url: 'https://crediplex.name.ng' }]
        ]}}
      );
      return;
    }

    if (text === '/lb_polymarket') {
      try {
        // Use Polymarket API directly for real trader data (0 Firestore reads)
        const pmRes = await fetch(
          `https://gamma-api.polymarket.com/profiles?limit=10&order=profitAndLoss&ascending=false`,
          { signal: AbortSignal.timeout(8000) }
        );
        let traders = [];
        if (pmRes.ok) {
          const pmData = await pmRes.json();
          traders = (Array.isArray(pmData) ? pmData : pmData.profiles || []).slice(0, 5);
        }
        // Fallback to cache if Polymarket API fails
        if (!traders.length) traders = _topTradersCache.slice(0, 5);
        if (!traders.length) { await sendTelegramMessage(chatId, `⚠️ Polymarket data unavailable right now. Try again shortly.`); return; }

        const medals = ['🥇','🥈','🥉','4️⃣','5️⃣'];
        const lines = traders.map((u, i) => {
          // Show name, username, or shortened wallet address
          const addr = u.proxyWallet || u.address || '';
          const displayName = u.name || u.username || (addr ? addr.substring(0,6)+'...'+addr.slice(-4) : `Trader ${i+1}`);
          const pnl = u.profitAndLoss || u.pnl || 0;
          const vol = u.volume || u.totalVolume || 0;
          const pnlStr = pnl >= 0 ? `+$${Number(pnl).toLocaleString()}` : `-$${Math.abs(Number(pnl)).toLocaleString()}`;
          return `${medals[i]} <b>${displayName}</b>\n   PnL: ${pnlStr} · Vol: $${Number(vol).toLocaleString()}`;
        }).join('\n\n');

        // Per-trader copy buttons
        const copyButtons = traders.slice(0,3).map((u, i) => {
          const addr = u.proxyWallet || u.address || '';
          const displayName = u.name || u.username || (addr ? addr.substring(0,6)+'...'+addr.slice(-4) : `Trader ${i+1}`);
          const safeName = displayName.replace(/[^a-zA-Z0-9]/g,'').substring(0,15);
          return [{ text: `${medals[i]} Copy ${displayName.substring(0,20)}`, callback_data: `ct_pick_pm_${safeName}_${displayName.substring(0,20)}` }];
        });
        copyButtons.push([{ text: '🌐 Crediplex Leaderboard', callback_data: 'lb_crediplex' }]);

        await sendTelegramMessage(chatId,
          `📊 <b>Top Polymarket Traders</b>\n\n${lines}\n\n<i>Copy any of these traders on Crediplex!</i>`,
          { reply_markup: { inline_keyboard: copyButtons }}
        );
      } catch(e) {
        await sendTelegramMessage(chatId, `⚠️ Could not load Polymarket data: ${e.message}`);
      }
      return;
    }

    // For /balance and /portfolio — 1 Firestore read: find user by chatId
    if (text === '/balance' || text === '/portfolio') {
      const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
      if (userSnap.empty) {
        await sendTelegramMessage(chatId, `⚠️ No Crediplex account linked. Use /start to link your account.`, {
          reply_markup: { inline_keyboard: [[{ text: '🔗 Link Account', url: 'https://crediplex.name.ng' }]] }
        });
        return;
      }
      const u = userSnap.docs[0].data();
      const fmt = n => '₦' + Number(n || 0).toLocaleString('en-NG');

      if (text === '/balance') {
        const refCode = u.referralCode ? `\nRef Code: <code>${u.referralCode}</code>` : '';
        await sendTelegramMessage(chatId,
          `💰 <b>${u.username}'s Balance</b>\n\n` +
          `Main: <b>${fmt(u.balance)}</b>\n` +
          `Bonus: <b>${fmt(u.bonusBalance)}</b>${refCode}`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '📈 View Portfolio', callback_data: 'portfolio' },
                { text: '🚀 Open App', url: 'https://crediplex.name.ng' }
              ]]
            }
          }
        );
      } else {
        const wr = u.totalBets > 0 ? Math.round((u.wins || 0) / u.totalBets * 100) : 0;
        const profit = u.profit || 0;
        await sendTelegramMessage(chatId,
          `📊 <b>${u.username}'s Portfolio</b>\n\n` +
          `Total Bets: <b>${u.totalBets || 0}</b>\n` +
          `Wins: <b>${u.wins || 0}</b>\n` +
          `Win Rate: <b>${wr}%</b>\n` +
          `P&L: <b>${profit >= 0 ? '+' : ''}${fmt(profit)}</b>\n` +
          `Streak: <b>${u.currentStreak || 0} 🔥</b>`,
          {
            reply_markup: {
              inline_keyboard: [[
                { text: '💰 Check Balance', callback_data: 'balance' },
                { text: '🚀 Open App', url: 'https://crediplex.name.ng' }
              ]]
            }
          }
        );
      }
      return;
    }
  if (text === '/setalert' || text.startsWith('/setalert ')) {
    const userSnap = await getUserByTgId(chatId);
    if (!userSnap) {
      await sendTelegramMessage(chatId, `⚠️ Link your account first. Go to Crediplex → Wallet → Link Telegram.`);
      return;
    }
    // show active markets list
    const activeMarkets = _marketsCache.filter(m => m.status === 'active').slice(0, 8);
    if (!activeMarkets.length) {
      await sendTelegramMessage(chatId, `No active markets right now.`);
      return;
    }
    const buttons = activeMarkets.map((m, i) => ([{
      text: `${i+1}. ${(m.question||'').substring(0,40)}`,
      callback_data: `setalert_pick_${m.id}`
    }]));
    await sendTelegramMessage(chatId,
      `🔔 <b>Set Market Alert</b>\n\nPick a market to set a YES odds alert on:`,
      { reply_markup: { inline_keyboard: buttons }}
    );
    return;
  }

  if (text === '/support') {
      _supportState[chatId.toString()] = { messages: [] };
      await sendTelegramMessage(chatId,
        `🎧 <b>Crediplex Support</b>\n\n` +
        `Hi! I'm the Crediplex AI Support agent. I can help with:\n\n` +
        `• Deposit & withdrawal issues\n` +
        `• Bet questions & disputes\n` +
        `• Account & balance problems\n` +
        `• How the platform works\n\n` +
        `Just type your question and I'll help you right away!\n\n` +
        `For complex issues, I'll connect you to our team at care@crediplex.name.ng`,
        { reply_markup: { inline_keyboard: [
          [{ text: '📧 Email Support', url: 'mailto:care@crediplex.name.ng' }],
          [{ text: '❌ End Support Chat', callback_data: 'support_end' }]
        ]}}
      );
      return;
    }

    if (text === '/support_end' || text === 'support_end') {
      delete _supportState[chatId.toString()];
      await sendTelegramMessage(chatId,
        `✅ Support chat ended. Hope we helped!\n\nFor further help email care@crediplex.name.ng`,
        { reply_markup: { inline_keyboard: [[{ text: '📋 Commands', callback_data: 'help' }]] }}
      );
      return;
    }

    // ── ADMIN COMMANDS (only for admin Telegram ID) ──
    if (chatId.toString() === ADMIN_TG_ID) {

      if (text === '/admin') {
        const totalUsers = _topTradersCache.length;
        const activeMarkets = _marketsCache.filter(m => m.status === 'active').length;
        const totalVolume = _marketsCache.reduce((s, m) => s + (m.totalPool || 0), 0);
        await sendTelegramMessage(chatId,
          `🛡️ <b>Crediplex Admin Panel</b>\n\n` +
          `👥 Linked Users (cache): <b>${totalUsers}</b>\n` +
          `📈 Active Markets: <b>${activeMarkets}</b>\n` +
          `💰 Total Pool Volume: <b>₦${Number(totalVolume).toLocaleString('en-NG')}</b>\n\n` +
          `NGN Rate: <b>₦${global._liveNgnRate || 'N/A'}/$</b>`,
          { reply_markup: { inline_keyboard: [
            [{ text: '📢 Broadcast Message', callback_data: 'admin_broadcast' }],
            [{ text: '📊 Market Stats', callback_data: 'admin_markets' }],
            [{ text: '👥 User Stats', callback_data: 'admin_users' }]
          ]}}
        );
        return;
      }

      if (text === '/admin_markets') {
        const active = _marketsCache.filter(m => m.status === 'active');
        const resolved = _marketsCache.filter(m => m.status === 'resolved');
        const topByVolume = [...active].sort((a,b) => (b.totalPool||0)-(a.totalPool||0)).slice(0,3);
        const lines = topByVolume.map((m,i) => `${i+1}. ${(m.question||'').substring(0,50)}\n   Pool: ₦${Number(m.totalPool||0).toLocaleString('en-NG')}`).join('\n\n');
        await sendTelegramMessage(chatId,
          `📊 <b>Market Stats</b>\n\n` +
          `Active: <b>${active.length}</b> | Resolved: <b>${resolved.length}</b>\n\n` +
          `<b>Top 3 by Volume:</b>\n${lines}`
        );
        return;
      }

      if (text === '/admin_users') {
        try {
          const snap = await db.collection('users').where('telegramChatId', '!=', '').select('username','balance','telegramChatId').limit(5).get();
          const lines = snap.docs.map((d,i) => {
            const u = d.data();
            return `${i+1}. @${u.username} — ₦${Number(u.balance||0).toLocaleString('en-NG')}`;
          }).join('\n');
          await sendTelegramMessage(chatId, `👥 <b>Recent Linked Users</b>\n\n${lines}`);
        } catch(e) { await sendTelegramMessage(chatId, `⚠️ Error fetching users: ${e.message}`); }
        return;
      }

      if (text === '/admin_broadcast') {
        _alertState[chatId.toString()] = { step: 'admin_broadcast_awaiting_message' };
        await sendTelegramMessage(chatId,
          `📢 <b>Broadcast Message</b>\n\nSend your message now. You can include text only, or send a photo with caption.\n\nI will forward it to ALL linked users.`,
          { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
        );
        return;
      }

      if (text.startsWith('/admin_credit ')) {
        // /admin_credit username amount
        const parts = text.split(' ');
        const targetUsername = parts[1];
        const creditAmount = parseInt(parts[2]);
        if (!targetUsername || isNaN(creditAmount)) {
          await sendTelegramMessage(chatId, `⚠️ Usage: /admin_credit username amount\nExample: /admin_credit john 5000`);
          return;
        }
        try {
          const snap = await db.collection('users').where('username', '==', targetUsername).limit(1).get();
          if (snap.empty) { await sendTelegramMessage(chatId, `❌ User "${targetUsername}" not found.`); return; }
          const userRef = snap.docs[0].ref;
          const userData = snap.docs[0].data();
          await db.runTransaction(async tx => {
            tx.update(userRef, { balance: admin.firestore.FieldValue.increment(creditAmount) });
            const txRef = db.collection('transactions').doc();
            tx.set(txRef, { uid: snap.docs[0].id, type: 'admin_credit', amount: creditAmount, note: `Admin credit by ${ADMIN_TG_ID}`, createdAt: admin.firestore.FieldValue.serverTimestamp() });
          });
          await sendTelegramMessage(chatId, `✅ Credited <b>₦${creditAmount.toLocaleString('en-NG')}</b> to <b>${targetUsername}</b>`);
          if (userData.telegramChatId) {
            sendTelegramMessage(userData.telegramChatId,
              `🎁 <b>Wallet Credited!</b>\n\n<b>₦${creditAmount.toLocaleString('en-NG')}</b> has been added to your Crediplex wallet by the admin team.`,
              { reply_markup: { inline_keyboard: [[{ text: '💰 Check Balance', callback_data: 'balance' }]] }}
            ).catch(()=>{});
          }
        } catch(e) { await sendTelegramMessage(chatId, `❌ Error: ${e.message}`); }
        return;
      }
    }

  // ── Deposit freetext flow ──
    const depositSt = _depositState[chatId.toString()];
    const betSt = _betState[chatId.toString()];
    if (depositSt) {
      if (betSt && betSt.step === 'awaiting_keyword') {
        const keyword = (msg.text||'').trim().toLowerCase();
        const matches = _marketsCache.filter(m =>
          m.status==='active' && (m.question||'').toLowerCase().includes(keyword)
        ).slice(0,5);
        if (!matches.length) {
          await sendTelegramMessage(chatId,
            `😕 No markets found for "<b>${msg.text}</b>". Try a different keyword.`,
            { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}
          ); return;
        }
        _betState[chatId.toString()] = { step:'awaiting_market', matches };
        const buttons = matches.map((m,i) => {
          const yes = m.polymarketYesOdds||50;
          return [{ text:`${(m.question||'').substring(0,50)} (YES ${yes}%)`, callback_data:`bet_mkt_${i}` }];
        });
        buttons.push([{ text:'❌ Cancel', callback_data:'alert_cancel' }]);
        await sendTelegramMessage(chatId,`🔍 Found <b>${matches.length}</b> market(s). Pick one:`,
          { reply_markup: { inline_keyboard: buttons }}
        ); return;
      }

      if (betSt.step === 'awaiting_amount') {
        const amount = parseInt(msg.text||'');
        if (isNaN(amount)||amount<200) { await sendTelegramMessage(chatId,`⚠️ Minimum bet is ₦200.`); return; }
        // Check balance
        const userSnap = await db.collection('users').where('telegramChatId','==',chatId.toString()).limit(1).get();
        if (userSnap.empty) { await sendTelegramMessage(chatId,`⚠️ Link your account first with /start.`); delete _betState[chatId.toString()]; return; }
        const u = userSnap.docs[0].data();
        if (amount > (u.balance||0)) {
          const fmt = n=>'₦'+Number(n||0).toLocaleString('en-NG');
          await sendTelegramMessage(chatId,`⚠️ Insufficient balance. You have <b>${fmt(u.balance)}</b>.`); return;
        }
        const m = betSt.market;
        const yes = m.polymarketYesOdds||50;
        const sideOdds = betSt.side==='YES'?yes:100-yes;
        const potential = Math.floor(amount*(100/sideOdds)*0.9);
        const fmt = n=>'₦'+Number(n||0).toLocaleString('en-NG');
        _betState[chatId.toString()] = { ...betSt, step:'awaiting_pin', amount, userId: userSnap.docs[0].id, potential };
        await sendTelegramMessage(chatId,
          `🎯 <b>Bet Summary</b>\n\n` +
          `Market: <i>${(m.question||'').substring(0,70)}</i>\n` +
          `Side: <b>${betSt.side}</b> (${sideOdds}%)\n` +
          `Stake: <b>${fmt(amount)}</b>\n` +
          `Potential win: <b>~${fmt(potential)}</b>\n\n` +
          `🔐 Enter your <b>4-digit PIN</b> to place this bet:`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}
        ); return;
      }

      if (betSt.step === 'awaiting_pin') {
        const pin = (msg.text||'').trim().replace(/\D/g,'');
        if (pin.length!==4) { await sendTelegramMessage(chatId,`⚠️ PIN must be 4 digits.`); return; }
        const verify = await verifyUserPin(chatId, pin);
        if (!verify.ok && verify.error==='wrong_pin') { await sendTelegramMessage(chatId,`❌ Wrong PIN. Try again.`); return; }
        if (!verify.ok && verify.error==='no_pin') {
          await sendTelegramMessage(chatId,`🔐 You need to set a Transaction PIN first.\n\nGo to the app → Menu → Transaction PIN`,
            { reply_markup: { inline_keyboard: [[{ text:'🔐 Set PIN in App', url:'https://crediplex.name.ng' }]] }}
          ); delete _betState[chatId.toString()]; return;
        }
        if (!verify.ok) { await sendTelegramMessage(chatId,`⚠️ ${verify.error}`); delete _betState[chatId.toString()]; return; }
        const st = betSt;
        delete _betState[chatId.toString()];
        const fmt = n=>'₦'+Number(n||0).toLocaleString('en-NG');
        try {
          await db.runTransaction(async tx => {
            const userRef = db.collection('users').doc(st.userId);
            const userDoc = await tx.get(userRef);
            if (!userDoc.exists) throw new Error('User not found');
            const bal = userDoc.data().balance||0;
            if (st.amount > bal) throw new Error('Insufficient balance');
            const mktRef = db.collection('markets').doc(st.market.id);
            const mktDoc = await tx.get(mktRef);
            if (!mktDoc.exists||mktDoc.data().status!=='active') throw new Error('Market no longer active');
            // Deduct balance
            tx.update(userRef, {
              balance: admin.firestore.FieldValue.increment(-st.amount),
              totalBets: admin.firestore.FieldValue.increment(1),
              totalStaked: admin.firestore.FieldValue.increment(st.amount),
              lastBetAt: admin.firestore.FieldValue.serverTimestamp()
            });
            // Update market pool
            const poolUpdate = st.side==='YES'
              ? { yesPool: admin.firestore.FieldValue.increment(st.amount) }
              : { noPool: admin.firestore.FieldValue.increment(st.amount) };
            tx.update(mktRef, poolUpdate);
            // Create bet doc
            const betRef = db.collection('bets').doc();
            tx.set(betRef, {
              uid: st.userId,
              marketId: st.market.id,
              question: (st.market.question||'').substring(0,100),
              side: st.side,
              amount: st.amount,
              potentialPayout: st.potential,
              status: 'pending',
              source: 'telegram',
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            // Transaction record
            const txRef = db.collection('transactions').doc();
            tx.set(txRef, {
              uid: st.userId, type:'bet', amount: -st.amount,
              note:`Telegram bet: ${st.side} on ${(st.market.question||'').substring(0,50)}`,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          });
          await sendTelegramMessage(chatId,
            `✅ <b>Bet Placed!</b>\n\n` +
            `Market: <i>${(st.market.question||'').substring(0,70)}</i>\n` +
            `Side: <b>${st.side}</b>\n` +
            `Staked: <b>${fmt(st.amount)}</b>\n` +
            `Potential win: <b>~${fmt(st.potential)}</b>\n\n` +
            `You'll be notified here when it resolves. Good luck! 🍀`,
            { reply_markup: { inline_keyboard: [
              [{ text:'🎯 Bet Again', callback_data:'bet' }, { text:'📊 My Bets', callback_data:'mybets' }],
              [{ text:'💰 Balance', callback_data:'balance' }]
            ]}}
          );
        } catch(e) {
          await sendTelegramMessage(chatId,`❌ Bet failed: ${e.message}`);
        }
        return;
      }
    }

  // ── Withdrawal freetext flow ──
    const withdrawSt = _withdrawState[chatId.toString()];
    if (withdrawSt) {
      if (withdrawSt.step === 'cashout_pin') {
        const pin = (msg.text||'').trim().replace(/\D/g,'');
        if (pin.length!==4) { await sendTelegramMessage(chatId,`⚠️ PIN must be 4 digits.`); return; }
        const verify = await verifyUserPin(chatId, pin);
        if (!verify.ok && verify.error==='wrong_pin') { await sendTelegramMessage(chatId,`❌ Wrong PIN. Try again.`); return; }
        if (!verify.ok) { await sendTelegramMessage(chatId,`⚠️ ${verify.error}`); delete _withdrawState[chatId.toString()]; return; }
        const st = withdrawSt;
        delete _withdrawState[chatId.toString()];
        const fmt = n=>'₦'+Number(n||0).toLocaleString('en-NG');
        try {
          await db.runTransaction(async tx => {
            const betRef = db.collection('bets').doc(st.betId);
            const betSnap = await tx.get(betRef);
            if (!betSnap.exists()||betSnap.data().status!=='pending') throw new Error('Bet already resolved or cashed out');
            const mktRef = db.collection('markets').doc(st.marketId);
            const userRef = db.collection('users').doc(verify.userId);
            const poolUpdate = st.side==='YES'
              ? { yesPool: admin.firestore.FieldValue.increment(-st.stakeAmount) }
              : { noPool: admin.firestore.FieldValue.increment(-st.stakeAmount) };
            tx.update(mktRef, poolUpdate);
            tx.update(userRef, { balance: admin.firestore.FieldValue.increment(st.cashoutVal) });
            tx.update(betRef, { status:'cancelled', cashoutValue: st.cashoutVal });
            const txRef = db.collection('transactions').doc();
            tx.set(txRef, {
              uid: verify.userId, type:'cashout', amount: st.cashoutVal,
              note:`Telegram cashout: received ${fmt(st.cashoutVal)}`,
              createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
          });
          await sendTelegramMessage(chatId,
            `✅ <b>Cashed Out!</b>\n\n<b>${fmt(st.cashoutVal)}</b> added to your balance.`,
            { reply_markup: { inline_keyboard: [[{ text:'💰 Check Balance', callback_data:'balance' }]] }}
          );
        } catch(e) { await sendTelegramMessage(chatId,`❌ Cashout failed: ${e.message}`); }
        return;
      }

      if (withdrawSt.step === 'naira_amount') {
        const amt = parseInt(msg.text||'');
        if (isNaN(amt)||amt<500) { await sendTelegramMessage(chatId,`⚠️ Minimum ₦500. Enter a valid amount.`); return; }
        if (amt > (withdrawSt.balance||0)) { await sendTelegramMessage(chatId,`⚠️ Insufficient balance. Your balance is ₦${Number(withdrawSt.balance||0).toLocaleString('en-NG')}.`); return; }
        _withdrawState[chatId.toString()] = { ...withdrawSt, step:'naira_bank', amount:amt };
        await sendTelegramMessage(chatId,`🏦 Amount: <b>₦${amt.toLocaleString('en-NG')}</b>\n\nEnter your <b>bank name</b> (e.g. GTBank, Opay, Access):`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}); return;
      }
      if (withdrawSt.step === 'naira_bank') {
        _withdrawState[chatId.toString()] = { ...withdrawSt, step:'naira_acct', bank: msg.text.trim() };
        await sendTelegramMessage(chatId,`Enter your <b>10-digit account number</b>:`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}); return;
      }
      if (withdrawSt.step === 'naira_acct') {
        const acct = msg.text.trim().replace(/\D/g,'');
        if (acct.length!==10) { await sendTelegramMessage(chatId,`⚠️ Account number must be exactly 10 digits.`); return; }
        _withdrawState[chatId.toString()] = { ...withdrawSt, step:'naira_name', acct };
        await sendTelegramMessage(chatId,`Enter the <b>account name</b> (as on your bank):`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}); return;
      }
      if (withdrawSt.step === 'naira_name') {
        const acctName = msg.text.trim();
        _withdrawState[chatId.toString()] = { ...withdrawSt, step:'naira_pin', acctName };
        await sendTelegramMessage(chatId,
          `✅ <b>Withdrawal Summary</b>\n\nAmount: <b>₦${Number(withdrawSt.amount).toLocaleString('en-NG')}</b>\nBank: <b>${withdrawSt.bank}</b>\nAccount: <code>${withdrawSt.acct}</code>\nName: <b>${acctName}</b>\n\n🔐 Enter your <b>4-digit Transaction PIN</b> to confirm:`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}); return;
      }
      if (withdrawSt.step === 'naira_pin') {
        const pin = msg.text.trim().replace(/\D/g,'');
        if (pin.length!==4) { await sendTelegramMessage(chatId,`⚠️ PIN must be 4 digits.`); return; }
        const verify = await verifyUserPin(chatId, pin);
        if (!verify.ok && verify.error === 'wrong_pin') {
          await sendTelegramMessage(chatId,`❌ Wrong PIN. Please try again.`); return;
        }
        if (!verify.ok) { await sendTelegramMessage(chatId,`⚠️ ${verify.error}`); delete _withdrawState[chatId.toString()]; return; }
        const st = withdrawSt;
        delete _withdrawState[chatId.toString()];
        try {
          await db.collection('withdrawals').add({
            uid: st.userId, username: st.username, amount: st.amount,
            bankName: st.bank, accountNumber: st.acct, accountName: st.acctName,
            status:'pending', source:'telegram', createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          await db.collection('transactions').add({
            uid: st.userId, type:'withdrawal_request', amount: 0,
            note:`Telegram withdrawal ₦${st.amount} to ${st.bank} - ${st.acct}`,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          sendTelegramMessage(ADMIN_TG_ID,
            `💸 <b>New Withdrawal Request</b>\n\nUser: <b>${st.username}</b>\nAmount: <b>₦${Number(st.amount).toLocaleString('en-NG')}</b>\nBank: <b>${st.bank}</b>\nAccount: <code>${st.acct}</code>\nName: <b>${st.acctName}</b>\n\nApprove: /admin_credit ${st.username} 0`
          ).catch(()=>{});
          await sendTelegramMessage(chatId,
            `✅ <b>Withdrawal Submitted!</b>\n\n₦${Number(st.amount).toLocaleString('en-NG')} to ${st.bank}\nAccount: <code>${st.acct}</code>\n\nProcessed within 24 hours. You'll be notified here when done. 🙏`,
            { reply_markup: { inline_keyboard: [[{ text:'💰 Check Balance', callback_data:'balance' }]] }}
          );
        } catch(e) { await sendTelegramMessage(chatId,`❌ Error: ${e.message}`); }
        return;
      }
      if (withdrawSt.step === 'crypto_addr') {
        const addr = msg.text.trim();
        _withdrawState[chatId.toString()] = { ...withdrawSt, step:'crypto_pin', addr };
        await sendTelegramMessage(chatId,
          `✅ <b>Withdrawal Summary</b>\n\nAmount: <b>$${withdrawSt.amountUsd} ${(withdrawSt.coin||'').toUpperCase()}</b>\nAddress: <code>${addr}</code>\n\n🔐 Enter your <b>4-digit Transaction PIN</b> to confirm:`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}); return;
      }
      if (withdrawSt.step === 'crypto_pin') {
        const pin = msg.text.trim().replace(/\D/g,'');
        if (pin.length!==4) { await sendTelegramMessage(chatId,`⚠️ PIN must be 4 digits.`); return; }
        const verify = await verifyUserPin(chatId, pin);
        if (!verify.ok && verify.error==='wrong_pin') { await sendTelegramMessage(chatId,`❌ Wrong PIN. Try again.`); return; }
        if (!verify.ok) { await sendTelegramMessage(chatId,`⚠️ ${verify.error}`); delete _withdrawState[chatId.toString()]; return; }
        const st = withdrawSt;
        delete _withdrawState[chatId.toString()];
        try {
          const payoutRes = await fetch(`${process.env.SERVER_URL||'https://crediplex-production.up.railway.app'}/api/payout`,{
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ userId: st.userId, amountUsd: st.amountUsd, currency: st.coin, address: st.addr })
          });
          const payoutData = await payoutRes.json();
          if (!payoutData.success) { await sendTelegramMessage(chatId,`❌ Withdrawal failed: ${payoutData.error}`); return; }
          await sendTelegramMessage(chatId,
            `✅ <b>Withdrawal Sent!</b>\n\n$${st.amountUsd} ${st.coin.toUpperCase()} sent to:\n<code>${st.addr}</code>\n\nArrives in 10–30 minutes. 🚀`,
            { reply_markup: { inline_keyboard: [[{ text:'💰 Check Balance', callback_data:'balance' }]] }}
          );
        } catch(e) { await sendTelegramMessage(chatId,`❌ Error: ${e.message}`); }
        return;
      }
    }

      if (depositSt.step === 'ct_awaiting_amount') {
        const val = parseFloat(msg.text || '');
        const mode = depositSt.mode || 'fixed';
        if (mode === 'fixed' && (isNaN(val) || val < 200)) {
          await sendTelegramMessage(chatId, `⚠️ Minimum is ₦200. Please enter a valid amount.`); return;
        }
        if (mode === 'prop' && (isNaN(val) || val < 1 || val > 50)) {
          await sendTelegramMessage(chatId, `⚠️ Please enter a % between 1 and 50.`); return;
        }
        const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
        if (userSnap.empty) { await sendTelegramMessage(chatId, `⚠️ Link your account first with /start.`); delete _depositState[chatId.toString()]; return; }
        const copierId = userSnap.docs[0].id;
        const copierData = userSnap.docs[0].data();
        delete _depositState[chatId.toString()];
        // Check not already copying
        const existing = await db.collection('copyRelations').where('copierId','==',copierId).where('traderId','==',depositSt.traderId).limit(1).get();
        if (!existing.empty) {
          await sendTelegramMessage(chatId, `⚠️ You are already copying <b>${depositSt.traderName}</b>.\n\nManage your copy trades at crediplex.name.ng`); return;
        }
        await db.collection('copyRelations').add({
          copierId, copierName: copierData.username,
          traderId: depositSt.traderId, traderName: depositSt.traderName,
          mode, amount: mode === 'fixed' ? val : 0, multiplier: mode === 'prop' ? val/100 : 1,
          active: true, createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        await sendTelegramMessage(chatId,
          `✅ <b>Now Copying ${depositSt.traderName}!</b>\n\n` +
          `Mode: <b>${mode === 'fixed' ? `₦${val} fixed per trade` : `${val}% of balance`}</b>\n\n` +
          `Every trade they make on Crediplex will be automatically copied for you. You'll get a notification each time.`,
          { reply_markup: { inline_keyboard: [
            [{ text: '🔄 Copy Another', callback_data: 'copytrade' }],
            [{ text: '📊 My Portfolio', callback_data: 'portfolio' }]
          ]}}
        );
        return;
      }

      // Crypto withdrawal amount
      if (withdrawSt && withdrawSt.step === 'crypto_amount') {
        const amountUsd = parseFloat(msg.text||'');
        if (isNaN(amountUsd)||amountUsd<0.5) { await sendTelegramMessage(chatId,`⚠️ Minimum $0.5. Enter a valid amount.`); return; }
        const balUsd = ((withdrawSt.balance||0)/(global._liveNgnRate||1500));
        if (amountUsd > balUsd) { await sendTelegramMessage(chatId,`⚠️ Insufficient balance. You have ≈$${balUsd.toFixed(2)}.`); return; }
        _withdrawState[chatId.toString()] = { ...withdrawSt, step:'crypto_addr', amountUsd };
        await sendTelegramMessage(chatId,
          `💰 Amount: <b>$${amountUsd} ${withdrawSt.coin.toUpperCase()}</b>\n\nEnter your <b>${withdrawSt.coin.toUpperCase()} wallet address</b>:`,
          { reply_markup: { inline_keyboard: [[{ text:'❌ Cancel', callback_data:'alert_cancel' }]] }}); return;
      }

      if (depositSt.step === 'awaiting_amount') {
        const amountUsd = parseFloat(msg.text || '');
        if (isNaN(amountUsd) || amountUsd < 1) {
          await sendTelegramMessage(chatId, `⚠️ Minimum is $1. Please enter a valid amount.`); return;
        }
        delete _depositState[chatId.toString()];
        try {
          const res = await fetch(`${process.env.SERVER_URL || 'https://crediplex-production.up.railway.app'}/api/create-payment`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: depositSt.userId, amountUsd, currency: depositSt.coin })
          });
          const data = await res.json();
          if (!data.success) { await sendTelegramMessage(chatId, `❌ Payment creation failed: ${data.error}`); return; }
          const coinNames = { usdttrc20:'USDT TRC20', usdterc20:'USDT ERC20', btc:'Bitcoin', sol:'Solana', eth:'Ethereum', bnb:'BNB' };
          await sendTelegramMessage(chatId,
            `✅ <b>Payment Created!</b>\n\n` +
            `Send exactly:\n<code>${data.payAmount} ${(data.payCurrency||depositSt.coin).toUpperCase()}</code>\n\n` +
            `To this address:\n<code>${data.payAddress}</code>\n\n` +
            `Amount: <b>$${amountUsd} USD</b>\n` +
            `Coin: <b>${coinNames[depositSt.coin]||depositSt.coin.toUpperCase()}</b>\n\n` +
            `⏱ Auto-credited within ~2 minutes after confirmation.\n` +
            `⚠️ Send EXACTLY the amount above or payment may fail.`,
            { reply_markup: { inline_keyboard: [
              [{ text: '✅ I Have Sent Payment', callback_data: `dep_check_${data.paymentId}` }],
              [{ text: '💰 Check Balance', callback_data: 'balance' }]
            ]}}
          );
        } catch(e) { await sendTelegramMessage(chatId, `❌ Error creating payment: ${e.message}\n\nPlease try again or visit crediplex.name.ng`); }
        return;
      }

      if (depositSt.step === 'naira_awaiting_amount') {
        const amount = parseInt(msg.text || '');
        if (isNaN(amount) || amount < 500) {
          await sendTelegramMessage(chatId, `⚠️ Minimum is ₦500. Please enter a valid amount.`); return;
        }
        _depositState[chatId.toString()] = { ...depositSt, step: 'naira_awaiting_sender', amount };
        await sendTelegramMessage(chatId,
          `💰 Amount: <b>₦${amount.toLocaleString('en-NG')}</b>\n\nWhat is the <b>sender name</b> on the transfer?\n(The name on your bank account)`,
          { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
        );
        return;
      }

      if (depositSt.step === 'naira_awaiting_sender') {
        const senderName = msg.text.trim();
        delete _depositState[chatId.toString()];
        // Save pending deposit to Firestore for admin to approve
        try {
          await db.collection('pendingNairaDeposits').add({
            userId: depositSt.userId,
            username: depositSt.username,
            amount: depositSt.amount,
            senderName,
            chatId: chatId.toString(),
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
          });
          // Notify admin
          sendTelegramMessage(ADMIN_TG_ID,
            `💰 <b>New Naira Deposit Request</b>\n\n` +
            `User: <b>${depositSt.username}</b>\n` +
            `Amount: <b>₦${depositSt.amount.toLocaleString('en-NG')}</b>\n` +
            `Sender Name: <b>${senderName}</b>\n\n` +
            `To approve: /admin_credit ${depositSt.username} ${depositSt.amount}`
          ).catch(()=>{});
          await sendTelegramMessage(chatId,
            `✅ <b>Deposit Request Submitted!</b>\n\n` +
            `Amount: <b>₦${depositSt.amount.toLocaleString('en-NG')}</b>\n` +
            `Sender: <b>${senderName}</b>\n\n` +
            `Our team will verify and credit your wallet within <b>15 minutes</b>.\n\n` +
            `Reference/Narration: <b>${depositSt.username}</b>`,
            { reply_markup: { inline_keyboard: [
              [{ text: '💰 Check Balance', callback_data: 'balance' }],
              [{ text: '📧 Contact Support', url: 'mailto:care@crediplex.name.ng' }]
            ]}}
          );
        } catch(e) { await sendTelegramMessage(chatId, `❌ Error: ${e.message}. Please email care@crediplex.name.ng`); }
        return;
      }
    }

  // ── Support AI flow ──
    const supportSt = _supportState[chatId.toString()];
    if (hasText && !msg.text.startsWith('/') && supportSt && !_alertState[chatId.toString()]) {
      const st = _supportState[chatId.toString()];
      const userMessage = msg.text.trim();
      st.messages.push({ role: 'user', content: userMessage });
      if (st.messages.length > 8) st.messages = st.messages.slice(-8);
      try {
        const reply = await askGroq([
          { role: 'system', content: CREDIPLEX_SUPPORT_PROMPT },
          ...st.messages
        ], 350);
        if (!reply) throw new Error('Empty response');
        st.messages.push({ role: 'assistant', content: reply });
        const needsEscalation = reply.toLowerCase().includes('care@crediplex') || reply.toLowerCase().includes('contact') || reply.toLowerCase().includes('team');
        await sendTelegramMessage(chatId, reply,
          { reply_markup: { inline_keyboard: [
            needsEscalation
              ? [{ text: '📧 Email care@crediplex.name.ng', url: 'mailto:care@crediplex.name.ng' }]
              : [{ text: '📧 Still need help?', url: 'mailto:care@crediplex.name.ng' }],
            [{ text: '❌ End Support Chat', callback_data: 'support_end' }]
          ]}}
        );
      } catch(e) {
        console.error('Support AI error:', e.message);
        await sendTelegramMessage(chatId,
          `I'm having a little trouble right now. 🙏\n\nFor immediate help please email:\n<b>care@crediplex.name.ng</b>\n\nOur team responds within 24 hours.`,
          { reply_markup: { inline_keyboard: [
            [{ text: '📧 Email Support Now', url: 'mailto:care@crediplex.name.ng' }],
            [{ text: '🔄 Try Again', callback_data: 'support' }]
          ]}}
        );
      }
      return;
    }

  // ── setalert threshold reply ──
  const alertSt2 = _alertState[chatId.toString()];
  if (alertSt2 && alertSt2.step === 'setalert_threshold') {
    const val = parseInt(msg.text);
    if (isNaN(val) || val < 1 || val > 99) {
      await sendTelegramMessage(chatId, `⚠️ Please send a number between 1 and 99.`);
      return;
    }
    const userSnap = await getUserByTgId(chatId);
    if (!userSnap) { delete _alertState[chatId.toString()]; return; }
    const uid = userSnap.id;
    const existing = userSnap.data().priceAlerts || [];
    const updated = existing.filter(a => a.marketId !== alertSt2.marketId);
    updated.push({ marketId: alertSt2.marketId, threshold: val, createdAt: Date.now() });
    await db.collection('users').doc(uid).update({ priceAlerts: updated });
    delete _alertState[chatId.toString()];
    await sendTelegramMessage(chatId,
      `✅ <b>Alert saved!</b>\n\nWe'll message you when YES hits <b>${val}%</b> on:\n<i>${(alertSt2.marketQuestion||'').substring(0,80)}</i>`,
      { reply_markup: { inline_keyboard: [[{ text: '🔔 Set Another Alert', callback_data: 'setalert' }]] }}
    );
    return;
  }

  // ── Alert flow: handle freetext keyword and threshold replies ──
  const alertSt = _alertState[chatId.toString()];
    if (alertSt) {
      // Admin broadcast handler
      if (alertSt.step === 'admin_broadcast_awaiting_message') {
        delete _alertState[chatId.toString()];
        const rawMsg = update.message || update.edited_message || {};
        const photo = rawMsg.photo;
        const caption = rawMsg.caption || rawMsg.text || '';
        const hasContent = caption || (photo && photo.length > 0);
        if (!hasContent) {
          await sendTelegramMessage(chatId, `⚠️ Please send a text message or a photo with caption.`);
          _alertState[chatId.toString()] = { step: 'admin_broadcast_awaiting_message' };
          return;
        }
        try {
          const usersSnap = await db.collection('users').where('telegramChatId', '!=', '').select('telegramChatId').limit(500).get();
          let sent = 0;
          let failed = 0;
          for (const doc of usersSnap.docs) {
            const tgId = doc.data().telegramChatId;
            if (!tgId) continue;
            try {
              if (photo && photo.length > 0) {
                // Use highest quality photo (last in array)
                const fileId = photo[photo.length - 1].file_id;
                const broadcastCaption = caption
                  ? `📢 <b>Crediplex Update</b>\n\n${caption}`
                  : `📢 <b>Crediplex Update</b>`;
                await fetch(`${TELEGRAM_API}/sendPhoto`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    chat_id: tgId,
                    photo: fileId,
                    caption: broadcastCaption,
                    parse_mode: 'HTML'
                  })
                });
              } else {
                await sendTelegramMessage(tgId, `📢 <b>Crediplex Update</b>\n\n${caption}`);
              }
              sent++;
            } catch(e) { failed++; }
            await new Promise(r => setTimeout(r, 60)); // slight delay to avoid Telegram rate limits
          }
          await sendTelegramMessage(chatId,
            `✅ <b>Broadcast Complete!</b>\n\n` +
            `Sent: <b>${sent}</b> users\n` +
            `Failed: <b>${failed}</b>`
          );
        } catch(e) { await sendTelegramMessage(chatId, `❌ Broadcast error: ${e.message}`); }
        return;
      }

      if (alertSt.step === 'awaiting_keyword') {
        const keyword = (msg.text || '').trim().toLowerCase();
        const matches = _marketsCache.filter(m =>
          m.status === 'active' && (m.question || '').toLowerCase().includes(keyword)
        ).slice(0, 5);
        if (!matches.length) {
          await sendTelegramMessage(chatId,
            `😕 No active markets found for "<b>${msg.text}</b>".\n\nTry a different keyword.`,
            { reply_markup: { inline_keyboard: [[{ text: '❌ Cancel', callback_data: 'alert_cancel' }]] }}
          );
          return;
        }
        _alertState[chatId.toString()] = { step: 'awaiting_market', matches };
        const buttons = matches.map((m, i) => [{ text: (m.question || '').substring(0, 60), callback_data: `alertmkt_${i}` }]);
        buttons.push([{ text: '❌ Cancel', callback_data: 'alert_cancel' }]);
        await sendTelegramMessage(chatId,
          `🔍 Found ${matches.length} market(s). Pick one:`,
          { reply_markup: { inline_keyboard: buttons }}
        );
        return;
      }

      if (alertSt.step === 'awaiting_threshold') {
        const val = parseInt(msg.text || '');
        if (isNaN(val) || val < 1 || val > 99) {
          await sendTelegramMessage(chatId, `⚠️ Please enter a number between 1 and 99.`); return;
        }
        // Save alert to Firestore
        const userSnap = await db.collection('users').where('telegramChatId', '==', chatId.toString()).limit(1).get();
        if (userSnap.empty) { await sendTelegramMessage(chatId, `⚠️ Link your account first with /start.`); delete _alertState[chatId.toString()]; return; }
        const m = alertSt.chosenMarket;
        const outcome = alertSt.chosenOutcome;
        const existingAlerts = userSnap.docs[0].data().priceAlerts || [];
        // Remove any existing alert for same market+outcome
        const filtered = existingAlerts.filter(a => !(a.marketId === m.id && a.outcome === outcome));
        filtered.push({ marketId: m.id, outcome, threshold: val, question: (m.question||'').substring(0,80) });
        await userSnap.docs[0].ref.update({ priceAlerts: filtered });
        delete _alertState[chatId.toString()];
        await sendTelegramMessage(chatId,
          `✅ <b>Alert Set!</b>\n\n` +
          `Market: <b>${(m.question||'').substring(0,70)}</b>\n` +
          `Outcome: <b>${outcome}</b>\n` +
          `Notify me when odds reach: <b>${val}%</b>\n\n` +
          `You'll get a message here when it hits.`,
          { reply_markup: { inline_keyboard: [[{ text: '🔔 Set Another Alert', callback_data: 'alert' }, { text: '📈 Bet Now', url: 'https://crediplex.name.ng' }]] }}
        );
        return;
      }
    }

  // ── Unknown command fallback (must be last) ──
    if (text.startsWith('/')) {
      await sendTelegramMessage(chatId,
        `🤔 I don't know that command.\n\nType /help to see everything I can do.`,
        { reply_markup: { inline_keyboard: [[{ text: '📋 Show Commands', callback_data: 'help' }]] }}
      );
    }

  } catch(e) { console.error('Telegram webhook error:', e.message); }
});

// ─── TELEGRAM CHANNEL INFO ────────────────────────────────────
app.get('/api/tg-channel-info', async (req, res) => {
  const channel = (req.query.channel || '').replace('@','');
  if (!channel) return res.status(400).json({ success:false, error:'No channel specified' });
  try {
    const r = await fetch(
      `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getChatMembersCount?chat_id=@${channel}`,
      { signal: AbortSignal.timeout(8000) }
    );
    const data = await r.json();
    if (!data.ok) return res.json({ success:false, error: data.description });
    res.json({ success:true, memberCount: data.result, channel });
  } catch(e) {
    res.status(500).json({ success:false, error: e.message });
  }
});

// ─── TELEGRAM MARKET CREATION ─────────────────────────────────
app.post('/api/create-telegram-market', async (req, res) => {
  try {
    const { question, telegramChannel, telegramLink, targetSubscribers, deadline, description, imageUrl, currentSubscribers, marketSubType, multiOutcomes } = req.body;
    if (!question || !telegramChannel || !deadline) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const slug = question.toLowerCase().replace(/[^a-z0-9\s-]/g,'').trim().replace(/\s+/g,'-').substring(0,60) + '-' + Date.now().toString(36);

    // marketSubType: 'higher_than' | 'lower_than' (default: 'higher_than')
    // multiOutcomes: array of subscriber count milestones e.g. [10000, 15000, 20000]
    const subType = marketSubType || 'higher_than';
    const isMulti = Array.isArray(multiOutcomes) && multiOutcomes.length >= 2;

    let outcomesArr, outcomePricesArr, poolsObj;

    if (isMulti) {
      // Sort milestones ascending, build outcome labels
      const sorted = [...multiOutcomes].map(Number).filter(n => n > 0).sort((a,b) => a-b);
      outcomesArr = sorted.map(n => `${n.toLocaleString()} subs`);
      const eq = 1 / outcomesArr.length;
      outcomePricesArr = outcomesArr.map(() => eq);
      poolsObj = { yesPool: 0, noPool: 0, totalPool: 0 };
      outcomesArr.forEach(o => {
        const key = 'pool_' + o.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
        poolsObj[key] = 0;
      });
    } else {
      outcomesArr = ['Yes', 'No'];
      outcomePricesArr = [0.5, 0.5];
      poolsObj = { yesPool: 0, noPool: 0, totalPool: 0 };
    }

    const docRef = await db.collection('markets').add({
      question,
      category: 'Telegram',
      telegramChannel: telegramChannel.replace('@',''),
      telegramLink: telegramLink || `https://t.me/${telegramChannel.replace('@','')}`,
      targetSubscribers: Number(targetSubscribers) || 0,
      resolveType: 'subscribers',
      marketSubType: subType, // 'higher_than' or 'lower_than'
      description: description || '',
      imageUrl: imageUrl || '',
      currentSubscribers: Number(currentSubscribers) || 0,
      subscriberSnapshots: currentSubscribers ? [{ count: Number(currentSubscribers), ts: Date.now() }] : [],
      outcomes: JSON.stringify(outcomesArr),
      outcomeCount: outcomesArr.length,
      outcomePrices: JSON.stringify(outcomePricesArr),
      ...poolsObj,
      deadline: admin.firestore.Timestamp.fromDate(new Date(deadline)),
      status: 'active',
      source: 'crediplex',
      slug,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    await docRef.update({ id: docRef.id });
    res.json({ success: true, marketId: docRef.id });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── SEND PUSH VIA FCM ───────────────────────────────────────
const { GoogleAuth } = require('google-auth-library');

let _fcmAuthClient = null;
let _fcmCachedToken = null;
let _fcmTokenExpiry = 0;

async function getFcmAccessToken(){
  if(_fcmCachedToken && Date.now() < _fcmTokenExpiry - 60000){
    return _fcmCachedToken;
  }
  if(!_fcmAuthClient){
    const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    const auth = new GoogleAuth({
      credentials: sa,
      scopes: ['https://www.googleapis.com/auth/firebase.messaging']
    });
    _fcmAuthClient = await auth.getClient();
  }
  const tokenResponse = await _fcmAuthClient.getAccessToken();
  _fcmCachedToken = tokenResponse.token;
  _fcmTokenExpiry = Date.now() + 55 * 60 * 1000; // cache 55 min
  return _fcmCachedToken;
}

async function sendFcmToToken(fcmToken, title, body, data={}){
  try {
    const accessToken = await getFcmAccessToken();
    const projectId = 'crediplexpredict';
    await fetch(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: fcmToken,
          notification: { title, body },
          webpush: {
            notification: {
              title, body,
              icon: 'https://i.postimg.cc/7hvV79Pp/file-000000007dd872438ee8e3a300b62930.png',
              badge: 'https://i.postimg.cc/7hvV79Pp/file-000000007dd872438ee8e3a300b62930.png',
              click_action: 'https://crediplex.name.ng'
            }
          },
          data: Object.fromEntries(Object.entries(data).map(([k,v])=>[k,String(v)]))
        }
      })
    });
  } catch(e){ console.log('FCM send error:', e.message); }
}

// POST /api/send-push — called internally or from admin to push notifications
app.post('/api/send-push', async (req, res) => {
  try {
    const { targetAll, uid, title, body } = req.body;
    if(!title||!body) return res.status(400).json({success:false,error:'Missing title/body'});
    if(targetAll){
      // Fetch all tokens in batches — limit 200 to stay cheap
      const snap = await db.collection('users').where('fcmToken','!=','').limit(200).get();
      let sent=0;
      const promises = snap.docs.map(async d=>{
        const token = d.data().fcmToken;
        if(!token) return;
        await sendFcmToToken(token, title, body);
        sent++;
      });
      await Promise.all(promises);
      res.json({success:true, sent});
    } else if(uid){
      const userSnap = await db.collection('users').doc(uid).get();
      const token = userSnap.data()?.fcmToken;
      if(!token) return res.json({success:false,error:'No FCM token for user'});
      await sendFcmToToken(token, title, body);
      res.json({success:true, sent:1});
    } else {
      res.status(400).json({success:false,error:'Specify targetAll or uid'});
    }
  } catch(e){ res.status(500).json({success:false,error:e.message}); }
});

// Push notifications are sent directly via /api/send-push — no polling needed (saves ~57,000 reads/day)
function watchNewNotifications(){ /* disabled — use /api/send-push endpoint directly */ }

// ─── IN-MEMORY MARKETS CACHE (serves all frontend reads) ──────
let _marketsCache = [];
let _marketsCacheBuiltAt = 0;
let _lastTgPollAt = 0;
const MARKETS_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

let _marketsCacheBackoffUntil = 0;
async function refreshMarketsCache() {
  if (Date.now() < _marketsCacheBackoffUntil) {
    console.log('⏸️ Markets cache refresh skipped (quota backoff)');
    return;
  }
  try {
    console.log('🔄 Refreshing markets cache from Firestore...');
    let allDocs = [];
    let lastDoc = null;
    const batchSize = 500;

    // Cap at 200 active markets max — reduces reads from 10,000 to 200 per refresh
    const MAX_MARKETS = 200;
    const snap = await db.collection('markets')
      .where('status', '==', 'active')
      .orderBy('createdAt', 'desc')
      .limit(MAX_MARKETS)
      .get();
    allDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    _marketsCache = allDocs;
    _marketsCacheBuiltAt = Date.now();
    console.log(`✅ Markets cache refreshed: ${_marketsCache.length} markets loaded`);
  } catch (e) {
    console.error('refreshMarketsCache error:', e.message);
    if (e.message && e.message.includes('RESOURCE_EXHAUSTED')) {
      _marketsCacheBackoffUntil = Date.now() + 60 * 60 * 1000; // pause 1 hour
      console.log('🚫 Quota exhausted — markets cache paused for 1 hour');
    }
  }
}

// Refresh on startup (staggered) and every 60 minutes
setTimeout(refreshMarketsCache, 10000);
setInterval(refreshMarketsCache, MARKETS_CACHE_TTL);

// Also refresh after auto-sync completes (so new markets are immediately available)
const _origAutoSync = autoSyncPolymarketMarkets;

// GET /api/markets — serves all frontend market reads from memory (0 Firestore reads per user)
app.get('/api/markets', async (req, res) => {
  // If cache is empty, build it now. If stale, refresh in background (don't block request).
  if (!_marketsCache.length) {
    await refreshMarketsCache();
  } else if (Date.now() - _marketsCacheBuiltAt > MARKETS_CACHE_TTL) {
    refreshMarketsCache().catch(e => console.error('bg cache refresh error:', e.message));
  }

  let markets = _marketsCache;

  // Optional filters
  const { category, limit: lim, status } = req.query;
  if (category && category !== 'All') {
    markets = markets.filter(m => m.category === category);
  }
  if (lim) {
    markets = markets.slice(0, parseInt(lim));
  }

  res.setHeader('Cache-Control', 'public, max-age=60'); // browsers can cache 1min too
  res.json({ success: true, markets, cachedAt: _marketsCacheBuiltAt, count: markets.length });
});

// POST /api/markets/refresh — call this after admin creates a market to bust the cache
app.post('/api/markets/refresh', async (req, res) => {
  await refreshMarketsCache();
  res.json({ success: true, count: _marketsCache.length });
});

app.post('/api/markets/force-sync', async (req, res) => {
  try {
    res.json({ success: true, message: 'Sync started in background — check logs' });
    await autoSyncPolymarketMarkets();
    await refreshMarketsCache();
  } catch(e) {
    console.error('force-sync error:', e.message);
  }
});

// ─── CRYPTO MARKETS CACHE ────────────────────────────────────
// ── CRYPTO MARKETS REMOVED — 15-min up/down feature disabled ──
app.get('/api/crypto-markets', async (req, res) => {
  res.json({ success: true, markets: [], count: 0 });
});

// ─── TOP TRADERS CACHE ───────────────────────────────────────
let _topTradersCache = [];
let _topTradersCacheBuiltAt = 0;
const TOP_TRADERS_CACHE_TTL = 30 * 60 * 1000; // 30 minutes

let _topTradersBackoffUntil = 0;
async function refreshTopTradersCache() {
  if (Date.now() < _topTradersBackoffUntil) return;
  try {
    const snap = await db.collection('users')
      .orderBy('profit', 'desc')
      .limit(10)
      .get();
    _topTradersCache = snap.docs.map(d => {
      const u = { id: d.id, ...d.data() };
      // calculate win streak from betHistory array if stored, else estimate
      const wins = u.wins || 0;
      const losses = (u.totalBets || 0) - wins;
      const wr = u.totalBets > 0 ? Math.round(wins / u.totalBets * 100) : 0;
      // streak: stored on user doc as currentStreak, else derive from winrate
      const streak = u.currentStreak || (wr >= 60 ? Math.floor(wr / 20) : 0);
      return { ...u, winRate: wr, currentStreak: streak };
    }).filter(u => u.totalBets > 0);
    _topTradersCacheBuiltAt = Date.now();
    console.log(`✅ Top traders cache refreshed: ${_topTradersCache.length} traders`);
  } catch (e) {
    console.error('refreshTopTradersCache error:', e.message);
    if (e.message && e.message.includes('RESOURCE_EXHAUSTED')) {
      _topTradersBackoffUntil = Date.now() + 60 * 60 * 1000;
      console.log('🚫 Quota exhausted — top traders cache paused for 1 hour');
    }
  }
}
setTimeout(refreshTopTradersCache, 60000);
setInterval(refreshTopTradersCache, 6 * 60 * 60 * 1000); // every 6 hours

app.get('/api/top-traders', async (req, res) => {
  if (!_topTradersCache.length || Date.now() - _topTradersCacheBuiltAt > TOP_TRADERS_CACHE_TTL) {
    await refreshTopTradersCache();
  }
  const tab = req.query.tab || 'profit';
  let traders = [..._topTradersCache];
  if (tab === 'winrate') traders.sort((a,b) => (b.winRate||0) - (a.winRate||0));
  else if (tab === 'bets') traders.sort((a,b) => (b.totalBets||0) - (a.totalBets||0));
  else traders.sort((a,b) => (b.profit||0) - (a.profit||0));
  res.setHeader('Cache-Control', 'public, max-age=120');
  res.json({ success: true, traders: traders.slice(0, 20) });
});

// ─── NOTIFICATIONS CACHE (per-user, 5 min) ───────────────────
const _notifCache = {}; // uid -> { data, ts }
const NOTIF_CACHE_TTL = 60 * 60 * 1000; // 1 hour — notifications rarely change
const MAX_NOTIF_CACHE_ENTRIES = 500;

// Cleanup old notification cache entries every hour
setInterval(() => {
  const now = Date.now();
  const keys = Object.keys(_notifCache);
  keys.forEach(k => { if (now - _notifCache[k].ts > NOTIF_CACHE_TTL * 2) delete _notifCache[k]; });
  // If still too large, evict oldest
  const remaining = Object.keys(_notifCache);
  if (remaining.length > MAX_NOTIF_CACHE_ENTRIES) {
    remaining.sort((a,b) => _notifCache[a].ts - _notifCache[b].ts)
      .slice(0, remaining.length - MAX_NOTIF_CACHE_ENTRIES)
      .forEach(k => delete _notifCache[k]);
  }
}, 60 * 60 * 1000);

app.get('/api/notifications/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ success: false, error: 'Missing userId' });

  const cached = _notifCache[userId];
  if (cached && Date.now() - cached.ts < NOTIF_CACHE_TTL) {
    return res.json({ success: true, notifications: cached.data });
  }

  try {
    const { getDocs, query, collection, where, orderBy, limit } = require('firebase-admin/firestore');
    // Use admin SDK query directly
    const [snap, userSnap] = await Promise.all([
      db.collection('notifications')
        .where('targetAll', '==', true)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get(),
      db.collection('notifications')
        .where('targetUid', '==', userId)
        .orderBy('createdAt', 'desc')
        .limit(10)
        .get()
    ]);

    const allNotifs = [
      ...snap.docs.map(d => ({ id: d.id, ...d.data() })),
      ...userSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    ].sort((a, b) => (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0)).slice(0, 10);

    _notifCache[userId] = { data: allNotifs, ts: Date.now() };
    res.json({ success: true, notifications: allNotifs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── USER BETS CACHE (per-user, 2 min) ───────────────────────
const _userBetsCache = {}; // uid -> { data, ts }
const USER_BETS_CACHE_TTL = 10 * 60 * 1000;

// Periodic cleanup of all per-user in-memory caches to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  [
    [_userBetsCache, USER_BETS_CACHE_TTL],
    [_txCache, TX_CACHE_TTL],
    [_commentsCache, COMMENTS_CACHE_TTL],
    [_activityCache, ACTIVITY_CACHE_TTL],
    [_referralCache, REFERRAL_CACHE_TTL],
  ].forEach(([cache, ttl]) => {
    Object.keys(cache).forEach(k => { if (now - cache[k].ts > ttl * 3) delete cache[k]; });
  });
}, 30 * 60 * 1000);

app.get('/api/user-bets/:userId', async (req, res) => {
  const { userId } = req.params;
  if (!userId) return res.status(400).json({ success: false, error: 'Missing userId' });

  const cached = _userBetsCache[userId];
  if (cached && Date.now() - cached.ts < USER_BETS_CACHE_TTL) {
    return res.json({ success: true, bets: cached.data });
  }

  try {
    const snap = await db.collection('bets')
      .where('uid', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    const bets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _userBetsCache[userId] = { data: bets, ts: Date.now() };
    res.json({ success: true, bets });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── RECENT BETS FEED (60s cache, shared — ~1440 reads/day regardless of user count) ───
let _recentBetsCache = null;
let _recentBetsCacheAt = 0;
app.get('/api/recent-bets', async (req, res) => {
  if(_recentBetsCache && Date.now() - _recentBetsCacheAt < 5 * 60 * 1000){
    return res.json({ bets: _recentBetsCache });
  }
  try {
    const snap = await db.collection('bets')
      .orderBy('createdAt','desc')
      .limit(20)
      .get();
    // Enrich with market question from _marketsCache (0 extra reads)
    const marketMap = {};
    _marketsCache.forEach(m=>{ marketMap[m.id]=m.question; });
    _recentBetsCache = snap.docs.map(d=>{
      const b = d.data();
      return {
        username: b.username||'User',
        side: b.side,
        amount: b.amount||0,
        question: marketMap[b.marketId]||'',
        createdAt: b.createdAt?._seconds ? { seconds: b.createdAt._seconds } : null
      };
    });
    _recentBetsCacheAt = Date.now();
    res.json({ bets: _recentBetsCache });
  } catch(e){ res.json({ bets: [] }); }
});

// ─── PRICE ALERT CHECKER — runs after every autoSync (0 reads — uses _marketsCache + user priceAlerts already on user docs) ───
async function checkPriceAlerts(){
  // Only run if markets cache is populated (avoid reads on cold start)
  if (!_marketsCache.length) return;
  try {
    // Only check users who have priceAlerts set — 1 Firestore read per run
    const usersSnap = await db.collection('users').where('priceAlerts','!=',null).select('priceAlerts','telegramChatId','username').limit(200).get();
    if(usersSnap.empty) return;
    const marketMap = {};
    _marketsCache.forEach(m=>{ marketMap[m.id] = m; });
    for(const userDoc of usersSnap.docs){
      const u = userDoc.data();
      const alerts = u.priceAlerts || [];
      const toRemove = [];
      for(const alert of alerts){
        const mkt = marketMap[alert.marketId];
        if(!mkt || mkt.status !== 'active') { toRemove.push(alert.marketId); continue; }
        const outcome = (alert.outcome || 'YES').toUpperCase();
        let currentOdds = 50;
        if (outcome === 'YES' || outcome === 'NO') {
          const yp = mkt.yesPool || 0; const np = mkt.noPool || 0;
          const total = yp + np;
          if (outcome === 'YES') currentOdds = mkt.polymarketYesOdds || (total > 0 ? Math.round(yp/total*100) : 50);
          else currentOdds = total > 0 ? Math.round(np/total*100) : 50;
        } else {
          // Multi-outcome: find pool key
          const poolKey = 'pool_' + outcome.replace(/[^a-zA-Z0-9]/g,'_').toLowerCase();
          const outcomePool = mkt[poolKey] || 0;
          const totalPool = mkt.totalPool || Object.keys(mkt).filter(k=>k.startsWith('pool_')).reduce((s,k)=>s+Number(mkt[k]||0),0);
          currentOdds = totalPool > 0 ? Math.round(outcomePool/totalPool*100) : 0;
        }
        if(currentOdds >= Number(alert.threshold)){
          if(u.telegramChatId){
            await sendTelegramMessage(u.telegramChatId,
              `🔔 <b>Price Alert Triggered!</b>\n\n` +
              `<b>${(mkt.question||'').substring(0,80)}</b>\n\n` +
              `<b>${outcome}</b> odds just hit <b>${currentOdds}%</b>\n` +
              `(your alert was set at ${alert.threshold}%)\n\n` +
              `Tap below to bet now 👇`,
              { reply_markup: { inline_keyboard: [[{ text: '📈 Bet Now', url: marketUrl(mkt) }, { text: '🔔 New Alert', callback_data: 'alert' }]] }}
            );
          }
          toRemove.push(alert.marketId); // remove triggered alert
        }
      }
      if(toRemove.length){
        const remaining = alerts.filter(a=>!toRemove.includes(a.marketId));
        await userDoc.ref.update({ priceAlerts: remaining });
      }
    }
  } catch(e){ console.error('checkPriceAlerts error:', e.message); }
}

// ─── COMMENT REPLY TELEGRAM NOTIFICATION ─────────────────────
app.post('/api/notify-comment-reply', async (req, res) => {
  try {
    const { targetUid, replierUsername, commentText, marketId, marketQuestion } = req.body;
    if (!targetUid || !replierUsername) return res.json({ success: false });
    const userSnap = await db.collection('users').doc(targetUid).get();
    if (!userSnap.exists) return res.json({ success: false });
    const tgId = userSnap.data().telegramChatId;
    if (!tgId) return res.json({ success: true, sent: false }); // user has no telegram linked
    await sendTelegramMessage(tgId,
      `💬 <b>@${replierUsername} replied to your comment</b>\n\n` +
      `<i>"${(commentText||'').substring(0,120)}"</i>\n\n` +
      `📊 Market: ${(marketQuestion||'').substring(0,60)}`,
      { reply_markup: { inline_keyboard: [[
        { text: '👀 View Market', url: marketUrl(_marketsCache.find(m=>m.id===marketId)||{}) }
      ]]}}
    );
    res.json({ success: true, sent: true });
  } catch(e) {
    console.error('notify-comment-reply error:', e.message);
    res.json({ success: false });
  }
});

// ─── COMMENTS CACHE (per-market, 3 min) ──────────────────────
const _commentsCache = {};
const COMMENTS_CACHE_TTL = 3 * 60 * 1000;

app.get('/api/comments/:marketId', async (req, res) => {
  const { marketId } = req.params;
  const cached = _commentsCache[marketId];
  if (cached && Date.now() - cached.ts < COMMENTS_CACHE_TTL) {
    return res.json({ success: true, comments: cached.data });
  }
  try {
    const snap = await db.collection('comments')
      .where('marketId', '==', marketId)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    const comments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _commentsCache[marketId] = { data: comments, ts: Date.now() };
    res.json({ success: true, comments });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── ACTIVITY FEED CACHE (per-market, 2 min) ─────────────────
const _activityCache = {};
const ACTIVITY_CACHE_TTL = 2 * 60 * 1000;

app.get('/api/activity/:marketId', async (req, res) => {
  const { marketId } = req.params;
  const cached = _activityCache[marketId];
  if (cached && Date.now() - cached.ts < ACTIVITY_CACHE_TTL) {
    return res.json({ success: true, bets: cached.data });
  }
  try {
    const cutoff = new Date(Date.now() - 15 * 60 * 1000);
    const snap = await db.collection('bets')
      .where('marketId', '==', marketId)
      .orderBy('createdAt', 'desc')
      .limit(15)
      .get();
    const bets = snap.docs.map(d => d.data()).filter(b => {
      if (!b.createdAt) return false;
      const t = b.createdAt.toDate ? b.createdAt.toDate() : new Date(b.createdAt._seconds * 1000);
      return t >= cutoff;
    });
    _activityCache[marketId] = { data: bets, ts: Date.now() };
    res.json({ success: true, bets });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── WALLET BALANCE (per-user, no cache — always fresh) ──────
const _balanceCache = {};
const BALANCE_CACHE_TTL = 3 * 60 * 1000; // 3 minutes
app.get('/api/user-balance/:userId', async (req, res) => {
  const { userId } = req.params;
  const cached = _balanceCache[userId];
  if (cached && Date.now() - cached.ts < BALANCE_CACHE_TTL) {
    return res.json({ success: true, ...cached.data });
  }
  try {
    const snap = await db.collection('users').doc(userId).get();
    if (!snap.exists) return res.status(404).json({ success: false });
    const d = snap.data();
    const payload = {
      balance: d.balance || 0,
      bonusBalance: d.bonusBalance || 0,
      referralCode: d.referralCode || '',
      referralTier: d.referralTier || 'bronze',
      referralCount: d.referralCount || 0,
      referralVolume: d.referralVolume || 0,
      totalBets: d.totalBets || 0,
      wins: d.wins || 0,
      profit: d.profit || 0
    };
    _balanceCache[userId] = { data: payload, ts: Date.now() };
    res.json({ success: true, ...payload });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── TRANSACTIONS CACHE (per-user, 5 min) ────────────────────
const _txCache = {};
const TX_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/transactions/:userId', async (req, res) => {
  const { userId } = req.params;
  const cached = _txCache[userId];
  if (cached && Date.now() - cached.ts < TX_CACHE_TTL) {
    return res.json({ success: true, transactions: cached.data });
  }
  try {
    const snap = await db.collection('transactions')
      .where('uid', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    const txs = snap.docs.map(d => d.data());
    _txCache[userId] = { data: txs, ts: Date.now() };
    res.json({ success: true, transactions: txs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── REFERRAL HISTORY (per-user, 5 min) ──────────────────────
const _referralCache = {};
const REFERRAL_CACHE_TTL = 5 * 60 * 1000;

app.get('/api/referrals/:userId', async (req, res) => {
  const { userId } = req.params;
  const cached = _referralCache[userId];
  if (cached && Date.now() - cached.ts < REFERRAL_CACHE_TTL) {
    return res.json({ success: true, referrals: cached.data });
  }
  try {
    const snap = await db.collection('referralPending')
      .where('referrerId', '==', userId)
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    const referrals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    _referralCache[userId] = { data: referrals, ts: Date.now() };
    res.json({ success: true, referrals });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ─── CACHE INVALIDATION (call after writes that change data) ──
// ─── REFERRAL BONUS CHECKER (called after every bet) ─────────
app.post('/api/check-referral', async (req, res) => {
  const { refereeId } = req.body;
  if (!refereeId) return res.json({ success: false });
  try {
    const pendingSnap = await db.collection('referralPending')
      .where('refereeId', '==', refereeId)
      .where('paid', '==', false)
      .limit(5)
      .get();
    if (pendingSnap.empty) return res.json({ success: true, checked: 0 });

    const txSnap = await db.collection('transactions')
      .where('uid', '==', refereeId)
      .where('type', 'in', ['bet', 'crypto_bet'])
      .get();
    const refereeTotalVolume = txSnap.docs.reduce((s,d) => s + Math.abs(d.data().amount||0), 0);

    for (const pendingDoc of pendingSnap.docs) {
      const refData = pendingDoc.data();
      const referrerSnap = await db.collection('users').doc(refData.referrerId).get();
      if (!referrerSnap.exists) continue;
      const referrerData = referrerSnap.data();
      const referrerIsNg = !referrerData.country || referrerData.country === 'NG';
      const tier = referrerData.referralTier || 'bronze';
      const tierMins = { bronze: referrerIsNg?200:Math.floor(0.2*1360), silver: referrerIsNg?500:Math.floor(0.5*1360), gold: referrerIsNg?2000:Math.floor(2*1360), diamond: referrerIsNg?5000:Math.floor(5*1360) };
      const minTrade = tierMins[tier] || tierMins.bronze;
      if (refereeTotalVolume < minTrade) continue;

      const tierRewards = { bronze: referrerIsNg?500:Math.floor(0.5*1360), silver: referrerIsNg?1000:Math.floor(1*1360), gold: referrerIsNg?2500:Math.floor(2.5*1360), diamond: referrerIsNg?5000:Math.floor(5*1360) };
      const bonusReward = tierRewards[tier] || tierRewards.bronze;

      await pendingDoc.ref.update({ paid: true });
      await referrerSnap.ref.update({
        bonusBalance: admin.firestore.FieldValue.increment(bonusReward),
        referralCount: admin.firestore.FieldValue.increment(1),
        referralVolume: admin.firestore.FieldValue.increment(refereeTotalVolume)
      });
      await db.collection('transactions').add({
        uid: refData.referrerId, type: 'referral_bonus', amount: bonusReward,
        note: `Referral bonus — credited to bonus wallet`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      // Notify referrer on Telegram (referrerData already in scope — 0 extra reads)
      if (referrerData.telegramChatId) {
        const fmt = n => '₦' + Number(n||0).toLocaleString('en-NG');
        sendTelegramMessage(referrerData.telegramChatId,
          `🎉 <b>Referral Bonus Earned!</b>\n\n` +
          `Someone you referred just completed their first trade.\n\n` +
          `<b>${fmt(bonusReward)}</b> has been added to your bonus wallet! 💰\n\n` +
          `Tier: <b>${tier.toUpperCase()}</b> • Total referrals: <b>${(referrerData.referralCount||0)+1}</b>`,
          { reply_markup: { inline_keyboard: [[{ text: '💰 Check Balance', callback_data: 'balance' }, { text: '👥 My Referrals', callback_data: 'refer' }]] }}
        ).catch(()=>{});
      }
    }
    res.json({ success: true });
  } catch(e) { res.json({ success: false, error: e.message }); }
});

app.post('/api/copy-trade', async (req, res) => {
  const { traderId, marketId, side, amount } = req.body;
  if(!traderId || !marketId || !side || !amount) return res.json({ success: false, error: 'Missing params' });
  try {
    const snap = await db.collection('copyRelations').where('traderId','==',traderId).get();
    for(const d of snap.docs){
      const rel = d.data();
      const multiplier = rel.multiplier || 1;
      const copierRef = db.collection('users').doc(rel.copierId);
      const copierSnap = await copierRef.get();
      if(!copierSnap.exists) continue;
      const copier = copierSnap.data();
      const fixedAmt = rel.fixedBetAmount || 0;
      const maxPerTrade = rel.maxPerTrade || 0;
      let copyAmt = fixedAmt > 0 ? fixedAmt : Math.floor(amount * multiplier);
      if(maxPerTrade > 0) copyAmt = Math.min(copyAmt, maxPerTrade);
      const copierIsNg = !copier.country || copier.country === 'NG';
      const copierMinBet = copierIsNg ? 100 : 400;
      const useBonusForCopy = rel.useBonus && (copier.bonusBalance||0) >= copyAmt && copyAmt <= (copierIsNg ? 200 : 300);
      if(useBonusForCopy){ if((copier.bonusBalance||0) < copyAmt) continue; }
      else { if((copier.balance||0) < copyAmt) continue; }
      if(copyAmt < copierMinBet) continue;
      await db.runTransaction(async tx => {
        const mktRef = db.collection('markets').doc(marketId);
        const mktSnap = await tx.get(mktRef);
        if(!mktSnap.exists || mktSnap.data().status !== 'active') return;
        const upd = side==='YES' ? { yesPool: admin.firestore.FieldValue.increment(copyAmt) } : { noPool: admin.firestore.FieldValue.increment(copyAmt) };
        tx.update(mktRef, upd);
        if(useBonusForCopy){
          tx.update(copierRef, { bonusBalance: admin.firestore.FieldValue.increment(-copyAmt), totalBets: admin.firestore.FieldValue.increment(1) });
        } else {
          tx.update(copierRef, { balance: admin.firestore.FieldValue.increment(-copyAmt), totalBets: admin.firestore.FieldValue.increment(1) });
        }
        const betRef = db.collection('bets').doc();
        tx.set(betRef, { uid: rel.copierId, username: copier.username, marketId, side, amount: copyAmt, potentialPayout: 0, status: 'pending', isCopyTrade: true, isBonus: useBonusForCopy||false, copiedFrom: traderId, multiplier, copyFeePercent: 15, traderFeePercent: 5, createdAt: admin.firestore.FieldValue.serverTimestamp() });
        const txRef = db.collection('transactions').doc();
        tx.set(txRef, { uid: rel.copierId, type: 'copy_bet', amount: -copyAmt, note: `Copy trade bet ${side} (${multiplier}×)`, createdAt: admin.firestore.FieldValue.serverTimestamp() });
      }).catch(()=>{});
      // Notify copier on Telegram (copier data already in scope — 0 extra reads)
      if (copier.telegramChatId) {
        const marketQ = _marketsCache.find(m => m.id === marketId)?.question || 'a market';
        sendTelegramMessage(copier.telegramChatId,
          `🤖 <b>Copy Trade Placed!</b>\n\n` +
          `A trade was auto-copied for you:\n\n` +
          `Side: <b>${side}</b> — Amount: <b>₦${Number(copyAmt).toLocaleString('en-NG')}</b>\n` +
          `Market: <i>${(marketQ).substring(0,70)}</i>\n` +
          `Multiplier: <b>${multiplier}×</b>`,
          { reply_markup: { inline_keyboard: [
            [{ text: '🎯 My Bets', callback_data: 'mybets' }, { text: '📈 Open App', url: 'https://crediplex.name.ng' }]
          ]}}
        ).catch(()=>{});
      }
    }
    res.json({ success: true });
  } catch(e){ res.json({ success: false, error: e.message }); }
});

app.post('/api/cache-invalidate', (req, res) => {
  const { type, id } = req.body;
  if (type === 'comments' && id) delete _commentsCache[id];
  if (type === 'activity' && id) delete _activityCache[id];
  if (type === 'transactions' && id) delete _txCache[id];
  if (type === 'bets' && id) delete _userBetsCache[id];
  if (type === 'referrals' && id) delete _referralCache[id];
  res.json({ success: true });
});

app.post('/api/upload-image', async (req, res) => {
  try {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const buffer = Buffer.concat(chunks);
        const boundary = req.headers['content-type'].split('boundary=')[1];
        const bodyStr = buffer.toString('binary');
        const parts = bodyStr.split('--' + boundary);
        let imageBase64 = '';
        for (const part of parts) {
          if (part.includes('name="image"')) {
            const split = part.split('\r\n\r\n');
            if (split[1]) {
              const raw = Buffer.from(split[1].replace(/\r\n$/, ''), 'binary');
              imageBase64 = raw.toString('base64');
            }
          }
        }
        if (!imageBase64) return res.status(400).json({ success: false, error: 'No image found' });

        const IMGBB_KEY = process.env.IMGBB_API_KEY;
        const form = new URLSearchParams();
        form.append('image', imageBase64);

        const imgbbRes = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_KEY}`, {
          method: 'POST',
          body: form
        });
        const data = await imgbbRes.json();
        if (!data.success) throw new Error('ImgBB upload failed');
        res.json({ success: true, data: { url: data.data.url } });
      } catch (e) {
        res.status(500).json({ success: false, error: e.message });
      }
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Crediplex API', version: '2.0' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Crediplex server running on port ${PORT}`);
});
