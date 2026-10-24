const mongoose = require('mongoose');

// Global system configuration (SuperAdmin-managed).
const systemSettingsSchema = new mongoose.Schema(
  {
    inactivityTimeoutMinutes: {
      type: Number,
      default: 15,
      min: 1,
      max: 120
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('SystemSettings', systemSettingsSchema);
