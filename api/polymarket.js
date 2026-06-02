export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  // If a custom URL is passed, proxy it (keeps old functionality)
  const { url } = req.query;
  if (url) {
    try {
      const response = await fetch(decodeURIComponent(url));
      const data = await response.json();
      return res.status(200).json(data);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // No URL = fetch Polymarket top traders directly
  const urls = [
    'https://data-api.polymarket.com/rankings?window=all&limit=20&sortBy=profitAndLoss',
    'https://data-api.polymarket.com/rankings?window=monthly&limit=20&sortBy=profitAndLoss',
    'https://data-api.polymarket.com/rankings?window=weekly&limit=20',
  ];

  for (const endpoint of urls) {
    try {
      const r = await fetch(endpoint, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' }
      });
      const data = await r.json();
      const list = Array.isArray(data) ? data : (data.data || data.rankings || []);
      if (list.length > 0) return res.status(200).json(list);
    } catch (e) { continue; }
  }

  return res.status(200).json([]);
}
