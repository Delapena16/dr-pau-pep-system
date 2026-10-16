"""
============================================================================
FILE: pyspark_etl/seed_data.py
ARCHITECTURAL LAYER: Big Data Analytics Layer (Step 0: Synthetic Data Generator)
============================================================================
PURPOSE WITHIN THE SYSTEM ARCHITECTURE:
Generates realistic synthetic clinical data for the Dr. Pau Animal Bite Center
PEP Management System so students can test and demonstrate:
  1. High-volume patient records with embedded 5-dose PEP schedules
     (Day 0, Day 3, Day 7, Day 14, Day 28).
  2. Vaccine & RIG cold-chain inventory batches.
  3. Structured transaction logs for PySpark ETL analytics (including a
     simulated Category III stray-dog bite outbreak spike in a target barangay
     so the anomaly detection algorithm has a clear signal to flag during
     the panel defense!).

MODULAR DESIGN FOR ACADEMIC DEFENSE:
  - Function 1: `generate_synthetic_patients_and_logs(num_records)`
  - Function 2: `generate_synthetic_inventory_batches()`
  - Function 3: `save_seed_data_to_json_and_mongodb(...)`
============================================================================
"""

import json
import os
import random
from datetime import datetime, timedelta

# Optional MongoDB connection (gracefully falls back to local JSON files if pymongo/mongod is unavailable)
try:
    from pymongo import MongoClient
    PYMONGO_AVAILABLE = True
except ImportError:
    PYMONGO_AVAILABLE = False


# Realistic Barangays surrounding Dr. Pau Animal Bite Center
CLINIC_BARANGAYS = [
    "Brgy. Commonwealth",
    "Brgy. Batasan Hills",
    "Brgy. Holy Spirit",
    "Brgy. Payatas",
    "Brgy. Fairview",
    "Brgy. Tandang Sora",
    "Brgy. Matandang Balara",
    "Brgy. Culiat",
]

ANIMAL_TYPES = ["Dog", "Cat", "Stray Dog", "Stray Cat", "Bat", "Rat"]
BITE_SITES = [
    "Right Hand (Fingers)",
    "Left Calf",
    "Right Forearm",
    "Left Ankle",
    "Head / Neck",
    "Right Thigh",
]
VACCINE_BRANDS = [
    ("Verorab (Purified Vero Cell Rabies Vaccine)", "VRB-2026-A101"),
    ("Speeda (Freeze-Dried Rabies Vaccine)", "SPD-2026-B204"),
    ("Rabipur (Purified Chick Embryo Cell Vaccine)", "RBP-2026-C308"),
]
PEP_DAY_OFFSETS = [0, 3, 7, 14, 28]


def calculate_pep_schedule_dates_python(day_zero_date, simulate_defaulter=False):
    """
    Calculates the 5-dose WHO/DOH PEP vaccination schedule (Day 0, 3, 7, 14, 28)
    and simulates realistic completed vs. missed/defaulted follow-up doses.
    """
    today = datetime.now()
    schedule = []
    chosen_vaccine, chosen_batch = random.choice(VACCINE_BRANDS)

    for index, offset in enumerate(PEP_DAY_OFFSETS):
        scheduled_dt = day_zero_date + timedelta(days=offset)

        # Day 0 is almost always administered immediately during walk-in
        if offset == 0:
            status = "Completed"
            administered_dt = scheduled_dt.strftime("%Y-%m-%d")
        elif scheduled_dt > today:
            status = "Scheduled"
            administered_dt = None
        else:
            # Past scheduled date: if patient is a simulated defaulter, miss Day 7/14/28
            if simulate_defaulter and offset >= 7:
                status = "Scheduled"  # Overdue and still unadministered -> Defaulter!
                administered_dt = None
            else:
                status = "Completed"
                administered_dt = scheduled_dt.strftime("%Y-%m-%d")

        schedule.append(
            {
                "doseLabel": f"Day {offset}",
                "dayOffset": offset,
                "scheduledDate": scheduled_dt.strftime("%Y-%m-%d"),
                "dateAdministered": administered_dt,
                "status": status,
                "vaccineBrand": chosen_vaccine if status == "Completed" else None,
                "vaccineBatchNumber": chosen_batch if status == "Completed" else None,
            }
        )

    return schedule


