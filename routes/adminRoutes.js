const express = require('express');
const { body, validationResult } = require('express-validator');
const {
  createStaffUserAccount,
  updateStaffUserAccount,
  deleteStaffUserAccount,
  toggleStaffAccountStatus,
  getAllStaffUsers,
  addOrRestockVaccineBatch,
  getInventoryStatusAndAlerts,
  logInventorySpoilageOrVoid,
  getSystemAuditLogsAndAnalyticsSummary,
  updatePatientDemographics,
  getDashboardSummary,
  getRecentAuditLogs,
  logDataExport
} = require('../controllers/adminController');
const {
  getPySparkAnalyticsSummary,
  recalculateMonthlyForecast
} = require('../controllers/physicianController');
const { getPatientsAndDailyQueue } = require('../controllers/receptionistController');
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

const staffValidators = [
  body('fullName').trim().notEmpty().withMessage('Staff full name is required.'),
  body('email').isEmail().withMessage('Valid clinic email is required.'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long.'),
  body('role')
    .isIn(['SuperAdmin', 'Receptionist', 'Physician'])
    .withMessage('Role must be SuperAdmin, Receptionist, or Physician.'),
  handleValidationErrors
];

const staffUpdateValidators = [
  body('fullName').trim().notEmpty().withMessage('Staff full name is required.'),
  body('email').isEmail().withMessage('Valid clinic email is required.'),
  body('password')
    .optional({ checkFalsy: true })
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters long.'),
  body('role')
    .isIn(['SuperAdmin', 'Receptionist', 'Physician'])
    .withMessage('Role must be SuperAdmin, Receptionist, or Physician.'),
  handleValidationErrors
];

const restockValidators = [
  body('vaccineType')
    .isIn(['anti-rabies', 'anti-tetanus', 'ERIG'])
    .withMessage('Vaccine type must be anti-rabies, anti-tetanus, or ERIG.'),
  body('brandName').trim().notEmpty().withMessage('Brand name is required.'),
  body('batchNumber').trim().notEmpty().withMessage('Batch number is required.'),
  body('vialsAdded')
    .isInt({ min: 1 })
    .withMessage('Vials added must be at least 1.'),
  body('expirationDate')
    .isISO8601()
    .withMessage('Valid expiration date (YYYY-MM-DD) is required.'),
  handleValidationErrors
];

router.use(verifyAuthenticationToken);
router.use(authorizeRoles('SuperAdmin'));

router.post('/users', staffValidators, createStaffUserAccount);
router.post('/staff', staffValidators, createStaffUserAccount);
router.get('/users', getAllStaffUsers);
router.get('/staff', getAllStaffUsers);
router.put('/staff/:id', staffUpdateValidators, updateStaffUserAccount);
router.patch('/staff/:id/toggle-status', toggleStaffAccountStatus);
router.delete('/staff/:id', deleteStaffUserAccount);

router.post('/inventory', restockValidators, addOrRestockVaccineBatch);
router.post('/inventory/restock', restockValidators, addOrRestockVaccineBatch);
router.post('/inventory/spoilage', logInventorySpoilageOrVoid);
router.post('/inventory/void', logInventorySpoilageOrVoid);
router.get('/inventory', getInventoryStatusAndAlerts);

router.get('/forecast', getPySparkAnalyticsSummary);
router.post('/forecast/recalculate', recalculateMonthlyForecast);
router.get('/analytics-summary', getSystemAuditLogsAndAnalyticsSummary);
router.get('/overview', getSystemAuditLogsAndAnalyticsSummary);
router.get('/audit-logs', getSystemAuditLogsAndAnalyticsSummary);
router.get('/audit-trail', getRecentAuditLogs);
router.get('/dashboard/summary', getDashboardSummary);
router.post('/export-log', logDataExport);

const patientDemographicsValidators = [
  body('fullName').trim().notEmpty().withMessage('Patient full name is required.'),
  body('contactNumber')
    .trim()
    .custom((val) => {
      const digitsOnly = String(val || '').replace(/\D/g, '');
      return /^09\d{9}$/.test(digitsOnly);
    })
    .withMessage('Please enter a valid 11-digit mobile number starting with 09 (e.g., 09171234567).'),
  body('purok').trim().notEmpty().withMessage('Purok address is required.'),
  handleValidationErrors
];

router.get('/patients', getPatientsAndDailyQueue);
router.put('/patients/demographics/:id', patientDemographicsValidators, updatePatientDemographics);
router.patch('/patients/demographics/:id', patientDemographicsValidators, updatePatientDemographics);
router.put('/patients/:id', patientDemographicsValidators, updatePatientDemographics);
router.patch('/patients/:id', patientDemographicsValidators, updatePatientDemographics);

module.exports = router;
