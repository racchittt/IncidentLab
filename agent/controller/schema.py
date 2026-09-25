from dataclasses import dataclass
from typing import Optional, Union

@dataclass
class Choice:
    instructions: str
    criteria: dict[str, Optional[str]]  # option name -> description

@dataclass
class Score:
    instructions: str
    criteria: list[str]  # ordinal labels, low to high

@dataclass
class Noul:
    instructions: str  # yes/no calibrated probability

Question = Union[Choice, Score, Noul]