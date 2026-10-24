const express = require('express');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');

// 1. IMPORT YOUR NODEMAILER FUNCTION HERE
const sendOTP = require('../utils/sendEmail'); 

const {
  initiateLoginStepOne,
  verifyMfaOtpStepTwo,
  logoutCurrentSession,
  getCurrentUserProfile,
  verifyPassword,
  verifyUnmask,
  googleLogin,
  verifyTotp,
  regenerateTotpQr
} = require('../controllers/authController');
const { verifyAuthenticationToken } = require('../middleware/authMiddleware');

const router = express.Router();

const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      message: errors.array()[0].msg
    });
  }
  next();
};

const verifyOtpValidators = [
  body('email').isEmail().withMessage('Valid clinic email is required.'),
  body('otpCode')
    .trim()
    .isLength({ min: 6, max: 6 })
    .isNumeric()
    .withMessage('Invalid verification code. Please try again.'),
  handleValidationErrors
];

const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: 'Too many failed login attempts. Please wait 15 minutes before trying again.',
    message: 'Too many failed login attempts. Please wait 15 minutes before trying again.'
  }
});

// 2. ADD AN OTP SPAM PROTECTOR (Rate Limiter)
const sendOtpRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 3, // Limit each IP to 3 OTP requests per 5 minutes
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many OTP requests. Please wait 5 minutes before requesting another code.'
  }
});

router.post(
  '/login',
  loginRateLimiter,
  [
    body('email').isEmail().withMessage('Please enter a valid clinic email address.'),
    body('password').notEmpty().withMessage('Password is required.'),
    handleValidationErrors
  ],
  initiateLoginStepOne
);

// 3. ADD THE SEND-OTP ROUTE HERE
router.post(
  '/send-otp',
  sendOtpRateLimiter, // Protects your Gmail from spam
  [
    body('email').isEmail().withMessage('Please enter a valid clinic email address.'),
    handleValidationErrors
  ],
  async (req, res) => {
    const { email } = req.body;
    
    // Generate a random 6-digit numeric OTP code
    const generatedOTP = Math.floor(100000 + Math.random() * 900000).toString();

    try {
      // TODO: Save `generatedOTP` to your MongoDB database (e.g., inside the User document) 
      // or to your session so you can verify it when they call /verify-otp

      // Send the email via Gmail
      await sendOTP(email, generatedOTP);

      res.status(200).json({ 
        success: true, 
        message: `OTP successfully sent to ${email}` 
      });
    } catch (error) {
      res.status(500).json({ 
        success: false, 
        message: 'Failed to send OTP email.' 
      });
    }
  }
);

router.post('/verify-mfa', verifyOtpValidators, verifyMfaOtpStepTwo);
router.post('/verify-otp', verifyOtpValidators, verifyMfaOtpStepTwo);

router.post('/logout', logoutCurrentSession);
router.get('/me', verifyAuthenticationToken, getCurrentUserProfile);
router.post('/verify-password', verifyAuthenticationToken, verifyPassword);
router.post('/verify-unmask', verifyAuthenticationToken, verifyUnmask);
router.post('/google', googleLogin);
router.post('/verify-totp', verifyTotp);
router.post('/regenerate-totp-qr', regenerateTotpQr);

module.exports = router;