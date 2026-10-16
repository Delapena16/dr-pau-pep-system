/**
 * ============================================================================
 * FILE: controllers/authController.js
 * ARCHITECTURAL LAYER: Controller Layer (2-Step MFA & Session Management)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Handles the complete authentication lifecycle for clinic staff:
 *   - Step 1 (`initiateLoginStepOne`): Verifies email + bcrypt-hashed password
 *     (12 salt rounds), enforces brute-force lockout protection, and generates a
 *     5-minute expiring 6-digit One-Time Password (OTP).
 *   - Step 2 (`verifyMfaOtpStepTwo`): Verifies the 6-digit OTP within the 5-minute
 *     window, clears the OTP to prevent replay attacks, signs a stateless JWT,
 *     and delivers it inside an `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
 *   - Logout (`logoutCurrentSession`): Clears the HttpOnly cookie cleanly.
 *
 * ACADEMIC DEFENSE TALKING POINTS:
 * 1. Why 2-Step MFA?
 *    Medical records contain sensitive patient health information. Even if a
 *    staff password is compromised via phishing, an attacker cannot log in
 *    without the 5-minute expiring 6-digit OTP.
 * 2. Why Clear the OTP Immediately After Verification?
 *    Setting `mfaOtpCode = null` and `mfaOtpExpiresAt = null` right after a
 *    successful login prevents OTP Replay Attacks within the 5-minute window.
 * ============================================================================
 */

const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuditLog = require('../models/AuditLog');

// Maximum consecutive failed password attempts before a 15-minute temporary lock
const MAX_FAILED_LOGIN_ATTEMPTS = 5;
const ACCOUNT_LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * Helper: Builds secure cookie options for storing the stateless JWT.
 * Enforces HttpOnly, Secure, and SameSite=Strict per Module 05/06/13 standards.
 */
const buildSecureJwtCookieOptions = () => {
  const isProductionEnvironment = process.env.NODE_ENV === 'production';

  return {
    httpOnly: true, // Prevents client-side JS (XSS) from reading the cookie
    secure: isProductionEnvironment, // Enforces HTTPS transmission in production
    sameSite: 'strict', // Prevents Cross-Site Request Forgery (CSRF)
    maxAge: 8 * 60 * 60 * 1000, // 8-hour clinical shift duration
  };
};

/**
 * STEP 1 OF 2-STEP MFA LOGIN: Verify Password & Issue 5-Minute 6-Digit OTP
 * Route: POST /api/auth/login
 */
const initiateLoginStepOne = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Explicitly select `passwordHash` because it has `select: false` in User.js
    const staffUser = await User.findOne({ email: email.toLowerCase().trim() }).select(
      '+passwordHash +mfaOtpCode +mfaOtpExpiresAt'
    );

    // Return a generic message if email doesn't exist to prevent User Enumeration attacks
    if (!staffUser || !staffUser.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Invalid clinic email or password.',
        data: null,
      });
    }

    // Check if the account is currently locked due to repeated failed attempts
    if (
      staffUser.accountLockedUntil &&
      staffUser.accountLockedUntil > new Date()
    ) {
      const remainingMinutes = Math.ceil(
        (staffUser.accountLockedUntil - new Date()) / 60000
      );
      return res.status(423).json({
        success: false,
        message: `Account is temporarily locked due to multiple failed login attempts. Try again in ${remainingMinutes} minute(s).`,
        data: null,
      });
    }

    // Verify submitted plain-text password against the 12-round bcrypt hash
    const isPasswordMatch = await staffUser.verifyPassword(password);

    if (!isPasswordMatch) {
      staffUser.failedLoginAttempts += 1;

      if (staffUser.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        staffUser.accountLockedUntil = new Date(
          Date.now() + ACCOUNT_LOCKOUT_DURATION_MS
        );
      }
      await staffUser.save();

      await AuditLog.create({
        actorId: staffUser._id,
        actorRole: staffUser.role,
        actionType: 'AUTH_LOGIN_FAILED',
        targetCollection: 'AuthSession',
        description: `Failed Step-1 password verification for ${staffUser.email} (Attempt #${staffUser.failedLoginAttempts}).`,
        ipAddress: req.ip || '127.0.0.1',
      });

      return res.status(401).json({
        success: false,
        message: 'Invalid clinic email or password.',
        data: null,
      });
    }

    // Password is valid: reset failed login counter and generate 5-minute 6-digit OTP
    staffUser.failedLoginAttempts = 0;
    staffUser.accountLockedUntil = null;
    const generatedOtpCode = staffUser.generateSixDigitMfaOtp();
    await staffUser.save();

    await AuditLog.create({
      actorId: staffUser._id,
      actorRole: staffUser.role,
      actionType: 'AUTH_STEP1_PASSWORD_OK',
      targetCollection: 'AuthSession',
      description: `Step-1 password verified for ${staffUser.email}. 5-minute 6-digit MFA OTP issued.`,
      ipAddress: req.ip || '127.0.0.1',
    });

    // In production, send `generatedOtpCode` via SMS/Email gateway.
    // For local development and academic defense walkthroughs, we log it to the
    // terminal and include `demoOtpPreview` when NODE_ENV !== 'production'.
    console.log(
      `[MFA OTP GENERATED] Staff: ${staffUser.email} (${staffUser.role}) | 6-Digit OTP: ${generatedOtpCode} (Expires in 5 mins)`
    );

    return res.status(200).json({
      success: true,
      message:
        'Step 1 complete: Password verified. Please enter the 6-digit MFA OTP within 5 minutes.',
      data: {
        mfaRequired: true,
        email: staffUser.email,
        role: staffUser.role,
        otpExpiresInSeconds: 300,
        // Included in non-production mode so students can demonstrate MFA live during defense
        demoOtpPreview:
          process.env.NODE_ENV === 'production' ? undefined : generatedOtpCode,
      },
    });
  } catch (serverError) {
    console.error('[Auth Step 1 Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'An internal error occurred during Step 1 authentication.',
      data: null,
    });
  }
};

