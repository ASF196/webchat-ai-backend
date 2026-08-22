// routes/pageassistant.js
// AI PILOT — the widget's ONLY on-page intelligence feature. As a visitor
// scrolls, it notices which section of the page they're looking at and
// offers ONE relevant question as a popup above the chat launcher — e.g.
// landing on a "Practice Areas" section prompts "What areas do you
// practice in?". Clicking it asks that question in chat.
//
// No cursor movement, no clicking, no navigation — this only ever reads
// text (via the browser's own IntersectionObserver, client-side) and shows
// a button. See db/index.js for the page_assistant_* schema this uses.

const express = require('express');
const { prepare: dbPrepare } = require('../db');
const db = { prepare: dbPrepare };
const router = express.Router();

const GROQ_KEY = process.env.GROQ_API_KEY;
const MODEL = 'openai/gpt-oss-20b';

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function safeParseJson(raw) {
  if (!raw) return null;
  let text = String(raw).trim().replace(/```(json)?/gi, '').trim();
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — same page content, reuse the same questions

const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10);
const hits = new Map();
function isRateLimited(token) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(token) || []).filter((t) => t > windowStart);
  arr.push(now);
  hits.set(token, arr);
  return arr.length > RATE_LIMIT;
}

function logEvent(token, visitorId, eventType, pageUrl, label) {
  db.prepare(
    'INSERT INTO page_assistant_events (bot_token, visitor_id, event_type, page_url, label) VALUES (?, ?, ?, ?, ?)'
  ).run(token, visitorId || null, eventType, pageUrl ? String(pageUrl).slice(0, 500) : null, label ? String(label).slice(0, 100) : null)
    .catch((err) => console.error('Page assistant event log failed:', err));
}

// ============================================================================
// PUBLIC
// ============================================================================
router.get('/api/page-assistant/config/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const settings = await db.prepare('SELECT * FROM page_assistant_settings WHERE bot_token = ?').get(token);
    if (!settings || !settings.enabled) return res.json({ enabled: false });
    res.json({
      enabled: true,
      cooldownSeconds: settings.cooldown_seconds ?? 4,
      maxSuggestions: settings.max_suggestions ?? 6,
    });
  } catch (err) {
    console.error('Page assistant config error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// One batched call per page per visitor (then cached) — the widget sends
// every section it detected (name + short text extract), and gets back ONE
// natural question per section, grounded only in that section's own text.
router.post('/api/page-assistant/section-questions', async (req, res) => {
  try {
    const { token, pageUrl, sections, visitorId } = req.body;
    if (!token || !pageUrl || !Array.isArray(sections) || !sections.length) {
      return res.status(400).json({ error: 'token, pageUrl, and a non-empty sections array are required' });
    }
    const bot = await db.prepare('SELECT * FROM bots WHERE token = ? AND is_active = 1').get(token);
    if (!bot) return res.status(404).json({ error: 'Unknown or inactive bot token' });

    const settings = await db.prepare('SELECT * FROM page_assistant_settings WHERE bot_token = ?').get(token);
    if (!settings || !settings.enabled) return res.json({ questions: [] });

    const cached = await db.prepare('SELECT * FROM page_assistant_cache WHERE bot_token = ? AND page_url = ?').get(token, pageUrl);
    if (cached && Date.now() - new Date(cached.created_at).getTime() < CACHE_TTL_MS) {
      let questions = [];
      try { questions = JSON.parse(cached.questions || '[]'); } catch { /* ignore */ }
      if (questions.length) return res.json({ questions });
    }

    if (isRateLimited(token)) return res.status(429).json({ error: 'Too many requests. Try again shortly.' });

    const cleanSections = sections.slice(0, 15).map((s) => ({
      name: String(s.name || '').slice(0, 80),
      text: String(s.text || '').slice(0, 900),
    })).filter((s) => s.name && s.text);
    if (!cleanSections.length) return res.json({ questions: [] });

    const prompt = `A visitor is scrolling through a webpage. For EACH section below, write the ONE most natural question a real visitor would have after reading just that section — the question that section itself would make someone wonder. The very first section (the hero/top of page) usually prompts something like "What is this page?" or "What does this company do?" — later sections should prompt more specific questions based on their actual content.

SECTIONS IN SCROLL ORDER (JSON):
${JSON.stringify(cleanSections)}

Respond with ONLY a JSON array, no markdown fences, no extra text, one entry per section IN THE SAME ORDER:
[{"section":"<exact section name from input>","question":"<short natural question, under 10 words>"}, ...]

Rules:
- Base each question ONLY on that section's own text — never invent something not actually there.
- Keep questions short and conversational, like something a person would actually type or tap.
- Don't repeat near-identical questions across sections.
- Never write vague meta-questions like "summarize this page" or "tell me more" — always ask about something SPECIFIC and concrete that's actually named or described in that section's text (a specific plan, service, feature, claim, or fact), so the question can be answered from that section alone.`;
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${GROQ_KEY}` },
      body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], max_tokens: 700, temperature: 0.4 }),
    });
    if (!groqRes.ok) {
      const errBody = await groqRes.text();
      console.error('Groq error (section-questions):', groqRes.status, errBody);
      return res.status(502).json({ error: 'Upstream AI provider error.' });
    }
    const data = await groqRes.json();
    const raw = data.choices?.[0]?.message?.content || '';
    const parsed = safeParseJson(raw);
    const questions = Array.isArray(parsed)
      ? parsed.filter((q) => q && q.section && q.question).map((q) => ({
          section: String(q.section).slice(0, 80),
          question: String(q.question).slice(0, 100),
        })).slice(0, 15)
      : [];

    if (questions.length) {
      await db.prepare(`
        INSERT INTO page_assistant_cache (bot_token, page_url, questions, created_at)
        VALUES (?, ?, ?, to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
        ON CONFLICT (bot_token, page_url) DO UPDATE SET
          questions = EXCLUDED.questions, created_at = to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
      `).run(token, pageUrl, JSON.stringify(questions));
    }

    res.json({ questions });
  } catch (err) {
    console.error('Section-questions error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/api/page-assistant/event', async (req, res) => {
  try {
    const { token, visitorId, eventType, pageUrl, label } = req.body;
    if (!token || !['suggestion_shown', 'suggestion_clicked'].includes(eventType)) {
      return res.status(400).json({ error: 'token and a valid eventType are required' });
    }
    const bot = await db.prepare('SELECT token FROM bots WHERE token = ? AND is_active = 1').get(token);
    if (!bot) return res.status(404).json({ error: 'Unknown or inactive bot token' });
    logEvent(token, visitorId, eventType, pageUrl, label);
    res.json({ ok: true });
  } catch (err) {
    console.error('Page assistant event route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================================
// ADMIN
// ============================================================================
router.get('/api/admin/page-assistant/:token', requireAdmin, async (req, res) => {
  try {
    const { token } = req.params;
    const bot = await db.prepare('SELECT token FROM bots WHERE token = ?').get(token);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });
    const settings = await db.prepare('SELECT * FROM page_assistant_settings WHERE bot_token = ?').get(token);
    res.json({
      settings: settings || { bot_token: token, enabled: false, cooldown_seconds: 4, max_suggestions: 6 },
    });
  } catch (err) {
    console.error('Get page-assistant settings error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.patch('/api/admin/page-assistant/:token', requireAdmin, async (req, res) => {
  try {
    const { token } = req.params;
    const bot = await db.prepare('SELECT token FROM bots WHERE token = ?').get(token);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const b = req.body || {};
    const enabled = !!b.enabled;
    const cooldownSeconds = Number.isFinite(b.cooldownSeconds) ? Math.max(1, Math.min(60, Math.round(b.cooldownSeconds))) : 4;
    const maxSuggestions = Number.isFinite(b.maxSuggestions) ? Math.max(0, Math.min(20, Math.round(b.maxSuggestions))) : 6;

    await db.prepare(`
      INSERT INTO page_assistant_settings (bot_token, enabled, cooldown_seconds, max_suggestions, updated_at)
      VALUES (?, ?, ?, ?, to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS'))
      ON CONFLICT (bot_token) DO UPDATE SET
        enabled = EXCLUDED.enabled, cooldown_seconds = EXCLUDED.cooldown_seconds, max_suggestions = EXCLUDED.max_suggestions,
        updated_at = to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    `).run(token, enabled, cooldownSeconds, maxSuggestions);

    res.json({ ok: true });
  } catch (err) {
    console.error('Update page-assistant settings error:', err);
    res.status(500).json({ error: 'Server error', detail: err.message });
  }
});

router.get('/api/admin/page-assistant-analytics/:token', requireAdmin, async (req, res) => {
  try {
    const { token } = req.params;
    const bot = await db.prepare('SELECT token FROM bots WHERE token = ?').get(token);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const events = await db.prepare(
      'SELECT event_type, label, created_at FROM page_assistant_events WHERE bot_token = ? ORDER BY created_at DESC LIMIT 3000'
    ).all(token);

    const shown = events.filter((e) => e.event_type === 'suggestion_shown').length;
    const clicked = events.filter((e) => e.event_type === 'suggestion_clicked').length;
    const clickRate = shown > 0 ? Math.round((clicked / shown) * 1000) / 10 : 0;

    const labelCounts = {};
    for (const e of events) {
      if (e.event_type !== 'suggestion_clicked' || !e.label) continue;
      labelCounts[e.label] = (labelCounts[e.label] || 0) + 1;
    }
    const mostClicked = Object.entries(labelCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, count]) => ({ label, count }));

    res.json({ suggestionsShown: shown, suggestionsClicked: clicked, clickRate, mostClicked });
  } catch (err) {
    console.error('Page assistant analytics error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
