"""Minimal pipeline state container for the standalone viewer.

The viewer only ever constructs a `PipelineState` describing already-loaded,
pre-grouped data (see `viz/viewer.py::create_viz_app`) — there is no
in-repo pipeline runner wired up to drive additional steps. This class stays
generic (step order/labels/variables are all just plain instance attributes)
so `viz/routes.py`'s status/variable-listing/rendering endpoints work against
whatever step layout the caller sets up.
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, List


class PipelineState:
    """Holds one 'session' worth of loaded/derived arrays for the viewer.

    STEP_ORDER / STEP_LABELS / STEP_VARIABLES are set by the caller after
    construction (see `create_viz_app`) — they default to empty here.
    """

    def __init__(self, config_path: str, config_dict: dict):
        self.config_path = config_path
        self.config_dict: dict = deepcopy(config_dict)

        self.STEP_ORDER: List[str] = []
        self.STEP_LABELS: Dict[str, str] = {}
        self.STEP_VARIABLES: Dict[str, List[str]] = {}

        self.intermediates: Dict[str, Any] = {}
