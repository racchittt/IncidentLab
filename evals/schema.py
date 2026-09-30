from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, field_validator


class FaultCategory(str, Enum):
    NO_INCIDENT = "no_incident"
    RETRY_MISCONFIGURATION = "retry_misconfiguration"
    CAPACITY_EXHAUSTION = "capacity_exhaustion"
    CACHE_STAMPEDE = "cache_stampede"
    DEPENDENCY_DEGRADATION = "dependency_degradation"
    MISROUTED_MESSAGING = "misrouted_messaging"
    RESOURCE_LEAK = "resource_leak"
    RATE_LIMIT_MISCONFIGURATION = "rate_limit_misconfiguration"
    INFRASTRUCTURE_BLIP = "infrastructure_blip"
    AUTH_MISCONFIGURATION = "auth_misconfiguration"
    CAPACITY_MISCONFIGURATION = "capacity_misconfiguration"
    STALE_SECRET = "stale_secret"
    PERFORMANCE_REGRESSION = "performance_regression"


# deploy:<change_id> | metric:<service>:<metric_name> | log:<service>:<template_hash> | trace:<service>:<span_name>
_EVIDENCE_PREFIXES = ("deploy:", "metric:", "log:", "trace:")


def _check_evidence_keys(patterns: list[str]) -> list[str]:
    for pattern in patterns:
        if not pattern.startswith(_EVIDENCE_PREFIXES):
            raise ValueError(f"evidence pattern {pattern!r} doesn't start with one of {_EVIDENCE_PREFIXES}")
    return patterns


class RootCause(BaseModel):
    service: str
    fault_category: FaultCategory
    # "causal" in the source .gt.yaml - a placeholder the recorder resolves
    # to a real change_id at record time. None for incidents whose root
    # cause isn't a config change at all (a load spike, a toxic, a network
    # blip) - there's nothing to resolve.
    change: Optional[str] = None


class GroundTruth(BaseModel):
    id: str = Field(pattern=r"^INC-\d{2}$")
    # What the on-call actually gets paged with - symptom only, never the
    # mechanism or the fix. An alert that gives away the cause defeats the
    # point of the incident.
    alert: str
    root_cause: RootCause
    required_evidence: list[str]
    acceptable_evidence: list[str] = []
    # deploy:{decoy_change_ids} in the source file - a placeholder the
    # recorder expands to every decoy deploy's actual change_id, since a
    # run can have more than one (the incident's own decoy, if it has one,
    # plus Task 5's randomly injected extra decoy).
    decoys: list[str] = []

    _check_required = field_validator("required_evidence")(_check_evidence_keys)
    _check_acceptable = field_validator("acceptable_evidence")(_check_evidence_keys)
    _check_decoys = field_validator("decoys")(_check_evidence_keys)


class EvidenceItem(BaseModel):
    key: str
    summary: str
