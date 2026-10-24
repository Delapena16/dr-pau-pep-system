const mongoose = require('mongoose');

// ito yung sa isang turok sa schedule, Day 0, 3, 7, 14, 28
const pepDoseSchema = new mongoose.Schema(
  {
    doseDay: {
      type: String,
      enum: ['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'],
      required: true
    },
    dayOffset: {
      type: Number,
      enum: [0, 3, 7, 14, 28],
      required: true
    },
    scheduledDate: {
      type: Date,
      required: true,
      index: true
    },
    status: {
      type: String,
      enum: ['Pending', 'Fulfilled', 'Defaulter'],
      default: 'Pending'
    },
    doseAdministered: {
      type: Boolean,
      default: false
    },
    vaccineTypeUsed: {
      type: String,
      default: 'anti-rabies'
    },
    dateProcessed: {
      type: Date,
      default: null
    },
    processedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    }
  },
  { _id: true }
);

const patientSchema = new mongoose.Schema(
  {
    patientId: {
      type: String,
      required: true,
      unique: true,
      index: true
    },
    fullName: {
      type: String,
      required: [true, 'Patient full name is required'],
      trim: true
    },
    age: {
      type: Number,
      required: [true, 'Patient age is required'],
      min: 0,
      max: 120
    },
    sex: {
      type: String,
      enum: ['Male', 'Female', 'Other'],
      required: true
    },
    contactNumber: {
      type: String,
      required: [true, 'Contact number is required for follow-up reminders'],
      trim: true
    },
    purok: {
      type: String,
      trim: true,
      default: 'Purok 1, Kapitan Pepe'
    },
    barangay: {
      type: String,
      required: [true, 'Purok address in Brgy. Kapitan Pepe is required'],
      trim: true
    },
    consentGiven: {
      type: Boolean,
      required: [true, 'Patient consent is required before saving clinical data'],
      validate: {
        validator: function (value) {
          return value === true;
        },
        message: 'Patient consent must be checked before intake.'
      }
    },
    day0WalkInDate: {
      type: Date,
      required: true,
      default: Date.now
    },
    animalType: {
      type: String,
      enum: ['Dog', 'Cat', 'Stray Dog', 'Stray Cat', 'Bat', 'Other'],
      default: 'Dog'
    },
    biteSite: {
      type: String,
      required: [true, 'Body part affected is required'],
      trim: true
    },
    biteStatus: {
      type: String,
      trim: true,
      default: 'Bite - Unprovoked'
    },
    woundCategory: {
      type: String,
      enum: ['Pending', 'Category I', 'Category II', 'Category III'],
      default: 'Pending',
      index: true
    },
    clinicalStatus: {
      type: String,
      enum: [
        'Waiting for Doctor',
        'Needs Triage',
        'Due Today',
        'Under Treatment',
        'Ongoing Schedule',
        'Missed Dose',
        'Completed',
        'Wound Cleansing Only'
      ],
      default: 'Waiting for Doctor'
    },
    checkedInForTriage: {
      type: Boolean,
      default: true
    },
    allergyNotes: {
      type: String,
      trim: true,
      default: 'Pending Physician Assessment'
    },
    clinicalNotes: {
      type: String,
      trim: true,
      default: ''
    },
    assessedByPhysician: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    pepSchedule: [pepDoseSchema]
  },
  {
    timestamps: true
  }
);

patientSchema.index({ patientId: 1, 'pepSchedule.scheduledDate': 1 });
patientSchema.index({ registryId: 1 }, { sparse: true });


module.exports = mongoose.model('Patient', patientSchema);
