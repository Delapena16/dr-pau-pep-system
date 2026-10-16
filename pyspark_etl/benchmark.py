"""
============================================================================
FILE: pyspark_etl/benchmark.py
ARCHITECTURAL LAYER: Big Data Analytics Layer (Performance & Scalability Benchmark)
============================================================================
PURPOSE WITHIN THE SYSTEM ARCHITECTURE:
Provides empirical performance benchmarks for the student team's academic
panel defense (Chapter 4 / Results & Evaluation). It compares the execution
latency and throughput (records/second) across increasing dataset scales:
  - 1,000 PEP transaction records
  - 10,000 PEP transaction records
  - 50,000 PEP transaction records
  - 100,000 PEP transaction records

ACADEMIC DEFENSE TALKING POINTS:
1. Why benchmark PySpark vs. unindexed sequential processing?
   At small scales (1,000 records), single-node loops are fast, but as a clinic
   accumulates multi-year regional animal bite logs (50,000 to 100,000+ doses),
   PySpark's Catalyst Optimizer and Tungstens in-memory columnar execution scale
   linearly across CPU cores without blocking the live Express.js API server.
============================================================================
"""

import json
import os
import random
import time

from pyspark.sql import SparkSession
from pyspark.sql import functions as F


def generate_in_memory_benchmark_records(record_count):
    """
    Generates `record_count` synthetic PEP transaction dictionaries in memory
    for controlled benchmarking across scales.
    """
    barangays = [
        "Brgy. Commonwealth",
        "Brgy. Batasan Hills",
        "Brgy. Holy Spirit",
        "Brgy. Payatas",
        "Brgy. Fairview",
        "Brgy. Tandang Sora",
    ]
    categories = ["Category I", "Category II", "Category III"]
    statuses = ["Completed", "Scheduled", "Missed / Defaulted"]
    brands = ["Verorab", "Speeda", "Rabipur"]

    return [
        {
            "patientCode": f"PEP-BM-{i:06d}",
            "barangay": barangays[i % len(barangays)],
            "whoCategory": categories[i % len(categories)],
            "doseStatus": statuses[i % len(statuses)],
            "vaccineBrand": brands[i % len(brands)],
            "dosesDeducted": 1,
        }
        for i in range(record_count)
    ]


def run_pyspark_etl_benchmark():
    """
    Runs the multi-scale PySpark aggregation benchmark and outputs a clean
    comparison table for academic documentation.
    """
    spark = (
        SparkSession.builder.appName("DrPau_PEP_Scalability_Benchmark")
        .master("local[*]")
        .config("spark.sql.shuffle.partitions", "4")
        .config("spark.ui.showConsoleProgress", "false")
        .getOrCreate()
    )
    spark.sparkContext.setLogLevel("ERROR")

    dataset_scales = [1000, 10000, 50000, 100000]
    benchmark_results = []

    print("============================================================================")
    print("Dr. Pau Animal Bite Center - PySpark Big Data ETL Scalability Benchmark")
    print("============================================================================")
    print(f"{'Dataset Size':<16} | {'ETL Execution (ms)':<20} | {'Throughput (rec/sec)':<22}")
    print("-" * 64)

    try:
        # Warm up JVM and Spark Catalyst Optimizer before timing
        warmup_df = spark.createDataFrame(generate_in_memory_benchmark_records(200))
        warmup_df.groupBy("barangay").count().collect()

        for scale in dataset_scales:
            records = generate_in_memory_benchmark_records(scale)
            df = spark.createDataFrame(records).cache()
            df.count()  # Materialize cache before timing transformation stage

            start_time = time.perf_counter()

            # Execute multi-dimensional aggregation (Barangay + WHO Category + Vaccine Brand)
            aggregated_df = (
                df.groupBy("barangay", "whoCategory", "vaccineBrand")
                .agg(
                    F.count("*").alias("totalTransactions"),
                    F.sum(
                        F.when(F.col("doseStatus") == "Completed", 1).otherwise(0)
                    ).alias("completedDoses"),
                    F.sum(
                        F.when(F.col("doseStatus") == "Missed / Defaulted", 1).otherwise(0)
                    ).alias("defaultedDoses"),
                )
                .orderBy(F.col("totalTransactions").desc())
            )
            aggregated_df.collect()

            elapsed_seconds = time.perf_counter() - start_time
            elapsed_ms = round(elapsed_seconds * 1000, 2)
            throughput = int(scale / elapsed_seconds) if elapsed_seconds > 0 else scale

            print(f"{scale:<16,d} | {elapsed_ms:<20.2f} | {throughput:<22,d}")

            benchmark_results.append(
                {
                    "datasetRecords": scale,
                    "executionTimeMs": elapsed_ms,
                    "throughputRecordsPerSecond": throughput,
                }
            )
            df.unpersist()

        output_dir = os.path.join(os.path.dirname(__file__), "data")
        os.makedirs(output_dir, exist_ok=True)
        benchmark_path = os.path.join(output_dir, "benchmark_results.json")
        with open(benchmark_path, "w", encoding="utf-8") as f:
            json.dump(benchmark_results, f, indent=2)

        print("-" * 64)
        print(f"[Benchmark Saved] Detailed metrics written to: {benchmark_path}")
    finally:
        spark.stop()


if __name__ == "__main__":
    run_pyspark_etl_benchmark()
