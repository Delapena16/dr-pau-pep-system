const SystemSettings = require('../models/SystemSettings');
const { logActivity, AUDIT_EVENTS } = require('../utils/logger');

const SETTINGS_UPDATED = 'SETTINGS_UPDATED';

// Ensures a default settings document exists (lazy init).
const ensureSettings = async () => {
  let settings = await SystemSettings.findOne();
  if (!settings) {
    settings = await SystemSettings.create({ inactivityTimeoutMinutes: 15 });
  }
  return settings;
};

const getSettings = async (req, res) => {
  try {
    const settings = await ensureSettings();
    return res.status(200).json({
      success: true,
      message: 'System settings retrieved.',
      data: {
        inactivityTimeoutMinutes: settings.inactivityTimeoutMinutes
      }
    });
  } catch (error) {
    console.error('Get settings error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to load system settings.'
    });
  }
};

const updateSettings = async (req, res) => {
  try {
    const timeout = Number(req.body.timeout);
    if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) {
      return res.status(400).json({
        success: false,
        message: 'Timeout must be a number between 1 and 120 minutes.'
      });
    }

    const settings = await ensureSettings();
    const previous = settings.inactivityTimeoutMinutes;
    settings.inactivityTimeoutMinutes = timeout;
    await settings.save();

    const actorUser = req.authenticatedUser || req.user || { role: 'SuperAdmin', userId: null };

    await logActivity(
      actorUser.role,
      SETTINGS_UPDATED,
      `Adjusted system inactivity timeout to ${timeout} minutes`,
      {
        actorId: actorUser.userId,
        ipAddress: req.ip || '127.0.0.1',
        targetCollection: 'Dashboard',
        metadata: { previousTimeout: previous, newTimeout: timeout }
      }
    );

    return res.status(200).json({
      success: true,
      message: `Inactivity timeout updated to ${timeout} minutes.`,
      data: {
        inactivityTimeoutMinutes: settings.inactivityTimeoutMinutes
      }
    });
  } catch (error) {
    console.error('Update settings error:', error.message);
    return res.status(500).json({
      success: false,
      message: 'Failed to update system settings.'
    });
  }
};

module.exports = { getSettings, updateSettings, ensureSettings };
