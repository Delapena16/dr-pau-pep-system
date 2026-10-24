const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema(
  {
    vaccineType: {
      type: String,
      enum: ['anti-rabies', 'anti-tetanus', 'ERIG'],
      required: [true, 'Vaccine type must be anti-rabies, anti-tetanus, or ERIG'],
      index: true
    },
    brandName: {
      type: String,
      required: [true, 'Brand name is required'],
      trim: true
    },
    batchNumber: {
      type: String,
      required: [true, 'Batch number is required'],
      unique: true,
      uppercase: true,
      trim: true
    },
    // ito yung bilang ng vials sa ref ng clinic
    currentStock: {
      type: Number,
      required: [true, 'Current vial stock count is required'],
      min: [0, 'Stock cannot be negative']
    },
    lowStockThreshold: {
      type: Number,
      default: 10
    },
    expirationDate: {
      type: Date,
      required: [true, 'Expiration date is required'],
      index: true
    },
    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    events: [
      {
        eventType: {
          type: String,
          enum: ['RESTOCKED', 'DOSE_DISPENSED', 'SPOILAGE_WRITE_OFF', 'CLERICAL_VOID'],
          default: 'SPOILAGE_WRITE_OFF'
        },
        vialsDeducted: {
          type: Number,
          required: true
        },
        reason: {
          type: String,
          required: true,
          trim: true
        },
        timestamp: {
          type: Date,
          default: Date.now
        },
        performedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
          default: null
        },
        actorRole: {
          type: String,
          default: 'SuperAdmin'
        }
      }
    ]
  },
  {
    timestamps: true
  }
);

inventorySchema.index({ batchLotId: 1 }, { sparse: true });

module.exports = mongoose.model('Inventory', inventorySchema);
