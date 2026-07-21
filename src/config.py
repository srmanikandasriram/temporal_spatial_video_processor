"""Pipeline config loading with a base + override merge via `extends:`.

A scene config only needs to set the handful of fields that differ from a
shared baseline:

    # configs/default_config.yaml
    pre_transform:
      common_offset: 15000
      common_scale: 20
    temporal_transform:
      level1_filter: 'near_sym_a'
      level2p_filter: 'qshift_a'
      num_levels: -1
    ...

    # configs/my_scene.yaml
    extends: default_config.yaml
    scene_name: my_scene
    input:
      file_path: '/data/my_scene.npz'
    output:
      file_path: '/data/my_scene_denoised.h5'

`load_config` resolves `extends` (relative to the config file's own
directory, chained if the base itself extends another file), then deep-merges
the scene's own keys on top: nested dicts merge key-by-key, everything else
(scalars, lists, smoother chains) is replaced wholesale by the override.
"""
from __future__ import annotations

from pathlib import Path
from typing import Union

import yaml


def load_config(config_path: Union[str, Path]) -> dict:
    """Load a YAML pipeline config, merging in a base config if `extends:` is set."""
    return _load_config(config_path, seen=frozenset())


def _load_config(config_path: Union[str, Path], seen: frozenset) -> dict:
    config_path = Path(config_path).resolve()
    if not config_path.exists():
        raise FileNotFoundError(f"Configuration file not found: {config_path}")
    if config_path in seen:
        chain = ' -> '.join(str(p) for p in (*seen, config_path))
        raise ValueError(f"Circular 'extends' chain: {chain}")

    try:
        with open(config_path) as f:
            config = yaml.safe_load(f)
    except yaml.YAMLError as e:
        raise ValueError(f"Failed to parse YAML config {config_path}: {e}")
    if not config or not isinstance(config, dict):
        raise ValueError(f"Configuration file is empty or malformed: {config_path}")

    extends = config.pop('extends', None)
    if extends is None:
        return config

    base_path = Path(extends)
    if not base_path.is_absolute():
        base_path = config_path.parent / base_path
    base_config = _load_config(base_path, seen | {config_path})
    return _deep_merge(base_config, config)


def _deep_merge(base: dict, override: dict) -> dict:
    merged = dict(base)
    for key, value in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged
