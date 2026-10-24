const mongoose = require('mongoose');

// ito yung lagayan ng forecast na 30 day tsaka 90 day
const inventoryForecastSchema = new mongoose.Schema(
  {
    generatedAt: {
      type: String,
      required: true
    },
    clinicScope: {
      type: String,
      default: 'Barangay Kapitan Pepe, Cabanatuan City'
    },
    vialForecasts: [
      {
        vaccineType: String,
        displayName: String,
        brandSummary: String,
        currentStock: Number,
        safetyThreshold: Number,
        scheduledReturning30d: Number,
        projectedNewWalkIn30d: Number,
        projected30DayDemand: Number,
        projected90DayDemand: Number,
        dailyBurnRate: Number,
        estimatedDaysUntilStockout: Number,
        recommendedRestockQty: Number,
        stockStatus: String
      }
    ],
    categoryBreakdown: [
      {
        category: String,
        clinicalDefinition: String,
        incidentCount: Number,
        sharePercent: Number,
        protocol: String
      }
    ],
    purokBreakdown: [
      {
        purok: String,
        categoryI: Number,
        categoryII: Number,
        categoryIII: Number,
        totalCases: Number,
        primaryVector: String,
        riskLevel: String
      }
    ],
    weeklyTrends: [
      {
        week: String,
        walkIns: Number,
        catIIICases: Number,
        vialsDispensed: Number
      }
    ],
    completionVsDefaulterRates: {
      totalScheduledDosesEvaluated: Number,
      fulfilledCount: Number,
      defaulterCount: Number,
      pendingCount: Number,
      completionRatePercent: Number,
      defaulterRatePercent: Number
    }
  },
  {
    collection: 'inventory_forecasts',
    timestamps: true
  }
);

module.exports = mongoose.model('InventoryForecast', inventoryForecastSchema);
