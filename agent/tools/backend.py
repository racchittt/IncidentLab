from typing import Protocol

from evals.schema import EvidenceItem


class ToolBackend(Protocol):
    """Six investigation tools, structurally typed so ReplayBackend (frozen
    bundle data) and LiveBackend (Prometheus/Loki/Tempo/the registry
    directly, added in Task 5) are interchangeable without either one
    inheriting from this - see ADR-04."""

    def list_services(self) -> list[EvidenceItem]: ...

    def get_service_graph(self) -> list[EvidenceItem]: ...

    def query_metrics(self, service: str, metric: str | None = None) -> list[EvidenceItem]: ...

    def query_logs(
        self, service: str, level: str | None = None, contains: str | None = None
    ) -> list[EvidenceItem]: ...

    def query_traces(
        self, service: str, min_duration_ms: float | None = None, errors_only: bool = False
    ) -> list[EvidenceItem]: ...

    def list_deployments(self, service: str | None = None) -> list[EvidenceItem]: ...

    def get_change_diff(self, change_id: str) -> list[EvidenceItem]: ...
