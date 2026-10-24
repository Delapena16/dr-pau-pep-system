const mongoose = require('mongoose');
const AuditLog = require('../models/AuditLog');

/**
 * Universal audit events captured across the whole clinic system.
 * These are the canonical actionType values written to the AuditLog collection.
 */
const AUDIT_EVENTS = {
  // Patient actions
  PATIENT_REGISTERED: 'PATIENT_REGISTERED',
  DOSE_ADMINISTERED: 'DOSE_ADMINISTERED',
  TRIAGE_UPDATED: 'TRIAGE_UPDATED',

  // Inventory actions
  VIAL_RESTOCKED: 'VIAL_RESTOCKED',
  STOCK_WRITTEN_OFF: 'STOCK_WRITTEN_OFF',

  // Data privacy actions (critical - RA 10173)
  EXPORT_MASKED: 'EXPORT_MASKED',
  EXPORT_UNMASKED: 'EXPORT_UNMASKED'
};

const VALID_ROLES = ['SuperAdmin', 'Receptionist', 'Physician', 'System', 'Unauthenticated'];
const VALID_TARGETS = ['User', 'Patient', 'Inventory', 'AuthSession', 'Export', 'Dashboard'];

/**
 * logActivity(role, event, details[, options])
 *
 * Records one activity in the audit trail. This helper never throws, so a
 * logging failure can never break the main request flow.
 *
 * @param {string} role      Actor role (SuperAdmin | Receptionist | Physician | System)
 * @param {string} event     Action type, e.g. AUDIT_EVENTS.DOSE_ADMINISTERED
 * @param {string} details   Human readable description stored in the trail
 * @param {object} [options] Optional: { actorId, ipAddress, targetCollection, metadata }
 * @returns {Promise<object|null>} The created audit entry, or null when it failed
 */
const logActivity = async (role, event, details, options = {}) => {
  try {
    const actorRole = VALID_ROLES.includes(role) ? role : 'System';
    const targetCollection = VALID_TARGETS.includes(options.targetCollection)
      ? options.targetCollection
      : 'AuthSession';
    const actorId =
      options.actorId && mongoose.Types.ObjectId.isValid(options.actorId) ? options.actorId : null;

    const entry = await AuditLog.create({
      actorId,
      actorRole,
      actionType: String(event || 'SYSTEM_EVENT').trim(),
      targetCollection,
      description: String(details || event || '').trim() || 'Activity recorded.',
      ipAddress: options.ipAddress || '127.0.0.1',
      metadata: options.metadata || {}
    });

    return entry;
  } catch (err) {
    // Audit logging is best-effort: log the failure but never break the request.
    console.warn('[AUDIT] Failed to record activity:', err.message);
    return null;
  }
};

module.exports = { logActivity, AUDIT_EVENTS };
