/**
 * ============================================================================
 * FILE: models/Patient.js
 * ARCHITECTURAL LAYER: Model Layer (Patient & Embedded PEP Regimen Schema)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Represents a patient treated at Dr. Pau Animal Bite Center. This schema uses
 * MongoDB's **Embedded Document Architecture** so that a patient's demographic
 * profile, animal bite exposure cases, and 5-dose Post-Exposure Prophylaxis
 * (PEP) schedule (Day 0, Day 3, Day 7, Day 14, Day 28) live inside a single
 * atomic document.
 *
 * ACADEMIC DEFENSE TALKING POINTS:
 * 1. Why Embedded Documents instead of Relational Joins ($lookup)?
 *    When a Physician opens a patient chart or a Receptionist checks today's
 *    vaccination queue, MongoDB retrieves the entire clinical history in ONE
 *    disk read without expensive multi-collection joins.
 * 2. Data Minimization (Privacy by Design):
 *    We only store fields strictly required for rabies PEP clinical management
 *    and barangay-level epidemiological surveillance (no unnecessary government
 *    IDs, financial records, or irrelevant personal history).
 * 3. Strict Field Indexing:
 *    Compound indexes accelerate patient lookups, daily dose queue filtering,
 *    defaulter tracking, and Category III bite anomaly detection.
 * ============================================================================
 */

const mongoose = require('mongoose');

/**
 * SUBDOCUMENT SCHEMA 1: Individual PEP Vaccination Dose (pepDoseSchema)
 * Tracks each scheduled dose in the standard WHO/DOH PEP Regimen:
 * Day 0 (Initial), Day 3, Day 7, Day 14, and Day 28.
 */
const pepDoseSchema = new mongoose.Schema(
  {
    doseLabel: {
      type: String,
      enum: ['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'],
      required: true,
    },

    dayOffset: {
      type: Number,
      enum: [0, 3, 7, 14, 28],
      required: true,
    },

    scheduledDate: {
      type: Date,
      required: true,
      index: true, // Indexed to quickly find patients due today or overdue (defaulters)
    },

    dateAdministered: {
      type: Date,
      default: null,
    },

    status: {
      type: String,
      enum: ['Scheduled', 'Completed', 'Missed / Defaulted'],
      default: 'Scheduled',
      index: true,
    },

    vaccineBrand: {
      type: String,
      default: null,
      trim: true,
    },

    vaccineBatchNumber: {
      type: String,
      default: null,
      trim: true,
    },

    administeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { _id: true }
);

/**
 * SUBDOCUMENT SCHEMA 2: Animal Bite Exposure Case (exposureCaseSchema)
 * Captures the clinical details of an animal bite/scratch incident and holds
 * the embedded `pepSchedule` array of vaccination doses.
 */
const exposureCaseSchema = new mongoose.Schema(
  {
    walkInDate: {
      type: Date,
      default: Date.now,
      index: true, // Indexed for PySpark walk-in trend analysis
    },

    exposureDate: {
      type: Date,
      required: [true, 'Date of animal bite/exposure is required.'],
    },

    animalType: {
      type: String,
      enum: ['Dog', 'Cat', 'Bat', 'Monkey', 'Rat', 'Other'],
      required: [true, 'Animal type is required for rabies risk assessment.'],
    },

    animalOwnershipStatus: {
      type: String,
      enum: ['Pet - Immunized', 'Pet - Unimmunized', 'Stray / Wild'],
      default: 'Stray / Wild',
    },

    biteSite: {
      type: String,
      required: [true, 'Anatomical bite site is required (e.g., Right Hand, Left Leg).'],
      trim: true,
    },

    exposureType: {
      type: String,
      enum: ['Bite', 'Scratch', 'Saliva on Broken Skin', 'Licking of Intact Skin'],
      default: 'Bite',
    },

    // WHO Rabies Exposure Category (set by Physician during triage, or defaulted to Pending)
    whoCategory: {
      type: String,
      enum: ['Pending Assessment', 'Category I', 'Category II', 'Category III'],
      default: 'Pending Assessment',
      index: true, // Indexed for Category III anomaly detection & high-risk filtering
    },

    woundWashingDone: {
      type: Boolean,
      default: false,
    },

    // Rabies Immunoglobulin (RIG) is mandatory for WHO Category III exposures
    rigRequired: {
      type: Boolean,
      default: false,
    },

    rigAdministered: {
      type: Boolean,
      default: false,
    },

    rigBatchNumber: {
      type: String,
      default: null,
      trim: true,
    },

    attendingPhysician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    clinicalNotes: {
      type: String,
      trim: true,
      maxlength: [500, 'Clinical notes cannot exceed 500 characters.'],
      default: '',
    },

    pepStatus: {
      type: String,
      enum: ['Pending Triage', 'Ongoing PEP', 'Completed', 'Defaulted'],
      default: 'Pending Triage',
      index: true,
    },

    // Embedded array of PEP doses (Day 0, Day 3, Day 7, Day 14, Day 28)
    pepSchedule: [pepDoseSchema],
  },
  { timestamps: true }
);

/**
 * MAIN DOCUMENT SCHEMA: Patient Profile (patientSchema)
 * Follows Data Minimization principles: only collects essential identification,
 * contact number for missed-dose follow-up, and barangay for outbreak mapping.
 */
const patientSchema = new mongoose.Schema(
  {
    patientCode: {
      type: String,
      required: true,
      unique: true,
      index: true, // Unique clinic identifier (e.g., "PEP-2026-1001")
    },

    fullName: {
      type: String,
      required: [true, 'Patient full name is required.'],
      trim: true,
      index: true,
    },

    age: {
      type: Number,
      required: [true, 'Patient age is required for pediatric/adult dosage tracking.'],
      min: [0, 'Age cannot be negative.'],
      max: [120, 'Age cannot exceed 120.'],
    },

    sex: {
      type: String,
      enum: ['Male', 'Female', 'Other'],
      required: [true, 'Patient sex is required.'],
    },

    contactNumber: {
      type: String,
      required: [true, 'Contact number is required for PEP dose reminder follow-ups.'],
      trim: true,
      index: true,
    },

    // Barangay is essential for PySpark epidemiological & Category III spike detection
    barangay: {
      type: String,
      required: [true, 'Barangay is required for community rabies surveillance.'],
      trim: true,
      index: true,
    },

    city: {
      type: String,
      default: 'Quezon City',
      trim: true,
    },

    registeredBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },

    // Embedded exposure cases (allows repeat bite incidents over the years in one record)
    exposureHistory: [exposureCaseSchema],
  },
  {
    timestamps: true,
  }
);

// ----------------------------------------------------------------------------
// COMPOUND INDEXES FOR HIGH-SPEED CLINICAL & ANALYTICS QUERIES
// ----------------------------------------------------------------------------
// 1. Fast Receptionist search by patient name and phone number
patientSchema.index({ fullName: 1, contactNumber: 1 });

// 2. Fast Physician & PySpark query for Category III cases sorted by walk-in date
patientSchema.index({
  'exposureHistory.whoCategory': 1,
  'exposureHistory.walkInDate': -1,
});

// 3. Fast Daily Queue & Defaulter lookup across embedded PEP schedule dates
patientSchema.index({
  'exposureHistory.pepSchedule.scheduledDate': 1,
  'exposureHistory.pepSchedule.status': 1,
});

module.exports = mongoose.model('Patient', patientSchema);
