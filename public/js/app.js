function getLocalTodayIso() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}
const todayDateIso = getLocalTodayIso();

const ROLE_NAVIGATION_MAP = {
  Receptionist: [
    { viewId: 'viewRecQueue', label: 'Front Desk Queue' },
    { viewId: 'viewRecIntake', label: 'New Walk-In Intake' },
    { viewId: 'viewRecFollowUp', label: 'Follow-Up Schedule' }
  ],
  Physician: [
    { viewId: 'viewPhysTriage', label: "Doctor's Triage & Dosing" },
    { viewId: 'viewPhysRecords', label: 'Patient PEP Records' },
    { viewId: 'viewPhysInventory', label: 'Vaccine Stock' }
  ],
  SuperAdmin: [
    { viewId: 'viewAdminDashboard', label: 'Clinic Overview' },
    { viewId: 'viewAdminInventory', label: 'Vaccine Stock & Restock' },
    { viewId: 'viewAdminRegistry', label: 'Patient Registry' },
    { viewId: 'viewAdminStaff', label: 'Staff Accounts' }
  ]
};

const WHO_CATEGORY_HINTS = {
  'Category I': 'Wash wound thoroughly for 15 minutes; no vaccine required.',
  'Category II': 'Anti-Rabies vaccine schedule (Days 0, 3, 7, 14, 28).',
  'Category III': 'ERIG wound infiltration + Anti-Rabies schedule (Days 0, 3, 7, 14, 28).'
};

const clinicAppState = {
  authenticatedUser: null,
  activeViewId: '',
  pendingLoginEmail: '',
  selectedPatientId: '',
  recQueueFilter: 'All',
  recFollowUpFilter: 'All',
  physQueueFilter: 'All',
  physRecordsFilter: 'All',
  adminRegistryFilter: 'All',
  pendingModalDose: null,
  patients: [],
  inventory: [],
  staffAccounts: [],
  auditLogs: [],
  dashboardSummary: null,
  forecastData: null
};

// RA 10173 Data Privacy: PHI is displayed in plaintext across all clinic workspaces
// so staff can work with full patient details. Masking is now applied only at
// export time (see exportTableToCSV), based on the format chosen by the SuperAdmin.

// dito nakatabi yung chart, para ma-destroy muna bago gumawa ng bago, iwas hover glitch
let purokChart = null;
let myChart = null;
let exposurePieChart = null;
let weeklyTrendChart = null;
let doseFunnelChart = null;
let peakTrafficChart = null;
let patientMixChart = null;

function showToast(message) {
  const toast = document.getElementById('toastMessage');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => {
    toast.classList.add('hidden');
  }, 4200);
}

function showConfirmDialog({ title, text, icon, confirmButtonText, confirmButtonColor }) {
  if (typeof Swal !== 'undefined') {
    return Swal.fire({
      title,
      text,
      icon: icon || 'warning',
      showCancelButton: true,
      confirmButtonColor: confirmButtonColor || '#2e7d32',
      cancelButtonColor: '#6c757d',
      confirmButtonText: confirmButtonText || 'Yes, proceed'
    }).then((res) => Boolean(res && res.isConfirmed));
  }
  const fallbackConfirmed = typeof confirm !== 'undefined' ? confirm(text || title) : true;
  return Promise.resolve(fallbackConfirmed);
}

function showAlertMessage({ title, text, icon }) {
  if (typeof Swal !== 'undefined') {
    return Swal.fire({
      title,
      text,
      icon: icon || 'info',
      confirmButtonColor: '#2e7d32'
    });
  }
  showToast(text || title);
  return Promise.resolve();
}

function showAuthError(message) {
  const alertEl = document.getElementById('authAlertBanner');
  if (!alertEl) return;
  if (!message) {
    alertEl.classList.add('hidden');
    return;
  }
  alertEl.textContent = message;
  alertEl.classList.remove('hidden');
}

function getCategoryBadgeClass(categoryText) {
  if (categoryText === 'Category III') return 'badge-red';
  if (categoryText === 'Category II') return 'badge-amber';
  if (categoryText === 'Category I') return 'badge-lime';
  return 'badge-amber';
}

function getPatientVisitStatus(patient) {
  if (
    patient.woundCategory === 'Pending' ||
    patient.clinicalStatus === 'Waiting for Doctor' ||
    patient.clinicalStatus === 'Needs Triage'
  ) {
    return { label: 'Needs Triage', badgeClass: 'badge-amber', key: 'Waiting for Doctor' };
  }

  if (patient.clinicalStatus === 'Wound Cleansing Only' || patient.woundCategory === 'Category I') {
    return { label: 'Wound Cleansing Only', badgeClass: 'badge-lime', key: 'Completed' };
  }

  // Overdue Logic: Catch any pending doses where the scheduled date is LESS THAN today's current date.
  // These patients are removed from the "Due Today" list and flagged as Missed / Overdue in red.
  const overduePending = (patient.pepSchedule || []).find(
    (d) => d.status === 'Pending' && String(d.scheduledDate).split('T')[0] < todayDateIso
  );
  const hasDefaulter = (patient.pepSchedule || []).some((d) => d.status === 'Defaulter');
  if (overduePending || hasDefaulter || patient.clinicalStatus === 'Missed Dose') {
    const overdueLabel = overduePending ? `Overdue (${overduePending.doseDay})` : 'Missed / Overdue';
    return { label: overdueLabel, badgeClass: 'badge-red', key: 'Missed Dose' };
  }

  // Due Today Logic: Must strictly match pending doses where the scheduled date is EXACTLY equal to today's current date.
  const dueToday = (patient.pepSchedule || []).find(
    (d) => String(d.scheduledDate).split('T')[0] === todayDateIso && d.status === 'Pending'
  );
  if (dueToday) {
    return { label: `Due Today (${dueToday.doseDay})`, badgeClass: 'badge-purple', key: 'Due Today' };
  }

  const allCompleted =
    (patient.pepSchedule || []).length > 0 &&
    (patient.pepSchedule || []).every((d) => d.status === 'Fulfilled');
  if (allCompleted || patient.clinicalStatus === 'Completed') {
    return { label: 'Completed', badgeClass: 'badge-lime', key: 'Completed' };
  }

  return { label: 'Under Treatment', badgeClass: 'badge-lime', key: 'Under Treatment' };
}

// PHI masking utility (RA 10173 Data Privacy Act compliance).
function maskPHI(text, type) {
  if (!text) return '';
  if (type === 'name') {
    return text.split(' ').map((word) => word.charAt(0) + '*'.repeat(word.length - 1)).join(' ');
  }
  if (type === 'phone') {
    return text.length >= 11 ? text.substring(0, 4) + '***' + text.substring(7) : '***';
  }
  return text;
}

function filterQueueMatch(patient, filterValue, rawSearch) {
  const statusObj = getPatientVisitStatus(patient);

  if (filterValue === "Today's Queue" && statusObj.key !== 'Waiting for Doctor' && statusObj.key !== 'Due Today') {
    return false;
  }
  if (filterValue === "Defaulters (Overdue)" && statusObj.key !== 'Missed Dose') {
    return false;
  }

  const searchVal = (rawSearch || '').toLowerCase().trim();
  if (!searchVal) return true;

  const addr = (patient.purok || patient.barangay || '').toLowerCase();
  const idMatch = (patient.patientId || '').toLowerCase().includes(searchVal);
  const nameMatch = (patient.fullName || '').toLowerCase().includes(searchVal);
  const purokMatch = addr.includes(searchVal);

  return idMatch || nameMatch || purokMatch;
}

function applyCategoryDefaults() {
  const selectEl = document.getElementById('physWoundCategory');
  const hintEl = document.getElementById('physCategoryClinicalHint');
  const vaccineEl = document.getElementById('physVaccineSelect');
  const doseDayEl = document.getElementById('physDoseDaySelect');
  const logDoseBtn = document.getElementById('physAdministerAndTriageBtn');
  const notesOnlyBtn = document.getElementById('physSaveTriageOnlyBtn');
  const cat3Badge = document.getElementById('physCat3ErigBadge');

  if (!selectEl) return;
  const selectedCat = selectEl.value;

  if (hintEl) {
    hintEl.textContent = WHO_CATEGORY_HINTS[selectedCat] || WHO_CATEGORY_HINTS['Category II'];
  }

  if (cat3Badge) {
    cat3Badge.textContent = 'ERIG + Anti-Rabies Required';
    cat3Badge.classList.toggle('hidden', selectedCat !== 'Category III');
  }

  if (selectedCat === 'Category I') {
    if (vaccineEl) vaccineEl.disabled = true;
    if (doseDayEl) doseDayEl.disabled = true;
    if (logDoseBtn) {
      logDoseBtn.disabled = true;
      logDoseBtn.classList.add('hidden');
    }
    if (notesOnlyBtn) {
      notesOnlyBtn.textContent = 'Complete Assessment (No Vaccine Needed)';
      notesOnlyBtn.classList.remove('btn-secondary');
      notesOnlyBtn.classList.add('btn-primary');
    }
  } else {
    if (vaccineEl) vaccineEl.disabled = false;
    if (doseDayEl) doseDayEl.disabled = false;
    if (logDoseBtn) {
      logDoseBtn.disabled = false;
      logDoseBtn.classList.remove('hidden');
    }
    if (notesOnlyBtn) {
      notesOnlyBtn.textContent = 'Save Notes Only';
      notesOnlyBtn.classList.remove('btn-primary');
      notesOnlyBtn.classList.add('btn-secondary');
    }
  }
}

function renderRoleSidebarNavigation(role) {
  const navContainer = document.getElementById('roleSidebarNav');
  const items = ROLE_NAVIGATION_MAP[role] || [];

  document.getElementById('sidebarRoleHeaderLabel').textContent = `${role} Workspace`;

  navContainer.innerHTML = items
    .map(
      (item, idx) => `
      <button
        type="button"
        class="sidebar-nav-item ${idx === 0 ? 'active' : ''}"
        data-nav-target="${item.viewId}"
      >
        <span class="nav-indicator"></span>
        <span class="nav-label">${item.label}</span>
      </button>
    `
    )
    .join('');

  navContainer.querySelectorAll('.sidebar-nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      switchClinicalView(btn.getAttribute('data-nav-target'));
    });
  });

  if (items.length > 0) {
    switchClinicalView(items[0].viewId);
  }
}

function switchClinicalView(targetViewId) {
  clinicAppState.activeViewId = targetViewId;

  document.querySelectorAll('.sidebar-nav-item').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-nav-target') === targetViewId);
  });

  document.querySelectorAll('.ehr-view').forEach((section) => {
    section.classList.toggle('hidden', section.id !== targetViewId);
  });

  if (targetViewId === 'viewAdminDashboard') {
    const scheduleCharts = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    scheduleCharts(() => {
      renderMasterDashboardCharts();
    });
  }
}

// Visual 5-Dose PEP Schedule timeline.
// Renders one node per dose (Day 0 -> Day 28) with a status circle, dose label,
// status text and the scheduled date. For the physician workspace the pending
// nodes stay clickable so a dose can be logged straight from the table.
function buildPepTimelineHtml(patient, interactiveForPhysician = false) {
  const schedule = patient.pepSchedule || [];

  if (!schedule.length) {
    return '<div class="pep-timeline"><span class="timeline-subtext">No PEP schedule yet</span></div>';
  }

  const nodes = schedule
    .map((dose) => {
      const dateStr = String(dose.scheduledDate).split('T')[0];
      const isOverdue = dose.status === 'Pending' && dateStr < todayDateIso;

      let circleState = 'pending';
      let statusLabel = 'Pending';

      if (dose.status === 'Fulfilled') {
        circleState = 'completed';
        statusLabel = 'Completed';
      } else if (dose.status === 'Defaulter') {
        circleState = 'overdue';
        statusLabel = 'Missed';
      } else if (isOverdue) {
        circleState = 'overdue';
        statusLabel = 'Overdue';
      }

      const nodeContent = `
            <span class="circle ${circleState}"></span>
            <span class="node-label">${dose.doseDay}</span>
            <span class="node-status">${statusLabel}</span>
            <span class="timeline-subtext">${dateStr}</span>
      `;

      if (dose.status === 'Pending' && interactiveForPhysician) {
        return `
          <button
            type="button"
            class="node dose-node ${circleState}"
            data-patient-id="${patient.patientId}"
            data-patient-name="${patient.fullName}"
            data-dose-day="${dose.doseDay}"
            title="Log ${dose.doseDay} dose (${dateStr})"
          >${nodeContent}</button>
        `;
      }

      return `
        <span class="node ${circleState}" title="${dose.doseDay}: ${dateStr} [${statusLabel}]">
          ${nodeContent}
        </span>
      `;
    })
    .join('');

  return `<div class="pep-timeline">${nodes}</div>`;
}

// --- Dynamic filter tab counters -------------------------------------------
// Every filter tab carries a badge span (data-count-key) that is refreshed
// whenever a clinical table renders.
const FILTER_TAB_COUNT_GROUPS = [
  'recQueueFilterTabs',
  'recFollowUpFilterTabs',
  'physTriageFilterTabs',
  'physRecordsFilterTabs',
  'adminRegistryFilterTabs'
];

// Counts how many patients fall into each filter category.
// Actionable KPI helpers (client-side fallbacks when the dashboard summary
// endpoint has not been loaded yet).
function countDueToday(patients) {
  const today = todayDateIso;
  let count = 0;
  (patients || []).forEach((p) => {
    if ((p.pepSchedule || []).some((d) => d.status === 'Pending' && String(d.scheduledDate).split('T')[0] === today)) {
      count += 1;
    }
  });
  return count;
}

function countMissedOverdue(patients) {
  const today = todayDateIso;
  let count = 0;
  (patients || []).forEach((p) => {
    if (p.clinicalStatus === 'Missed Dose') { count += 1; return; }
    if ((p.pepSchedule || []).some((d) => d.status === 'Defaulter')) { count += 1; return; }
    if ((p.pepSchedule || []).some((d) => d.status === 'Pending' && String(d.scheduledDate).split('T')[0] < today)) { count += 1; }
  });
  return count;
}

