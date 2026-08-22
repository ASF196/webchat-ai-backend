// scripts/restore.js
// Restores a backup (from scripts/backup.js) into whatever DATABASE_URL
// points at right now. Meant to be run against a BRAND NEW, empty Postgres
// database — e.g. right after creating a fresh free Render Postgres instance
// to replace one that's about to expire.
//
// Usage:
//   DATABASE_URL="postgresql://...new-db..." node scripts/restore.js
//   DATABASE_URL="..." node scripts/restore.js backups/some-older-backup.json

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set — point it at the NEW database you want to restore into.');
  process.exit(1);
}

const backupPath = process.argv[2] || path.join(__dirname, '..', 'backups', 'latest.json');
if (!fs.existsSync(backupPath)) {
  console.error(`Backup file not found: ${backupPath}`);
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function main() {
  const backup = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
  console.log(`Restoring backup from ${backup.backedUpAt} (${backup.bots.length} bot(s), ${backup.questions.length} question(s))`);

  // Same schema as db/index.js's init() — kept in sync manually since this
  // script needs to run standalone, before the main app has necessarily
  // touched this database yet.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bots (
      token          TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      site_url       TEXT,
      site_name      TEXT,
      color_grad     TEXT,
      icon_key       TEXT,
      icon_data_url  TEXT,
      greeting       TEXT,
      knowledge_base TEXT,
      owner_email    TEXT,
      created_at     TEXT DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
      is_active      INTEGER DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS questions (
      id          SERIAL PRIMARY KEY,
      bot_token   TEXT NOT NULL REFERENCES bots(token),
      question    TEXT NOT NULL,
      asked_at    TEXT DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
      visitor_id  TEXT,
      is_human_request  BOOLEAN DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_questions_bot ON questions(bot_token);
    CREATE INDEX IF NOT EXISTS idx_questions_time ON questions(asked_at);
    ALTER TABLE questions ADD COLUMN IF NOT EXISTS is_human_request BOOLEAN DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS usage_daily (
      bot_token     TEXT NOT NULL REFERENCES bots(token),
      day           TEXT NOT NULL,
      request_count INTEGER DEFAULT 0,
      PRIMARY KEY (bot_token, day)
    );
    CREATE TABLE IF NOT EXISTS human_messages (
      id             SERIAL PRIMARY KEY,
      bot_token      TEXT NOT NULL REFERENCES bots(token),
      visitor_id     TEXT NOT NULL,
      sender         TEXT NOT NULL CHECK (sender IN ('visitor','agent')),
      message        TEXT NOT NULL,
      created_at     TEXT DEFAULT (to_char(NOW(), 'YYYY-MM-DD HH24:MI:SS')),
      read_by_agent  BOOLEAN DEFAULT FALSE
    );
    CREATE INDEX IF NOT EXISTS idx_human_msg_bot ON human_messages(bot_token);
    CREATE INDEX IF NOT EXISTS idx_human_msg_visitor ON human_messages(bot_token, visitor_id);
    CREATE INDEX IF NOT EXISTS idx_human_msg_time ON human_messages(created_at);
  `);

  // Bots first — questions/usage_daily reference bot tokens via foreign key.
  for (const bot of backup.bots) {
    await pool.query(
      `INSERT INTO bots (token, name, site_url, site_name, color_grad, icon_key, icon_data_url, greeting, knowledge_base, owner_email, created_at, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (token) DO NOTHING`,
      [bot.token, bot.name, bot.site_url, bot.site_name, bot.color_grad, bot.icon_key,
       bot.icon_data_url, bot.greeting, bot.knowledge_base, bot.owner_email, bot.created_at, bot.is_active]
    );
  }

  for (const q of backup.questions) {
    await pool.query(
      `INSERT INTO questions (id, bot_token, question, asked_at, visitor_id, is_human_request)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO NOTHING`,
      [q.id, q.bot_token, q.question, q.asked_at, q.visitor_id, q.is_human_request || false]
    );
  }
  // Since we just inserted explicit ids into a SERIAL column, bump the
  // sequence forward — otherwise the next real question logged would try to
  // reuse an id that's already taken and fail.
  if (backup.questions.length) {
    await pool.query(`SELECT setval('questions_id_seq', (SELECT COALESCE(MAX(id), 1) FROM questions))`);
  }

  for (const u of backup.usageDaily) {
    await pool.query(
      `INSERT INTO usage_daily (bot_token, day, request_count)
       VALUES ($1,$2,$3)
       ON CONFLICT (bot_token, day) DO NOTHING`,
      [u.bot_token, u.day, u.request_count]
    );
  }

  for (const m of (backup.humanMessages || [])) {
    await pool.query(
      `INSERT INTO human_messages (id, bot_token, visitor_id, sender, message, created_at, read_by_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (id) DO NOTHING`,
      [m.id, m.bot_token, m.visitor_id, m.sender, m.message, m.created_at, m.read_by_agent || false]
    );
  }
  if (backup.humanMessages && backup.humanMessages.length) {
    await pool.query(`SELECT setval('human_messages_id_seq', (SELECT COALESCE(MAX(id), 1) FROM human_messages))`);
  }

  console.log('Restore complete. Bot tokens are unchanged — existing embed <script> tags will keep working.');
  await pool.end();
}

main().catch(err => {
  console.error('Restore failed:', err);
  process.exit(1);
});
