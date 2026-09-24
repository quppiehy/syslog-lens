const { DataTypes } = require('sequelize');
const sequelize = require('../db');

const User = sequelize.define(
  'User',
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    employeeNumber: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
  },
  {
    tableName: 'users',
    timestamps: true, // adds createdAt / updatedAt
  }
);

// Safety net: even if a route accidentally serializes a full model instance
// (e.g. via res.json(user)), passwordHash must never leak into a response.
User.prototype.toJSON = function toJSON() {
  const values = { ...this.get() };
  delete values.passwordHash;
  return values;
};

module.exports = User;
