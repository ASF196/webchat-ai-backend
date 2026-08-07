// routes/analytics.js
// Per-bot analytics — anyone holding a bot's token can read that bot's own stats,
// but never another bot's. This is what the Analytics page in the dashboard would
// call instead of relying on browser-only state.

const express = require('express');
const { prepare: dbPrepare } = require('../db');
const db = { prepare: dbPrepare };
const router = express.Router();

router.get('/analytics/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const bot = await db.prepare('SELECT token, name, site_name FROM bots WHERE token = ?').get(token);
    if (!bot) return res.status(404).json({ error: 'Unknown bot token' });

    const all = await db.prepare('SELECT question, asked_at FROM questions WHERE bot_token = ? ORDER BY asked_at ASC').all(token);

  const total = all.length;
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const todayCount = all.filter(q => q.asked_at.slice(0, 10) === todayStr).length;

  // Group identical (normalized) questions for "most asked"
  const norm = s => s.toLowerCase().trim().replace(/[?!.,]+$/, '').replace(/\s+/g, ' ');
  const groups = {};
  for (const q of all) {
    const key = norm(q.question);
    if (!groups[key]) groups[key] = { text: q.question, count: 0, last: q.asked_at };
    groups[key].count++;
    if (q.asked_at > groups[key].last) { groups[key].last = q.asked_at; groups[key].text = q.question; }
  }
  const topQuestions = Object.values(groups)
    .sort((a, b) => b.count - a.count || (b.last > a.last ? 1 : -1))
    .slice(0, 10);

  // Hourly buckets for today
  const hourBuckets = new Array(24).fill(0);
  for (const q of all) {
    if (q.asked_at.slice(0, 10) === todayStr) {
      const hour = parseInt(q.asked_at.slice(11, 13), 10);
      hourBuckets[hour]++;
    }
  }

  // Last 7 days
  const last7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().slice(0, 10);
    const count = all.filter(q => q.asked_at.slice(0, 10) === dayStr).length;
    last7.push({ date: dayStr, count });
  }

  res.json({
    bot: { name: bot.name, siteName: bot.site_name },
    total,
    today: todayCount,
    uniqueQuestions: Object.keys(groups).length,
    topQuestions,
    hourBuckets,
    last7days: last7,
    recent: all.slice(-20).reverse()
  });
  } catch (err) {
    console.error('Analytics route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
