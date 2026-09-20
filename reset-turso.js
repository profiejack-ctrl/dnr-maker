const { createClient } = require('@libsql/client');

if (process.env.RESET_DNR_DATABASE !== '1') {
  console.error('Refusing to reset. Set RESET_DNR_DATABASE=1 to confirm.');
  process.exit(1);
}

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required.');
  process.exit(1);
}

(async () => {
  const db = createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN
  });

  await db.batch([
    'DROP TABLE IF EXISTS dnr_history',
    'DROP TABLE IF EXISTS dnr_drafts'
  ]);

  console.log('DNR Turso tables reset. They will be recreated automatically on the next request.');
})().catch(error => {
  console.error(error.message);
  process.exit(1);
});