function computePvrvRunway(inventory) {
  const stock = (inventory || [])
    .filter((i) => i.vaccineType === 'anti-rabies')
    .reduce((sum, i) => sum + Number(i.currentStock || 0), 0);

  // Fallback: Days Left = Math.floor(Total PVRV Vials / (30-Day Demand / 30))
  let projected30DayDemand = 0;
  const forecast = clinicAppState.forecastData;
  if (forecast && Array.isArray(forecast.vialForecasts)) {
    const vf = forecast.vialForecasts.find((v) => v.vaccineType === 'anti-rabies');
    if (vf) projected30DayDemand = Number(vf.projected30DayDemand || 0);
  }
  const averageDailyConsumption = projected30DayDemand > 0 ? projected30DayDemand / 30 : 1;
  return Math.max(0, Math.floor(stock / averageDailyConsumption));
}

function countHighSurgePuroks(patients) {
  const counts = {};
  (patients || []).forEach((p) => {
    const key = p.purok || 'Unknown';
    counts[key] = (counts[key] || 0) + 1;
  });
  const values = Object.values(counts);
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.filter((v) => v > mean).length;
}

function countPatientsByCategory(patients) {
  const counts = { all: patients.length, today: 0, overdue: 0 };

  patients.forEach((p) => {
    const statusObj = getPatientVisitStatus(p);

    if (statusObj.key === 'Waiting for Doctor' || statusObj.key === 'Due Today') counts.today += 1;
    if (statusObj.key === 'Missed Dose') counts.overdue += 1;
  });

  return counts;
}

// updateTabCounts(data[, groupId]) -> refreshes the innerText of every
// filter tab badge. Without groupId all filter tab groups are updated.
function updateTabCounts(data, groupId = null) {
  const counts = countPatientsByCategory(data || []);
  const groupIds = groupId ? [groupId] : FILTER_TAB_COUNT_GROUPS;

  groupIds.forEach((id) => {
    const group = document.getElementById(id);
    if (!group) return;

    group.querySelectorAll('[data-count-key]').forEach((badge) => {
      const key = badge.getAttribute('data-count-key');
      if (Object.prototype.hasOwnProperty.call(counts, key)) {
        badge.innerText = String(counts[key]);
      }
    });
  });
}

let idleSessionTimer = null;
let IDLE_TIMEOUT_DURATION = 15 * 60 * 1000; // 15 minutes (default; overridden by system settings)

// Applies a new inactivity timeout (in minutes) and resets the idle timer.
function applySessionTimeout(minutes) {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed < 1) return;
  IDLE_TIMEOUT_DURATION = Math.round(parsed) * 60 * 1000;
  resetIdleTimer();
}

function resetIdleTimer() {
  if (idleSessionTimer) {
    clearTimeout(idleSessionTimer);
  }
  if (!clinicAppState.authenticatedUser) return;

  idleSessionTimer = setTimeout(async () => {
    if (!clinicAppState.authenticatedUser) return;
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (e) {}

    if (idleSessionTimer) clearTimeout(idleSessionTimer);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('pep_auth_token');
      localStorage.removeItem('pep_user_role');
    }
    if (typeof window !== 'undefined' && window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', '/');
    }
    clinicAppState.authenticatedUser = null;
    clinicAppState.pendingLoginEmail = '';
    clinicAppState.selectedPatientId = '';
    const shell = document.getElementById('authenticatedAppShell');
    const auth = document.getElementById('authScreen');
    const s2 = document.getElementById('loginStep2Form');
    const s1 = document.getElementById('loginStep1Form');
    if (shell) shell.classList.add('hidden');
    if (auth) auth.classList.remove('hidden');
    if (s2) s2.classList.add('hidden');
    if (s1) s1.classList.remove('hidden');

    const minutes = Math.round(IDLE_TIMEOUT_DURATION / 60000);
    if (typeof Swal !== 'undefined') {
      Swal.fire({
        title: 'Session Expired',
        text: `Your session has expired after ${minutes} minutes of inactivity for patient privacy and DOH data protection.`,
        icon: 'warning',
        confirmButtonColor: '#2e7d32'
      });
    } else {
      showToast(`Session expired due to ${minutes} minutes of inactivity. Please sign in again.`);
    }
  }, IDLE_TIMEOUT_DURATION);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('mousemove', resetIdleTimer, { passive: true });
  window.addEventListener('keydown', resetIdleTimer, { passive: true });
} else if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('mousemove', resetIdleTimer, { passive: true });
  document.addEventListener('keydown', resetIdleTimer, { passive: true });
}

async function openAuthenticatedRoleWorkspace(user) {
  clinicAppState.authenticatedUser = user;
  resetIdleTimer();

  document.getElementById('authScreen').classList.add('hidden');
  document.getElementById('authenticatedAppShell').classList.remove('hidden');

  document.getElementById('headerUserFullName').textContent = user.fullName;
  document.getElementById('headerUserRoleBadge').textContent = user.role;

  renderRoleSidebarNavigation(user.role);
  await loadRoleAuthorizedData();

  // Load the configured session timeout (SuperAdmin-managed).
  try {
    const savedToken = (typeof localStorage !== 'undefined') ? (localStorage.getItem('token') || localStorage.getItem('pep_auth_token')) : null;
    const settingsRes = await fetch('/api/settings', {
      headers: savedToken ? { 'Authorization': `Bearer ${savedToken}` } : {}
    });
    if (settingsRes.ok) {
      const sJson = await settingsRes.json();
      if (sJson && sJson.data && sJson.data.inactivityTimeoutMinutes) {
        applySessionTimeout(sJson.data.inactivityTimeoutMinutes);
        const select = document.getElementById('sessionTimeout');
        if (select) select.value = String(sJson.data.inactivityTimeoutMinutes);
      }
    }
  } catch (err) {
    // dito banda wala lang, default 15 minutes na lang
  }
}

// Fetches the live dashboard KPIs from the database and refreshes the four
// top KPI boxes of the Clinic Overview.
async function loadDashboardSummary() {
  try {
    const res = await fetch('/api/dashboard/summary');
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.data) return null;

    clinicAppState.dashboardSummary = json.data;

    const setKpi = (id, value) => {
      const el = document.getElementById(id);
      if (el) el.textContent = value;
    };

    // Actionable Executive KPI boxes
    setKpi('adminKpiDueToday', json.data.patientsDueToday || 0);
    setKpi('adminKpiMissedDoses', json.data.missedOverdueDoses || 0);
    setKpi('adminKpiStockRunway', `${json.data.pvrvStockRunwayDays || 0} Days`);
    const runwayMeta = document.getElementById('adminKpiStockRunwayMeta');
    if (runwayMeta) {
      const vialCount = json.data.pvrvStock != null ? json.data.pvrvStock : 129;
      runwayMeta.textContent = `${vialCount} vials on hand`;
    }
    setKpi('adminKpiSurgePuroks', json.data.highSurgePuroks || 0);

    // Backwards-compatible fallback bindings
    setKpi('adminKpiPatients', json.data.patientsDueToday || json.data.activePatients || 0);
    setKpi('adminKpiRabies', json.data.pvrvStock || 129);
    setKpi('adminKpiErig', json.data.erigStock || 0);
    setKpi('adminKpiStaffCount', json.data.activeStaff || 0);

    return json.data;
  } catch (err) {
    console.warn('Could not load dashboard summary:', err.message);
    return null;
  }
}

async function loadRoleAuthorizedData() {
  const user = clinicAppState.authenticatedUser;
  if (!user) return;
  try {
    if (user.role === 'Receptionist') {
      const res = await fetch('/api/receptionist/patients');
      if (res.ok) {
        const json = await res.json();
        clinicAppState.patients = (json.data && json.data.patients) || [];
      }
      renderReceptionistViews();
    } else if (user.role === 'Physician') {
      const [patRes, invRes] = await Promise.all([
        fetch('/api/physician/patients'),
        fetch('/api/physician/inventory')
      ]);
      if (patRes.ok) {
        const pJson = await patRes.json();
        clinicAppState.patients = (pJson.data && pJson.data.patients) || [];
      }
      if (invRes.ok) {
        const iJson = await invRes.json();
        clinicAppState.inventory = (iJson.data && iJson.data.inventory) || [];
      }
      renderPhysicianViews();
    } else if (user.role === 'SuperAdmin') {
      const [patRes, summaryRes, usersRes, dashRes] = await Promise.all([
        fetch('/api/admin/patients'),
        fetch('/api/admin/analytics-summary'),
        fetch('/api/admin/users'),
        fetch('/api/dashboard/summary')
      ]);

      if (patRes.ok) {
        const pJson = await patRes.json();
        clinicAppState.patients = (pJson.data && pJson.data.patients) || [];
      }
      if (summaryRes.ok) {
        const sJson = await summaryRes.json();
        if (sJson.data) {
          clinicAppState.inventory = sJson.data.inventory || [];
          clinicAppState.auditLogs = sJson.data.recentAuditLogs || [];
          clinicAppState.forecastData = sJson.data.pySparkAnalytics || null;
        }
      }
      if (usersRes.ok) {
        const uJson = await usersRes.json();
        clinicAppState.staffAccounts = (uJson.data && uJson.data.staffAccounts) || [];
      }
      if (dashRes.ok) {
        const dJson = await dashRes.json();
        if (dJson.data) {
          clinicAppState.dashboardSummary = dJson.data;
        }
      }
      renderSuperAdminViews();
    }
  } catch (err) {
    console.warn('Error loading workspace data:', err.message);
  }
}

function renderReceptionistViews() {
  const patients = clinicAppState.patients || [];
  const queueSearchVal = document.getElementById('recQueueSearchInput')?.value || '';
  const followSearchVal = document.getElementById('recFollowUpSearchInput')?.value || '';

  let waitingCount = 0;
  let dueTodayCount = 0;
  let missedCount = 0;

  patients.forEach((p) => {
    const statusObj = getPatientVisitStatus(p);
    if (statusObj.key === 'Waiting for Doctor') waitingCount += 1;
    if (statusObj.key === 'Due Today') dueTodayCount += 1;
    if (statusObj.key === 'Missed Dose') missedCount += 1;
  });

  document.getElementById('recKpiWaitingDoctor').textContent = waitingCount;
  document.getElementById('recKpiDueToday').textContent = dueTodayCount;
  document.getElementById('recKpiTotalPatients').textContent = patients.length;
  document.getElementById('recKpiMissedCount').textContent = missedCount;

  // Dynamic filter tab counters
  updateTabCounts(patients, 'recQueueFilterTabs');
  updateTabCounts(patients, 'recFollowUpFilterTabs');

  const filteredQueue = patients.filter((p) =>
    filterQueueMatch(p, clinicAppState.recQueueFilter, queueSearchVal)
  );

  const frontDeskBody = document.getElementById('recFrontDeskTableBody');
  frontDeskBody.innerHTML = filteredQueue
    .map((p) => {
      const statusObj = getPatientVisitStatus(p);
      const addr = p.purok || p.barangay || 'Brgy. Kapitan Pepe';
      const biteDate = String(p.day0WalkInDate).split('T')[0];
      const isAlreadyQueued = p.checkedInForTriage || p.woundCategory === 'Pending';

      const actionHtml = isAlreadyQueued
        ? `<span class="badge badge-lime">Checked In</span>`
        : `<button type="button" class="btn btn-secondary btn-sm icon-btn btn-checkin-patient" data-patient-id="${p.patientId}" title="Check In patient" aria-label="Check In patient"><i class="fas fa-clipboard-check"></i></button>`;

      return `
        <tr data-patient-id="${p.patientId}">
          <td class="col-id"><strong>${p.patientId}</strong></td>
          <td>
            <strong>${p.fullName}</strong> (${p.age}y / ${p.sex})
            <span class="cell-sub">${addr} • <span class="mono-num">${p.contactNumber}</span></span>
          </td>
          <td>
            <strong>${p.animalType}</strong> — ${p.biteSite}
            <span class="cell-sub">${p.biteStatus || 'Bite Exposure'}</span>
          </td>
          <td class="num-col mono-num">${biteDate}</td>
          <td><span class="badge ${statusObj.badgeClass}">${statusObj.label}</span></td>
          <td>${actionHtml}</td>
        </tr>
      `;
    })
    .join('');

  const followPatients = patients.filter((p) =>
    filterQueueMatch(p, clinicAppState.recFollowUpFilter, followSearchVal)
  );

  const followBody = document.getElementById('recFollowUpTableBody');
  followBody.innerHTML = followPatients
    .map((p) => {
      const addr = p.purok || p.barangay || 'Brgy. Kapitan Pepe';
      const isQueued = p.checkedInForTriage;
      const btnHtml = isQueued
        ? `<span class="badge badge-lime">Checked In</span>`
        : `<button type="button" class="btn btn-primary btn-sm icon-btn btn-checkin-patient" data-patient-id="${p.patientId}" title="Check In patient" aria-label="Check In patient"><i class="fas fa-clipboard-check"></i></button>`;

      return `
        <tr data-patient-id="${p.patientId}">
          <td class="col-id"><strong>${p.patientId}</strong></td>
          <td>
            <strong>${p.fullName}</strong>
            <span class="cell-sub mono-num">${p.contactNumber}</span>
          </td>
          <td>${addr}</td>
          <td>${buildPepTimelineHtml(p, false)}</td>
          <td>${btnHtml}</td>
        </tr>
      `;
    })
    .join('');
}

