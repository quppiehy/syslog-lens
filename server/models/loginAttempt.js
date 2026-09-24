// DB-backed counter used for login/register rate limiting. Storing this in
// the database (instead of an in-process Map) is required because the app
// runs as multiple stateless serverless instances in production — an
// in-memory counter would be per-instance and trivially bypassable.
const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const LoginAttempt = sequelize.define(
  'LoginAttempt',
  {
    key: {
      // e.g. "ip:203.0.113.5" or "emp:EMP-001" or "regip:203.0.113.5"
      type: DataTypes.STRING,
      primaryKey: true,
    },
    failedCount: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    windowStart: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    lockedUntil: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: 'login_attempts',
    timestamps: true,
  }
);

module.exports = LoginAttempt;
