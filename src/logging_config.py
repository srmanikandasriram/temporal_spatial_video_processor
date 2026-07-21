"""Centralized logging setup for TSVP.

Call `setup_logging()` once, from the entry point (`run_tsvp.py`), before any
other TSVP code logs anything. Every other module gets its own logger the
standard way:

    import logging
    logger = logging.getLogger(__name__)

and just logs through it — level/formatting/handlers are controlled solely by
the one `setup_logging()` call, not by individual modules. Loggers propagate
up to the root logger by default, so this one call configures logging for
the whole package regardless of which module is doing the logging.
"""

import logging
import sys
from pathlib import Path
from typing import Optional

_FORMAT = '%(asctime)s %(levelname)-7s %(name)s: %(message)s'
_DATEFMT = '%H:%M:%S'


def setup_logging(level: int = logging.INFO, log_file: Optional[str] = None) -> None:
    """Configure the root logger's handlers/formatting/level.

    Safe to call more than once — re-running replaces the handlers rather
    than stacking duplicates.
    """
    root = logging.getLogger()
    root.setLevel(level)
    root.handlers.clear()

    formatter = logging.Formatter(_FORMAT, datefmt=_DATEFMT)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)
    root.addHandler(console_handler)

    if log_file:
        log_path = Path(log_file)
        log_path.parent.mkdir(parents=True, exist_ok=True)
        file_handler = logging.FileHandler(log_path)
        file_handler.setLevel(level)
        file_handler.setFormatter(formatter)
        root.addHandler(file_handler)