async function checkInPatient(patientId) {
  try {
    const response = await fetch(`/api/receptionist/checkin/${patientId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' }
    });
    const result = await response.json();
    if (!response.ok) {
      showToast(result.message || 'Could not check in patient.');
      return;
    }
    showToast(`Checked in ${result.data?.patientRecord?.fullName || patientId}`);
    await loadRoleAuthorizedData();
  } catch (err) {
    showToast('Network error during check-in.');
  }
}

window.checkInPatient = checkInPatient;
window.checkInPatientForDoctor = checkInPatient;

function renderPhysicianViews() {
  const patients = clinicAppState.patients || [];
  const inventory = clinicAppState.inventory || [];

  const waitingCount = patients.filter((p) => p.woundCategory === 'Pending').length;
  const dueTodayCount = patients.filter((p) =>
    (p.pepSchedule || []).some(
      (d) => String(d.scheduledDate).split('T')[0] === todayDateIso && d.status === 'Pending'
    )
  ).length;
  const cat3Count = patients.filter((p) => p.woundCategory === 'Category III').length;
  const rabiesStock = inventory
    .filter((i) => i.vaccineType === 'anti-rabies')
    .reduce((sum, i) => sum + Number(i.currentStock || 0), 0);

  document.getElementById('physKpiWaiting').textContent = waitingCount;
  document.getElementById('physKpiDueToday').textContent = dueTodayCount;
  document.getElementById('physKpiCat3').textContent = cat3Count;
  document.getElementById('physKpiRabiesVials').textContent = rabiesStock;

  // Dynamic filter tab counters
  updateTabCounts(patients, 'physTriageFilterTabs');
  updateTabCounts(patients, 'physRecordsFilterTabs');

  const queueSearchVal = document.getElementById('physQueueSearchInput')?.value || '';
  const filteredTriageQueue = patients.filter((p) =>
    filterQueueMatch(p, clinicAppState.physQueueFilter, queueSearchVal)
  );

  if (!clinicAppState.selectedPatientId && patients.length > 0) {
    clinicAppState.selectedPatientId = patients[0].patientId;
  }

  const triageBody = document.getElementById('physTriageQueueBody');
  triageBody.innerHTML = filteredTriageQueue
    .map((p) => {
      const isSelected = p.patientId === clinicAppState.selectedPatientId;
      const catBadge = getCategoryBadgeClass(p.woundCategory);
      const catText = p.woundCategory === 'Pending' ? 'Needs Triage' : p.woundCategory;
      const addr = p.purok || p.barangay || 'Brgy. Kapitan Pepe';
      const nextPending = (p.pepSchedule || []).find((d) => d.status === 'Pending');
      const nextLabel = nextPending
        ? `${nextPending.doseDay} (${String(nextPending.scheduledDate).split('T')[0]})`
        : 'Completed';

      return `
        <tr class="patient-row ${isSelected ? 'active-row' : ''}" data-patient-id="${p.patientId}">
          <td class="col-id"><strong>${p.patientId}</strong></td>
          <td>
            <strong>${p.fullName}</strong> (${p.age}y / ${p.sex})
            <span class="cell-sub">${addr}</span>
          </td>
          <td>
            <strong>${p.animalType}</strong>
            <span class="cell-sub">${p.biteSite}</span>
          </td>
          <td><span class="badge ${catBadge}">${catText}</span></td>
          <td class="mono-num">${nextLabel}</td>
          <td>
            <button
              type="button"
              class="btn btn-secondary btn-sm icon-btn btn-assess-triage"
              data-patient-id="${p.patientId}"
              title="Assess / Triage"
              aria-label="Assess / Triage"
            >
              <i class="fas fa-stethoscope"></i>
            </button>
          </td>
        </tr>
      `;
    })
    .join('');

  if (clinicAppState.selectedPatientId) {
    selectPatient(clinicAppState.selectedPatientId, false);
  }

  const recordsSearchVal = document.getElementById('physSearchInput')?.value || '';
  const filteredRecords = patients.filter((p) =>
    filterQueueMatch(p, clinicAppState.physRecordsFilter, recordsSearchVal)
  );

  const recordsBody = document.getElementById('physRecordsTableBody');
  recordsBody.innerHTML = filteredRecords
    .map((p) => {
      const catBadge = getCategoryBadgeClass(p.woundCategory);
      const catText = p.woundCategory === 'Pending' ? 'Needs Triage' : p.woundCategory;
      const addr = p.purok || p.barangay || 'Brgy. Kapitan Pepe';
      return `
        <tr data-patient-id="${p.patientId}">
          <td class="col-id"><strong>${p.patientId}</strong></td>
          <td>
            <strong>${p.fullName}</strong> (${p.age}y, ${p.sex})
            <span class="cell-sub">${addr} • <span class="mono-num">${p.contactNumber}</span></span>
          </td>
          <td>
            <strong>${p.animalType} — ${p.biteSite}</strong>
            <span class="cell-sub">${p.clinicalNotes || 'Awaiting physician notes'}</span>
          </td>
          <td><span class="badge ${catBadge}">${catText}</span></td>
          <td>${buildPepTimelineHtml(p, true)}</td>
        </tr>
      `;
    })
    .join('');

  const roBody = document.getElementById('physReadOnlyInventoryBody');
  roBody.innerHTML = inventory
    .map((item) => {
      const expStr = String(item.expirationDate).split('T')[0];
      const isExpired = expStr < todayDateIso;
      const threshold = item.lowStockThreshold || 10;
      const isLow = item.currentStock <= threshold;

      let badgeClass = isLow ? 'badge-red' : 'badge-lime';
      let statusText = isLow ? 'Low Stock' : 'In Stock';
      if (isExpired) {
        badgeClass = 'badge-red badge-expired';
        statusText = 'EXPIRED';
      }

      return `
        <tr>
          <td><strong>${item.vaccineType}</strong></td>
          <td>${item.brandName}</td>
          <td class="num-col mono-num"><strong>${item.batchNumber}</strong></td>
          <td class="num-col tabular-num"><strong class="${isExpired || isLow ? 'text-red' : ''}">${item.currentStock}</strong></td>
          <td class="num-col tabular-num">${threshold}</td>
          <td class="num-col mono-num ${isExpired ? 'text-red' : ''}">${expStr}</td>
          <td><span class="badge ${badgeClass}">${statusText}</span></td>
        </tr>
      `;
    })
    .join('');
}

function selectPatient(patientId, flashCard = true) {
  const patient = (clinicAppState.patients || []).find((p) => p.patientId === patientId);
  if (!patient) return;

  clinicAppState.selectedPatientId = patient.patientId;

  document.querySelectorAll('#physTriageQueueBody tr.patient-row').forEach((row) => {
    row.classList.toggle('active-row', row.getAttribute('data-patient-id') === patient.patientId);
  });

  document.getElementById('physSelectedPatientId').value = patient.patientId;
  document.getElementById('physWoundCategory').value =
    patient.woundCategory === 'Pending' ? 'Category II' : patient.woundCategory;
  document.getElementById('physAllergyNotes').value =
    patient.allergyNotes === 'Pending Physician Assessment'
      ? 'Negative equine skin test; no known drug allergies'
      : patient.allergyNotes || '';
  document.getElementById('physClinicalNotes').value = patient.clinicalNotes || '';

  const nextPending = (patient.pepSchedule || []).find((d) => d.status === 'Pending');
  if (nextPending) {
    document.getElementById('physDoseDaySelect').value = nextPending.doseDay;
  } else {
    document.getElementById('physDoseDaySelect').value = 'Day 0';
  }

  applyCategoryDefaults();

  const statusObj = getPatientVisitStatus(patient);
  const addr = patient.purok || patient.barangay || 'Brgy. Kapitan Pepe';
  const nextDoseText = nextPending ? nextPending.doseDay : 'Completed';

  document.getElementById('physActivePatientBanner').innerHTML = `
    <div><strong>${patient.fullName}</strong> (<span class="mono-num">${patient.patientId}</span>) — ${patient.age}y / ${patient.sex}</div>
    <div class="cell-sub">${addr} • Exposure: <strong>${patient.animalType}</strong> on <strong>${patient.biteSite}</strong> (${patient.biteStatus || 'Bite'})</div>
    <div style="margin-top:4px;">Status: <span class="badge ${statusObj.badgeClass}">${statusObj.label}</span> • Next Dose: <strong class="mono-num">${nextDoseText}</strong></div>
  `;

  if (flashCard) {
    const formCard = document.getElementById('physTriageFormCard');
    if (formCard) {
      formCard.classList.add('card-flash-focus');
      clearTimeout(window._cardFlashTimer);
      window._cardFlashTimer = setTimeout(() => {
        formCard.classList.remove('card-flash-focus');
      }, 450);
    }
  }
}

window.selectPatient = selectPatient;
window.selectPatientForTriage = selectPatient;

// ito yung pang drawing ng bar chart ng kagat kada purok, galing sa purokBreakdown ng forecast
// Shared ordering for the purok breakdown: highest total cases first, so the
// stacked bar chart and the summary table below it stay perfectly aligned.
function getSortedPurokRows(forecast) {
  return ((forecast && forecast.purokBreakdown) || [])
    .slice()
    .sort((a, b) => {
      const totalDiff = Number(b.totalCases || 0) - Number(a.totalCases || 0);
      if (totalDiff !== 0) return totalDiff;
      return String(a.purok).localeCompare(String(b.purok), undefined, { numeric: true });
    });
}

// Keeps the full Kapitan Pepe purok label so the chart axis and table rows
// explicitly reflect the Barangay Kapitan Pepe scope.
function formatPurokLabel(purok) {
  return String(purok || '').trim();
}

// Stacked Bar Chart: Bite Incidents by Purok (Barangay Kapitan Pepe)
function renderPurokChart() {
  const canvas = document.getElementById('purokChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (purokChart) {
    purokChart.destroy();
    purokChart = null;
  }
  if (myChart) {
    myChart.destroy();
    myChart = null;
  }

  const ctxPurok = canvas.getContext('2d');
  purokChart = new Chart(ctxPurok, {
    type: 'bar',
    data: {
      labels: [
        'Purok 1, Kapitan Pepe',
        'Purok 6, Kapitan Pepe',
        'Purok 3, Kapitan Pepe',
        'Purok 2, Kapitan Pepe',
        'Purok 4, Kapitan Pepe',
        'Purok 5, Kapitan Pepe',
        'Purok 7, Kapitan Pepe'
      ],
      datasets: [
        { label: 'Category I', backgroundColor: '#cddc39', data: [6, 4, 5, 4, 3, 5, 2] },
        { label: 'Category II', backgroundColor: '#ff9800', data: [24, 19, 18, 15, 12, 11, 9] },
        { label: 'Category III', backgroundColor: '#f44336', data: [14, 12, 7, 5, 4, 3, 2] }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0 },
          title: { display: true, text: 'Bite Incidents' }
        }
      },
      plugins: {
        tooltip: {
          callbacks: {
            footer: (tooltipItems) => {
              let total = 0;
              tooltipItems.forEach((item) => {
                total += item.parsed.y;
              });
              return 'Total Cases: ' + total;
            }
          }
        },
        legend: { position: 'bottom' }
      }
    }
  });
  myChart = purokChart;
}

const renderAnalyticsChart = renderPurokChart;

// Pie / Doughnut chart: Exposure Category Summary (Category I, II, III case shares)
function renderExposurePieChart(forecast) {
  const canvas = document.getElementById('exposurePieChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (exposurePieChart) {
    exposurePieChart.destroy();
    exposurePieChart = null;
  }
  const rows = ((forecast && forecast.categoryBreakdown) || []).slice();
  const labels = rows.length ? rows.map((r) => r.category || 'Unknown') : ['Category I', 'Category II', 'Category III'];
  const data = rows.length ? rows.map((r) => Number(r.sharePercent || r.incidentCount || 0)) : [15.8, 58.7, 25.5];
  const ctxExposure = canvas.getContext('2d');
  exposurePieChart = new Chart(ctxExposure, {
    type: 'doughnut',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Exposure Category Case Share',
          data: data,
          backgroundColor: ['#cddc39', '#ff9800', '#f44336'],
          borderColor: '#FFFFFF',
          borderWidth: 2,
          hoverOffset: 16
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '70%',
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 14, font: { family: 'IBM Plex Sans', size: 12 } }
        },
        tooltip: {
          callbacks: {
            label: function(context) {
              const val = context.raw != null ? context.raw : context.parsed;
              return `${context.label}: ${val}% of cases`;
            }
          }
        }
      }
    }
  });
}

// Line graph: Weekly Walk-Ins vs Vials Used
function renderWeeklyTrendGraph(forecast) {
  const canvas = document.getElementById('weeklyTrendGraph');
  if (!canvas || typeof Chart === 'undefined') return;
  if (weeklyTrendChart) {
    weeklyTrendChart.destroy();
    weeklyTrendChart = null;
  }
  const rows = ((forecast && forecast.weeklyTrends) || []).slice();
  const ctxTrend = canvas.getContext('2d');
  // Mixed combo chart: Walk-Ins as bars (left axis) + Vials Used as a line (right axis).
  weeklyTrendChart = new Chart(ctxTrend, {
    type: 'bar',
    data: {
      labels: rows.length
        ? rows.map((r) => {
            const match = String(r.week).match(/W(\d+)/);
            return match ? `W${match[1]}` : String(r.week);
          })
        : ['W38', 'W39', 'W40', 'W41'],
      datasets: [
        {
          type: 'bar',
          label: 'Walk-Ins',
          data: rows.length ? rows.map((r) => Number(r.walkIns || 0)) : [38, 42, 49, 55],
          backgroundColor: '#7C3AED', // Solid purple for bars
          yAxisID: 'yWalkIns',
          borderRadius: 4,
          maxBarThickness: 35, // Restricts bar width
          categoryPercentage: 0.5 // Adds breathing room between bars
        },
        {
          type: 'line',
          label: 'Vials Used',
          data: rows.length ? rows.map((r) => Number(r.vialsDispensed || 0)) : [114, 129, 148, 172],
          borderColor: '#4caf50', // Green line
          backgroundColor: '#4caf50',
          borderWidth: 3,
          tension: 0.3, // Slight curve
          yAxisID: 'yVials',
          pointBackgroundColor: '#fff',
          pointRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'bottom',
          labels: { boxWidth: 14, font: { family: 'IBM Plex Sans', size: 12 } }
        },
        tooltip: { mode: 'index', intersect: false }
      },
      scales: {
        x: {
          display: true,
          title: { display: true, text: 'Week' },
          ticks: { font: { family: 'IBM Plex Sans', size: 12 } }
        },
        // Dual Y axes: walk-ins are much lower than vial counts, so a single
        // axis would flatten the walk-in line.
        yWalkIns: {
          type: 'linear',
          position: 'left',
          beginAtZero: true,
          title: { display: true, text: 'Total Walk-Ins' },
          ticks: { precision: 0, font: { family: 'IBM Plex Mono', size: 11 } }
        },
        yVials: {
          type: 'linear',
          position: 'right',
          beginAtZero: true,
          title: { display: true, text: 'Vials Consumed' },
          ticks: { precision: 0, font: { family: 'IBM Plex Mono', size: 11 } },
          grid: { drawOnChartArea: false }
        }
      }
    }
  });
}

// Horizontal funnel bar chart: patient dose completion (Day 0 -> Day 28) over
// the last 90 days. Drop-off indicates missed doses and clinical non-compliance.
function renderDoseCompletionFunnel() {
  const canvas = document.getElementById('doseFunnelChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (doseFunnelChart) {
    doseFunnelChart.destroy();
    doseFunnelChart = null;
  }

  const summary = clinicAppState.dashboardSummary || {};
  const completion = Array.isArray(summary.doseCompletion) && summary.doseCompletion.length === 5
    ? summary.doseCompletion
    : [0, 0, 0, 0, 0];

  doseFunnelChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['Day 0 (Initial)', 'Day 3', 'Day 7', 'Day 14', 'Day 28'],
      datasets: [
        {
          label: 'Completed Doses',
          data: completion,
          backgroundColor: ['#4caf50', '#8bc34a', '#cddc39', '#ffeb3b', '#ff9800'],
          borderRadius: 4
        }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0 },
          title: { display: true, text: 'Patients Completed' }
        }
      },
      plugins: {
        title: { display: true, text: 'Drop-off indicates missed doses & non-compliance' }
      }
    }
  });
}

// Bar chart: Peak Clinic Traffic by Day of Week (staff scheduling).
function renderPeakTrafficChart() {
  const canvas = document.getElementById('peakTrafficChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (peakTrafficChart) {
    peakTrafficChart.destroy();
    peakTrafficChart = null;
  }

  const summary = clinicAppState.dashboardSummary || {};
  const data = Array.isArray(summary.peakTrafficByDay) && summary.peakTrafficByDay.length === 7
    ? summary.peakTrafficByDay
    : [0, 0, 0, 0, 0, 0, 0];

  peakTrafficChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      datasets: [
        {
          label: 'Patient Visits',
          data: data,
          backgroundColor: '#7C3AED',
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: {
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0 },
          title: { display: true, text: 'Patient Visits' }
        }
      },
      plugins: {
        title: { display: true, text: 'Peak Clinic Traffic by Day' }
      }
    }
  });
}

// Stacked bar chart: Daily Patient Mix (New vs. Returning) over the last 7 days.
function renderPatientMixChart() {
  const canvas = document.getElementById('patientMixChart');
  if (!canvas || typeof Chart === 'undefined') return;
  if (patientMixChart) {
    patientMixChart.destroy();
    patientMixChart = null;
  }

  const summary = clinicAppState.dashboardSummary || {};
  const mix = summary.patientMix || { labels: [], new: [], returning: [] };

  patientMixChart = new Chart(canvas, {
    type: 'bar',
    data: {
      labels: mix.labels || [],
      datasets: [
        {
          label: 'New Patients',
          data: mix.new || [],
          backgroundColor: '#7C3AED',
          borderRadius: 4
        },
        {
          label: 'Returning Patients',
          data: mix.returning || [],
          backgroundColor: '#4caf50',
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true },
        y: {
          stacked: true,
          beginAtZero: true,
          ticks: { stepSize: 1, precision: 0 },
          title: { display: true, text: 'Total Patients' }
        }
      },
      plugins: {
        title: { display: true, text: 'Daily Patient Mix: New vs. Returning' }
      }
    }
  });
}

// Renders the unified Clinic Overview: executive KPIs, inventory health,
// visual epidemiological analytics and the system audit trail.
// All Chart.js instances for this view are (re)initialized here.
function renderMasterDashboard() {
  const patients = clinicAppState.patients || [];
  const inventory = clinicAppState.inventory || [];
  const auditLogs = clinicAppState.auditLogs || [];
  const staff = clinicAppState.staffAccounts || [];
  const forecast = clinicAppState.forecastData;

  const sumByType = (type) =>
    inventory
      .filter((i) => i.vaccineType === type)
      .reduce((acc, i) => acc + Number(i.currentStock || 0), 0);

  // Live actionable metrics from /api/dashboard/summary take precedence.
  const live = clinicAppState.dashboardSummary;
  const dueToday = live ? live.patientsDueToday : countDueToday(patients);
  const missed = live ? live.missedOverdueDoses : countMissedOverdue(patients);
  const runway = live ? live.pvrvStockRunwayDays : computePvrvRunway(inventory);
  const surge = live ? live.highSurgePuroks : countHighSurgePuroks(patients);

  const dueEl = document.getElementById('adminKpiDueToday');
  if (dueEl) dueEl.textContent = dueToday;
  const missedEl = document.getElementById('adminKpiMissedDoses');
  if (missedEl) missedEl.textContent = missed;
  const runwayEl = document.getElementById('adminKpiStockRunway');
  if (runwayEl) runwayEl.textContent = `${runway} Days`;
  const runwayMeta = document.getElementById('adminKpiStockRunwayMeta');
  if (runwayMeta) {
    const vialCount = live ? live.pvrvStock : (inventory || []).filter((i) => i.vaccineType === 'anti-rabies').reduce((s, i) => s + Number(i.currentStock || 0), 0);
    runwayMeta.textContent = `${vialCount} vials on hand`;
  }
  const surgeEl = document.getElementById('adminKpiSurgePuroks');
  if (surgeEl) surgeEl.textContent = surge;

  // Dynamic filter tab counters
  updateTabCounts(patients, 'adminRegistryFilterTabs');

  const auditBody = document.getElementById('adminOverviewAuditBody');
  auditBody.innerHTML = auditLogs
    .slice(0, 50)
    .map((log) => {
      const timeStr = new Date(log.timestamp).toISOString().replace('T', ' ').slice(0, 16);
      return `
        <tr>
          <td class="num-col mono-num">${timeStr}</td>
          <td><span class="badge badge-purple">${log.actorRole}</span></td>
          <td><strong>${log.actionType}</strong></td>
          <td>${log.description}</td>
        </tr>
      `;
    })
    .join('');

  const overviewStockBody = document.getElementById('adminOverviewStockBody');
  overviewStockBody.innerHTML = inventory
    .map((item) => {
      const expStr = String(item.expirationDate).split('T')[0];
      const isExpired = expStr < todayDateIso;
      const threshold = item.lowStockThreshold || 10;
      const isLow = item.currentStock <= threshold;

      let badgeClass = isLow ? 'badge-red' : 'badge-lime';
      let statusText = isLow ? 'Low Stock' : 'In Stock';
      if (isExpired) {
        badgeClass = 'badge-red badge-expired';
        statusText = 'EXPIRED';
      }

      return `
        <tr>
          <td>
            <strong>${item.vaccineType}</strong>
            <span class="cell-sub">${item.brandName} • <span class="mono-num">${item.batchNumber}</span></span>
          </td>
          <td class="num-col tabular-num"><strong class="${isExpired || isLow ? 'text-red' : ''}">${item.currentStock}</strong></td>
          <td class="num-col mono-num ${isExpired ? 'text-red' : ''}">${expStr}</td>
          <td><span class="badge ${badgeClass}">${statusText}</span></td>
        </tr>
      `;
    })
    .join('');

  if (forecast) {
    document.getElementById('forecastVialsTableBody').innerHTML = (
      forecast.vialForecasts || []
    )
      .map((vf) => {
        const isCritical = vf.stockStatus === 'CRITICAL RESTOCK';
        const badgeClass = isCritical
          ? 'badge-red'
          : vf.stockStatus === 'REORDER SOON'
          ? 'badge-amber'
          : 'badge-lime';

        return `
          <tr>
            <td>
              <strong>${vf.displayName}</strong>
              <span class="cell-sub">${vf.brandSummary}</span>
            </td>
            <td class="num-col tabular-num"><strong class="${isCritical ? 'text-red' : ''}">${vf.currentStock}</strong></td>
            <td class="num-col tabular-num">${vf.scheduledReturning30d}</td>
            <td class="num-col tabular-num">${vf.projectedNewWalkIn30d}</td>
            <td class="num-col tabular-num"><strong>${vf.projected30DayDemand}</strong></td>
            <td class="num-col tabular-num">${vf.projected90DayDemand}</td>
            <td class="num-col tabular-num"><strong class="${vf.estimatedDaysUntilStockout <= 10 ? 'text-red' : ''}">${vf.estimatedDaysUntilStockout}d</strong></td>
            <td class="num-col tabular-num"><strong>+${vf.recommendedRestockQty}</strong></td>
            <td><span class="badge ${badgeClass}">${vf.stockStatus}</span></td>
          </tr>
        `;
      })
      .join('');

    document.getElementById('forecastWeeklyTableBody').innerHTML = (
      forecast.weeklyTrends || []
    )
      .map(
        (w) => `
        <tr>
          <td class="mono-num"><strong>${w.week}</strong></td>
          <td class="num-col tabular-num">${w.walkIns}</td>
          <td class="num-col tabular-num"><strong class="text-red">${w.catIIICases}</strong></td>
          <td class="num-col tabular-num"><strong>${w.vialsDispensed}</strong></td>
        </tr>
      `
      )
      .join('');
  }

  // Always schedule a clean render of all 6 Clinic Overview master analytics charts
  const scheduleCharts = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
  scheduleCharts(() => {
    renderMasterDashboardCharts();
  });
}

// Orchestrates initialization/refresh of all 6 Clinic Overview master analytics charts:
// 1. Purok Bite Incidents (Stacked Bar)
// 2. Exposure Category Summary (Doughnut)
// 3. Weekly Walk-Ins vs Vials Consumed (Combo Bar + Line)
// 4. PEP Regimen Compliance / Defaulter Drop-off (Horizontal Funnel Bar)
// 5. Peak Clinic Traffic by Day (Bar)
// 6. Daily Patient Mix (Stacked Bar)
function renderMasterDashboardCharts() {
  const adminView = document.getElementById('viewAdminDashboard');
  if (adminView && adminView.classList.contains('hidden')) {
    return;
  }

  const forecast = clinicAppState.forecastData;

  renderPurokChart();
  renderExposurePieChart(forecast);
  renderWeeklyTrendGraph(forecast);
  renderDoseCompletionFunnel();
  renderPeakTrafficChart();
  renderPatientMixChart();
}

// Renders the remaining SuperAdmin views (vaccine stock, patient registry, staff accounts).
function renderSuperAdminViews() {
  renderMasterDashboard();

  const patients = clinicAppState.patients || [];
  const inventory = clinicAppState.inventory || [];
  const staff = clinicAppState.staffAccounts || [];

  const invTableBody = document.getElementById('adminInventoryTableBody');
  invTableBody.innerHTML = inventory
    .map((item) => {
      const expStr = String(item.expirationDate).split('T')[0];
      const isExpired = expStr < todayDateIso;
      const threshold = item.lowStockThreshold || 10;
      const isLow = item.currentStock <= threshold;

      let badgeClass = isLow ? 'badge-red' : 'badge-lime';
      let statusText = isLow ? 'Low Stock' : 'In Stock';
      if (isExpired) {
        badgeClass = 'badge-red badge-expired';
        statusText = 'EXPIRED';
      }

      return `
        <tr>
          <td><strong>${item.vaccineType}</strong></td>
          <td>${item.brandName}</td>
          <td class="num-col mono-num"><strong>${item.batchNumber}</strong></td>
          <td class="num-col tabular-num"><strong class="${isExpired || isLow ? 'text-red' : ''}">${item.currentStock}</strong></td>
          <td class="num-col tabular-num">${threshold}</td>
          <td class="num-col mono-num ${isExpired ? 'text-red' : ''}">${expStr}</td>
          <td><span class="badge ${badgeClass}">${statusText}</span></td>
          <td>
            <button
              type="button"
              class="btn btn-secondary btn-sm admin-void-spoilage-btn"
              data-batch-id="${item._id}"
              data-batch-lot="${item.batchNumber}"
              data-current-stock="${item.currentStock}"
              data-vaccine-type="${item.vaccineType}"
              data-brand-name="${item.brandName}"
              ${item.currentStock <= 0 ? 'disabled style="opacity:0.5;cursor:not-allowed;"' : ''}
            >
              Write-Off / Void
            </button>
          </td>
        </tr>
      `;
    })
    .join('');

  const regSearchVal = document.getElementById('adminRegistrySearchInput')?.value || '';
  const filteredRegistry = patients.filter((p) =>
    filterQueueMatch(p, clinicAppState.adminRegistryFilter, regSearchVal)
  );

  const regBody = document.getElementById('adminRegistryTableBody');
  regBody.innerHTML = filteredRegistry
    .map((p) => {
      const catBadge = getCategoryBadgeClass(p.woundCategory);
      const catText = p.woundCategory === 'Pending' ? 'Needs Triage' : p.woundCategory;
      const addr = p.purok || p.barangay || 'Brgy. Kapitan Pepe';
      return `
        <tr>
          <td class="col-id"><strong>${p.patientId}</strong></td>
          <td>
            <strong>${p.fullName}</strong> (${p.age}y, ${p.sex})
            <span class="cell-sub">${addr} • <span class="mono-num">${p.contactNumber}</span></span>
          </td>
          <td>
            <strong>${p.animalType} — ${p.biteSite}</strong>
            <span class="cell-sub">${p.clinicalNotes || 'Needs Triage'}</span>
          </td>
          <td><span class="badge ${catBadge}">${catText}</span></td>
          <td>${buildPepTimelineHtml(p, false)}</td>
          <td>
            <div class="row-actions">
              <button
                type="button"
                class="btn btn-secondary btn-sm icon-btn admin-view-patient-btn"
                data-patient-id="${p.patientId}"
                title="View Details"
                aria-label="View confidential patient record"
              >
                <i class="fas fa-eye"></i>
              </button>
              <button
                type="button"
                class="btn btn-secondary btn-sm icon-btn admin-edit-patient-btn"
                data-patient-id="${p.patientId}"
                title="Edit patient record"
                aria-label="Edit patient record"
              >
                <i class="fas fa-pen"></i>
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  const staffBody = document.getElementById('adminStaffTableBody');
  const selfId = clinicAppState.authenticatedUser && clinicAppState.authenticatedUser.userId;
  staffBody.innerHTML = staff
    .map((u) => {
      const isActive = u.isActive !== false;
      const statusBadge = isActive
        ? '<span class="badge badge-lime">Active</span>'
        : '<span class="badge badge-red">Deactivated</span>';
      const toggleActionClass = isActive ? 'staff-deactivate' : 'staff-reactivate';
      const toggleActionLabel = isActive ? 'Deactivate' : 'Reactivate';

      return `
      <tr>
        <td><strong>${u.fullName}</strong></td>
        <td>${u.email}</td>
        <td><span class="badge badge-purple">${u.role}</span></td>
        <td>${statusBadge}</td>
        <td>
          <div class="staff-actions">
            <button type="button" class="staff-edit" data-staff-id="${u._id}">Edit</button>
            ${
              String(u._id) === String(selfId)
                ? ''
                : `
                <button type="button" class="staff-toggle-btn ${toggleActionClass}" data-staff-id="${u._id}" data-active="${isActive}">
                  ${toggleActionLabel}
                </button>
              `
            }
          </div>
        </td>
      </tr>
    `;
    })
    .join('');
}

function setStaffFormMode(staffMember) {
  const editing = Boolean(staffMember);
  document.getElementById('staffEditId').value = editing ? staffMember._id : '';
  document.getElementById('staffFullName').value = editing ? staffMember.fullName : '';
  document.getElementById('staffEmail').value = editing ? staffMember.email : '';
  document.getElementById('staffRole').value = editing ? staffMember.role : 'Receptionist';
  const pw = document.getElementById('staffPassword');
  pw.value = '';
  pw.required = !editing;
  pw.placeholder = editing ? 'Leave blank to keep current' : 'Minimum 8 characters';
  document.getElementById('staffPasswordLabel').textContent = editing
    ? 'New Password (optional)'
    : 'Password (min 8 chars) *';
  document.getElementById('staffFormHeading').textContent = editing
    ? 'Edit Staff Account'
    : 'Add Staff Account';
  document.getElementById('submitCreateStaffBtn').textContent = editing
    ? 'Save Changes'
    : 'Create Staff Account';
}

function openDoseModal(patientId, fullName, doseDay) {
  clinicAppState.pendingModalDose = { patientId, fullName, doseDay };
  document.getElementById('doseModalTitle').textContent =
    `Log ${doseDay} Dose — ${fullName} (${patientId})`;
  document.getElementById('doseConfirmationModal').classList.remove('hidden');
}

window.openDoseModal = openDoseModal;
window.openDoseConfirmationModal = openDoseModal;

// --- Confidential Patient Record modal (read-only) -------------------------
// Sanitizes patient data before it is injected into the modal markup.
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Maps a PEP dose onto the modal status classes.
function getDoseModalStatus(dose) {
  const dateStr = String(dose.scheduledDate).split('T')[0];
  const isOverdue = dose.status === 'Pending' && dateStr < todayDateIso;

  if (dose.status === 'Fulfilled') {
    return { dateStr, state: 'completed', label: 'Completed', dot: 'dot-completed' };
  }
  if (dose.status === 'Defaulter') {
    return { dateStr, state: 'missed', label: 'Missed', dot: 'dot-missed' };
  }
  if (isOverdue) {
    return { dateStr, state: 'missed', label: 'Overdue', dot: 'dot-missed' };
  }
  return { dateStr, state: 'pending', label: 'Pending', dot: 'dot-pending' };
}

// Maps the visit status badge onto the modal status color classes.
function getStatusBadgeState(statusObj) {
  if (!statusObj) return 'pending';
  if (statusObj.badgeClass === 'badge-red') return 'missed';
  if (statusObj.badgeClass === 'badge-lime') return 'completed';
  return 'pending';
}

// Builds the full read-only record markup for a single patient.
function buildPatientRecordHtml(patient) {
  const statusObj = getPatientVisitStatus(patient);
  const addr = patient.purok || patient.barangay || 'Brgy. Kapitan Pepe';
  const exposureDate = String(patient.day0WalkInDate || '').split('T')[0] || '—';
  const schedule = patient.pepSchedule || [];

  const header = `
    <div class="modal-patient-header">
      <div class="modal-subtitle">Confidential Patient Record</div>
      <div class="modal-patient-name">${escapeHtml(patient.fullName || 'Unknown Patient')}</div>
      <div class="modal-patient-meta">
        ${escapeHtml(patient.patientId || '')} &bull; ${escapeHtml(patient.age || '—')}y &bull;
        ${escapeHtml(patient.sex || '—')} &bull; ${escapeHtml(addr)}
      </div>
      <div class="modal-badge-top status-badge ${getStatusBadgeState(statusObj)}">
        ${escapeHtml(statusObj.label)}
      </div>
    </div>
  `;

  const infoGrid = `
    <div class="modal-info-grid">
      <div class="info-group">
        <label>Registry ID</label>
        <span class="mono-num">${escapeHtml(patient.patientId || '—')}</span>
      </div>
      <div class="info-group">
        <label>Full Name</label>
        <span>${escapeHtml(patient.fullName || '—')}</span>
      </div>
      <div class="info-group">
        <label>Age / Sex</label>
        <span>${escapeHtml(patient.age || '—')} years old &bull; ${escapeHtml(patient.sex || '—')}</span>
      </div>
      <div class="info-group">
        <label>Contact Number</label>
        <span class="mono-num">${escapeHtml(patient.contactNumber || '—')}</span>
      </div>
      <div class="info-group">
        <label>Address (Purok / Barangay)</label>
        <span>${escapeHtml(addr)}</span>
      </div>
      <div class="info-group">
        <label>Exposure Date</label>
        <span class="mono-num">${escapeHtml(exposureDate)}</span>
      </div>
      <div class="info-group">
        <label>Animal Type / Bite Site</label>
        <span>${escapeHtml(patient.animalType || '—')} &bull; ${escapeHtml(patient.biteSite || '—')}</span>
      </div>
      <div class="info-group">
        <label>Bite Status</label>
        <span>${escapeHtml(patient.biteStatus || 'Bite Exposure')}</span>
      </div>
      <div class="info-group">
        <label>WHO Wound Category</label>
        <span>${escapeHtml(patient.woundCategory || 'Pending')}</span>
      </div>
      <div class="info-group">
        <label>Clinical Status</label>
        <span>${escapeHtml(patient.clinicalStatus || statusObj.label)}</span>
      </div>
    </div>
  `;

  const notes = `
    <div class="info-group" style="margin-bottom: 20px; text-align: left;">
      <label>Clinical Notes</label>
      <span>${escapeHtml(patient.clinicalNotes || 'Awaiting physician notes.')}</span>
    </div>
  `;

  const timelineItems = schedule.length
    ? schedule
        .map((dose) => {
          const doseStatus = getDoseModalStatus(dose);
          return `
            <div class="vertical-timeline-item">
              <div class="timeline-left">
                <span class="timeline-dot ${doseStatus.dot}"></span>
                <span>${escapeHtml(dose.doseDay)}</span>
              </div>
              <div class="row-actions">
                <span class="timeline-date">${escapeHtml(doseStatus.dateStr)}</span>
                <span class="status-badge ${doseStatus.state}">${escapeHtml(doseStatus.label)}</span>
              </div>
            </div>
          `;
        })
        .join('')
    : '<div class="vertical-timeline-item"><span class="timeline-date">No PEP schedule recorded yet.</span></div>';

  const pepCard = `
    <div class="pep-vertical-card">
      <h4>5-Dose PEP Schedule</h4>
      <p>Post-exposure prophylaxis series &bull; Day 0 &rarr; Day 28</p>
      ${timelineItems}
    </div>
  `;

  return header + infoGrid + notes + pepCard;
}

// Copies text to the clipboard (with a fallback for non-secure contexts).
function copyTextToClipboard(text) {
  const value = String(text == null ? '' : text);
  if (!value) return Promise.resolve(false);

  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    return navigator.clipboard
      .writeText(value)
      .then(() => true)
      .catch(() => copyTextToClipboardFallback(value));
  }

  return Promise.resolve(copyTextToClipboardFallback(value));
}

function copyTextToClipboardFallback(text) {
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-1000px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textarea);
    return copied;
  } catch (e) {
    return false;
  }
}

