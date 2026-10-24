const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    actorId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    actorRole: {
      type: String,
      enum: ['SuperAdmin', 'Receptionist', 'Physician', 'System', 'Unauthenticated'],
      default: 'System'
    },
    actionType: {
      type: String,
      required: true,
      trim: true,
      index: true
    },
    targetCollection: {
      type: String,
      enum: ['User', 'Patient', 'Inventory', 'AuthSession', 'Export', 'Dashboard'],
      required: true
    },
    description: {
      type: String,
      required: true,
      trim: true
    },
    ipAddress: {
      type: String,
      default: '127.0.0.1'
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    timestamp: {
      type: Date,
      default: Date.now,
      index: true
    }
  },
  {
    timestamps: { createdAt: 'timestamp', updatedAt: false }
  }
);

module.exports = mongoose.model('AuditLog', auditLogSchema);
