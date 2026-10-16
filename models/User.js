/**
 * ============================================================================
 * FILE: models/User.js
 * ARCHITECTURAL LAYER: Model Layer (Staff Authentication & RBAC Schema)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Defines the structure and security behaviors for clinic personnel accounts
 * at Dr. Pau Animal Bite Center. Every user belongs to one of three strict
 * Role-Based Access Control (RBAC) roles:
 *   - 'SuperAdmin'   : Manages staff accounts, vaccine inventory, and analytics.
 *   - 'Receptionist' : Registers walk-in patients and tracks daily queues.
 *   - 'Physician'    : Performs WHO Category I-III triage and records PEP doses.
 *
 * SECURITY COMPLIANCE (Modules 05, 06 & 13):
 * 1. Password Hashing: Uses bcryptjs with 12 salt rounds inside a pre-save hook
 *    so plain-text passwords are NEVER stored in MongoDB.
 * 2. Data Minimization & Projection Protection: Sensitive fields (`passwordHash`,
 *    `mfaOtpCode`, `mfaOtpExpiresAt`) have `select: false`, meaning standard
 *    `User.find()` queries never accidentally leak credentials in API responses.
 * 3. Multi-Factor Authentication (MFA): Stores a temporary 6-digit OTP that
 *    strictly expires after 5 minutes (300,000 ms).
 * ============================================================================
 */

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

// Constant defining the required cryptographic work factor (12 salt rounds)
const BCRYPT_SALT_ROUNDS = 12;

// Constant defining the 5-minute MFA OTP expiration window in milliseconds
const MFA_OTP_VALIDITY_DURATION_MS = 5 * 60 * 1000;

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Staff member full name is required.'],
      trim: true,
      maxlength: [100, 'Full name cannot exceed 100 characters.'],
    },

    email: {
      type: String,
      required: [true, 'Official clinic email address is required.'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true, // Indexed for fast O(log n) lookup during Step 1 Login
    },

    // Plain-text passwords are never stored. `select: false` hides the hash from default queries.
    passwordHash: {
      type: String,
      required: [true, 'Password hash is required.'],
      select: false,
    },

    // Strict Role-Based Access Control (RBAC) enumeration
    role: {
      type: String,
      enum: {
        values: ['SuperAdmin', 'Receptionist', 'Physician'],
        message: 'Role must be strictly SuperAdmin, Receptionist, or Physician.',
      },
      required: [true, 'User role must be specified for RBAC enforcement.'],
      index: true,
    },

    // Allows SuperAdmin to deactivate a staff account without deleting historical clinical records
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },

    // ------------------------------------------------------------------------
    // MULTI-FACTOR AUTHENTICATION (MFA) FIELDS (5-Minute Expiring 6-Digit OTP)
    // ------------------------------------------------------------------------
    mfaOtpCode: {
      type: String,
      default: null,
      select: false, // Never returned in standard API queries
    },

    mfaOtpExpiresAt: {
      type: Date,
      default: null,
      select: false,
    },

    // ------------------------------------------------------------------------
    // ACCOUNT LOCKOUT / BRUTE-FORCE TRACKING FIELDS
    // ------------------------------------------------------------------------
    failedLoginAttempts: {
      type: Number,
      default: 0,
    },

    accountLockedUntil: {
      type: Date,
      default: null,
    },

    lastLoginAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true, // Automatically manages `createdAt` and `updatedAt`
  }
);

/**
 * PRE-SAVE HOOK: Automatic Password Hashing with 12 Salt Rounds
 * Why this exists: Even if a developer forgets to hash a password in a controller,
 * the Model guarantees that `passwordHash` is salted and hashed before reaching MongoDB.
 */
userSchema.pre('save', async function (next) {
  // Only hash the password if it was newly created or modified
  if (!this.isModified('passwordHash')) {
    return next();
  }

  try {
    const cryptographicSalt = await bcrypt.genSalt(BCRYPT_SALT_ROUNDS);
    this.passwordHash = await bcrypt.hash(this.passwordHash, cryptographicSalt);
    next();
  } catch (hashingError) {
    next(hashingError);
  }
});

/**
 * INSTANCE METHOD: Verify Candidate Password
 * Compares the plain-text password submitted during login against the stored bcrypt hash.
 *
 * @param {string} candidatePlainTextPassword - Password entered by the user
 * @returns {Promise<boolean>} True if password matches, false otherwise
 */
userSchema.methods.verifyPassword = async function (candidatePlainTextPassword) {
  return await bcrypt.compare(candidatePlainTextPassword, this.passwordHash);
};

/**
 * INSTANCE METHOD: Generate 5-Minute 6-Digit MFA OTP
 * Generates a random 6-digit numerical OTP and sets its expiration timestamp
 * to exactly 5 minutes from the current server time.
 *
 * @returns {string} The generated 6-digit OTP string (e.g., "482910")
 */
userSchema.methods.generateSixDigitMfaOtp = function () {
  // Generate a random 6-digit integer between 100000 and 999999
  const sixDigitCode = Math.floor(100000 + Math.random() * 900000).toString();

  this.mfaOtpCode = sixDigitCode;
  this.mfaOtpExpiresAt = new Date(Date.now() + MFA_OTP_VALIDITY_DURATION_MS);

  return sixDigitCode;
};

module.exports = mongoose.model('User', userSchema);