// Opens the read-only confidential patient record modal (SweetAlert2).
function openPatientRecordModal(patientId) {
  const patient = (clinicAppState.patients || []).find(
    (p) => p.patientId === patientId || String(p._id) === patientId
  );
  if (!patient) return;

  const registryId = patient.registryId || patient.patientId || '';

  Swal.fire({
    html: buildPatientRecordHtml(patient),
    width: '640px',
    padding: '18px',
    showConfirmButton: true,
    confirmButtonText: 'Close Record',
    confirmButtonColor: '#7C3AED',
    showCancelButton: true,
    cancelButtonText: '<i class="far fa-copy"></i> Copy Registry ID',
    cancelButtonColor: '#6c757d',
    reverseButtons: true, // "Close" on the right, "Copy" on the left
    customClass: {
      popup: 'patient-record-popup',
      htmlContainer: 'patient-record-body'
    }
  }).then((result) => {
    // Copy action (the cancel button).
    if (result.dismiss === Swal.DismissReason.cancel) {
      copyTextToClipboard(registryId).then((copied) => {
        Swal.fire({
          toast: true,
          position: 'top-end',
          icon: copied ? 'success' : 'error',
          title: copied ? 'Registry ID Copied!' : 'Unable to copy Registry ID.',
          showConfirmButton: false,
          timer: 1500
        });
      });
    }
  });
}

