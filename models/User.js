const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

const userSchema = new mongoose.Schema(
  {
    fullName: {
      type: String,
      required: [true, 'Staff full name is required'],
      trim: true,
      maxlength: 100
    },
    email: {
      type: String,
      required: [true, 'Clinic email is required'],
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    passwordHash: {
      type: String,
      required: [true, 'Password is required'],
      select: false
    },
    role: {
      type: String,
      enum: ['SuperAdmin', 'Receptionist', 'Physician'],
      required: [true, 'Role must be SuperAdmin, Receptionist, or Physician'],
      index: true
    },
    isActive: {
      type: Boolean,
      default: true
    },
    // ito yung OTP na naka hash na para di mabasa sa db
    mfaOtp: {
      type: String,
      default: null,
      select: false
    },
    mfaOtpExpires: {
      type: Number,
      default: null,
      select: false
    },
    failedMfaAttempts: {
      type: Number,
      default: 0
    },
    accountLockedUntil: {
      type: Number,
      default: null
    },
    lastLoginAt: {
      type: Date,
      default: null
    },
    // TOTP (Google Authenticator) fields for F2F onboarding
    totpSecret: {
      type: String,
      default: null,
      select: false
    },
    previousTotpSecrets: {
      type: [String],
      default: [],
      select: false
    },
    isTotpSetup: {
      type: Boolean,
      default: false
    }
  },
  {
    timestamps: true
  }
);

// ito yung anu pang hide ng password bago i save, wag galawin
userSchema.pre('save', async function (next) {
  if (!this.isModified('passwordHash')) {
    return next();
  }

  try {
    this.passwordHash = await bcrypt.hash(this.passwordHash, SALT_ROUNDS);
    next();
  } catch (error) {
    next(error);
  }
});

module.exports = mongoose.model('User', userSchema);
