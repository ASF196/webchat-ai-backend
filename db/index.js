// db/index.js
// Postgres-backed (via Render's free Postgres, or any Postgres URL). Uses the
// `pg` package and a connection pool — appropriate for a web server handling
// concurrent requests, unlike a single-file SQLite database.
//
// IMPORTANT DIFFERENCE FROM THE OLD SQLITE VERSION: Postgres is accessed over
// the network, so every query is asynchronous now. The `prepare(sql)` shim
// below keeps the same `.get()/.all()/.run()` shape the route files already
// use, but each of those methods now returns a Promise — every call site
// needs `await` in front of it, and every route handler needs to be `async`.
//
// This shim also auto-translates SQLite-style `?` placeholders to Postgres's
// `$1, $2, ...` style, so the actual SQL strings in the route files didn't
// need to change — only adding `await` did.

const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Set it to your Render Postgres connection string.');
}

const pool = new Pool({
  connectionString,
  // Render's free Postgres (and most managed Postgres providers) require SSL,
  // but present a certificate that isn't in Node's default trusted CA list —
  // rejectUnauthorized:false accepts that. This is standard for these
  // providers' free/starter tiers, not a security downgrade specific to us.
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

// Converts 'SELECT * FROM x WHERE a = ? AND b = ?' into
// 'SELECT * FROM x WHERE a = $1 AND b = $2' — lets route files keep using
// the same `?` placeholders they always did.
function toPgSql(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

function prepare(sql) {
  const pgSql = toPgSql(sql);
  return {
    async get(...params) {
      const { rows } = await pool.query(pgSql, params);
      return rows[0] || undefined;
    },
    async all(...params) {
      const { rows } = await pool.query(pgSql, params);
      return rows;
    },
    async run(...params) {
      const result = await pool.query(pgSql, params);
      // .changes mirrors what the old sqlite wrapper returned, since
      // routes/admin.js checks result.changes === 0 to detect "not found".
      return { changes: result.rowCount };
    },
  };
}

// Creates the schema if it doesn't exist yet. server.js awaits this once,
// before accepting any requests — there's no synchronous schema setup like
// there was with node:sqlite, since every query here goes over the network.
async function init() {
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

    -- Real human-handoff conversations, grouped by visitor_id so multiple
    -- messages from the same visitor become one thread instead of looking
    -- like separate unrelated people. Supports replies going the other way
    -- too (sender='agent'), which questions.is_human_request never could.
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
}

module.exports = { prepare, init, pool };
