const express = require('express');
const { body, validationResult } = require('express-validator');
const {
  registerWalkInPatient,
  checkInReturningPatient,
  processScheduledDose,
  getPatientsAndDailyQueue
} = require('../controllers/receptionistController');
const { verifyAuthenticationToken } = require('../middleware/authMiddleware');
const { authorizeRoles } = require('../middleware/roleMiddleware');

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

const walkInValidators = [
  body('fullName')
    .trim()
    .notEmpty()
    .withMessage('Patient full name is required.')
    .matches(/^[a-zA-ZÀ-ÿ\s.\-]+$/)
    .withMessage('Letters, spaces, dots, and hyphens only.'),
  body('age')
    .isInt({ min: 0, max: 120 })
    .withMessage('Patient age must be a valid number between 0 and 120.'),
  body('sex')
    .isIn(['Male', 'Female', 'Other'])
    .withMessage('Sex must be Male, Female, or Other.'),
  body('contactNumber')
    .trim()
    .custom((val) => {
      const digitsOnly = String(val || '').replace(/\D/g, '');
      return /^09\d{9}$/.test(digitsOnly);
    })
    .withMessage('Please enter a valid 11-digit mobile number starting with 09 (e.g., 09171234567).'),
  body('biteSite').trim().notEmpty().withMessage('Body part affected is required.'),
  body('consentGiven')
    .custom((val) => val === true || val === 'true')
    .withMessage('Patient consent must be checked before intake.'),
  handleValidationErrors
];

router.use(verifyAuthenticationToken);

router.get('/patients', authorizeRoles('Receptionist', 'Physician', 'SuperAdmin'), getPatientsAndDailyQueue);
router.get('/queue', authorizeRoles('Receptionist', 'Physician', 'SuperAdmin'), getPatientsAndDailyQueue);
router.get('/followup-today', authorizeRoles('Receptionist', 'Physician', 'SuperAdmin'), getPatientsAndDailyQueue);

router.post('/patients', authorizeRoles('Receptionist'), walkInValidators, registerWalkInPatient);
router.post('/register-walkin', authorizeRoles('Receptionist'), walkInValidators, registerWalkInPatient);

router.patch('/patients/:patientId/checkin', authorizeRoles('Receptionist'), checkInReturningPatient);
router.put('/checkin/:patientId', authorizeRoles('Receptionist'), checkInReturningPatient);
router.post('/checkin/:patientId', authorizeRoles('Receptionist'), checkInReturningPatient);

router.patch(
  '/patients/:patientId/schedule',
  authorizeRoles('Physician'),
  [
    body('doseDay')
      .isIn(['Day 0', 'Day 3', 'Day 7', 'Day 14', 'Day 28'])
      .withMessage('doseDay must be Day 0, Day 3, Day 7, Day 14, or Day 28.'),
    body('doseAdministered')
      .isBoolean()
      .withMessage('doseAdministered must be true or false.'),
    handleValidationErrors
  ],
  processScheduledDose
);

module.exports = router;
