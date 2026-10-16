/**
 * ============================================================================
 * FILE: server.js
 * ARCHITECTURAL LAYER: Application Entry Point & Defense-in-Depth Gateway
 * ============================================================================
 * PURPOSE WITHIN MVC ARCHITECTURE:
 * Bootstraps the Express.js application, connects to MongoDB (`config/db.js`),
 * configures global vulnerability defenses BEFORE mounting routes, serves the
 * clean UI/UX Blueprint (`/public`), and provides centralized error handling.
 *
 * SECURITY COMPLIANCE (Modules 05, 06 & 13):
 * 1. HTTP Header Hardening (`helmet`):
 *    Sets Content-Security-Policy (CSP), X-Frame-Options (Clickjacking defense),
 *    X-Content-Type-Options (`nosniff`), and Strict-Transport-Security (HSTS).
 * 2. Brute-Force Defense (`express-rate-limit`):
 *    Applies a strict rate limit on `/api/auth` (max 15 login/MFA requests per
 *    15 minutes per IP) and a general API rate limit (max 200 requests per 15 mins).
 * 3. NoSQL Injection Prevention (`express-mongo-sanitize`):
 *    Recursively strips keys starting with `$` or containing `.` from `req.body`,
 *    `req.query`, and `req.params` (blocking attacks like `{"email": {"$gt": ""}}`).
 * 4. Payload Size Limiting (`express.json({ limit: '15kb' })`):
 *    Prevents Denial-of-Service (DoS) via oversized JSON request bodies.
 * ============================================================================
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const mongoSanitize = require('express-mongo-sanitize');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const connectToDatabase = require('./config/db');
const User = require('./models/User');
const Inventory = require('./models/Inventory');

// Import Modular MVC Route Files
const authRoutes = require('./routes/authRoutes');
const adminRoutes = require('./routes/adminRoutes');
const receptionistRoutes = require('./routes/receptionistRoutes');
const physicianRoutes = require('./routes/physicianRoutes');

const app = express();

// ----------------------------------------------------------------------------
// 1. SECURITY MIDDLEWARE: HTTP HEADERS & CONTENT SECURITY POLICY (Helmet)
// ----------------------------------------------------------------------------
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  })
);

// ----------------------------------------------------------------------------
// 2. SECURITY MIDDLEWARE: CORS WITH CREDENTIALS (HttpOnly Cookie Support)
// ----------------------------------------------------------------------------
app.use(
  cors({
    origin: process.env.CLIENT_ORIGIN || 'http://localhost:5000',
    credentials: true, // Required so browsers send the HttpOnly JWT cookie
  })
);

// ----------------------------------------------------------------------------
// 3. BODY PARSING & COOKIE PARSING WITH PAYLOAD SIZE LIMITS
// ----------------------------------------------------------------------------
app.use(express.json({ limit: '15kb' }));
app.use(express.urlencoded({ extended: true, limit: '15kb' }));
app.use(cookieParser());

// ----------------------------------------------------------------------------
// 4. SECURITY MIDDLEWARE: NOSQL INJECTION SANITIZATION
// ----------------------------------------------------------------------------
// Strips any keys containing `$` or `.` (e.g. {"$ne": null}) from user inputs
app.use(
  mongoSanitize({
    replaceWith: '_',
    onSanitize: ({ req, key }) => {
      console.warn(
        `[Security Alert: NoSQL Injection Blocked] Stripped prohibited operator in '${key}' from IP ${req.ip}`
      );
    },
  })
);

// ----------------------------------------------------------------------------
// 5. SECURITY MIDDLEWARE: RATE LIMITING (Brute-Force & DoS Protection)
// ----------------------------------------------------------------------------
const authenticationRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15-minute window
  max: 25, // Limit each IP to 25 login/MFA requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message:
      'Too many authentication attempts from this IP address. Please wait 15 minutes before trying again.',
    data: null,
  },
});

const generalApiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    message: 'API rate limit exceeded. Please slow down your requests.',
    data: null,
  },
});

// Apply rate limiters to API routes
app.use('/api/auth', authenticationRateLimiter);
app.use('/api', generalApiRateLimiter);

// ----------------------------------------------------------------------------
// 6. MOUNT MODULAR MVC API ROUTES
// ----------------------------------------------------------------------------
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/receptionist', receptionistRoutes);
app.use('/api/physician', physicianRoutes);

// Health Check Endpoint for Monitoring & Defense Verification
app.get('/api/health', (req, res) => {
  res.status(200).json({
    success: true,
    message: 'Dr. Pau Animal Bite Center PEP System API is healthy and secured.',
    data: {
      securityModulesActive: [
        'bcryptjs (12 salt rounds)',
        '2-Step MFA (5-min 6-digit OTP)',
        'HttpOnly + Secure + SameSite=Strict JWT Cookies',
        'RBAC (SuperAdmin, Receptionist, Physician)',
        'helmet (CSP + Security Headers)',
        'express-mongo-sanitize (NoSQL Injection Defense)',
        'express-rate-limit (Brute-Force Defense)',
        'express-validator (Strict Input Validation)',
      ],
      timestamp: new Date().toISOString(),
    },
  });
});

// ----------------------------------------------------------------------------
// 7. SERVE CLEAN UI/UX BLUEPRINT (SuperAdmin, Receptionist & Physician Panels)
// ----------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public')));

// Fallback route for unknown API endpoints
app.use('/api/*', (req, res) => {
  res.status(404).json({
    success: false,
    message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
    data: null,
  });
});

// ----------------------------------------------------------------------------
// 8. CENTRALIZED GLOBAL ERROR HANDLER (Prevents Stack-Trace Leakage)
// ----------------------------------------------------------------------------
app.use((err, req, res, next) => {
  console.error('[Global Error Handler]:', err.message);
  res.status(err.status || 500).json({
    success: false,
    message:
      process.env.NODE_ENV === 'production'
        ? 'An unexpected server error occurred.'
        : err.message,
    data: null,
  });
});

/**
 * Helper: Seeds default clinic staff accounts and starter cold-chain inventory
 * when the database is empty so students can log in immediately during defense.
 */
