import os
from .jev_connector import JevController
from .laya_connector import LayaController

def get_controller():
    backend = os.getenv("CONTROLLER_BACKEND", "laya").lower()
    if backend == "jev":
        return JevController()
    if backend == "laya":
        return LayaController()
    raise ValueError(f"Unknown CONTROLLER_BACKEND: {backend}")