# agent/controller/jev_backend.py
from jev_lite import TypeSafe, Choice as JevChoice, Score as JevScore, Noul as JevNoul
from .base import SystemOneClient
from .schema import Choice, Score, Noul

class JevController(SystemOneClient):
    def __init__(self):
        self.client = TypeSafe()

    def _translate(self, q):
        if isinstance(q, Choice):
            return JevChoice(instructions=q.instructions, criteria=q.criteria)
        if isinstance(q, Score):
            return JevScore(instructions=q.instructions, criteria=q.criteria)
        if isinstance(q, Noul):
            return JevNoul(instructions=q.instructions)
        raise TypeError(f"Unknown question type: {type(q)}")

    def _normalize(self, answer):
        if answer.type == "noul":
            return {"answer": answer.noul >= 0.5, "probability": answer.noul}
        if answer.type == "choice":
            return {"answer": answer.choice, "confidence": answer.confidence, "probabilities": answer.probabilities}
        if answer.type == "score":
            return {"answer": answer.value, "confidence": getattr(answer, "confidence", None)}
        raise TypeError(f"Unknown answer type: {answer.type}")

    def decide(self, state: dict, questions: dict) -> dict:
        jev_questions = {name: self._translate(q) for name, q in questions.items()}
        result = self.client.system_one.create(state=state, questions=jev_questions)
        return {name: self._normalize(ans) for name, ans in result.answers.items()}