/**
 * STEP 2 OF 2-STEP MFA LOGIN: Verify 6-Digit OTP & Issue HttpOnly JWT Cookie
 * Route: POST /api/auth/verify-mfa
 */
const verifyMfaOtpStepTwo = async (req, res) => {
  try {
    const { email, otpCode } = req.body;

    const staffUser = await User.findOne({ email: email.toLowerCase().trim() }).select(
      '+mfaOtpCode +mfaOtpExpiresAt'
    );

    if (!staffUser || !staffUser.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Authentication failed. User account not found or inactive.',
        data: null,
      });
    }

    // Check if an OTP was actually generated and has not expired (5-minute limit)
    if (!staffUser.mfaOtpCode || !staffUser.mfaOtpExpiresAt) {
      return res.status(400).json({
        success: false,
        message: 'No active MFA OTP found. Please complete Step 1 login first.',
        data: null,
      });
    }

    if (new Date() > staffUser.mfaOtpExpiresAt) {
      // Clear expired OTP immediately
      staffUser.mfaOtpCode = null;
      staffUser.mfaOtpExpiresAt = null;
      await staffUser.save();

      return res.status(401).json({
        success: false,
        message:
          'Your 6-digit MFA OTP has expired (5-minute timeout exceeded). Please log in again.',
        data: null,
      });
    }

    // Compare submitted 6-digit OTP against stored OTP
    if (staffUser.mfaOtpCode !== otpCode.trim()) {
      await AuditLog.create({
        actorId: staffUser._id,
        actorRole: staffUser.role,
        actionType: 'AUTH_MFA_FAILED',
        targetCollection: 'AuthSession',
        description: `Invalid 6-digit MFA OTP entered for ${staffUser.email}.`,
        ipAddress: req.ip || '127.0.0.1',
      });

      return res.status(401).json({
        success: false,
        message: 'Invalid 6-digit MFA OTP code. Please double-check and try again.',
        data: null,
      });
    }

    // OTP is valid! Clear OTP fields immediately to prevent replay attacks
    staffUser.mfaOtpCode = null;
    staffUser.mfaOtpExpiresAt = null;
    staffUser.lastLoginAt = new Date();
    await staffUser.save();

    // Sign stateless JWT containing minimal identity claims
    const jwtSecretKey =
      process.env.JWT_SECRET ||
      'dr_pau_pep_super_secret_jwt_signing_key_2026_capstone_defense';

    const signedJwtToken = jwt.sign(
      {
        userId: staffUser._id,
        role: staffUser.role,
        mfaVerified: true,
      },
      jwtSecretKey,
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    );

    // Attach JWT inside HttpOnly, Secure, SameSite=Strict cookie
    res.cookie('pep_auth_token', signedJwtToken, buildSecureJwtCookieOptions());

    await AuditLog.create({
      actorId: staffUser._id,
      actorRole: staffUser.role,
      actionType: 'AUTH_STEP2_MFA_VERIFIED',
      targetCollection: 'AuthSession',
      description: `2-Step MFA completed for ${staffUser.fullName} (${staffUser.role}). Session started.`,
      ipAddress: req.ip || '127.0.0.1',
    });

    return res.status(200).json({
      success: true,
      message: `Welcome back, ${staffUser.fullName}. 2-Step MFA verified and secure session established.`,
      data: {
        user: {
          userId: staffUser._id,
          fullName: staffUser.fullName,
          email: staffUser.email,
          role: staffUser.role,
          lastLoginAt: staffUser.lastLoginAt,
        },
        // Also returned for easy Postman environment variable binding during testing
        tokenForPostmanTesting:
          process.env.NODE_ENV === 'production' ? undefined : signedJwtToken,
      },
    });
  } catch (serverError) {
    console.error('[Auth Step 2 MFA Error]:', serverError);
    return res.status(500).json({
      success: false,
      message: 'An internal error occurred during Step 2 MFA verification.',
      data: null,
    });
  }
};

/**
 * LOGOUT CURRENT SESSION: Clear HttpOnly JWT Cookie
 * Route: POST /api/auth/logout
 */
const logoutCurrentSession = async (req, res) => {
  res.clearCookie('pep_auth_token', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict',
  });

  return res.status(200).json({
    success: true,
    message: 'You have been securely logged out. HttpOnly session cookie cleared.',
    data: null,
  });
};

/**
 * GET CURRENT AUTHENTICATED USER PROFILE
 * Route: GET /api/auth/me
 */
const getCurrentUserProfile = async (req, res) => {
  return res.status(200).json({
    success: true,
    message: 'Active authenticated staff profile retrieved.',
    data: {
      user: req.authenticatedUser,
    },
  });
};

module.exports = {
  initiateLoginStepOne,
  verifyMfaOtpStepTwo,
  logoutCurrentSession,
  getCurrentUserProfile,
};