function closePatientRecordModal() {
  if (typeof Swal !== 'undefined' && Swal.isVisible()) {
    Swal.close();
  }
}

window.openPatientRecordModal = openPatientRecordModal;
window.closePatientRecordModal = closePatientRecordModal;

// ito yung helper para magbukas at mag-populate ng Edit Patient modal (demographics lang)
function openEditPatientModal(patient) {
  if (!patient) return;
  const modal = document.getElementById('editPatientModal');
  const idInput = document.getElementById('editPatientId');
  const nameInput = document.getElementById('editPatientName');
  const phoneInput = document.getElementById('editPatientPhone');
  const purokSelect = document.getElementById('editPatientPurok');

  if (!modal || !idInput || !nameInput || !phoneInput || !purokSelect) return;

  idInput.value = patient.patientId || patient._id || '';
  nameInput.value = patient.fullName || '';
  phoneInput.value = patient.contactNumber || '';

  const patientPurok = patient.purok || patient.barangay || 'Purok 1, Kapitan Pepe';
  let matched = false;
  for (let i = 0; i < purokSelect.options.length; i++) {
    if (purokSelect.options[i].value === patientPurok) {
      purokSelect.selectedIndex = i;
      matched = true;
      break;
    }
  }
  if (!matched) {
    const opt = document.createElement('option');
    opt.value = patientPurok;
    opt.textContent = patientPurok;
    purokSelect.appendChild(opt);
    purokSelect.value = patientPurok;
  }

  modal.classList.remove('hidden');
}

function closeEditPatientModal() {
  const modal = document.getElementById('editPatientModal');
  if (modal) modal.classList.add('hidden');
  const form = document.getElementById('editPatientForm');
  if (form) form.reset();
}

window.openEditPatientModal = openEditPatientModal;
window.closeEditPatientModal = closeEditPatientModal;


async function submitModalDoseDecision(doseAdministered) {
  const modalContext = clinicAppState.pendingModalDose;
  if (!modalContext) return;

  const vaccineType = document.getElementById('modalVaccineSelect').value;

  if (doseAdministered) {
    const availableVials = (clinicAppState.inventory || [])
      .filter((i) => i.vaccineType === vaccineType)
      .reduce((sum, i) => sum + Number(i.currentStock || 0), 0);

    if (availableVials <= 0) {
      document.getElementById('doseConfirmationModal').classList.add('hidden');
      clinicAppState.pendingModalDose = null;
      showAlertMessage({
        title: 'Out of Stock',
        text: 'Cannot log dose: Selected vaccine batch is out of stock. Please notify Admin.',
        icon: 'error'
      });
      return;
    }
  }

  const confirmTitle = doseAdministered ? 'Confirm Dose Administration' : 'Confirm Dose Defaulted';
  const confirmText = doseAdministered
    ? `Record administration of ${modalContext.doseDay} (${vaccineType}) for ${modalContext.patientName || modalContext.patientId}? This will deduct 1 vial from clinic inventory.`
    : `Mark ${modalContext.doseDay} as Missed / Defaulted for ${modalContext.patientName || modalContext.patientId}?`;

  const confirmed = await showConfirmDialog({
    title: confirmTitle,
    text: confirmText,
    icon: doseAdministered ? 'question' : 'warning',
    confirmButtonText: doseAdministered ? 'Yes, record dose' : 'Yes, mark defaulted',
    confirmButtonColor: doseAdministered ? '#2e7d32' : '#d32f2f'
  });
  if (!confirmed) return;

  try {
    const response = await fetch(
      `/api/physician/patients/${modalContext.patientId}/schedule`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          doseDay: modalContext.doseDay,
          doseAdministered,
          vaccineType
        })
      }
    );
    const result = await response.json();

    document.getElementById('doseConfirmationModal').classList.add('hidden');
    clinicAppState.pendingModalDose = null;

    if (!response.ok) {
      showAlertMessage({
        title: 'Dose Update Failed',
        text: result.message || 'Could not process dose.',
        icon: 'error'
      });
      return;
    }

    showAlertMessage({
      title: 'Dose Recorded',
      text: result.message || `${modalContext.doseDay} recorded successfully.`,
      icon: 'success'
    });
    await loadRoleAuthorizedData();
  } catch (err) {
    showToast('Network error while recording dose.');
  }
}

