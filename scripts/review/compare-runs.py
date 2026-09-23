"""Read-only comparison of two saved runs. No model/network calls.
Usage: python3 scripts/review/compare-runs.py PROJECT_DIRECTORY --without-rag RUN_ID --with-rag RUN_ID
Prints JSON; reads the project's SQLite database in read-only mode.
"""
import collections
import hashlib
import json
import pathlib
import sqlite3
import argparse

parser = argparse.ArgumentParser(description="Compare two saved local RAG runs without network calls or writes.")
parser.add_argument("project_directory", type=pathlib.Path)
parser.add_argument("--without-rag", required=True, help="Run ID for the baseline")
parser.add_argument("--with-rag", required=True, help="Run ID for the comparison")
args = parser.parse_args()
ROOT = args.project_directory.resolve()
IDS = {"without_rag": args.without_rag, "with_rag": args.with_rag}
for run_id in IDS.values():
    if pathlib.Path(run_id).name != run_id or run_id in (".", ".."):
        parser.error("Run IDs must be a single directory name")



def read(path):
    return json.loads(path.read_text())


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def differences(left, right, path=""):
    if isinstance(left, dict) and isinstance(right, dict):
        return [d for key in sorted(left.keys() | right.keys())
                for d in differences(left.get(key), right.get(key), f"{path}.{key}".strip("."))]
    if left != right:
        return [{"field": path, "without_rag": left, "with_rag": right}]
    return []


db = sqlite3.connect(f"file:{ROOT / 'project.db'}?mode=ro", uri=True)
db.row_factory = sqlite3.Row
records = {}
configs = {}
inputs = {}
for label, run_id in IDS.items():
    path = ROOT / "runs" / run_id
    run = read(path / "run.json")
    configs[label] = {"useRag": run["config"]["analysisConfig"].get("useRag", True)}
    row = dict(db.execute("SELECT * FROM threat_models WHERE id=?", (run_id,)).fetchone())
    inputs[label] = row["input"]
    architecture = read(path / "architecture.json")
    threats = read(path / "threats.json")
    trace = read(path / "rag-trace.json")
    rounds = read(path / "phases/debate.json")["rounds"]
    candidates = [t for phase in ["stride_analyst", "pasta_analyst", "attack_tree_analyst"]
                  for t in read(path / f"phases/{phase}.json")]
    selected = [source for entry in trace["entries"] for source in entry["selected"]]
    quality = read(path / "quality.json")
    usage = run["summary"]["usage"]
    records[label] = {
        "run_id": run_id, "title": run["systemName"], "started_at": run["startedAt"],
        "input_characters": len(row["input"]), "input_sha256": digest(row["input"]),
        "input_contains_rtf": "{\\rtf1" in row["input"],
        "separate_supporting_documents": row["supporting_documents"],
        "architecture_sha256": digest(json.dumps(architecture, sort_keys=True)),
        "architecture_components": [c["name"] for c in architecture["components"]],
        "architecture_control_count": len(architecture["factLedger"]["controls"]),
        "manifest_categories": run["config"]["runManifest"]["categories"],
        "raw_candidates": len(candidates),
        "raw_candidates_by_analyst": {phase: len(read(path / f"phases/{phase}_analyst.json"))
                                      for phase in ["stride", "pasta", "attack_tree"]},
        "raw_rag_labeled_citations": sum(s["sourceType"] == "rag" for t in candidates for s in t["evidenceSources"]),
        "kept_candidates": len(read(path / "phases/pre_dedup.json")["threatsKept"]),
        "reported_filtered": run["summary"]["filteredThreats"],
        "post_synthesis_count": len(read(path / "phases/threat_synthesizer.json")),
        "final_count": len(threats), "priorities": dict(collections.Counter(t["priority"] for t in threats)),
        "debate_rounds": len(rounds),
        "judge_assessments": sum(bool(a.get("judgeNotes")) for r in rounds for a in r["threatAssessments"]),
        "duration_ms": run["summary"]["durationMs"],
        "input_tokens": usage["inputTokens"], "output_tokens": usage["outputTokens"],
        "total_tokens": usage["inputTokens"] + usage["outputTokens"], "model_calls": usage["calls"],
        "estimated_cost_usd_recorded": usage["estimatedCostUsd"], "unpriced_models": usage["unpricedModels"],
        "rag": {**trace["totals"], "unique_selected_ids": len({s["id"] for s in selected}),
                "unique_source_names": len({s["source"] for s in selected}),
                "selections_by_domain": dict(collections.Counter(s["domain"] for s in selected)),
                "selections_by_source": dict(collections.Counter(s["source"] for s in selected)),
                "queries_by_profile": dict(collections.Counter(e["profile"] for e in trace["entries"]))},
        "final_threats_with_rag_label": sum(any(s["sourceType"] == "rag" for s in t["evidenceSources"]) for t in threats),
        "mitigations_ending_ellipsis": sum(t["mitigation"].endswith("...") for t in threats),
        "automatic_quality_report": quality,
        "threats": [{"review_label": f"{'ON' if label == 'with_rag' else 'OFF'}-{i + 1:02d}",
                     **{key: threat.get(key) for key in ["id", "title", "component", "description", "impact", "mitigation", "priority", "disposition", "dread", "confidenceScore", "sourceCandidateIds", "evidenceSources"]}}
                    for i, threat in enumerate(threats)],
    }
db.close()
off, on = records["without_rag"], records["with_rag"]
out = {
    "reviewed_at": "2026-09-08",
    "method": "Artifact measurements; semantic judgments are separately documented in review.md. Labels OFF/ON enumerate threats.json order, not application finding IDs.",
    "comparability": {
        "identical_effective_input": inputs["without_rag"] == inputs["with_rag"],
        "analysis_config_differences": differences(configs["without_rag"], configs["with_rag"]),
        "same_recorded_model_fingerprint": off["manifest_categories"]["models"] == on["manifest_categories"]["models"],
        "same_recorded_prompt_version_fingerprint": off["manifest_categories"]["prompts"] == on["manifest_categories"]["prompts"],
        "same_architecture": off["architecture_sha256"] == on["architecture_sha256"],
    },
    "relative_changes_percent": {k: round(100 * (on[k] / off[k] - 1), 3)
                                 for k in ["input_tokens", "output_tokens", "total_tokens", "duration_ms"]},
    "runs": records,
}
assert out["comparability"]["identical_effective_input"]
assert [d["field"] for d in out["comparability"]["analysis_config_differences"]] == ["useRag"]
assert off["rag"]["queries"] == 0 and on["rag"]["queries"] == 14
assert off["final_count"] == on["final_count"] == 10
print(json.dumps(out, ensure_ascii=False, indent=2))
