// routes/inbox.js
// ADMIN endpoints — used by your dashboard's Inbox page (not by visitor sites).
// Groups human_messages by visitor_id into real conversation threads, and
// lets an agent actually reply — the piece that was missing when this was
// still just flat rows in the questions table.

const express = require('express');
const { prepare: dbPrepare } = require('../db');
const db = { prepare: dbPrepare };
const router = express.Router();

function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// List every visitor who's messaged this bot, most recent first, each with
// their latest message + how many of their messages are still unread.
router.get('/human-conversations/:token', requireAdmin, async (req, res) => {
  try {
    const { token } = req.params;
    const rows = await db.prepare(`
      SELECT visitor_id,
             MAX(created_at) AS last_message_at,
             COUNT(*) FILTER (WHERE sender='visitor' AND read_by_agent=false) AS unread_count
      FROM human_messages
      WHERE bot_token = ?
      GROUP BY visitor_id
      ORDER BY last_message_at DESC
    `).all(token);

    // Grab the actual latest message text per visitor too (last_message_at
    // alone doesn't give us the content) — one extra query, but this list is
    // small in practice and only loads when the Inbox is opened.
    const conversations = [];
    for (const row of rows) {
      const last = await db.prepare(
        'SELECT sender, message, created_at FROM human_messages WHERE bot_token = ? AND visitor_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
      ).get(token, row.visitor_id);
      conversations.push({
        visitorId: row.visitor_id,
        lastMessageAt: row.last_message_at,
        unreadCount: parseInt(row.unread_count, 10) || 0,
        lastMessage: last ? last.message : '',
        lastSender: last ? last.sender : 'visitor',
      });
    }
    res.json({ conversations });
  } catch (err) {
    console.error('List human-conversations error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Full thread for one visitor — also marks their messages as read, since
// opening the conversation is what "read" means here.
router.get('/human-conversations/:token/:visitorId', requireAdmin, async (req, res) => {
  try {
    const { token, visitorId } = req.params;
    const messages = await db.prepare(
      'SELECT sender, message, created_at FROM human_messages WHERE bot_token = ? AND visitor_id = ? ORDER BY created_at ASC, id ASC'
    ).all(token, visitorId);

    await db.prepare(
      'UPDATE human_messages SET read_by_agent = true WHERE bot_token = ? AND visitor_id = ? AND sender = ?'
    ).run(token, visitorId, 'visitor');

    res.json({ messages });
  } catch (err) {
    console.error('Get human-conversation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Agent sends a reply — the visitor's widget picks this up on its next poll.
router.post('/human-reply', requireAdmin, async (req, res) => {
  try {
    const { token, visitorId, message } = req.body;
    if (!token || !visitorId || !message || typeof message !== 'string') {
      return res.status(400).json({ error: 'token, visitorId, and message are required' });
    }
    const bot = await db.prepare('SELECT token FROM bots WHERE token = ?').get(token);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    await db.prepare('INSERT INTO human_messages (bot_token, visitor_id, sender, message) VALUES (?, ?, ?, ?)')
      .run(token, visitorId, 'agent', message.slice(0, 1000));

    res.json({ ok: true });
  } catch (err) {
    console.error('Human-reply error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
