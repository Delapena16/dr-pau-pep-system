// In-memory data store for when MongoDB is unreachable
// Provides demo data so the app remains functional

const inMemoryStore = {
  users: [
    { _id: 'admin@drpauclinic.ph', fullName: 'Dr. Edgar Rivera', email: 'admin@drpauclinic.ph', role: 'SuperAdmin', isActive: true },
    { _id: 'receptionist@drpauclinic.ph', fullName: 'Amen Leaderr', email: 'receptionist@drpauclinic.ph', role: 'Receptionist', isActive: true },
    { _id: 'physician@drpauclinic.ph', fullName: 'Dr. Jose Rizalino Cruz', email: 'physician@drpauclinic.ph', role: 'Physician', isActive: true }
  ],
  patients: [],
  inventory: [
    { _id: '1', vaccineType: 'anti-rabies', brandName: 'Verorab (Purified Vero Cell Rabies Vaccine)', batchNumber: 'VRB-2026-A104', currentStock: 84, lowStockThreshold: 15, expirationDate: '2027-06-30' },
    { _id: '2', vaccineType: 'anti-rabies', brandName: 'Speeda (Purified Vero Cell Vaccine)', batchNumber: 'SPD-2026-C219', currentStock: 42, lowStockThreshold: 15, expirationDate: '2027-08-15' },
    { _id: '3', vaccineType: 'anti-tetanus', brandName: 'Tetavax (Adsorbed Tetanus Toxoid 0.5mL)', batchNumber: 'TTX-2026-B204', currentStock: 36, lowStockThreshold: 10, expirationDate: '2027-03-20' },
    { _id: '4', vaccineType: 'ERIG', brandName: 'Equirab (Equine Rabies Immunoglobulin 200 IU/mL)', batchNumber: 'EQB-2026-R309', currentStock: 7, lowStockThreshold: 10, expirationDate: '2027-05-10' }
  ],
  auditLogs: [],
  staffAccounts: [
    { _id: 'admin@drpauclinic.ph', fullName: 'Dr. Edgar Rivera', email: 'admin@drpauclinic.ph', role: 'SuperAdmin', isActive: true },
    { _id: 'receptionist@drpauclinic.ph', fullName: 'Amen Leaderr', email: 'receptionist@drpauclinic.ph', role: 'Receptionist', isActive: true },
    { _id: 'physician@drpauclinic.ph', fullName: 'Dr. Jose Rizalino Cruz', email: 'physician@drpauclinic.ph', role: 'Physician', isActive: true }
  ],
  isMongoConnected: false
};

// Check if MongoDB is connected
function isMongoAvailable() {
  const mongoose = require('mongoose');
  return mongoose.connection.readyState === 1;
}

module.exports = { inMemoryStore, isMongoAvailable };
