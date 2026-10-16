/**
 * ============================================================================
 * FILE: models/AuditLog.js
 * ARCHITECTURAL LAYER: Model Layer (Immutable Security & Transaction Log Schema)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Records every critical security event (logins, MFA verifications, unauthorized
 * RBAC attempts) and clinical transaction (patient registrations, Category III
 * triage, vaccine dose deductions).
 *
 * ACADEMIC DEFENSE TALKING POINTS:
 * 1. Non-Repudiation & Compliance (Modules 05, 06 & 13):
 *    Every state-changing action in the clinic is tied to an `actorId`,
 *    `actorRole`, `ipAddress`, and `timestamp`. Staff cannot deny performing
 *    an action, and SuperAdmins can audit suspicious activity.
 * 2. PySpark Big Data Source:
 *    Our Apache PySpark ETL pipeline (`pyspark_etl/etl_analytics.py`) extracts
 *    structured transaction logs from this collection alongside `Patient` and
 *    `Inventory` to compute vaccine burn rates, walk-in trends, and Category III
 *    bite anomalies without slowing down operational tables.
 * ============================================================================
 */

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null, // Null only for failed unauthenticated login attempts
      index: true,
    },

    actorRole: {
      type: String,
      enum: ['SuperAdmin', 'Receptionist', 'Physician', 'Unauthenticated', 'System'],
      default: 'System',
      index: true,
    },

    actionType: {
      type: String,
      required: [true, 'Audit action type identifier is required.'],
      trim: true,
      index: true,
      // Examples:
      // 'AUTH_STEP1_PASSWORD_OK', 'AUTH_STEP2_MFA_VERIFIED', 'AUTH_LOGIN_FAILED',
      // 'RBAC_ACCESS_DENIED', 'PATIENT_WALKIN_REGISTERED', 'CLINICAL_TRIAGE_COMPLETED',
      // 'VACCINE_DOSE_ADMINISTERED', 'INVENTORY_BATCH_ADDED'
    },

    targetCollection: {
      type: String,
      enum: ['User', 'Patient', 'Inventory', 'AuthSession'],
      required: true,
    },

    targetDocumentId: {
      type: mongoose.Schema.Types.ObjectId,
      default: null,
    },

    description: {
      type: String,
      required: true,
      trim: true,
    },

    ipAddress: {
      type: String,
      default: '127.0.0.1',
    },

    // Structured JSON payload used by PySpark ETL for fast aggregation
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },

    timestamp: {
      type: Date,
      default: Date.now,
      index: true, // Indexed descending for time-series queries and PySpark date filtering
    },
  },
  {
    // Disable `updatedAt` because audit logs are append-only / immutable records
    timestamps: { createdAt: 'timestamp', updatedAt: false },
  }
);

// Compound index for PySpark time-window extraction by action type
auditLogSchema.index({ actionType: 1, timestamp: -1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
