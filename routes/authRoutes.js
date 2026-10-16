/**
 * ============================================================================
 * FILE: routes/authRoutes.js
 * ARCHITECTURAL LAYER: Route Layer (Authentication & MFA Endpoints)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Maps authentication HTTP endpoints (`/api/auth/*`) to `authController.js`
 * and enforces strict server-side input validation using `express-validator`
 * BEFORE requests reach the controller logic.
 *
 * SECURITY COMPLIANCE (Modules 05, 06 & 13):
 * 1. Strict Input Validation (`express-validator`):
 *    Ensures emails are syntactically valid and MFA OTP codes are strictly
 *    6 numeric digits, blocking malformed payloads early.
 * ============================================================================
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const {
  initiateLoginStepOne,
  verifyMfaOtpStepTwo,
  logoutCurrentSession,
  getCurrentUserProfile,
} = require('../controllers/authController');
const { verifyAuthenticationToken } = require('../middleware/authMiddleware');

const router = express.Router();

/**
 * Reusable Validation Error Handler Middleware
 * Returns a consistent `{ success: false, message, data }` JSON structure
 * whenever `express-validator` catches invalid user input.
 */
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg,
      data: { validationErrors: errors.array() },
    });
  }
  next();
};

/**
 * @route   POST /api/auth/login
 * @desc    Step 1 of MFA: Verify email & password, generate 5-minute 6-digit OTP
 * @access  Public (Rate-limited in server.js)
 */
router.post(
  '/login',
  [
    body('email')
      .isEmail()
      .withMessage('Please provide a valid clinic email address.')
      .normalizeEmail(),
    body('password')
      .isString()
      .notEmpty()
      .withMessage('Password is required for Step 1 authentication.'),
    handleValidationErrors,
  ],
  initiateLoginStepOne
);

/**
 * @route   POST /api/auth/verify-mfa
 * @desc    Step 2 of MFA: Verify 6-digit OTP & set HttpOnly JWT Cookie
 * @access  Public (Rate-limited in server.js)
 */
router.post(
  '/verify-mfa',
  [
    body('email')
      .isEmail()
      .withMessage('Valid clinic email address is required.')
      .normalizeEmail(),
    body('otpCode')
      .trim()
      .isLength({ min: 6, max: 6 })
      .isNumeric()
      .withMessage('MFA OTP must be a valid 6-digit numeric code.'),
    handleValidationErrors,
  ],
  verifyMfaOtpStepTwo
);

/**
 * @route   POST /api/auth/logout
 * @desc    Clear the HttpOnly JWT session cookie
 * @access  Private (Any Authenticated Role)
 */
router.post('/logout', logoutCurrentSession);

/**
 * @route   GET /api/auth/me
 * @desc    Get currently logged-in staff member's identity and role
 * @access  Private (Any Authenticated Role)
 */
router.get('/me', verifyAuthenticationToken, getCurrentUserProfile);

module.exports = router;
