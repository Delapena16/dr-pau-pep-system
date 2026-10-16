/**
 * ============================================================================
 * FILE: models/Inventory.js
 * ARCHITECTURAL LAYER: Model Layer (Vaccine & RIG Cold-Chain Inventory Schema)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Tracks biological stock levels at Dr. Pau Animal Bite Center, including
 * Anti-Rabies Vaccines (ARV), Rabies Immunoglobulin (RIG), and Tetanus Toxoid.
 *
 * ACADEMIC DEFENSE TALKING POINTS:
 * 1. FEFO (First Expired, First Out) Indexing:
 *    Vaccines are temperature-sensitive biologics with strict expiration dates.
 *    We index `expirationDate` in ascending order (`1`) alongside `remainingDoses`
 *    so that when a Physician administers a shot, the system automatically
 *    deducts from the earliest-expiring valid batch first.
 * 2. Multi-Dose Vial Accounting:
 *    In intradermal (ID) PEP regimens, 1 vial typically yields multiple patient
 *    doses. Tracking both `vialQuantity` and `remainingDoses` prevents stock
 *    discrepancies and feeds accurate burn-rate data into our PySpark forecast.
 * ============================================================================
 */

const mongoose = require('mongoose');

const inventorySchema = new mongoose.Schema(
  {
    itemName: {
      type: String,
      required: [true, 'Vaccine or biologic name is required (e.g., Verorab, Speeda, Equirab).'],
      trim: true,
      index: true,
    },

    itemCategory: {
      type: String,
      enum: {
        values: [
          'Anti-Rabies Vaccine (ARV)',
          'Rabies Immunoglobulin (RIG)',
          'Tetanus Toxoid',
          'Medical Consumable',
        ],
        message: 'Invalid inventory category.',
      },
      required: [true, 'Item category is required.'],
      index: true,
    },

    batchNumber: {
      type: String,
      required: [true, 'Manufacturer lot/batch number is required for traceability.'],
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },

    manufacturer: {
      type: String,
      default: 'Sanofi Pasteur / Bharat Biotech',
      trim: true,
    },

    vialQuantity: {
      type: Number,
      required: [true, 'Initial number of vials is required.'],
      min: [0, 'Vial quantity cannot be negative.'],
    },

    dosesPerVial: {
      type: Number,
      default: 5, // Standard intradermal doses yielded per reconstituted vial
      min: [1, 'Must yield at least 1 dose per vial.'],
    },

    remainingDoses: {
      type: Number,
      required: [true, 'Remaining available doses count is required.'],
      min: [0, 'Remaining doses cannot be negative.'],
      index: true,
    },

    reorderThresholdDoses: {
      type: Number,
      default: 25, // Triggers low-stock warning when remainingDoses <= 25
    },

    expirationDate: {
      type: Date,
      required: [true, 'Expiration date is mandatory for cold-chain biologics.'],
      index: true, // Indexed for FEFO (First Expired, First Out) automatic deduction
    },

    storageTemperatureCelsius: {
      type: String,
      default: '2°C to 8°C (Cold-Chain Refrigerator)',
    },

    lastUpdatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

// Virtual property to automatically flag low-stock batches in API responses
inventorySchema.virtual('isLowStock').get(function () {
  return this.remainingDoses <= this.reorderThresholdDoses;
});

// Virtual property to automatically flag expired batches in API responses
inventorySchema.virtual('isExpired').get(function () {
  return new Date() > this.expirationDate;
});

// Compound index optimized for FEFO (First Expired, First Out) batch lookup
inventorySchema.index({
  itemCategory: 1,
  expirationDate: 1,
  remainingDoses: 1,
});

module.exports = mongoose.model('Inventory', inventorySchema);
