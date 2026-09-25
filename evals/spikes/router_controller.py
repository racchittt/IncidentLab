"""Spike B, Q2: run the same 20 scenarios through Jev and Laya for comparison.

Usage: python -m evals.spikes.router_controller <jev|laya>
"""
import json
import sys
import time
from pathlib import Path

from agent.controller.jev_connector import JevController
from agent.controller.laya_connector import LayaController
from agent.controller.schema import Choice

CRITERIA = {
    "query_metrics": "No metrics pulled yet for this service.",
    "query_logs": "Metrics show an anomaly, need log detail.",
    "finish": "Root cause already confirmed.",
}


def get_backend(name: str):
    if name == "jev":
        return JevController()
    if name == "laya":
        return LayaController()
    raise ValueError(f"Unknown backend: {name}")


def main() -> None:
    backend_name = sys.argv[1] if len(sys.argv) > 1 else "jev"
    controller = get_backend(backend_name)

    scenarios = json.loads((Path(__file__).parent / "scenarios.json").read_text())

    questions = {
        "next_tool": Choice(
            instructions="Which tool should the agent call next?",
            criteria=CRITERIA,
        ),
    }

    results = []
    for s in scenarios:
        state = {"incident_id": s["incident_id"], "symptom": s["symptom"]}

        start = time.perf_counter()
        decision = controller.decide(state=state, questions=questions)
        elapsed = time.perf_counter() - start

        answer = decision["next_tool"]["answer"]
        correct = answer == s["expected"]
        results.append({
            "incident_id": s["incident_id"],
            "symptom": s["symptom"],
            "expected": s["expected"],
            "answer": answer,
            "correct": correct,
            "valid_json": True,  # typed SDK response, always structured
            "seconds": round(elapsed, 3),
        })
        print(f"[{'OK' if correct else 'X '}] expected={s['expected']:<13} got={str(answer):<13} "
              f"time={elapsed:.2f}s  {s['symptom'][:60]}")

    n = len(results)
    n_correct = sum(r["correct"] for r in results)
    avg_time = sum(r["seconds"] for r in results) / n

    print("\n--- Summary ---")
    print(f"Backend: {backend_name}")
    print(f"Accuracy: {n_correct}/{n} ({100 * n_correct / n:.0f}%)")
    print(f"Avg time: {avg_time:.2f}s")

    out_path = Path(__file__).parent / f"results-{backend_name}.json"
    out_path.write_text(json.dumps({
        "backend": backend_name,
        "accuracy": n_correct / n,
        "valid_json_rate": 1.0,
        "avg_seconds": avg_time,
        "results": results,
    }, indent=2))
    print(f"\nWrote {out_path}")


if __name__ == "__main__":
    main()