function filterQueue(scope, filterValue) {
  if (scope === 'recQueue') {
    clinicAppState.recQueueFilter = filterValue;
    document.querySelectorAll('#recQueueFilterTabs .filter-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-rec-queue-filter') === filterValue);
    });
    document.querySelectorAll('[data-rec-kpi-filter]').forEach((card) => {
      card.classList.toggle('active-kpi', card.getAttribute('data-rec-kpi-filter') === filterValue);
    });
    renderReceptionistViews();
  } else if (scope === 'physQueue') {
    clinicAppState.physQueueFilter = filterValue;
    document.querySelectorAll('#physTriageFilterTabs .filter-tab').forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-phys-queue-filter') === filterValue);
    });
    document.querySelectorAll('[data-phys-kpi-filter]').forEach((card) => {
      card.classList.toggle('active-kpi', card.getAttribute('data-phys-kpi-filter') === filterValue);
    });
    renderPhysicianViews();
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  const biteDateInput = document.getElementById('biteDate');
  if (biteDateInput) {
    biteDateInput.value = todayDateIso;
    biteDateInput.max = todayDateIso;
  }

  const restockExpInput = document.getElementById('restockExpiry');
  if (restockExpInput) {
    restockExpInput.value = '2027-09-30';
    restockExpInput.min = todayDateIso;
  }

  applyCategoryDefaults();

  document.querySelectorAll('[data-jump-nav]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetView = btn.getAttribute('data-jump-nav');
      const focusInputId = btn.getAttribute('data-focus-input');
      if (targetView) {
        switchClinicalView(targetView);
      }
      if (focusInputId) {
        const focusEl = document.getElementById(focusInputId);
        if (focusEl) focusEl.focus();
      }
    });
  });

  document.querySelectorAll('[data-rec-kpi-filter]').forEach((card) => {
    card.addEventListener('click', () => {
      const targetFilter = card.getAttribute('data-rec-kpi-filter');
      const nextFilter =
        clinicAppState.recQueueFilter === targetFilter && targetFilter !== 'All'
          ? 'All'
          : targetFilter;
      filterQueue('recQueue', nextFilter);
    });
  });

  document.querySelectorAll('[data-phys-kpi-filter]').forEach((card) => {
    card.addEventListener('click', () => {
      const targetFilter = card.getAttribute('data-phys-kpi-filter');
      const nextFilter =
        clinicAppState.physQueueFilter === targetFilter ? 'All' : targetFilter;
      filterQueue('physQueue', nextFilter);
    });
  });

  document.getElementById('recFrontDeskTableBody').addEventListener('click', (e) => {
    const checkinBtn = e.target.closest('.btn-checkin-patient');
    if (checkinBtn) {
      const pid = checkinBtn.getAttribute('data-patient-id');
      if (pid) checkInPatient(pid);
    }
  });

  document.getElementById('recFollowUpTableBody').addEventListener('click', (e) => {
    const checkinBtn = e.target.closest('.btn-checkin-patient');
    if (checkinBtn) {
      const pid = checkinBtn.getAttribute('data-patient-id');
      if (pid) checkInPatient(pid);
    }
  });

  document.getElementById('physTriageQueueBody').addEventListener('click', (e) => {
    const targetEl = e.target.closest('.btn-assess-triage, tr.patient-row');
    if (!targetEl) return;
    const pid = targetEl.getAttribute('data-patient-id');
    if (pid) selectPatient(pid, true);
  });

  document.getElementById('physRecordsTableBody').addEventListener('click', (e) => {
    const doseBtn = e.target.closest('button.dose-node.pending');
    if (doseBtn) {
      const pid = doseBtn.getAttribute('data-patient-id');
      const pname = doseBtn.getAttribute('data-patient-name') || pid;
      const dday = doseBtn.getAttribute('data-dose-day');
      if (pid && dday) openDoseModal(pid, pname, dday);
    }
  });

  document.getElementById('loginStep1Form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');

    const email = document.getElementById('loginEmail').value.trim().toLowerCase();
    const password = document.getElementById('loginPassword').value;

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      const result = await response.json();

      if (!response.ok) {
        showAuthError(result.message || 'Invalid clinic email or password. Please check your credentials.');
        return;
      }

      if (result.data && result.data.user && result.data.token) {
        if (typeof localStorage !== 'undefined') {
          localStorage.setItem('pep_auth_token', result.data.token);
          localStorage.setItem('pep_user_role', result.data.user.role);
          localStorage.setItem('token', result.data.token);
          localStorage.setItem('role', result.data.user.role);
        }
        await openAuthenticatedRoleWorkspace(result.data.user);
        showToast(`Signed in as ${result.data.user.fullName} (${result.data.user.role})`);
        return;
      }

      clinicAppState.pendingLoginEmail = email;
      document.getElementById('mfaTargetEmailDisplay').textContent = email;
      document.getElementById('loginOtpCode').value = '';

      document.getElementById('loginStep1Form').classList.add('hidden');
      document.getElementById('loginStep2Form').classList.remove('hidden');
      document.getElementById('loginOtpCode').focus();
    } catch (err) {
      showAuthError('Unable to reach authentication server.');
    }
  });

  document.getElementById('backToStep1Btn').addEventListener('click', () => {
    showAuthError('');
    clinicAppState.pendingLoginEmail = '';
    document.getElementById('loginOtpCode').value = '';
    document.getElementById('loginStep2Form').classList.add('hidden');
    document.getElementById('loginStep1Form').classList.remove('hidden');
  });

  document.getElementById('loginStep2Form').addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthError('');

    const email = clinicAppState.pendingLoginEmail;
    const otpCode = document.getElementById('loginOtpCode').value.trim();

    try {
      const response = await fetch('/api/auth/verify-mfa', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, otpCode })
      });
      const result = await response.json();

      if (!response.ok) {
        showAuthError(result.message || 'Invalid verification code. Please try again.');
        if (result.lockedOut) {
          document.getElementById('loginStep2Form').classList.add('hidden');
          document.getElementById('loginStep1Form').classList.remove('hidden');
        }
        return;
      }

      await openAuthenticatedRoleWorkspace(result.data.user);
      showToast(`Signed in as ${result.data.user.fullName} (${result.data.user.role})`);
    } catch (err) {
      showAuthError('Error verifying security code.');
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (err) {
      // ito yung anu pang linis ng data ng dating user para walang matira
    }

    if (idleSessionTimer) clearTimeout(idleSessionTimer);
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('pep_auth_token');
      localStorage.removeItem('pep_user_role');
    }
    if (typeof window !== 'undefined' && window.history && typeof window.history.replaceState === 'function') {
      window.history.replaceState(null, '', '/');
    }
    clinicAppState.authenticatedUser = null;
    clinicAppState.pendingLoginEmail = '';
    clinicAppState.selectedPatientId = '';
    document.getElementById('authenticatedAppShell').classList.add('hidden');
    document.getElementById('authScreen').classList.remove('hidden');
    document.getElementById('loginStep2Form').classList.add('hidden');
    document.getElementById('loginStep1Form').classList.remove('hidden');
    document.getElementById('loginPassword').value = '';
    document.getElementById('loginOtpCode').value = '';
    showAuthError('');
    showToast('Signed out of clinic workspace.');
  });

  document.getElementById('recQueueSearchInput').addEventListener('input', () => {
    renderReceptionistViews();
  });

  document.getElementById('recFollowUpSearchInput').addEventListener('input', () => {
    renderReceptionistViews();
  });

  document.querySelectorAll('#recQueueFilterTabs .filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      filterQueue('recQueue', tab.getAttribute('data-rec-queue-filter'));
    });
  });

  document.querySelectorAll('#recFollowUpFilterTabs .filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document
        .querySelectorAll('#recFollowUpFilterTabs .filter-tab')
        .forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      clinicAppState.recFollowUpFilter = tab.getAttribute('data-rec-filter');
      renderReceptionistViews();
    });
  });

  document.getElementById('resetWalkInFormBtn').addEventListener('click', () => {
    document.getElementById('walkInForm').reset();
    const biteInput = document.getElementById('biteDate');
    if (biteInput) {
      biteInput.value = todayDateIso;
      biteInput.max = todayDateIso;
    }
    document.getElementById('regConsentCheckbox').checked = true;
    showToast('Walk-in form reset.');
  });

  // Restrict mobile number to numbers only and max 11 digits starting with 09
  const mobileInput = document.getElementById('mobileNumber');
  if (mobileInput) {
    mobileInput.setAttribute('pattern', '^09[0-9]{9}$');
    mobileInput.addEventListener('input', function (e) {
      this.value = this.value.replace(/[^0-9]/g, '').slice(0, 11);
      if (typeof this.setCustomValidity === 'function') this.setCustomValidity('');
    });
  }

  // Restrict full name to letters, spaces, periods, and hyphens only
  const nameInput = document.getElementById('patientName');
  if (nameInput) {
    nameInput.setAttribute('pattern', '^[a-zA-ZÀ-ÿ\\s\\.\\-]+$');
    nameInput.addEventListener('input', function (e) {
      this.value = this.value.replace(/[^a-zA-ZÀ-ÿ\s\.\-]/g, '');
      if (typeof this.setCustomValidity === 'function') this.setCustomValidity('');
    });
  }

  document.getElementById('walkInForm').addEventListener('submit', async function (event) {
    event.preventDefault();

    const nameEl = document.getElementById('patientName');
    const phoneEl = document.getElementById('mobileNumber');
    if (nameEl && typeof nameEl.setCustomValidity === 'function') {
      const nv = nameEl.value.trim();
      if (!nv || !/^[a-zA-ZÀ-ÿ\s.\-]+$/.test(nv)) {
        nameEl.setCustomValidity('Letters, spaces, dots, and hyphens only.');
      } else {
        nameEl.setCustomValidity('');
      }
    }
    if (phoneEl && typeof phoneEl.setCustomValidity === 'function') {
      const pv = phoneEl.value.trim();
      if (!pv || !/^09[0-9]{9}$/.test(pv)) {
        phoneEl.setCustomValidity('Must be 11 digits starting with 09 (e.g., 09123456789)');
      } else {
        phoneEl.setCustomValidity('');
      }
    }

    // Force native HTML5 red warning popups before running custom logic
    if (typeof this.checkValidity === 'function' && !this.checkValidity()) {
      if (typeof this.reportValidity === 'function') this.reportValidity();
      return; // Instantly kill the function so SweetAlert does not fire
    }

    const ageVal = Number(document.getElementById('regAge').value);
    const rawPhone = document.getElementById('mobileNumber').value.trim();
    const digitsOnly = rawPhone.replace(/\D/g, '');
    const purokVal = document.getElementById('regBarangay').value;
    const biteInput = document.getElementById('biteDate');
    const biteDateVal = biteInput ? biteInput.value : todayDateIso;
    const payload = {
      fullName: document.getElementById('patientName').value.trim(),
      age: ageVal,
      sex: document.getElementById('regSex').value,
      contactNumber: digitsOnly,
      purok: purokVal,
      barangay: purokVal,
      day0WalkInDate: biteDateVal,
      animalType: document.getElementById('regAnimalType').value,
      biteSite: document.getElementById('regBiteSite').value.trim(),
      consentGiven: document.getElementById('regConsentCheckbox').checked
    };

    const response = await fetch('/api/receptionist/patients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      showAlertMessage({
        title: 'Registration Failed',
        text: result.message || 'Could not register walk-in patient.',
        icon: 'error'
      });
      return;
    }

    if (typeof this.reset === 'function') {
      this.reset();
    } else if (event.target && typeof event.target.reset === 'function') {
      event.target.reset();
    }
    if (biteInput) {
      biteInput.value = todayDateIso;
      biteInput.max = todayDateIso;
    }
    document.getElementById('regConsentCheckbox').checked = true;

    await loadRoleAuthorizedData();
    switchClinicalView('viewRecQueue');
    showAlertMessage({
      title: 'Patient Registered',
      text: result.message || `Added ${payload.fullName} to Doctor's Queue`,
      icon: 'success'
    });
  });

  document.getElementById('physQueueSearchInput').addEventListener('input', () => {
    renderPhysicianViews();
  });

  document.getElementById('physSearchInput').addEventListener('input', () => {
    renderPhysicianViews();
  });

  document.querySelectorAll('#physTriageFilterTabs .filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      filterQueue('physQueue', tab.getAttribute('data-phys-queue-filter'));
    });
  });

  document.querySelectorAll('#physRecordsFilterTabs .filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document
        .querySelectorAll('#physRecordsFilterTabs .filter-tab')
        .forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      clinicAppState.physRecordsFilter = tab.getAttribute('data-phys-rec-filter');
      renderPhysicianViews();
    });
  });

  document.getElementById('physWoundCategory').addEventListener('change', () => {
    applyCategoryDefaults();
  });

  document.getElementById('resetPhysTriageFormBtn').addEventListener('click', () => {
    document.getElementById('physWoundCategory').value = 'Category II';
    document.getElementById('physDoseDaySelect').value = 'Day 0';
    document.getElementById('physVaccineSelect').value = 'anti-rabies';
    document.getElementById('physAllergyNotes').value = '';
    document.getElementById('physClinicalNotes').value = '';
    applyCategoryDefaults();
    showToast('Triage form reset.');
  });

  async function submitTriage(administerDoseNow) {
    const patientId = document.getElementById('physSelectedPatientId').value;
    if (!patientId) {
      showToast('Select a patient from the queue first.');
      return;
    }

    const woundCategory = document.getElementById('physWoundCategory').value;
    const doseDay = document.getElementById('physDoseDaySelect').value;
    const vaccineType = document.getElementById('physVaccineSelect').value;
    const shouldAdminister = administerDoseNow && woundCategory !== 'Category I';

    if (shouldAdminister) {
      const availableVials = (clinicAppState.inventory || [])
        .filter((i) => i.vaccineType === vaccineType)
        .reduce((sum, i) => sum + Number(i.currentStock || 0), 0);

      if (availableVials <= 0) {
        showAlertMessage({
          title: 'Out of Stock',
          text: 'Cannot log dose: Selected vaccine batch is out of stock. Please notify Admin.',
          icon: 'error'
        });
        return;
      }

      const selectedPatient = (clinicAppState.patients || []).find(
        (p) => p.patientId === patientId
      );
      const selectedDoseObj = (selectedPatient?.pepSchedule || []).find(
        (d) => d.doseDay === doseDay
      );
      if (selectedDoseObj && selectedDoseObj.status === 'Fulfilled') {
        showAlertMessage({
          title: 'Already Completed',
          text: `Cannot log dose: ${doseDay} has already been completed and cannot be deducted twice.`,
          icon: 'warning'
        });
        return;
      }

      const confirmed = await showConfirmDialog({
        title: 'Confirm Dose Administration',
        text: `Administer ${doseDay} (${vaccineType}) and save triage assessment for patient ${patientId}? This will deduct 1 vial from inventory.`,
        icon: 'question',
        confirmButtonText: 'Yes, administer & save'
      });
      if (!confirmed) return;
    }

    const payload = {
      woundCategory,
      allergyNotes: document.getElementById('physAllergyNotes').value.trim(),
      clinicalNotes: document.getElementById('physClinicalNotes').value.trim(),
      administerDose: shouldAdminister,
      doseDay,
      vaccineType
    };

    const response = await fetch(`/api/physician/triage/${patientId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();

    if (!response.ok) {
      showAlertMessage({
        title: 'Assessment Failed',
        text: result.message || 'Could not save clinical assessment.',
        icon: 'error'
      });
      return;
    }

    showAlertMessage({
      title: 'Assessment Saved',
      text: result.message || 'Clinical assessment saved successfully.',
      icon: 'success'
    });
    await loadRoleAuthorizedData();
    selectPatient(patientId, false);
  }

  document
    .getElementById('physicianAssessmentForm')
    .addEventListener('submit', async (e) => {
      e.preventDefault();
      if (e.target && typeof e.target.checkValidity === 'function') {
        if (!e.target.checkValidity()) {
          if (typeof e.target.reportValidity === 'function') e.target.reportValidity();
          return;
        }
      }
      await submitTriage(true);
    });

  document
    .getElementById('physSaveTriageOnlyBtn')
    .addEventListener('click', async () => {
      await submitTriage(false);
    });

  document
    .getElementById('confirmFulfillDoseBtn')
    .addEventListener('click', () => submitModalDoseDecision(true));

  document
    .getElementById('confirmDefaulterDoseBtn')
    .addEventListener('click', () => submitModalDoseDecision(false));

  document
    .getElementById('cancelDoseModalBtn')
    .addEventListener('click', () => {
      document.getElementById('doseConfirmationModal').classList.add('hidden');
      clinicAppState.pendingModalDose = null;
    });

  document.getElementById('adminRegistrySearchInput').addEventListener('input', () => {
    renderSuperAdminViews();
  });

  document.querySelectorAll('#adminRegistryFilterTabs .filter-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document
        .querySelectorAll('#adminRegistryFilterTabs .filter-tab')
        .forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      clinicAppState.adminRegistryFilter = tab.getAttribute('data-admin-reg-filter');
      renderSuperAdminViews();
    });
  });

  // Edit Patient button click handler in SuperAdmin Patient Registry
  document.getElementById('adminRegistryTableBody').addEventListener('click', (e) => {
    const editBtn = e.target.closest('button.admin-edit-patient-btn');
    if (!editBtn) return;
    const patientId = editBtn.getAttribute('data-patient-id');
    const patientList = clinicAppState.patients || [];
    const patient = patientList.find(
      (p) => p.patientId === patientId || String(p._id) === patientId
    );
    if (!patient) return;
    openEditPatientModal(patient);
  });

  // View Details (eye) button -> read-only confidential patient record modal
  document.getElementById('adminRegistryTableBody').addEventListener('click', (e) => {
    const viewBtn = e.target.closest('button.admin-view-patient-btn');
    if (!viewBtn) return;
    openPatientRecordModal(viewBtn.getAttribute('data-patient-id'));
  });

  document.getElementById('cancelEditPatientBtn').addEventListener('click', () => {
    closeEditPatientModal();
  });

  document.getElementById('editPatientModal').addEventListener('click', (e) => {
    if (e.target.id === 'editPatientModal') {
      closeEditPatientModal();
    }
  });

  document
    .getElementById('editPatientForm')
    .addEventListener('submit', async (e) => {
      e.preventDefault();
      if (e.target && typeof e.target.checkValidity === 'function') {
        if (!e.target.checkValidity()) {
          if (typeof e.target.reportValidity === 'function') e.target.reportValidity();
          return;
        }
      }
      const patientId = document.getElementById('editPatientId').value;
      const fullName = document.getElementById('editPatientName').value.trim();
      const rawPhone = document.getElementById('editPatientPhone').value.trim();
      const purok = document.getElementById('editPatientPurok').value.trim();

      const digitsOnly = rawPhone.replace(/\D/g, '');
      if (!/^09\d{9}$/.test(digitsOnly)) {
        showAlertMessage({
          title: 'Invalid Contact Number',
          text: 'Please enter a valid 11-digit Philippine mobile number starting with 09.',
          icon: 'warning'
        });
        return;
      }

      try {
        const response = await fetch(`/api/patients/demographics/${encodeURIComponent(patientId)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            fullName,
            contactNumber: digitsOnly,
            purok
          })
        });
        const result = await response.json();

        if (!response.ok) {
          showAlertMessage({
            title: 'Update Failed',
            text: result.message || 'Could not update patient demographics.',
            icon: 'error'
          });
          return;
        }

        closeEditPatientModal();
        showAlertMessage({
          title: 'Demographics Updated',
          text: result.message || 'Patient demographics updated successfully.',
          icon: 'success'
        });
        await loadRoleAuthorizedData();
      } catch (err) {
        showToast('Network error while updating patient demographics.');
      }
    });

  document.getElementById('resetRestockFormBtn').addEventListener('click', () => {
    document.getElementById('adminRestockForm').reset();
    document.getElementById('invVialsAdded').value = '25';
    document.getElementById('invThreshold').value = '10';
    const expEl = document.getElementById('restockExpiry');
    if (expEl) {
      expEl.value = '2027-09-30';
      expEl.min = todayDateIso;
    }
    showToast('Restock form reset.');
  });

  document
    .getElementById('adminRestockForm')
    .addEventListener('submit', async (e) => {
      e.preventDefault();
      if (e.target && typeof e.target.checkValidity === 'function') {
        if (!e.target.checkValidity()) {
          if (typeof e.target.reportValidity === 'function') e.target.reportValidity();
          return;
        }
      }
      const expEl = document.getElementById('restockExpiry');
      const payload = {
        vaccineType: document.getElementById('invVaccineType').value,
        brandName: document.getElementById('invBrandName').value.trim(),
        batchNumber: document.getElementById('invBatchNumber').value.trim(),
        vialsAdded: Number(document.getElementById('invVialsAdded').value),
        lowStockThreshold: Number(document.getElementById('invThreshold').value || 10),
        expirationDate: expEl ? expEl.value : ''
      };

      const confirmed = await showConfirmDialog({
        title: 'Confirm Restock',
        text: `Restock ${payload.vialsAdded} vials of ${payload.vaccineType} (${payload.brandName}, Lot: ${payload.batchNumber})?`,
        icon: 'question',
        confirmButtonText: 'Yes, add vials'
      });
      if (!confirmed) return;

      const response = await fetch('/api/admin/inventory/restock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const result = await response.json();

      if (!response.ok) {
        showAlertMessage({
          title: 'Restock Failed',
          text: result.message || 'Could not restock vaccine batch.',
          icon: 'error'
        });
        return;
      }

      e.target.reset();
      document.getElementById('invVialsAdded').value = '25';
      if (expEl) {
        expEl.value = '2027-09-30';
        expEl.min = todayDateIso;
      }
      document.getElementById('invThreshold').value = '10';
      showAlertMessage({
        title: 'Restock Success',
        text: result.message || 'Vaccine batch restocked successfully.',
        icon: 'success'
      });
      await loadRoleAuthorizedData();
    });

  document.getElementById('adminInventoryTableBody').addEventListener('click', async (e) => {
    const voidBtn = e.target.closest('button.admin-void-spoilage-btn');
    if (!voidBtn) return;

    const batchLotId = voidBtn.getAttribute('data-batch-lot');
    const vaccineType = voidBtn.getAttribute('data-vaccine-type');
    const brandName = voidBtn.getAttribute('data-brand-name') || '';
    const currentStock = parseInt(voidBtn.getAttribute('data-current-stock') || '0', 10);

    if (currentStock <= 0) {
      showAlertMessage({
        title: 'Zero Stock',
        text: `Lot ${batchLotId} currently has 0 vials available in inventory.`,
        icon: 'warning'
      });
      return;
    }

    let vialsToDeduct = 1;
    let reason = 'Broken Vial';

    if (typeof Swal !== 'undefined') {
      const { value: formValues, isConfirmed } = await Swal.fire({
        title: `Write-Off / Void: ${batchLotId}`,
        html: `
          <div style="text-align:left; font-size: 13.5px; margin-bottom: 4px;">
            <p style="margin: 0 0 6px 0;"><strong>Vaccine:</strong> ${vaccineType} (${brandName})</p>
            <p style="margin: 0 0 12px 0;"><strong>Current Stock:</strong> <span style="color:#BE123C; font-weight:bold;">${currentStock} vial(s)</span></p>
            <label for="swalVoidVials" style="display:block; font-weight:600; margin-bottom:4px; font-size:12.5px;">Vials to Deduct (1 - ${currentStock}) *</label>
            <input id="swalVoidVials" type="number" min="1" max="${currentStock}" value="1" class="swal2-input" style="width:100%; margin: 0 0 14px 0; box-sizing: border-box; height:38px; font-size:14px;" required />
            <label for="swalVoidReason" style="display:block; font-weight:600; margin-bottom:4px; font-size:12.5px;">Reason for Write-Off *</label>
            <select id="swalVoidReason" class="swal2-select" style="width:100%; margin: 0; box-sizing: border-box; display:block; height:38px; font-size:13px;">
              <option value="Broken Vial">Physical Damage / Broken Vial</option>
              <option value="Clerical Error">Clerical Typo on Expiry Date / Batch Lot</option>
              <option value="Expired">Expired / Chemical Degradation</option>
              <option value="Cold Chain Excursion">Cold Chain Temperature Excursion</option>
              <option value="Manufacturer Recall">Manufacturer Recall</option>
              <option value="Contaminated Seal">Contaminated / Compromised Seal</option>
            </select>
          </div>
        `,
        focusConfirm: false,
        showCancelButton: true,
        confirmButtonText: 'Confirm Write-Off',
        confirmButtonColor: '#BE123C',
        cancelButtonText: 'Cancel',
        cancelButtonColor: '#6c757d',
        preConfirm: () => {
          const popup = typeof Swal !== 'undefined' && Swal.getPopup ? Swal.getPopup() : document;
          const vialsEl = popup.querySelector('#swalVoidVials');
          const reasonEl = popup.querySelector('#swalVoidReason');
          const count = parseInt(vialsEl ? vialsEl.value : '0', 10);
          const r = reasonEl ? reasonEl.value.trim() : '';

          if (!count || isNaN(count) || count < 1 || count > currentStock) {
            Swal.showValidationMessage(`Please enter a valid vial count between 1 and ${currentStock}.`);
            return false;
          }
          if (!r) {
            Swal.showValidationMessage('Please select a reason for write-off.');
            return false;
          }
          return { vialsToDeduct: count, reason: r };
        }
      });

      if (!isConfirmed || !formValues) return;
      vialsToDeduct = formValues.vialsToDeduct;
      reason = formValues.reason;
    } else {
      const confirmed = typeof confirm !== 'undefined' ? confirm(`Void 1 vial from ${batchLotId}?`) : true;
      if (!confirmed) return;
    }

    try {
      const response = await fetch('/api/inventory/spoilage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          batchLotId,
          vialsToDeduct,
          reason
        })
      });
      const result = await response.json();

      if (!response.ok) {
        showAlertMessage({
          title: 'Write-Off Failed',
          text: result.message || 'Could not process inventory spoilage write-off.',
          icon: 'error'
        });
        return;
      }

      showAlertMessage({
        title: 'Stock Voided',
        text: result.message || `Voided ${vialsToDeduct} vial(s) from Lot ${batchLotId}.`,
        icon: 'success'
      });
      await loadRoleAuthorizedData();
    } catch (err) {
      showToast('Network error while processing inventory write-off.');
    }
  });

  document.getElementById('refreshForecastBtn').addEventListener('click', async () => {
    try {
      const response = await fetch('/api/admin/forecast/recalculate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const result = await response.json();
      if (!response.ok) {
        showToast(result.message || 'Could not update forecast.');
        return;
      }
      clinicAppState.forecastData = result.data || clinicAppState.forecastData;
      renderSuperAdminViews();
      await loadDashboardSummary();
      showToast(result.message || 'Forecast updated.');
    } catch (err) {
      showToast('Network error while updating forecast.');
    }
  });

  document.getElementById('resetStaffFormBtn').addEventListener('click', () => {
    setStaffFormMode(null);
  });

  // Security settings: update the global inactivity timeout.
  const btnSaveSettings = document.getElementById('btnSaveSettings');
  if (btnSaveSettings) {
    btnSaveSettings.addEventListener('click', async () => {
      const select = document.getElementById('sessionTimeout');
      const timeout = Number(select ? select.value : 0);
      if (!Number.isFinite(timeout) || timeout < 1 || timeout > 120) {
        if (typeof Swal !== 'undefined') {
          Swal.fire('Invalid Value', 'Timeout must be between 1 and 120 minutes.', 'error');
        } else {
          showToast('Invalid timeout value.');
        }
        return;
      }

      try {
        const response = await fetch('/api/settings', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${getStoredAuthToken()}`
          },
          body: JSON.stringify({ timeout })
        });

        const result = await response.json();

        if (response.ok && result.success) {
          applySessionTimeout(timeout);
          if (typeof Swal !== 'undefined') {
            Swal.fire('Security Policy Updated', `Auto-logout set to ${timeout} minutes.`, 'success');
          } else {
            showToast(`Auto-logout set to ${timeout} minutes.`);
          }
        } else {
          if (typeof Swal !== 'undefined') {
            Swal.fire('Update Failed', result.message || 'Could not update settings.', 'error');
          } else {
            showToast(result.message || 'Could not update settings.');
          }
        }
      } catch (err) {
        if (typeof Swal !== 'undefined') {
          Swal.fire('Error', 'Server verification failed.', 'error');
        } else {
          showToast('Server verification failed.');
        }
      }
    });
  }

  document.getElementById('adminStaffTableBody').addEventListener('click', async (e) => {
    const editBtn = e.target.closest('button.staff-edit');
    const toggleBtn = e.target.closest('button.staff-toggle-btn');
    const staffList = clinicAppState.staffAccounts || [];

    if (editBtn) {
      const member = staffList.find((u) => String(u._id) === editBtn.getAttribute('data-staff-id'));
      if (member) {
        setStaffFormMode(member);
        document.getElementById('staffFullName').focus();
      }
      return;
    }

    if (toggleBtn) {
      const id = toggleBtn.getAttribute('data-staff-id');
      const member = staffList.find((u) => String(u._id) === id);
      if (!member) return;
      const isCurrentlyActive = member.isActive !== false;
      const actionName = isCurrentlyActive ? 'deactivate' : 'reactivate';
      const actionTitle = isCurrentlyActive ? 'Deactivate Staff Account' : 'Reactivate Staff Account';
      const confirmText = isCurrentlyActive
        ? `Are you sure you want to deactivate ${member.fullName}? They will be blocked from logging into the clinic system.`
        : `Reactivate account for ${member.fullName}? They will be permitted to log in again.`;

      const confirmed = await showConfirmDialog({
        title: actionTitle,
        text: confirmText,
        icon: isCurrentlyActive ? 'warning' : 'question',
        confirmButtonText: isCurrentlyActive ? 'Yes, deactivate' : 'Yes, reactivate',
        confirmButtonColor: isCurrentlyActive ? '#d32f2f' : '#2e7d32'
      });
      if (!confirmed) return;

      try {
        const response = await fetch(`/api/staff/${id}/toggle-status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' }
        });
        const result = await response.json();
        if (!response.ok) {
          showAlertMessage({
            title: 'Action Failed',
            text: result.message || `Could not ${actionName} staff account.`,
            icon: 'error'
          });
          return;
        }
        showAlertMessage({
          title: 'Account Status Updated',
          text: result.message || `Staff account ${actionName}d successfully.`,
          icon: 'success'
        });
        await loadRoleAuthorizedData();
      } catch (err) {
        showToast(`Network error while trying to ${actionName} staff account.`);
      }
      return;
    }

  });

  document
    .getElementById('adminOnboardStaffForm')
    .addEventListener('submit', async (e) => {
      e.preventDefault();
      if (e.target && typeof e.target.checkValidity === 'function') {
        if (!e.target.checkValidity()) {
          if (typeof e.target.reportValidity === 'function') e.target.reportValidity();
          return;
        }
      }
      const editId = document.getElementById('staffEditId').value;
      const payload = {
        fullName: document.getElementById('staffFullName').value.trim(),
        email: document.getElementById('staffEmail').value.trim(),
        password: document.getElementById('staffPassword').value,
        role: document.getElementById('staffRole').value
      };

      try {
        const response = await fetch(editId ? `/api/admin/staff/${editId}` : '/api/admin/staff', {
          method: editId ? 'PUT' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const result = await response.json();

        if (!response.ok) {
          showToast(result.message || 'Could not save staff account.');
          return;
        }

        setStaffFormMode(null);
        showToast(result.message);
        await loadRoleAuthorizedData();
      } catch (err) {
        showToast('Network error while saving staff account.');
      }
    });

  // --- RA 10173 secure CSV export (Patient Registry) ---
  // NOTE: the registry UI now shows plaintext PHI for all staff roles.
  // maskPHI() is retained here and is applied ONLY when the SuperAdmin
  // chooses the "Masked" export format (RA 10173 compliant external reporting).

  function getFilteredRegistry() {
    const patients = clinicAppState.patients || [];
    const regSearchVal = document.getElementById('adminRegistrySearchInput')?.value || '';
    return patients.filter((p) => filterQueueMatch(p, clinicAppState.adminRegistryFilter, regSearchVal));
  }

  // type: 'masked' | 'unmasked'
  function exportTableToCSV(type = 'masked', filename) {
    const rows = getFilteredRegistry();
    if (!rows || rows.length === 0) {
      showToast('No registry data available to export.');
      return false; // Tell the caller it failed
    }

    const shouldMask = type !== 'unmasked';

    const headers = [
      'Registry ID',
      'Patient Name',
      'Age',
      'Sex',
      'Purok / Address',
      'Contact Number',
      'Animal Type',
      'Bite Site',
      'WHO Category',
      'Clinical Notes',
      'Next Dose'
    ];

    const escapeCsv = (value) => {
      const str = String(value == null ? '' : value);
      return /[",\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
    };

    const lines = [headers.join(',')];
    rows.forEach((p) => {
      const addr = p.purok || p.barangay || 'Brgy. Kapitan Pepe';
      const nextPending = (p.pepSchedule || []).find((d) => d.status === 'Pending');
      const nextDose = nextPending
        ? `${nextPending.doseDay} (${String(nextPending.scheduledDate).split('T')[0]})`
        : 'Completed';
      const record = [
        p.patientId || '',
        shouldMask ? maskPHI(p.fullName, 'name') : p.fullName,
        p.age || '',
        p.sex || '',
        addr,
        shouldMask ? maskPHI(p.contactNumber, 'phone') : p.contactNumber,
        p.animalType || '',
        p.biteSite || '',
        p.woundCategory || '',
        p.clinicalNotes || '',
        nextDose
      ];
      lines.push(record.map(escapeCsv).join(','));
    });

    const csvContent = lines.join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download =
      filename || `drpau-pep-registry-${getLocalTodayIso()}-${shouldMask ? 'masked' : 'unmasked'}.csv`;
    a.style.visibility = 'hidden';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast(
      shouldMask ? 'CSV exported with masked PHI (PII protected).' : 'CSV exported with unmasked PHI.'
    );
    return true; // Tell the caller it succeeded
  }

  if (typeof window !== 'undefined') {
    window.exportTableToCSV = exportTableToCSV;
  }

  // RA 10173 RBAC: only SuperAdmin may export raw (unmasked) clinical records.
  function getCurrentUserRole() {
    if (typeof localStorage !== 'undefined') {
      const storedRole = localStorage.getItem('pep_user_role');
      if (storedRole) return storedRole;
      const token = localStorage.getItem('pep_auth_token');
      if (token) {
        try {
          const payload = token.split('.')[1];
          const decoded = JSON.parse(atob(payload));
          return decoded.role || null;
        } catch (e) {
          return null;
        }
      }
    }
    return null;
  }

  // Shared session token used for the export re-authentication challenge.
  function getStoredAuthToken() {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem('token') || localStorage.getItem('pep_auth_token');
  }

  // Records the data-privacy event (EXPORT_MASKED / EXPORT_UNMASKED) in the
  // universal audit trail.
  async function logExportActivity(exportType) {
    try {
      await fetch('/api/admin/export-log', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${getStoredAuthToken()}`
        },
        body: JSON.stringify({ format: exportType })
      });
    } catch (err) {
      console.warn('Could not record export activity:', err.message);
    }
  }

  const btnExportAnalytics = document.getElementById('btnExportAnalytics');
  const btnExport = document.getElementById('btnExport');

  const runRegistryExport = async (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();

    // 1. Bulletproof Empty Table Check
    const specificBody = document.getElementById('adminRegistryTableBody');
    const tbody = specificBody || document.querySelector('table tbody');
    const rows = tbody ? tbody.querySelectorAll('tr') : [];
    let isEmpty = true;

    if (rows.length > 0) {
      // If there are rows, ensure it isn't just a "No data available" placeholder
      const firstRowText = rows[0].innerText.toLowerCase();
      if (!firstRowText.includes('no registry data') && !firstRowText.includes('no matching records') && !firstRowText.includes('no records')) {
        isEmpty = false; // The table has real data
      }
    }

    // 2. Halt Execution if Empty
    if (isEmpty) {
      await Swal.fire({
        icon: 'error',
        title: 'Export Blocked',
        text: 'No patient records found. Please clear your search and try again.',
        confirmButtonColor: '#7C3AED'
      });
      return; // HARD STOP: This prevents the format prompt and password challenge from firing
    }

      // Step 1: Select Export Format
      const { value: exportType } = await Swal.fire({
        title: 'Export Format',
        text: 'Select how patient data should be handled in the CSV:',
        icon: 'question',
        input: 'radio',
        inputOptions: {
          masked: 'Masked Data (Safe Export / No Password Required)',
          unmasked: 'Unmasked Data (Requires SuperAdmin Password)'
        },
        inputValidator: (value) => {
          if (!value) return 'You must choose an export format!';
        },
        confirmButtonText: 'Continue',
        showCancelButton: true
      });

      if (!exportType) return; // User canceled

      // Step 2: Conditional Password Challenge
      // Masked exports are safe by design (RA 10173 compliant) -> export instantly.
      if (exportType === 'masked') {
        const exportSucceeded = exportTableToCSV('masked');
        if (!exportSucceeded) return; // Do not show success modal if export failed
        await logExportActivity('masked');
        Swal.fire(
          'Export Successful',
          'Your masked, RA-10173 compliant report has been downloaded.',
          'success'
        );
        return;
      }

      // Unmasked exports expose raw PHI -> strict SuperAdmin password challenge.
      if (exportType === 'unmasked') {
        const { value: password } = await Swal.fire({
          title: 'SuperAdmin Authorization',
          text: 'Enter your password to authorize the extraction of raw Patient Data.',
          input: 'password',
          inputPlaceholder: 'Enter password...',
          inputAttributes: {
            autocomplete: 'new-password', // CRITICAL FIX: Blocks autofill injection
            autocapitalize: 'off',
            autocorrect: 'off'
          },
          showCancelButton: true,
          confirmButtonColor: '#d33', // Red button to indicate sensitive action
          customClass: {
            popup: 'pep-reauth-modal',
            title: 'pep-reauth-title',
            content: 'pep-reauth-content',
            input: 'pep-reauth-input',
            confirmButton: 'pep-reauth-confirm',
            cancelButton: 'pep-reauth-cancel'
          },
          inputValidator: (value) => (value ? undefined : 'Please enter your admin password.')
        });

        if (!password) return; // User canceled

        try {
          // Verify password with the backend
          const response = await fetch('/api/auth/verify-unmask', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${getStoredAuthToken()}`
            },
            body: JSON.stringify({ password })
          });

          const result = await response.json();

          if (response.ok && result.success) {
            // Authorized — generate and download the raw clinical CSV.
            const exportSucceeded = exportTableToCSV('unmasked');
            if (!exportSucceeded) return; // Do not show success modal if export failed
            await logExportActivity('unmasked');
            Swal.fire('Export Successful', 'Unmasked clinical report downloaded.', 'success');
          } else {
            Swal.fire(
              'Access Denied',
              result.message || result.error || 'Incorrect Password. Unmasked export blocked.',
              'error'
            );
          }
        } catch (error) {
          Swal.fire('Error', 'Server verification failed.', 'error');
        }
      }
  };

  if (btnExportAnalytics) {
    btnExportAnalytics.addEventListener('click', runRegistryExport);
  }
  if (btnExport) {
    btnExport.addEventListener('click', runRegistryExport);
  }

  try {
    const savedToken = (typeof localStorage !== 'undefined') ? (localStorage.getItem('token') || localStorage.getItem('pep_auth_token')) : null;
    const meRes = await fetch('/api/auth/me', {
      headers: savedToken ? { 'Authorization': `Bearer ${savedToken}` } : {}
    });
    if (meRes.ok) {
      const meJson = await meRes.json();
      if (meJson.data && meJson.data.user) {
        await openAuthenticatedRoleWorkspace(meJson.data.user);
      }
    }
  } catch (err) {
    // dito banda wala pang naka login kaya login screen muna
  }
});



