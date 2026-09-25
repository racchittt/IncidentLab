import laya
from .base import SystemOneClient
from .schema import Choice, Score, Noul

class LayaController(SystemOneClient):
    def __init__(self, checkpoint: str = "convaiinnovations/laya"):
        self.agent = laya.load(checkpoint)

    def _translate(self, q):
        if isinstance(q, Choice):
            return {"type": "choice", "instructions": q.instructions, "criteria": q.criteria}
        if isinstance(q, Score):
            return {"type": "score", "instructions": q.instructions, "criteria": q.criteria}
        if isinstance(q, Noul):
            return {"type": "noul", "instructions": q.instructions}
        raise TypeError(f"Unknown question type: {type(q)}")

    def _normalize(self, ans: dict) -> dict:
        if ans["type"] == "noul":
            return {"answer": ans["noul"] >= 0.5, "probability": ans["noul"]}
        if ans["type"] == "choice":
            return {"answer": ans["choice"], "confidence": ans["answer_confidence"], "probabilities": ans["probabilities"]}
        if ans["type"] == "score":
            return {"answer": ans.get("value"), "confidence": ans.get("answer_confidence")}
        raise TypeError(f"Unknown answer type: {ans['type']}")

    def decide(self, state: dict, questions: dict) -> dict:
        laya_questions = {name: self._translate(q) for name, q in questions.items()}
        raw = self.agent.predict(state, laya_questions)
        return {name: self._normalize(ans) for name, ans in raw["answers"].items()}