from agent.controller.factory import get_controller
from agent.controller.schema import Choice, Noul

controller = get_controller()

result = controller.decide(
    state={"incident_id": "INC-01", "symptom": "order latency +300%, no root cause yet"},
    questions={
        "needs_investigation": Noul(instructions="Does this incident need investigation right now?"),
        "next_tool": Choice(
            instructions="Which tool should the agent call next?",
            criteria={
                "query_metrics": "No metrics pulled yet for this service.",
                "query_logs": "Metrics show an anomaly, need log detail.",
                "finish": "Root cause already confirmed.",
            },
        ),
    },
)
print(result)