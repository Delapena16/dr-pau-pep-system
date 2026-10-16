# Dr. Pau Animal Bite Center — Patient Record & Post-Exposure Prophylaxis (PEP) Management System

A production-ready, student-friendly, humanized **Node.js + Express.js + MongoDB (MVC)** and **Apache PySpark Big Data ETL** codebase engineered for university IT capstone defense.

---

## 1. Modular Project Directory Structure

```text
/dr-pau-pep-system
├── /config
│   └── db.js                       # MongoDB connection pooling, strictQuery & graceful shutdown
├── /models
│   ├── User.js                     # Staff RBAC schema, bcrypt (12 salt rounds) & 5-min MFA OTP
│   ├── Patient.js                  # Embedded exposure & 5-dose PEP schedule with compound indexes
│   ├── Inventory.js                # Cold-chain vaccine & RIG inventory with FEFO indexing
│   └── AuditLog.js                 # Immutable security & clinical audit trail for PySpark ETL
├── /controllers
│   ├── authController.js           # 2-Step MFA login, OTP verification & HttpOnly JWT cookies
│   ├── adminController.js          # Staff provisioning, FEFO restock & executive analytics
│   ├── receptionistController.js   # Walk-in patient registration, indexed search & daily queue
│   └── physicianController.js      # WHO Category I-III triage, calculatePepScheduleDates & FEFO shots
├── /routes
│   ├── authRoutes.js               # /api/auth/* endpoints with express-validator checks
│   ├── adminRoutes.js              # /api/admin/* protected by SuperAdmin RBAC gate
│   ├── receptionistRoutes.js       # /api/receptionist/* protected by Receptionist RBAC gate
│   └── physicianRoutes.js          # /api/physician/* protected by Physician RBAC gate
├── /middleware
│   ├── authMiddleware.js           # Stateless JWT verification from HttpOnly cookies
│   └── roleMiddleware.js           # Strict RBAC enforcement & unauthorized access audit logging
├── /pyspark_etl
│   ├── seed_data.py                # Synthetic patient, PEP schedule & inventory generator
│   ├── etl_analytics.py            # Modular Extract -> Transform -> Load PySpark analytics pipeline
│   ├── benchmark.py                # Multi-scale (1k to 100k records) ETL throughput benchmark
│   └── requirements.txt            # Python & PySpark dependencies
├── /public
│   ├── index.html                  # Clean UI/UX Blueprint (Receptionist, Physician, SuperAdmin)
│   ├── /css/styles.css             # Uncluttered clinical stylesheet
│   └── /js/app.js                  # Frontend logic & 2-Step MFA workflow integration
├── server.js                       # App entry point integrating helmet, rate-limiter & mongo-sanitize
├── package.json                    # Node.js dependencies and scripts
└── .env.example                    # Environment configuration template
```

---

## 2. Security & Compliance Matrix (Modules 05, 06 & 13)

| Security Control | Implementation File | How to Explain It During Your Panel Defense |
| :--- | :--- | :--- |
| **Password Hashing (`bcryptjs`, 12 Salt Rounds)** | `models/User.js` | Plain-text passwords are never stored. A Mongoose `pre('save')` hook automatically salts and hashes passwords with `bcrypt.genSalt(12)` before saving. |
| **2-Step Multi-Factor Authentication (MFA)** | `controllers/authController.js` | Step 1 verifies the password and generates a 6-digit OTP (`generateSixDigitMfaOtp()`) valid for **5 minutes**. Step 2 verifies the OTP and immediately clears it (`mfaOtpCode = null`) to prevent replay attacks. |
| **Stateless JWT in `HttpOnly`, `Secure`, `SameSite=Strict` Cookies** | `controllers/authController.js` & `middleware/authMiddleware.js` | Storing JWTs in `localStorage` is vulnerable to XSS theft. Using `HttpOnly` prevents client-side JS from reading the token, while `SameSite=Strict` blocks cross-site CSRF requests. |
| **Role-Based Access Control (RBAC)** | `middleware/roleMiddleware.js` | Enforces strict privilege boundaries across `SuperAdmin`, `Receptionist`, and `Physician`. Unauthorized access attempts return `403 Forbidden` and write an alert to `AuditLog`. |
| **NoSQL Injection Prevention** | `server.js` (`express-mongo-sanitize`) | Strips prohibited MongoDB operators (`$` and `.`) from `req.body`, `req.query`, and `req.params`, blocking payloads like `{"email": {"$gt": ""}}`. |
| **HTTP Security Headers & CSP** | `server.js` (`helmet`) | Applies Content-Security-Policy (CSP), `X-Frame-Options`, and `X-Content-Type-Options: nosniff` headers. |
| **Brute-Force Rate Limiting** | `server.js` (`express-rate-limit`) | Limits `/api/auth` login/MFA attempts per IP window and locks accounts for 15 minutes after 5 consecutive failed password attempts. |
| **Strict Input Validation** | `routes/*.js` (`express-validator`) | Validates every request field on the server before reaching any controller, returning a standardized `{ success, message, data }` JSON structure. |

---

## 3. Quick Start Guide

### A. Run the Node.js & Express MVC Server
```bash
# 1. Install Node.js dependencies
npm install

# 2. Copy environment variables template
cp .env.example .env

# 3. Start the server
npm start
```
Then open **http://localhost:5000** in your browser to interact with the **Receptionist**, **Physician**, and **SuperAdmin** UI panels and test the **2-Step MFA Login Modal**.

### Default Defense Staff Credentials (Auto-Seeded on First Run)
- **SuperAdmin:** `admin@drpauclinic.ph` / `Admin@12345`
- **Receptionist:** `receptionist@drpauclinic.ph` / `Reception@12345`
- **Physician:** `physician@drpauclinic.ph` / `Physician@12345`

### B. Run the Apache PySpark Big Data ETL Pipeline
```bash
# 1. Generate synthetic patients, 5-dose PEP schedules, and inventory logs
python pyspark_etl/seed_data.py

# 2. Run the modular Extract-Transform-Load (ETL) analytics pipeline
python pyspark_etl/etl_analytics.py

# 3. Run the scalability & throughput benchmark (1,000 to 100,000 records)
python pyspark_etl/benchmark.py
```
