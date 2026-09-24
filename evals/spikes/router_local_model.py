"""Spike B, Q1: can a small local model act as the next_tool router?

Runs the 20 scenarios in scenarios.json through a local Ollama model,
forcing a JSON answer via a schema, and records correctness/validity/latency.
"""
import json
import time
from pathlib import Path

import ollama

MODEL = "qwen2.5:3b"

CRITERIA = {
    "query_metrics": "No metrics pulled yet for this service.",
    "query_logs": "Metrics show an anomaly, need log detail.",
    "finish": "Root cause already confirmed.",
}

SCHEMA = {
    "type": "object",
    "properties": {
        "next_tool": {"type": "string", "enum": list(CRITERIA.keys())},
    },
    "required": ["next_tool"],
}

SYSTEM_PROMPT = (
    "You are the System One router for an incident-investigation agent. "
    "Given the current investigation state, pick exactly one next_tool from: "
    + ", ".join(f"{k} ({v})" for k, v in CRITERIA.items())
    + ". Respond with JSON only."
)


def ask(symptom: str, incident_id: str) -> tuple[str | None, bool, float]:
    prompt = f"incident_id: {incident_id}\nsymptom: {symptom}\nWhich next_tool?"

    start = time.perf_counter()
    response = ollama.chat(
        model=MODEL,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ],
        format=SCHEMA,
    )
    elapsed = time.perf_counter() - start

    raw = response["message"]["content"]
    try:
        parsed = json.loads(raw)
        valid_json = True
        answer = parsed.get("next_tool")
    except (json.JSONDecodeError, AttributeError):
        valid_json = False
        answer = None

    return answer, valid_json, elapsed


def main() -> None:
    scenarios = json.loads((Path(__file__).parent / "scenarios.json").read_text())

    results = []
    for s in scenarios:
        answer, valid_json, elapsed = ask(s["symptom"], s["incident_id"])
        correct = answer == s["expected"]
        results.append({
            "incident_id": s["incident_id"],
            "symptom": s["symptom"],
            "expected": s["expected"],
            "answer": answer,
            "correct": correct,
            "valid_json": valid_json,
            "seconds": round(elapsed, 3),
        })
        print(f"[{'OK' if correct else 'X '}] expected={s['expected']:<13} got={str(answer):<13} "
              f"valid_json={valid_json} time={elapsed:.2f}s  {s['symptom'][:60]}")

    n = len(results)
    n_correct = sum(r["correct"] for r in results)
    n_valid = sum(r["valid_json"] for r in results)
    avg_time = sum(r["seconds"] for r in results) / n

    print("\n--- Summary ---")
    print(f"Model: {MODEL}")
    print(f"Accuracy: {n_correct}/{n} ({100 * n_correct / n:.0f}%)")
    print(f"Valid JSON: {n_valid}/{n} ({100 * n_valid / n:.0f}%)")
    print(f"Avg time: {avg_time:.2f}s")

    out_path = Path(__file__).parent / "results-local.json"
    out_path.write_text(json.dumps({
        "model": MODEL,
        "accuracy": n_correct / n,
        "valid_json_rate": n_valid / n,
        "avg_seconds": avg_time,
        "results": results,
    }, indent=2))
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
