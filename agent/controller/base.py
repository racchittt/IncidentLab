from abc import ABC, abstractmethod
from .schema import Question

class SystemOneClient(ABC):
    @abstractmethod
    def decide(self, state: dict, questions: dict[str, Question]) -> dict:
        """Returns {question_name: {"answer": ..., "confidence": float}}"""
        raise NotImplementedError