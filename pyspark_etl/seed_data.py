# Dataset seeder for offline analytics testing

import json
import os
import random
from datetime import datetime, timedelta

try:
    from pymongo import MongoClient
    HAS_PYMONGO = True
except ImportError:
    HAS_PYMONGO = False

PUROKS = [
    "Purok 1, Kapitan Pepe",
    "Purok 2, Kapitan Pepe",
    "Purok 3, Kapitan Pepe",
    "Purok 4, Kapitan Pepe",
    "Purok 5, Kapitan Pepe",
    "Purok 6, Kapitan Pepe",
    "Purok 7, Kapitan Pepe",
]


FIRST_NAMES = ["Juan", "Maria", "Jose", "Ana", "Carlo", "Bea", "Mark", "Angela", "Paolo", "Sofia"]
LAST_NAMES = ["Dela Cruz", "Santos", "Reyes", "Ramos", "Mendoza", "Bautista", "Garcia", "Aquino"]
ANIMAL_TYPES = ["Dog", "Cat", "Stray Dog", "Stray Cat", "Bat"]
BITE_SITES = ["Right Hand", "Left Calf", "Right Forearm", "Left Ankle", "Right Thigh"]


def build_pep_schedule(day0_date, simulate_defaulter=False):
    # Generate Day 3, 7, and 28 follow-up dates from Day 0 walk-in date
    today = datetime.now()
    schedule = []

    for offset in [3, 7, 28]:
        sched_date = day0_date + timedelta(days=offset)
        if sched_date > today:
            status = "Pending"
            administered = False
        elif simulate_defaulter and offset >= 7:
            status = "Defaulter"
            administered = False
        else:
            status = "Fulfilled"
            administered = True

        schedule.append(
            {
                "doseDay": f"Day {offset}",
                "dayOffset": offset,
                "scheduledDate": sched_date.strftime("%Y-%m-%d"),
                "status": status,
                "doseAdministered": administered,
                "vaccineTypeUsed": "anti-rabies",
            }
        )

    return schedule


def generate_dataset(record_count):
    random.seed(2026)
    today = datetime.now()
    records = []

    for i in range(1, record_count + 1):
        patient_id = f"PEP-2026-{i + 1000:05d}"
        full_name = f"{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}"
        purok = random.choice(PUROKS)
        barangay = "Brgy. Kapitan Pepe"

        days_ago = random.randint(0, 89)
        walk_in_date = today - timedelta(days=days_ago)
        iso_year, iso_week, _ = walk_in_date.isocalendar()
        week_label = f"{iso_year}-W{iso_week:02d}"

        if purok == "Purok 1, Kapitan Pepe" and days_ago <= 7:
            wound_category = "Category III" if random.random() < 0.78 else "Category II"
        else:
            wound_category = random.choices(
                ["Category I", "Category II", "Category III"],
                weights=[0.15, 0.60, 0.25],
                k=1,
            )[0]

        is_defaulter = random.random() < 0.14
        pep_schedule = build_pep_schedule(walk_in_date, is_defaulter)

        records.append(
            {
                "patientId": patient_id,
                "fullName": full_name,
                "age": random.randint(5, 75),
                "sex": random.choice(["Male", "Female"]),
                "contactNumber": f"0917{random.randint(1000000, 9999999)}",
                "purok": purok,
                "barangay": barangay,
                "consentGiven": True,
                "day0WalkInDate": walk_in_date.strftime("%Y-%m-%d"),
                "monthYear": walk_in_date.strftime("%Y-%m"),
                "weekWindow": week_label,
                "animalType": random.choice(ANIMAL_TYPES),
                "biteSite": random.choice(BITE_SITES),
                "woundCategory": wound_category,
                "pepSchedule": pep_schedule,
            }
        )

    return records


def seed_all_datasets():
    data_dir = os.path.join(os.path.dirname(__file__), "data")
    os.makedirs(data_dir, exist_ok=True)

    baseline_500 = generate_dataset(500)
    scaled_10000 = generate_dataset(10000)

    baseline_path = os.path.join(data_dir, "patients_baseline_500.json")
    scaled_path = os.path.join(data_dir, "patients_scaled_10000.json")

    with open(baseline_path, "w", encoding="utf-8") as f:
        json.dump(baseline_500, f, indent=2)

    with open(scaled_path, "w", encoding="utf-8") as f:
        json.dump(scaled_10000, f, indent=2)

    print("Seeded 500-record baseline dataset -> " + baseline_path)
    print("Seeded 10,000-record scaled dataset -> " + scaled_path)

    if HAS_PYMONGO:
        try:
            mongo_uri = os.environ.get("MONGO_URI", "mongodb://127.0.0.1:27017/")
            client = MongoClient(mongo_uri, serverSelectionTimeoutMS=2000)
            client.server_info()
            db = client["dr_pau_pep_db"]

            db["patients_baseline_500"].delete_many({})
            db["patients_baseline_500"].insert_many(baseline_500)

            db["patients_scaled_10000"].delete_many({})
            db["patients_scaled_10000"].insert_many(scaled_10000)
            print("Synced both 500-row and 10,000-row datasets to MongoDB (dr_pau_pep_db)")
        except Exception as err:
            print("MongoDB offline; saved JSON files for local ETL (" + str(err.__class__.__name__) + ")")


if __name__ == "__main__":
    seed_all_datasets()
