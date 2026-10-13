"""Entry point: python -m viz.viewer configs/my_scene.yaml

Serves a read-only browser viewer for a pipeline run's output. Takes the same
config file as run_tsvp.py, and loads whichever of input_video.h5,
output.file_path (e.g. denoised_video.h5), and output.cache_dir/intermediates.h5
currently exist. Does not run the pipeline itself.

For viewing arbitrary .h5 files without a config, see viz/viewer_files.py
(`python -m viz.viewer_files a.h5 b.h5 ...`), which reuses the
create_viz_app_from_files() app factory below.

Datasets are grouped for the UI's "add panel" dropdown by matching known names
(or, for the per-level detail coefficient arrays, known prefixes) against the
pipeline stage that produces them (_group_for_name() below) — this is purely a
cosmetic grouping for the menu, not a real step-ordering/execution concept
(there is no pipeline runner behind this viewer).
"""
import os
import sys
import webbrowser
from pathlib import Path
import socket

_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

# Maps a known dataset name to (group_id, group_label) for the add-panel dropdown.
_GROUP_FOR_EXACT_NAME = {
    'input_baseline':                   ('input', 'Input'),
    'denoised_baseline':                ('output', 'Output'),
    'frame_means':                      ('pre_transform', 'Pre-transform'),
    'global_mean_trend':                ('pre_transform', 'Pre-transform'),
    'video_detrended':                  ('pre_transform', 'Pre-transform'),
    'video_coeffs_approx':              ('wavelet', 'Wavelet'),
    'video_approx_pass1':               ('approx', 'Approx'),
    'video_approx_pass1_noise':         ('approx', 'Approx'),
    'video_approx_mean_noise':          ('approx', 'Approx'),
    'video_approx_noise_subtracted':    ('approx', 'Approx'),
    'video_approx_smoothed':            ('approx', 'Approx'),
}
# run_tsvp.py caches each DTCWT decomposition level's detail coefficients separately
# (video_coeffs_detail_lvl{N}, video_detail_smoothed_lvl{N}, ..._thresholded_lvl{N})
# rather than one concatenated blob, so these are matched by prefix instead of by
# exact name. Longest/most-specific prefix first, since "..._thresholded_lvl" would
# also (harmlessly) match a "..._smoothed_lvl" check if checked in the wrong order.
_GROUP_FOR_PREFIX = [
    ('video_coeffs_detail_lvl',              ('wavelet', 'Wavelet')),
    ('video_detail_smoothed_thresholded_lvl', ('detail', 'Detail')),
    ('video_detail_smoothed_lvl',             ('detail', 'Detail')),
]
_GROUP_DISPLAY_ORDER = ['input', 'pre_transform', 'wavelet', 'approx', 'detail', 'output', 'other']
_GROUP_LABELS = {
    'input': 'Input', 'pre_transform': 'Pre-transform', 'wavelet': 'Wavelet',
    'approx': 'Approx', 'detail': 'Detail', 'output': 'Output', 'other': 'Other',
}


def _group_for_name(name: str):
    if name in _GROUP_FOR_EXACT_NAME:
        return _GROUP_FOR_EXACT_NAME[name]
    for prefix, group in _GROUP_FOR_PREFIX:
        if name.startswith(prefix):
            return group
    return ('other', 'Other')


def _open_h5_readonly(path):
    """Open an .h5 file for reading, tolerant of run_tsvp.py actively writing it.

    run_tsvp.py (_cache_write) opens/writes/closes its cache file per dataset rather
    than holding one handle for the whole run, so any lock contention window is brief.
    locking=False skips the reader's own flock() call so it never contends for the
    writer's lock in the first place (no SWMR is set up on the writer side, so this
    is a best-effort read — a read landing mid-write can still hit a transient error,
    which the retry loop below absorbs).
    """
    import time
    import h5py

    last_err = None
    for attempt in range(10):
        try:
            return h5py.File(str(path), 'r', locking=False)
        except OSError as e:
            last_err = e
            time.sleep(0.2 * (attempt + 1))
    raise last_err