def generate_synthetic_patients_and_logs(total_patients=1500):
    """
    STEP 1 OF SEEDING:
    Generates structured patient records and flattened dose/exposure transaction
    logs suitable for both MongoDB storage and PySpark DataFrame ingestion.
    """
    random.seed(2026)
    today = datetime.now()

    patient_records = []
    transaction_logs = []

    first_names = [
        "Juan", "Maria", "Jose", "Ana", "Carlo", "Bea", "Mark", "Angela",
        "Gabriel", "Sofia", "Miguel", "Camille", "Rafael", "Jasmine", "Paolo", "Patricia"
    ]
    last_names = [
        "Dela Cruz", "Santos", "Reyes", "Ramos", "Mendoza", "Bautista",
        "Villanueva", "Fernandez", "Aquino", "Garcia", "Soriano", "Castillo"
    ]

    for index in range(1, total_patients + 1):
        patient_code = f"PEP-2026-{index + 1000:04d}"
        full_name = f"{random.choice(first_names)} {random.choice(last_names)}"
        age = random.randint(4, 78)
        sex = random.choice(["Male", "Female"])
        barangay = random.choice(CLINIC_BARANGAYS)

        # Simulate walk-in dates spread across the past 60 days
        days_ago = random.randint(1, 60)
        walk_in_dt = today - timedelta(days=days_ago)

        # Inject a realistic Category III Stray Dog Bite outbreak spike in
        # "Brgy. Commonwealth" during the last 7 days so PySpark Anomaly Detection
        # clearly flags it during the student defense demonstration!
        if barangay == "Brgy. Commonwealth" and days_ago <= 7 and random.random() < 0.72:
            who_category = "Category III"
            animal_type = "Dog"
            ownership_status = "Stray / Wild"
        else:
            who_category = random.choices(
                ["Category I", "Category II", "Category III"],
                weights=[0.12, 0.58, 0.30],
                k=1,
            )[0]
            animal_type = random.choices(
                ["Dog", "Cat", "Bat", "Rat"],
                weights=[0.65, 0.28, 0.03, 0.04],
                k=1,
            )[0]
            ownership_status = random.choice(
                ["Pet - Immunized", "Pet - Unimmunized", "Stray / Wild"]
            )

        simulate_defaulter = random.random() < 0.18  # 18% realistic PEP defaulter rate
        pep_schedule = (
            []
            if who_category == "Category I"
            else calculate_pep_schedule_dates_python(walk_in_dt, simulate_defaulter)
        )

        # Determine overall PEP regimen status
        if who_category == "Category I":
            pep_status = "Completed"
        elif simulate_defaulter and days_ago >= 10:
            pep_status = "Defaulted"
        elif all(d["status"] == "Completed" for d in pep_schedule):
            pep_status = "Completed"
        else:
            pep_status = "Ongoing PEP"

        patient_doc = {
            "patientCode": patient_code,
            "fullName": full_name,
            "age": age,
            "sex": sex,
            "contactNumber": f"0917{random.randint(1000000, 9999999)}",
            "barangay": barangay,
            "city": "Quezon City",
            "walkInDate": walk_in_dt.strftime("%Y-%m-%d"),
            "animalType": animal_type,
            "animalOwnershipStatus": ownership_status,
            "biteSite": random.choice(BITE_SITES),
            "whoCategory": who_category,
            "rigRequired": who_category == "Category III",
            "pepStatus": pep_status,
            "pepSchedule": pep_schedule,
        }
        patient_records.append(patient_doc)

        # Also create flattened dose transaction records for fast PySpark ETL analysis
        for dose in pep_schedule:
            transaction_logs.append(
                {
                    "patientCode": patient_code,
                    "barangay": barangay,
                    "animalType": animal_type,
                    "animalOwnershipStatus": ownership_status,
                    "whoCategory": who_category,
                    "walkInDate": walk_in_dt.strftime("%Y-%m-%d"),
                    "doseLabel": dose["doseLabel"],
                    "dayOffset": dose["dayOffset"],
                    "scheduledDate": dose["scheduledDate"],
                    "dateAdministered": dose["dateAdministered"],
                    "doseStatus": dose["status"],
                    "vaccineBrand": dose["vaccineBrand"] or "Verorab (Purified Vero Cell Rabies Vaccine)",
                    "vaccineBatchNumber": dose["vaccineBatchNumber"] or "VRB-2026-A101",
                }
            )

    return patient_records, transaction_logs