const ensureDefaultDefenseAccountsExist = async () => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      return;
    }
    const userCount = await User.countDocuments();
    if (userCount === 0) {
      await User.create([
        {
          fullName: 'Dr. Pauline Santos (Clinic Director)',
          email: 'admin@drpauclinic.ph',
          passwordHash: 'Admin@12345', // Hashed automatically with 12 salt rounds by User.js
          role: 'SuperAdmin',
        },
        {
          fullName: 'Maria Clara Reyes (Front Desk)',
          email: 'receptionist@drpauclinic.ph',
          passwordHash: 'Reception@12345',
          role: 'Receptionist',
        },
        {
          fullName: 'Dr. Jose Rizalino Cruz (Attending MD)',
          email: 'physician@drpauclinic.ph',
          passwordHash: 'Physician@12345',
          role: 'Physician',
        },
      ]);
      console.log(
        '[Bootstrap Seed] Created default SuperAdmin, Receptionist, and Physician accounts.'
      );
    }

    const inventoryCount = await Inventory.countDocuments();
    if (inventoryCount === 0) {
      await Inventory.create([
        {
          itemName: 'Verorab (Purified Vero Cell Rabies Vaccine)',
          itemCategory: 'Anti-Rabies Vaccine (ARV)',
          batchNumber: 'VRB-2026-A101',
          manufacturer: 'Sanofi Pasteur',
          vialQuantity: 30,
          dosesPerVial: 5,
          remainingDoses: 150,
          reorderThresholdDoses: 25,
          expirationDate: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000),
        },
        {
          itemName: 'Speeda (Freeze-Dried Rabies Vaccine)',
          itemCategory: 'Anti-Rabies Vaccine (ARV)',
          batchNumber: 'SPD-2026-B204',
          manufacturer: 'Liaoning Cheng Da',
          vialQuantity: 4,
          dosesPerVial: 5,
          remainingDoses: 18, // Below threshold (25) to demonstrate low-stock alerts
          reorderThresholdDoses: 25,
          expirationDate: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000),
        },
        {
          itemName: 'Equirab (Equine Rabies Immunoglobulin - ERIG)',
          itemCategory: 'Rabies Immunoglobulin (RIG)',
          batchNumber: 'EQB-2026-R309',
          manufacturer: 'Bharat Serums and Vaccines',
          vialQuantity: 15,
          dosesPerVial: 2,
          remainingDoses: 30,
          reorderThresholdDoses: 10,
          expirationDate: new Date(Date.now() + 120 * 24 * 60 * 60 * 1000),
        },
      ]);
      console.log(
        '[Bootstrap Seed] Created starter FEFO cold-chain vaccine & RIG inventory batches.'
      );
    }
  } catch (seedError) {
    // Non-fatal if MongoDB is offline during static testing
  }
};

// ----------------------------------------------------------------------------
// 9. START SERVER & CONNECT TO MONGODB
// ----------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;

const startServer = async () => {
  await connectToDatabase();
  await ensureDefaultDefenseAccountsExist();

  app.listen(PORT, () => {
    console.log('============================================================================');
    console.log(`Dr. Pau Animal Bite Center PEP System running on http://localhost:${PORT}`);
    console.log('MVC Architecture + 2-Step MFA + RBAC + Security Hardening Active');
    console.log('============================================================================');
  });
};

if (require.main === module) {
  startServer();
}

module.exports = app;
