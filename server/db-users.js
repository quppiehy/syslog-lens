// Verification script for Stage 2 registration: lists stored users and
// shows that passwordHash is present and not the plaintext password,
// without ever printing the full hash (only its length and a short prefix).
const sequelize = require('./db');
const User = require('./models/user');

async function main() {
  try {
    await sequelize.authenticate();
    console.log('Connected to DB at:', sequelize.options.storage);

    const users = await User.findAll({
      attributes: ['id', 'name', 'employeeNumber', 'passwordHash', 'createdAt'],
      order: [['id', 'ASC']],
    });

    if (!users.length) {
      console.log('No users found.');
      return;
    }

    console.log(`Found ${users.length} user(s):\n`);
    users.forEach((user) => {
      const hash = user.passwordHash || '';
      const hashPreview = `${hash.slice(0, 12)}... (length ${hash.length})`;
      console.log(`  id: ${user.id}`);
      console.log(`  name: ${user.name}`);
      console.log(`  employeeNumber: ${user.employeeNumber}`);
      console.log(`  createdAt: ${user.createdAt}`);
      console.log(`  passwordHash: ${hashPreview}`);
      console.log('');
    });
  } catch (err) {
    console.error('db:users failed:', err);
    process.exitCode = 1;
  } finally {
    await sequelize.close();
  }
}

main();