def generate_synthetic_inventory_batches():
    """
    STEP 2 OF SEEDING:
    Creates cold-chain vaccine and RIG batches with current remaining doses
    so PySpark can forecast exact days until stockout.
    """
    today = datetime.now()
    return [
        {
            "itemName": "Verorab (Purified Vero Cell Rabies Vaccine)",
            "itemCategory": "Anti-Rabies Vaccine (ARV)",
            "batchNumber": "VRB-2026-A101",
            "remainingDoses": 210,
            "reorderThresholdDoses": 40,
            "expirationDate": (today + timedelta(days=95)).strftime("%Y-%m-%d"),
        },
        {
            "itemName": "Speeda (Freeze-Dried Rabies Vaccine)",
            "itemCategory": "Anti-Rabies Vaccine (ARV)",
            "batchNumber": "SPD-2026-B204",
            "remainingDoses": 65,
            "reorderThresholdDoses": 35,
            "expirationDate": (today + timedelta(days=42)).strftime("%Y-%m-%d"),
        },
        {
            "itemName": "Rabipur (Purified Chick Embryo Cell Vaccine)",
            "itemCategory": "Anti-Rabies Vaccine (ARV)",
            "batchNumber": "RBP-2026-C308",
            "remainingDoses": 120,
            "reorderThresholdDoses": 30,
            "expirationDate": (today + timedelta(days=140)).strftime("%Y-%m-%d"),
        },
        {
            "itemName": "Equirab (Equine Rabies Immunoglobulin - ERIG)",
            "itemCategory": "Rabies Immunoglobulin (RIG)",
            "batchNumber": "EQB-2026-R309",
            "remainingDoses": 38,
            "reorderThresholdDoses": 15,
            "expirationDate": (today + timedelta(days=110)).strftime("%Y-%m-%d"),
        },
    ]


def save_seed_data_to_json_and_mongodb(patients, transactions, inventory_batches):
    """
    STEP 3 OF SEEDING:
    Writes the generated datasets to `pyspark_etl/data/` for reliable PySpark
    DataFrame reading AND inserts into MongoDB if a local server is running.
    """
    data_dir = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(data_dir, exist_ok=True)

    patients_path = os.path.join(data_dir, "seed_patients.json")
    transactions_path = os.path.join(data_dir, "seed_pep_transactions.json")
    inventory_path = os.path.join(data_dir, "seed_inventory.json")

    with open(patients_path, "w", encoding="utf-8") as f:
        json.dump(patients, f, indent=2)

    with open(transactions_path, "w", encoding="utf-8") as f:
        json.dump(transactions, f, indent=2)

    with open(inventory_path, "w", encoding="utf-8") as f:
        json.dump(inventory_batches, f, indent=2)

    print(f"[Seed Complete] Saved {len(patients)} patient records -> {patients_path}")
    print(f"[Seed Complete] Saved {len(transactions)} PEP dose logs -> {transactions_path}")
    print(f"[Seed Complete] Saved {len(inventory_batches)} inventory batches -> {inventory_path}")

    # Optional: Also sync to live MongoDB if reachable
    if PYMONGO_AVAILABLE:
        try:
            mongo_uri = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017/")
            client = MongoClient(mongo_uri, serverSelectionTimeoutMS=2000)
            client.server_info()  # Trigger connection check
            db = client["dr_pau_pep_db"]
            db["pyspark_seed_transactions"].delete_many({})
            db["pyspark_seed_transactions"].insert_many(transactions)
            print("[MongoDB Sync] Inserted synthetic PEP transaction logs into MongoDB collection 'pyspark_seed_transactions'.")
        except Exception as mongo_err:
            print(f"[MongoDB Offline Notice] Local JSON datasets are ready for PySpark ETL ({mongo_err.__class__.__name__}).")


if __name__ == "__main__":
    print("============================================================================")
    print("Dr. Pau Animal Bite Center - Synthetic Clinical Data Generator (seed_data.py)")
    print("============================================================================")
    seeded_patients, seeded_transactions = generate_synthetic_patients_and_logs(total_patients=1500)
    seeded_inventory = generate_synthetic_inventory_batches()
    save_seed_data_to_json_and_mongodb(seeded_patients, seeded_transactions, seeded_inventory)
