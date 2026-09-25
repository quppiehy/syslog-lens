const sequelize = require('./db');
const { PORT, JWT_SECRET, validateJwtSecret, validateInviteCodeConfig } = require('./config');
const app = require('./app');

async function start() {
  try {
    validateJwtSecret(JWT_SECRET);
    validateInviteCodeConfig();
  } catch (err) {
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
    return;
  }

  try {
    await sequelize.authenticate();
    await sequelize.sync(); // no force/alter — creates tables only if missing
    app.listen(PORT, () => {
      console.log(`Syslog Lens backend listening on port ${PORT}`);
    });
  } catch (err) {
    console.error('Failed to start server:', err);
    process.exit(1);
  }
}

start();
