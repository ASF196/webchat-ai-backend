// scripts/backup.js
// Dumps every table's full contents to a single JSON file. Run manually
// anytime, or on a schedule via .github/workflows/backup.yml. The restore
// script (scripts/restore.js) reads this same file to rebuild a fresh
// database with IDENTICAL bot tokens — so every embed <script> tag your
// clients already pasted keeps working after a restore, unchanged.

const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({
  connectionString,
  ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: false },
});

async function main() {
  const [bots, questions, usageDaily, humanMessages] = await Promise.all([
    pool.query('SELECT * FROM bots'),
    pool.query('SELECT * FROM questions'),
    pool.query('SELECT * FROM usage_daily'),
    pool.query('SELECT * FROM human_messages'),
  ]);

  const backup = {
    backedUpAt: new Date().toISOString(),
    bots: bots.rows,
    questions: questions.rows,
    usageDaily: usageDaily.rows,
    humanMessages: humanMessages.rows,
  };

  const outDir = path.join(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'latest.json');
  fs.writeFileSync(outPath, JSON.stringify(backup, null, 2));

  console.log(`Backed up ${bots.rows.length} bot(s), ${questions.rows.length} question(s), ${usageDaily.rows.length} usage_daily row(s), ${humanMessages.rows.length} human message(s) → ${outPath}`);
  await pool.end();
}

main().catch(err => {
  console.error('Backup failed:', err);
  process.exit(1);
});
