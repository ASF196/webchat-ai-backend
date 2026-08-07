// routes/chat.js
// PUBLIC endpoint — this is what every client's embedded <script> snippet calls.
// It is intentionally open to any origin (the widget has to work on any client's
// site), but it never exposes your Groq key — that lives only in process.env here.

const express = require('express');
const { prepare: dbPrepare } = require('../db');
const db = { prepare: dbPrepare };
const router = express.Router();

const GROQ_KEY = process.env.GROQ_API_KEY;
// llama-3.1-8b-instant was deprecated by Groq (announced June 17, 2026) —
// openai/gpt-oss-20b is their recommended replacement: similar speed/cost,
// current generation. If Groq changes their lineup again, check
// https://console.groq.com/docs/models for what's current.
const MODEL = 'openai/gpt-oss-20b';

// Same phrase list the dashboard uses to detect "the bot doesn't know" replies,
// so the embed widget can nudge the visitor toward contacting you directly.
const UNSURE = ['not in the content','not found',"don't have",'not mention','cannot find','no information',"doesn't mention","isn't covered",'not available','not provided',"can't find",'unable to find','not specified','not stated','not included',"i don't see",'not listed',"doesn't say","doesn't cover",'not described','no details',"i cannot answer",'not enough information','unclear from',"doesn't provide"];
function isUnsure(t) {
  const lower = t.toLowerCase();
  return UNSURE.some(p => lower.includes(p));
}

// Splits the model's raw reply into clean text + the suggestion chips,
// matching the |||SUGS|||[...] marker format the dashboard's prompt also uses.
function parseSuggestions(raw) {
  const marker = '|||SUGS|||';
  const idx = raw.indexOf(marker);
  if (idx === -1) return { text: raw.trim(), suggestions: [] };
  const text = raw.slice(0, idx).trim();
  const jsonPart = raw.slice(idx + marker.length).trim();
  try {
    const arr = JSON.parse(jsonPart);
    if (Array.isArray(arr)) {
      return { text, suggestions: arr.filter(s => typeof s === 'string').slice(0, 3) };
    }
  } catch {
    // model didn't return valid JSON for suggestions — just drop the marker
  }
  return { text, suggestions: [] };
}

const SYSTEM_PROMPT = (siteName, kb) => `You are a helpful, knowledgeable assistant for "${siteName}". You have been trained on the site's full content below.

RULES:
- Answer from the provided content. If the answer IS in the content, give it — never say you "can't find" or "don't have" info that is actually present.
- Security, compliance, pricing, features: quote the exact text from the content verbatim.
- Keep answers concise: 3-6 sentences. Use bullet points for lists.
- Use **bold** for one key term per answer only.
- Never reply with [object], JSON syntax, or raw data structures.
- Only say "I don't have that info" for topics genuinely absent from the knowledge base.
- If asked about security/privacy/compliance/certifications, look for that info in the content and answer it directly.

RESPONSE FORMAT — always end every reply with this exact block (no exceptions):
|||SUGS|||["short follow-up 1","short follow-up 2","short follow-up 3"]

The 3 suggestions must be under 6 words each, relevant to the conversation, and be questions the person would naturally ask next. Keep them as a valid JSON array on one line after |||SUGS|||.

SITE KNOWLEDGE BASE:
${kb}`;

// In-memory per-token rate limiting (resets on restart — fine for a single-process
// deploy; move to Redis if you ever run multiple server instances)
const RATE_LIMIT = parseInt(process.env.RATE_LIMIT_PER_MINUTE || '20', 10);
const hits = new Map(); // token -> [timestamps]

function isRateLimited(token) {
  const now = Date.now();
  const windowStart = now - 60_000;
  const arr = (hits.get(token) || []).filter(t => t > windowStart);
  arr.push(now);
  hits.set(token, arr);
  return arr.length > RATE_LIMIT;
}