def create_viz_app(config_path: str):
    """Build the viewer app from a pipeline config, loading whichever of
    input_video.h5 / output.file_path / intermediates.h5 currently exist.

    Raises FileNotFoundError if none of them exist yet (i.e. the pipeline
    hasn't been run against this config at all).
    """
    from src.config import load_config
    from viz.routes import _build_app
    from viz.h5store import H5ArrayProxy
    from viz.state import PipelineState

    config = load_config(config_path)
    output_cfg = config['output']
    output_path = Path(output_cfg['file_path'])

    candidates = [output_path.parent / 'input_video.h5', output_path]
    cache_dir = output_cfg.get('cache_dir', '')
    if cache_dir:
        candidates.append(Path(cache_dir) / 'intermediates.h5')

    intermediates: dict = {}
    handles = []
    groups: dict = {}  # group_id -> [var names]

    for path in candidates:
        if not path.exists():
            continue
        handle = _open_h5_readonly(path)
        handles.append(handle)
        for key in handle.keys():
            name = key if key not in intermediates else f"{path.stem}__{key}"
            intermediates[name] = H5ArrayProxy(handle[key])
            group_id, _ = _group_for_name(key)
            groups.setdefault(group_id, []).append(name)

    if not intermediates:
        raise FileNotFoundError(
            "None of the expected files exist yet: "
            + ", ".join(str(p) for p in candidates)
            + f". Run `python run_tsvp.py {config_path}` first."
        )

    step_order = [g for g in _GROUP_DISPLAY_ORDER if g in groups]
    step_labels = {g: _GROUP_LABELS[g] for g in step_order}

    state = PipelineState(config_path=str(config_path), config_dict=config)
    state.STEP_ORDER = step_order
    state.STEP_LABELS = step_labels
    state.STEP_VARIABLES = groups
    state.intermediates = intermediates
    state._viz_h5_handles = handles  # keep refs alive

    return _build_app(state)


def create_viz_app_from_files(h5_paths):
    """Build the viewer app from arbitrary pre-existing .h5 files, without a
    pipeline config. Used by `viz/viewer_files.py`.

    Each entry in *h5_paths* may be prefixed with "thw:" to mark a file whose
    datasets are laid out (T, H, W) on disk (e.g. a raw sensor capture)
    instead of the viewer's usual (H, W, T). Those are wrapped in
    THWArrayProxy so they present as (H, W, T, 1) like every other dataset.
    """
    from viz.routes import _build_app
    from viz.h5store import H5ArrayProxy, THWArrayProxy
    from viz.state import PipelineState

    is_thw = []
    clean_paths = []
    for p in h5_paths:
        thw = p.startswith('thw:')
        clean_paths.append(p[len('thw:'):] if thw else p)
        is_thw.append(thw)

    # Keep file handles open for the server's lifetime so the proxy reads work.
    handles = [_open_h5_readonly(p) for p in clean_paths]

    intermediates: dict = {}
    groups: dict = {}
    for path, handle, thw in zip(clean_paths, handles, is_thw):
        stem = Path(path).stem
        for key in handle.keys():
            name = key if key not in intermediates else f"{stem}__{key}"
            dataset = handle[key]
            intermediates[name] = THWArrayProxy(dataset) if (thw and dataset.ndim == 3) \
                else H5ArrayProxy(dataset)
            group_id, _ = _group_for_name(key)
            groups.setdefault(group_id, []).append(name)

    if not intermediates:
        raise FileNotFoundError("No datasets found in: " + ", ".join(clean_paths))

    step_order = [g for g in _GROUP_DISPLAY_ORDER if g in groups]
    step_labels = {g: _GROUP_LABELS[g] for g in step_order}

    state = PipelineState(config_path='', config_dict={})
    state.STEP_ORDER = step_order
    state.STEP_LABELS = step_labels
    state.STEP_VARIABLES = groups
    state.intermediates = intermediates
    state._viz_h5_handles = handles  # keep refs alive

    return _build_app(state)


def main():
    import argparse
    parser = argparse.ArgumentParser(description='Standalone viewer for a TSVP pipeline run')
    parser.add_argument('config', help='Path to the same YAML config used with run_tsvp.py')
    parser.add_argument('--bind', action='store_true',
                        help='Bind to 0.0.0.0 instead of localhost')
    args = parser.parse_args()

    try:
        app = create_viz_app(args.config)
    except FileNotFoundError as e:
        print(str(e), file=sys.stderr)
        sys.exit(1)

    host = '0.0.0.0' if args.bind else os.environ.get('VIEWER_HOST', 'localhost')
    port = int(os.environ.get('VIEWER_PORT', '8765'))
    port = find_available_port(port)

    if args.bind:
        print("WARNING: --bind exposes the viewer on all network interfaces with no authentication.")

    print("Starting standalone video viewer")
    print(f"Config: {Path(args.config).resolve()}")
    print(f"Bind:   {host}:{port}")
    print(f"URL:    http://localhost:{port}")

    # Open browser after a short delay
    def _open():
        import time; time.sleep(1.5)
        webbrowser.open(f'http://localhost:{port}')

    import threading
    threading.Thread(target=_open, daemon=True).start()

    import uvicorn
    uvicorn.run(app, host=host, port=port, log_level='info')


def find_available_port(start_port):
    port = start_port
    while True:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex(('localhost', port)) != 0:
                return port
            port += 1


if __name__ == '__main__':
    main()
