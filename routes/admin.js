// routes/admin.js
// ADMIN endpoints — used by YOUR WebChat AI dashboard (not by client websites).
// These should be locked down in production (see requireAdmin middleware below).

const express = require('express');
const { nanoid } = require('nanoid');
const { prepare: dbPrepare } = require('../db');
const db = { prepare: dbPrepare };
const router = express.Router();

// Very simple shared-secret check. Swap for real auth (sessions/JWT/OAuth)
// before letting real customers log in to create their own bots.
function requireAdmin(req, res, next) {
  const provided = req.headers['x-admin-secret'];
  if (!provided || provided !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Create a new trained bot → returns the token to embed
router.post('/bots', requireAdmin, async (req, res) => {
  try {
    const { name, siteUrl, siteName, colorGrad, iconKey, iconDataUrl, greeting, knowledgeBase, ownerEmail } = req.body;
    if (!knowledgeBase) return res.status(400).json({ error: 'knowledgeBase is required' });

    const token = 'sp_' + nanoid(24);
    await db.prepare(`
      INSERT INTO bots (token, name, site_url, site_name, color_grad, icon_key, icon_data_url, greeting, knowledge_base, owner_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(token, name || 'WebChat AI', siteUrl || null, siteName || null, colorGrad || null,
           iconKey || 'bot', iconDataUrl || null, greeting || "Hi! Ask me anything about this site.",
           knowledgeBase, ownerEmail || null);

    res.json({ token });
  } catch (err) {
    console.error('Create bot error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update an existing bot's config (re-train, change name/color/etc)
router.patch('/bots/:token', requireAdmin, async (req, res) => {
  try {
    const { token } = req.params;
    const bot = await db.prepare('SELECT token FROM bots WHERE token = ?').get(token);
    if (!bot) return res.status(404).json({ error: 'Bot not found' });

    const fields = ['name', 'site_url', 'site_name', 'color_grad', 'icon_key', 'icon_data_url', 'greeting', 'knowledge_base', 'is_active'];
    const updates = [];
    const values = [];
    const bodyKeyMap = { siteUrl: 'site_url', siteName: 'site_name', colorGrad: 'color_grad', iconKey: 'icon_key', iconDataUrl: 'icon_data_url', knowledgeBase: 'knowledge_base', isActive: 'is_active' };

    for (const [bodyKey, val] of Object.entries(req.body)) {
      const col = bodyKeyMap[bodyKey] || (fields.includes(bodyKey) ? bodyKey : null);
      if (col) { updates.push(`${col} = ?`); values.push(val); }
    }
    if (!updates.length) return res.status(400).json({ error: 'No valid fields to update' });

    await db.prepare(`UPDATE bots SET ${updates.join(', ')} WHERE token = ?`).run(...values, token);
    res.json({ ok: true });
  } catch (err) {
    console.error('Update bot error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List all bots (for your own admin overview)
router.get('/bots', requireAdmin, async (req, res) => {
  try {
    const bots = await db.prepare('SELECT token, name, site_name, owner_email, created_at, is_active FROM bots ORDER BY created_at DESC').all();
    res.json({ bots });
  } catch (err) {
    console.error('List bots error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a bot and its question history
router.delete('/bots/:token', requireAdmin, async (req, res) => {
  try {
    const { token } = req.params;
    await db.prepare('DELETE FROM questions WHERE bot_token = ?').run(token);
    await db.prepare('DELETE FROM usage_daily WHERE bot_token = ?').run(token);
    await db.prepare('DELETE FROM human_messages WHERE bot_token = ?').run(token);
    const result = await db.prepare('DELETE FROM bots WHERE token = ?').run(token);
    if (result.changes === 0) return res.status(404).json({ error: 'Bot not found' });
    res.json({ ok: true });
  } catch (err) {
    console.error('Delete bot error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
