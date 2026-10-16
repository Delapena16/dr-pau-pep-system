/**
 * ============================================================================
 * FILE: routes/physicianRoutes.js
 * ARCHITECTURAL LAYER: Route Layer (Physician Clinical Triage & PEP Endpoints)
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Defines all `/api/physician/*` endpoints for clinical WHO Category I-III
 * wound evaluation, 5-dose PEP schedule generation, FEFO vaccine administration,
 * and defaulter/high-risk monitoring.
 *
 * SECURITY COMPLIANCE (Modules 05, 06 & 13):
 * Protected by `verifyAuthenticationToken` and `authorizeRoles('Physician', 'SuperAdmin')`.
 * Receptionists are strictly blocked from prescribing PEP regimens or deducting
 * vaccine inventory.
 * ============================================================================
 */

const express = require('express');
const { body, param, validationResult } = require('express-validator');
const {
  evaluateExposureAndGeneratePepSchedule,
  recordVaccineDoseAdministration,
  getHighRiskAndDefaulterPatients,
} = require('../controllers/physicianController');
const { searchPatientRecords } = require('../controllers/receptionistController');
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

// Apply JWT verification and Role-Based Access Control (Physician or SuperAdmin)
router.use(verifyAuthenticationToken);
router.use(authorizeRoles('Physician', 'SuperAdmin'));

/**
 * @route   GET /api/physician/patients
 * @desc    Allow Physicians to search and view patient records for triage
 * @access  Private (Physician, SuperAdmin)
 */
router.get('/patients', searchPatientRecords);

/**
 * @route   POST /api/physician/patients/:patientId/triage
 * @desc    Classify wound into WHO Category I, II, or III & generate 5-dose PEP schedule
 * @access  Private (Physician, SuperAdmin)
 */
router.post(
  '/patients/:patientId/triage',
  [
    param('patientId')
      .isMongoId()
      .withMessage('Valid MongoDB patientId parameter is required.'),
    body('whoCategory')
      .isIn(['Category I', 'Category II', 'Category III'])
      .withMessage('WHO Category must be strictly Category I, Category II, or Category III.'),
    body('clinicalNotes')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Clinical notes cannot exceed 500 characters.'),
    handleValidationErrors,
  ],
  evaluateExposureAndGeneratePepSchedule
);

/**
 * @route   POST /api/physician/patients/:patientId/administer-dose
 * @desc    Record administration of Day 0, 3, 7, 14, or 28 dose & deduct FEFO inventory
 * @access  Private (Physician, SuperAdmin)
 */
router.post(
  '/patients/:patientId/administer-dose',
  [
    param('patientId')
      .isMongoId()
      .withMessage('Valid MongoDB patientId parameter is required.'),
    body('doseLabel')
      .isIn(['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'])
      .withMessage('doseLabel must be Day 0, Day 3, Day 7, Day 14, or Day 28.'),
    handleValidationErrors,
  ],
  recordVaccineDoseAdministration
);

/**
 * @route   GET /api/physician/alerts/defaulters-and-cat3
 * @desc    Retrieve overdue PEP defaulters and high-risk WHO Category III cases
 * @access  Private (Physician, SuperAdmin)
 */
router.get('/alerts/defaulters-and-cat3', getHighRiskAndDefaulterPatients);

module.exports = router;
