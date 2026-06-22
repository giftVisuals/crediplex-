const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;

async function sendTelegram(chatId, message) {
  try {
    await fetch(`${TELEGRAM_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
  } catch(e) {
    console.log('Telegram error:', e.message);
  }
}

async function fetchPolymarket(url) {
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return null;
    return await res.json();
  } catch(e) { return null; }
}

async function getTraderTrades(walletAddress) {
  const urls = [
    `https://data-api.polymarket.com/trades?user=${walletAddress}&limit=5`,
    `https://data-api.polymarket.com/activity?user=${walletAddress}&limit=5`,
  ];
  for (const url of urls) {
    const data = await fetchPolymarket(url);
    if (data && Array.isArray(data) && data.length) return data;
    if (data && data.data && Array.isArray(data.data)) return data.data;
  }
  return [];
}

async function findMatchingMarket(db, conditionId) {
  if (!conditionId) return null;
  try {
    const snap = await db.collection('markets')
      .where('polymarketId', '==', String(conditionId))
      .where('status', '==', 'active')
      .limit(1).get();
    if (snap.empty) return null;
    return { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch(e) { return null; }
}

async function autoPlaceTrade(db, admin, copierId, copierData, market, side, betAmount) {
  try {
    if (betAmount < 100) return { success: false, reason: 'Below minimum' };
    if ((copierData.balance || 0) < betAmount) return { success: false, reason: 'Insufficient balance' };

    const marketRef = db.collection('markets').doc(market.id);
    const userRef = db.collection('users').doc(copierId);
    const yesPool = market.yesPool || 0;
    const noPool = market.noPool || 0;
    const totalPool = yesPool + noPool + betAmount;
    const sidePool = side === 'YES' ? (yesPool + betAmount) : (noPool + betAmount);
    const potentialPayout = Math.floor((totalPool * 0.90 / sidePool) * betAmount);

    await db.runTransaction(async tx => {
      const mktNow = await tx.get(marketRef);
      const userNow = await tx.get(userRef);
      if (!mktNow.exists || mktNow.data().status !== 'active') throw new Error('Market not active');
      if ((userNow.data().balance || 0) < betAmount) throw new Error('Insufficient balance');

      const poolUpd = side === 'YES'
        ? { yesPool: admin.firestore.FieldValue.increment(betAmount) }
        : { noPool: admin.firestore.FieldValue.increment(betAmount) };
      tx.update(marketRef, poolUpd);
      tx.update(userRef, {
        balance: admin.firestore.FieldValue.increment(-betAmount),
        totalBets: admin.firestore.FieldValue.increment(1)
      });

      const betRef = db.collection('bets').doc();
      tx.set(betRef, {
        uid: copierId,
        username: copierData.username || 'User',
        marketId: market.id,
        side,
        amount: betAmount,
        potentialPayout,
        status: 'pending',
        isCopyTrade: true,
        isPolymarketCopy: true,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      const txRef = db.collection('transactions').doc();
      tx.set(txRef, {
        uid: copierId,
        type: 'pm_auto_copy',
        amount: -betAmount,
        note: `Auto-copied Polymarket trade ${side} on "${(market.question || '').substring(0, 40)}..."`,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    });

    return { success: true, payout: potentialPayout };
  } catch(e) {
    return { success: false, reason: e.message };
  }
}

async function pollAllCopyRelations(db, admin) {
  console.log(`[${new Date().toISOString()}] Polling Polymarket copy relations...`);
  try {
    const relSnap = await db.collection('copyRelations')
      .where('isPolymarket', '==', true).get();
    if (relSnap.empty) { console.log('No Polymarket copy relations found.'); return; }

    // Group by traderId
    const traderMap = {};
    relSnap.docs.forEach(d => {
      const rel = d.data();
      if (!traderMap[rel.traderId]) traderMap[rel.traderId] = [];
      traderMap[rel.traderId].push({ id: d.id, ...rel });
    });

    console.log(`Polling ${Object.keys(traderMap).length} unique traders...`);

    for (const [traderAddress, relations] of Object.entries(traderMap)) {
      try {
        const trades = await getTraderTrades(traderAddress);
        if (!trades.length) continue;

        for (const trade of trades) {
          const tradeTime = trade.timestamp
            ? new Date(trade.timestamp).getTime()
            : trade.created_at ? new Date(trade.created_at).getTime() : 0;

          // Only trades from last 6 minutes
          if (tradeTime && (Date.now() - tradeTime) > 6 * 60 * 1000) continue;

          const conditionId = trade.conditionId || trade.market || trade.asset;
          if (!conditionId) continue;

          const market = await findMatchingMarket(db, conditionId);
          if (!market) continue;

          const outcomeStr = (trade.outcome || trade.side || '').toLowerCase();
          const side = (outcomeStr === 'yes' || outcomeStr === 'buy' || outcomeStr === '1') ? 'YES' : 'NO';

          for (const rel of relations) {
            try {
              const copierSnap = await db.collection('users').doc(rel.copierId).get();
              if (!copierSnap.exists) continue;
              const copier = copierSnap.data();

              const tradeUsd = parseFloat(trade.size || trade.amount || trade.usdcSize || 0);
              const liveRate = 1360; // update this periodically or fetch from your /api/live-rate
              let betAmount;
              if (rel.copyMode === 'fixed' && rel.fixedBetAmount > 0) {
                betAmount = rel.fixedBetAmount;
              } else {
                const multiplier = rel.multiplier || 0.01;
                betAmount = Math.max(100, Math.floor(tradeUsd * liveRate * multiplier));
              }
              if (rel.maxPerTrade > 0) betAmount = Math.min(betAmount, rel.maxPerTrade);
              if (betAmount < 100 || (copier.balance || 0) < betAmount) continue;

              const result = await autoPlaceTrade(db, admin, rel.copierId, copier, market, side, betAmount);

              if (result.success) {
                console.log(`✅ Placed: ${rel.copierId} → ${side} ₦${betAmount}`);
                if (copier.telegramChatId) {
                  const short = traderAddress.substring(0,8) + '...' + traderAddress.substring(traderAddress.length-4);
                  await sendTelegram(copier.telegramChatId,
                    `🤖 <b>Copy Trade Placed!</b>\n\n` +
                    `Trader: <code>${short}</code>\n` +
                    `Position: <b>${side}</b>\n` +
                    `Staked: <b>₦${betAmount.toLocaleString()}</b>\n` +
                    `Market: ${(market.question || '').substring(0, 60)}\n\n` +
                    `Potential payout: ₦${(result.payout || 0).toLocaleString()}`
                  );
                }
              } else {
                console.log(`⚠️ Failed for ${rel.copierId}: ${result.reason}`);
              }
            } catch(e) { console.log('Copier error:', e.message); }
          }
        }
      } catch(e) { console.log(`Trader poll error ${traderAddress}:`, e.message); }

      await new Promise(r => setTimeout(r, 500));
    }
    console.log('✅ Poll cycle done.');
  } catch(e) { console.log('Poll error:', e.message); }
}

module.exports = { pollAllCopyRelations, sendTelegram };
