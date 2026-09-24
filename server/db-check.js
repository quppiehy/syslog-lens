// Tiny verification script: opens the SQLite DB and prints the users table
// columns. Useful on Windows where the sqlite3 CLI usually isn't installed.
const sequelize = require('./db');
require('./models/user');

async function main() {
  try {
    await sequelize.authenticate();
    console.log('Connected to DB at:', sequelize.options.storage);

    const [columns] = await sequelize.query('PRAGMA table_info(users);');
    if (!columns.length) {
      console.log('No "users" table found. Has the server been started yet (it runs sync() on boot)?');
    } else {
      console.log('Columns in "users" table:');
      columns.forEach((col) => {
        console.log(`  - ${col.name} (${col.type})${col.notnull ? ' NOT NULL' : ''}${col.pk ? ' PRIMARY KEY' : ''}`);
      });
    }
  } catch (err) {
    console.error('DB check failed:', err);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
