// Sequelize connection setup (SQLite via the sqlite3 driver).
const fs = require('fs');
const path = require('path');
const { Sequelize } = require('sequelize');
const { DB_STORAGE } = require('./config');

// Make sure the directory that will hold the SQLite file exists.
const dbDir = path.dirname(DB_STORAGE);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const sequelize = new Sequelize({
  dialect: 'sqlite',
  dialectModule: require('sqlite3'),
  storage: DB_STORAGE,
  logging: false,
});

module.exports = sequelize;
