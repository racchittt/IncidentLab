from pathlib import Path

import pytest
import yaml

from evals.schema import GroundTruth

INCIDENTS_DIR = Path(__file__).parent.parent / "incidents"
GT_FILES = sorted(INCIDENTS_DIR.glob("*.gt.yaml"))

EXPECTED_IDS = {"INC-00", "INC-01", "INC-02", "INC-03", "INC-05", "INC-08", "INC-09", "INC-10", "INC-12"}


def _id_from_path(path: Path) -> str:
    return path.name.removesuffix(".gt.yaml")


def test_found_all_nine_incidents():
    assert {_id_from_path(p) for p in GT_FILES} == EXPECTED_IDS


@pytest.mark.parametrize("path", GT_FILES, ids=_id_from_path)
def test_ground_truth_file_validates(path: Path):
    data = yaml.safe_load(path.read_text())
    gt = GroundTruth.model_validate(data)
    assert gt.id == _id_from_path(path)


@pytest.mark.parametrize("path", GT_FILES, ids=_id_from_path)
def test_causal_root_cause_has_the_deploy_placeholder(path: Path):
    # A causal deploy is meaningless as ground truth unless required_evidence
    # actually asks for it - this is exactly the class of mismatch the
    # review caught for INC-12 (a deploy present but nothing marking it as
    # the cause).
    gt = GroundTruth.model_validate(yaml.safe_load(path.read_text()))
    has_placeholder = "deploy:{causal_change_id}" in gt.required_evidence
    assert has_placeholder == (gt.root_cause.change == "causal")
