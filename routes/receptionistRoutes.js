/**
 * ============================================================================
 * FILE: routes/receptionistRoutes.js
 * ARCHITECTURAL LAYER: Route Layer (Receptionist Patient Intake & Queue Endpoints)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Defines all `/api/receptionist/*` endpoints for front-desk walk-in patient
 * registration, demographic search, and daily vaccination appointment queues.
 *
 * SECURITY COMPLIANCE (Modules 05, 06 & 13):
 * Protected by `verifyAuthenticationToken` and `authorizeRoles('Receptionist', 'SuperAdmin')`.
 * Uses `express-validator` to sanitize and validate patient demographics and
 * prevent injection or malformed clinical records.
 * ============================================================================
 */

const express = require('express');
const { body, validationResult } = require('express-validator');
const {
  registerWalkInPatient,
  searchPatientRecords,
  getDailyAppointmentQueue,
} = require('../controllers/receptionistController');
const { verifyAuthenticationToken } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

const router = express.Router();

/**
 * Validation Error Handler
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

// Apply JWT verification and Role-Based Access Control (Receptionist or SuperAdmin)
router.use(verifyAuthenticationToken);
router.use(authorizeRoles('Receptionist', 'SuperAdmin'));

/**
 * @route   POST /api/receptionist/patients
 * @desc    Register a new walk-in animal bite patient for Physician triage
 * @access  Private (Receptionist, SuperAdmin)
 */
router.post(
  '/patients',
  [
    body('fullName')
      .trim()
      .notEmpty()
      .withMessage('Patient full name is required.')
      .isLength({ max: 100 }),
    body('age')
      .isInt({ min: 0, max: 120 })
      .withMessage('Patient age must be a valid integer between 0 and 120.'),
    body('sex')
      .isIn(['Male', 'Female', 'Other'])
      .withMessage('Sex must be Male, Female, or Other.'),
    body('contactNumber')
      .trim()
      .notEmpty()
      .withMessage('Contact phone number is required for PEP follow-up reminders.'),
    body('barangay')
      .trim()
      .notEmpty()
      .withMessage('Barangay is required for epidemiological tracking.'),
    body('exposureDate')
      .isISO8601()
      .withMessage('Valid date of animal exposure (YYYY-MM-DD) is required.'),
    body('animalType')
      .isIn(['Dog', 'Cat', 'Bat', 'Monkey', 'Rat', 'Other'])
      .withMessage('Animal type must be Dog, Cat, Bat, Monkey, Rat, or Other.'),
    body('biteSite')
      .trim()
      .notEmpty()
      .withMessage('Anatomical bite site is required (e.g., Right Hand, Left Calf).'),
    handleValidationErrors,
  ],
  registerWalkInPatient
);

/**
 * @route   GET /api/receptionist/patients/search
 * @desc    Search patient records by name, patientCode, phone, or barangay
 * @access  Private (Receptionist, SuperAdmin, Physician)
 */
router.get('/patients/search', searchPatientRecords);

/**
 * @route   GET /api/receptionist/appointments/today
 * @desc    Get patients awaiting initial triage or scheduled for a PEP dose today
 * @access  Private (Receptionist, SuperAdmin)
 */
router.get('/appointments/today', getDailyAppointmentQueue);

module.exports = router;
