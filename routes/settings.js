const express = require('express');
const { body, validationResult } = require('express-validator');
const { verifyAuthenticationToken } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');
const { getSettings, updateSettings } = require('../controllers/settingsController');

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

// Any authenticated staff member may read the current timeout.
router.get('/', verifyAuthenticationToken, getSettings);

// Only SuperAdmin may change the global security policy.
router.put(
  '/',
  verifyAuthenticationToken,
  authorizeRoles('SuperAdmin'),
  [body('timeout').isInt({ min: 1, max: 120 }).withMessage('Timeout must be between 1 and 120 minutes.'), handleValidationErrors],
  updateSettings
);

module.exports = router;
