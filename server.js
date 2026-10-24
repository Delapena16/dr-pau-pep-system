require('dotenv').config();
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const xss = require('xss-clean');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const connectToDatabase = require('./config/db');
const { getPatients } = require('./controllers/receptionistController');
const {
  updatePatientDemographics,
  toggleStaffAccountStatus,
  logInventorySpoilageOrVoid,
  getDashboardSummary,
  getRecentAuditLogs,
  logDataExport
} = require('./controllers/adminController');
const { ensureSettings } = require('./controllers/settingsController');
const { verifyAuthenticationToken } = require('./middleware/authMiddleware');
const { authorizeRoles } = require('./middleware/roleMiddleware');

const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const receptionistRoutes = require('./routes/receptionistRoutes');
const physicianRoutes = require('./routes/physicianRoutes');
const settingsRoutes = require('./routes/settings');

const app = express();

// ito yung pang security ng server, pati yung CSP, wag galawin kundi mawawala yung font
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdn.jsdelivr.net', 'https://accounts.google.com'],
        scriptSrcAttr: ["'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://cdnjs.cloudflare.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:', 'https://cdnjs.cloudflare.com'],
        imgSrc: ["'self'", 'data:', 'https://*.googleusercontent.com'],
        frameSrc: ["'self'", 'https://accounts.google.com'],
        connectSrc: ["'self'", 'https://accounts.google.com', 'https://oauth2.googleapis.com']
      }
    },
    crossOriginOpenerPolicy: { policy: "same-origin-allow-popups" },
    crossOriginEmbedderPolicy: false
  })
);

app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5000',
    credentials: true
  })
);

app.use(express.json({ limit: '15kb' }));
app.use(express.urlencoded({ extended: true, limit: '15kb' }));
app.use(cookieParser());
app.use(xss());

// ito yung anu pang linis ng input na pumapasok para walang bastos na data
app.use(
  mongoSanitize({
    replaceWith: '_'
  })
);

const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 150,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many login attempts. Please wait a few minutes and try again.'
  }
});

const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'Too many requests. Please wait a moment and try again.'
  }
});

app.use('/api/auth', authRateLimiter);
app.use('/api', apiRateLimiter);

// Anti-caching middleware for sensitive clinical and patient records (OWASP & DOH compliance)
const antiCacheMiddleware = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  next();
};

app.use('/api/patients', antiCacheMiddleware);

app.use('/api/auth', authRoutes);
app.use('/api/admin', antiCacheMiddleware, adminRoutes);
app.use('/api/receptionist', antiCacheMiddleware, receptionistRoutes);
app.use('/api/physician', antiCacheMiddleware, physicianRoutes);
app.use('/api/settings', antiCacheMiddleware, settingsRoutes);

// Dynamic patient list endpoint
app.get('/api/patients', verifyAuthenticationToken, authorizeRoles('Receptionist', 'Physician', 'SuperAdmin'), getPatients);

// ito yung direct endpoint para sa pag edit ng pasyente demographic lang
app.put('/api/patients/demographics/:id', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), updatePatientDemographics);
app.patch('/api/patients/demographics/:id', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), updatePatientDemographics);
app.put('/api/patients/:id', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), updatePatientDemographics);
app.patch('/api/patients/:id', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), updatePatientDemographics);

// ito yung toggle route para sa deactivation / reactivation ng staff accounts
app.patch('/api/staff/:id/toggle-status', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), toggleStaffAccountStatus);
app.patch('/api/admin/staff/:id/toggle-status', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), toggleStaffAccountStatus);

// ito yung direct endpoint para sa void o log spoilage ng vials
app.post('/api/inventory/spoilage', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), logInventorySpoilageOrVoid);
app.post('/api/inventory/void', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), logInventorySpoilageOrVoid);

// Live KPI metrics for the Clinic Overview
app.get('/api/dashboard/summary', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), getDashboardSummary);

// Universal audit trail: 50 most recent entries, newest first
app.get('/api/audit-logs', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), getRecentAuditLogs);

// Data-privacy audit event for CSV exports (masked / unmasked)
app.post('/api/admin/export-log', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), logDataExport);
app.post('/api/dashboard/export-log', verifyAuthenticationToken, authorizeRoles('SuperAdmin'), logDataExport);

app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Dr. Pau Animal Bite Center PEP System API is online.',
    data: {
      databaseConnected: mongoose.connection.readyState === 1
    }
  });
});

app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
  })
);

app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route not found: ${req.method} ${req.originalUrl}`
  });
});

app.use((err, req, res, next) => {
  console.error('Server unhandled error:', err.message || err);
  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    success: false,
    error: 'Internal Server Error',
    message: statusCode === 500 ? 'Internal Server Error' : (err.message || 'Internal Server Error')
  });
});

const PORT = process.env.PORT || 5000;

const listenWithPortRecovery = (retried = false) => {
  const server = app.listen(PORT, () => {
    console.log(`Dr. Pau PEP System server running on http://localhost:${PORT}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE' && !retried) {
      try {
        const { execSync } = require('child_process');
        if (process.platform === 'win32') {
          execSync(
            `powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort ${PORT} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -ne ${process.pid} -and $_.OwningProcess -ne 0 } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }"`,
            { stdio: 'ignore' }
          );
        }
        setTimeout(() => listenWithPortRecovery(true), 600);
        return;
      } catch (cleanupErr) {
        // dito banda wala lang, tuloy lang sa baba
      }
    }
    console.error(`Port ${PORT} error:`, err.message);
    process.exit(1);
  });
};

process.on('unhandledRejection', (reason) => {
  console.warn('Unhandled Rejection observed:', reason && reason.message ? reason.message : reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception caught:', err.message);
});

const startServer = async () => {
  await connectToDatabase();
  // Ensure a default system settings document exists (RA 10173 unattended-terminal security).
  try {
    await ensureSettings();
    console.log('System settings initialized.');
  } catch (settingsErr) {
    console.warn('System settings init warning:', settingsErr.message);
  }
  listenWithPortRecovery();
};

if (require.main === module) {
  startServer();
}

module.exports = app;