router.post('/chat', async (req, res) => {
  try {
    const { token, message, history = [] } = req.body;
    if (!token || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'token and message are required' });
    }

    const bot = await db.prepare('SELECT * FROM bots WHERE token = ? AND is_active = 1').get(token);
    if (!bot) {
      return res.status(404).json({ error: 'Unknown or inactive bot token' });
    }

    if (isRateLimited(token)) {
      return res.status(429).json({ error: 'This bot is receiving too many requests. Try again shortly.' });
    }

    // Log the question — this is what powers the Analytics dashboard, server-side now
    await db.prepare('INSERT INTO questions (bot_token, question, visitor_id) VALUES (?, ?, ?)')
      .run(token, message.slice(0, 500), req.body.visitorId || null);

    // Track daily usage per bot (so you can cap free-tier clients later if needed)
    const today = new Date().toISOString().slice(0, 10);
    await db.prepare(`
      INSERT INTO usage_daily (bot_token, day, request_count) VALUES (?, ?, 1)
      ON CONFLICT(bot_token, day) DO UPDATE SET request_count = usage_daily.request_count + 1
    `).run(token, today);

    // Build the conversation for Groq — last 4 turns of history + the new message
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT(bot.site_name || bot.name, bot.knowledge_base || '') },
      ...history.slice(-4),
      { role: 'user', content: message }
    ];

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}` // ← never sent to the browser, stays here
      },
      body: JSON.stringify({ model: MODEL, messages, max_tokens: 450, temperature: 0.4 })
    });

    if (!groqRes.ok) {
      const errBody = await groqRes.text();
      console.error('Groq error:', groqRes.status, errBody);
      return res.status(502).json({ error: 'Upstream AI provider error. Try again.' });
    }

    const data = await groqRes.json();
    const raw = data.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";
    const { text, suggestions } = parseSuggestions(raw);

    res.json({
      reply: text,
      suggestions,
      unsure: isUnsure(text) // tells the widget whether to offer "Talk to a Human"
    });
  } catch (err) {
    console.error('Chat route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Called when a visitor uses "Talk to a Human" in the widget, and for every
// message they send afterward. Doesn't touch Groq — just logs the message
// into a real per-visitor conversation thread (human_messages), so multiple
// messages from the same visitor stay grouped together instead of looking
// like separate unrelated people, and so an agent's reply can actually be
// delivered back.
router.post('/human-message', async (req, res) => {
  try {
    const { token, message, visitorId } = req.body;
    if (!token || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'token and message are required' });
    }
    if (!visitorId || typeof visitorId !== 'string') {
      return res.status(400).json({ error: 'visitorId is required' });
    }

    const bot = await db.prepare('SELECT token FROM bots WHERE token = ? AND is_active = 1').get(token);
    if (!bot) {
      return res.status(404).json({ error: 'Unknown or inactive bot token' });
    }

    if (isRateLimited(token)) {
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }

    await db.prepare('INSERT INTO human_messages (bot_token, visitor_id, sender, message) VALUES (?, ?, ?, ?)')
      .run(token, visitorId, 'visitor', message.slice(0, 1000));

    const today = new Date().toISOString().slice(0, 10);
    await db.prepare(`
      INSERT INTO usage_daily (bot_token, day, request_count) VALUES (?, ?, 1)
      ON CONFLICT(bot_token, day) DO UPDATE SET request_count = usage_daily.request_count + 1
    `).run(token, today);

    res.json({ ack: true });
  } catch (err) {
    console.error('Human-message route error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// PUBLIC — the widget polls this every few seconds while in human mode, to
// pick up any reply an agent sends from the dashboard. No admin secret
// needed: visitorId itself is an unguessable per-browser random string (see
// embed.js), so knowing it is equivalent to being that visitor.
router.get('/human-messages/:token/:visitorId', async (req, res) => {
  try {
    const { token, visitorId } = req.params;
    const rows = await db.prepare(
      'SELECT sender, message, created_at FROM human_messages WHERE bot_token = ? AND visitor_id = ? ORDER BY created_at ASC, id ASC'
    ).all(token, visitorId);
    res.json({ messages: rows });
  } catch (err) {
    console.error('Human-messages poll error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;