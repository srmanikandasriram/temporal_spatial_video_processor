"""Standalone pipeline: config.yaml → denoised video .h5

Usage
-----
    python run_tsvp.py configs/my_config.yaml

A scene config may set a top-level `extends: default_config.yaml` key (path
resolved relative to the scene config's own directory) to inherit fields from
a shared base config, overriding only what differs per scene. See
`src/config.py` and `configs/default_config.yaml` / `configs/scene_example.yaml`.

The temporal dimension (after input.start_idx/end_idx trimming) must be a
multiple of 2**num_levels for the DTCWT decomposition.

Steps
-----
  1. Load          — parse Boson-format NPZ capture → (H, W, T) raw video
  2. Pre-transform  — normalize to working units; optionally subtract and
                      separately smooth the per-frame mean (detrend)
  3. Wavelet        — DTCWT forward transform → approx + detail coefficients
  4. Spatial approx — smooth the approx band (one pass, or two passes with a
                      per-pixel DC noise correction in between)
  5. Spatial detail — smooth the detail coefficients, optionally skipping
                      spatially low-energy coefficients, then soft-threshold
                      coefficient magnitude
  6. Reconstruct    — inverse DTCWT, re-add the mean trend, write output .h5
"""
from __future__ import annotations

import argparse
import gc
import logging
import os
import sys
import time
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
from typing import Optional

import h5py
import hdf5plugin
import numpy as np
import pywt
import torch
from tqdm import tqdm

# make src/ importable
_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(_ROOT))

from src.config import load_config
from src.data_loading import load_data
from src.logging_config import setup_logging
from src.smoother import COMPLEX_AWARE_SMOOTHERS, SMOOTHER_REGISTRY, parse_smoother_chain, run_smoother_chain_1d
from src.wavelet import compute_dtcwt_transform, reconstruct_dtcwt_transform

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Device / worker selection
# ---------------------------------------------------------------------------

_DEVICE = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
_N_WORKERS = os.cpu_count() or 1

# DTCWT filter length used for the auto max-decomposition-level computation.
_DTCWT_FILTER_LENGTH = 10


# ---------------------------------------------------------------------------
# Chunk worker (module-level so ProcessPoolExecutor can pickle it)
# ---------------------------------------------------------------------------

def _smooth_chunk_worker(chunk: np.ndarray, smoother_name: str, params: dict) -> np.ndarray:
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from src.smoother import SMOOTHER_REGISTRY
    return SMOOTHER_REGISTRY[smoother_name](chunk, **params)


# ---------------------------------------------------------------------------
# Core smoothing loop
# ---------------------------------------------------------------------------

def _smooth_array(arr: np.ndarray, chain, thr: float, label: str) -> np.ndarray:
    """Apply a smoother chain to arr (H, W, N, 1).

    thr: skip coefficients whose max magnitude is below this (set <= 0 to disable).

    Complex-valued input (e.g. detail-band DTCWT coefficients) is handled per
    stage: smoothers listed in COMPLEX_AWARE_SMOOTHERS receive the raw complex
    2D frame directly; every other smoother runs independently on the real and
    imaginary parts, which are then recombined as real + 1j*imag — rather than
    the imaginary part being silently discarded by a real-only cast.
    """
    from skimage.transform import resize

    if not chain:
        return arr.copy()

    H, W, N, C = arr.shape
    out = arr.copy()
    is_complex_arr = np.iscomplexobj(arr)

    for stage_dict in chain:
        stage_name, stage_params = list(stage_dict.items())[0]
        stage_params = dict(stage_params)

        fn = SMOOTHER_REGISTRY.get(stage_name)
        if fn is None:
            raise ValueError(
                f"Unknown smoother '{stage_name}' in '{label}' chain. "
                f"Available: {sorted(SMOOTHER_REGISTRY)}"
            )

        # build list of indices to process (skip low-energy if thr > 0)
        indices = []
        if thr > 0:
            for k in range(N):
                frame = arr[:, :, k, :]
                if is_complex_arr:
                    # Skip only if BOTH the real and imaginary parts are low-energy —
                    # a frame survives if either part alone clears the threshold.
                    real_mag = resize(np.abs(frame.real), (H // 4, W // 4), order=2, anti_aliasing=True)
                    imag_mag = resize(np.abs(frame.imag), (H // 4, W // 4), order=2, anti_aliasing=True)
                    real_max, imag_max = real_mag.max(), imag_mag.max()
                    if real_max < thr and imag_max < thr:
                        out[:, :, k, :] = 0
                        logger.debug(f"  [{label}] index {k}: skipped "
                                    f"(real_max={real_max:.6g}, imag_max={imag_max:.6g} both < thr={thr:.6g})")
                        continue
                    indices.append(k)
                    logger.debug(f"  [{label}] index {k}: kept "
                                f"(real_max={real_max:.6g}, imag_max={imag_max:.6g}, thr={thr:.6g})")
                else:
                    mag = resize(np.abs(frame), (H // 4, W // 4), order=2, anti_aliasing=True)
                    mag_max = mag.max()
                    if mag_max < thr:
                        out[:, :, k, :] = 0
                        logger.debug(f"  [{label}] index {k}: skipped (mag_max={mag_max:.6g} < thr={thr:.6g})")
                        continue
                    indices.append(k)
                    logger.debug(f"  [{label}] index {k}: kept (mag_max={mag_max:.6g} >= thr={thr:.6g})")
        else:
            indices = list(range(N))

        if not indices:
            continue

        split_complex = is_complex_arr and stage_name not in COMPLEX_AWARE_SMOOTHERS

        logger.info(f"  [{label}] {stage_name}: {len(indices)} coeffs"
             + (f", n_workers={_N_WORKERS}" if _N_WORKERS > 1 else ""))

        # Build (key, chunk) work items. Complex input through a non-complex-
        # aware smoother is split into two independent real-valued jobs per
        # frame (real part, imaginary part), keyed (k, 're'/'im').
        if split_complex:
            jobs = []
            for k in indices:
                chunk = arr[:, :, k, 0]
                jobs.append(((k, 're'), chunk.real.astype(np.float32)))
                jobs.append(((k, 'im'), chunk.imag.astype(np.float32)))
        else:
            cast = (lambda a: a) if is_complex_arr else (lambda a: a.astype(np.float32))
            jobs = [(k, cast(arr[:, :, k, 0])) for k in indices]

        results: dict = {}
        if _N_WORKERS > 1:
            with ProcessPoolExecutor(max_workers=_N_WORKERS) as ex:
                futures = {ex.submit(_smooth_chunk_worker, chunk, stage_name, dict(stage_params)): key
                           for key, chunk in jobs}
                for fut, key in tqdm(futures.items(), total=len(futures), desc=label):
                    results[key] = fut.result()
        else:
            for key, chunk in tqdm(jobs, desc=label):
                results[key] = _smooth_chunk_worker(chunk, stage_name, dict(stage_params))

        if split_complex:
            for k in indices:
                out[:, :, k, 0] = results[(k, 're')] + 1j * results[(k, 'im')]
        else:
            for k in indices:
                out[:, :, k, 0] = results[k]

        arr = out  # feed output into next stage in chain

    return out


class _Tee:
    """Minimal stdout/stderr duplicator — writes go to every wrapped stream."""

    def __init__(self, *streams):
        self._streams = streams

    def write(self, data):
        for s in self._streams:
            s.write(data)

    def flush(self):
        for s in self._streams:
            s.flush()

    def isatty(self):
        return self._streams[0].isatty() if self._streams else False


def _cache_write(cache_path: Path, key: str, array: np.ndarray) -> None:
    """Write (or overwrite) one dataset in the cache HDF5 file, opening and closing it
    just for this write.

    Deliberately not holding one long-lived open handle across the run: several steps
    spawn ProcessPoolExecutor workers (fork), which inherit any file descriptor open in
    the parent at fork time. If the parent were killed abruptly while a cache file
    handle stayed open, orphaned workers could keep holding it open indefinitely,
    leaving a stale HDF5 file lock that blocks the next run.
    """
    # track_order=True makes the viewer's key iteration reflect write order (e.g. detail
    # levels J..1) instead of HDF5's default alphabetical order (which would sort "lvl10"
    # before "lvl2").
    with h5py.File(str(cache_path), 'a', track_order=True) as cache_file:
        if key in cache_file:
            del cache_file[key]
        if array.ndim <= 1:
            cache_file.create_dataset(key, data=array, **hdf5plugin.Zstd(clevel=4))
        else:
            H, W = array.shape[0], array.shape[1]
            chunks = (H, W) + (1,) * (array.ndim - 2)
            cache_file.create_dataset(key, data=array, chunks=chunks, **hdf5plugin.Zstd(clevel=4))
    logger.info(f"  Cached '{key}'  shape={array.shape}")


# ---------------------------------------------------------------------------
# Main pipeline
# ---------------------------------------------------------------------------

def run(config_path: str) -> None:
    config = load_config(config_path)
    output_cfg = config['output']
    cache_dir = output_cfg.get('cache_dir', '')

    if not cache_dir:
        _run_impl(config)
        return

    # Duplicate everything written to stdout/stderr for this run (log lines, tqdm
    # progress, tracebacks) into cache_dir/log.txt, in addition to the console.
    # Also repoint any existing logging StreamHandler at the tee'd stream, so log
    # lines land in the file too instead of only the raw prints/tqdm bars — a
    # StreamHandler captures its stream object at construction time, so simply
    # reassigning sys.stdout afterward wouldn't otherwise reach it.
    Path(cache_dir).mkdir(parents=True, exist_ok=True)
    log_path = Path(cache_dir) / 'log.txt'
    old_stdout, old_stderr = sys.stdout, sys.stderr

    with open(log_path, 'w') as log_file:
        sys.stdout = _Tee(old_stdout, log_file)
        sys.stderr = _Tee(old_stderr, log_file)
        patched_handlers = [
            h for h in logging.getLogger().handlers
            if isinstance(h, logging.StreamHandler) and h.stream is old_stdout
        ]
        for h in patched_handlers:
            h.stream = sys.stdout
        logger.info(f"Logging to {log_path}")
        try:
            _run_impl(config)
        finally:
            for h in patched_handlers:
                h.stream = old_stdout
            sys.stdout, sys.stderr = old_stdout, old_stderr


def _run_impl(config: dict) -> None:
    t0_total = time.perf_counter()

    output_cfg = config['output']
    pre_cfg = config.get('pre_transform', {})
    tt_cfg = config.get('temporal_transform', {})
    approx_cfg = config.get('spatial_processing', {}).get('approx', {})
    detail_cfg = config.get('spatial_processing', {}).get('detail', {})

    output_path = Path(output_cfg['file_path'])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cache_dir = output_cfg.get('cache_dir', '')

    # ── 1. Load ──────────────────────────────────────────────────────────────
    logger.info("Loading data…")
    data = load_data(config)
    raw_np = data['thermal_data_np']  # (H, W, T) raw ADU, float32
    H, W, T = raw_np.shape
    logger.info(f"Loaded: ({H}, {W}, {T})  device={_DEVICE}")

    input_path = output_path.parent / 'input_video.h5'
    logger.info(f"Writing {input_path}  shape=({H},{W},{T})…")
    with h5py.File(str(input_path), 'w') as f:
        f.create_dataset(
            'input_baseline',
            data=raw_np,
            chunks=(H, W, 1),
            **hdf5plugin.Zstd(clevel=4),
        )

    # cache_path is resolved right after loading (if output.cache_dir is set); each
    # step below writes into it immediately after computing its result, gated by that
    # step's own `cache: true/false` flag. _cache_write opens/closes the file per
    # write rather than holding one handle open for the whole run — see its docstring.
    cache_path: Optional[Path] = None
    if cache_dir:
        cache_path = Path(cache_dir) / 'intermediates.h5'
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        with h5py.File(str(cache_path), 'w', track_order=True):
            pass  # start this run's cache file fresh (truncate any previous contents)
        logger.info(f"Caching intermediates to {cache_path}")

    # ── 2. Pre-transform ─────────────────────────────────────────────────
    common_offset = float(pre_cfg.get('common_offset', 0.0))
    common_scale = float(pre_cfg.get('common_scale', 1.0))
    video = ((raw_np - common_offset) / common_scale)[:, :, :, None].astype(np.float32)  # (H, W, T, 1)
    del raw_np

    global_mean_trend = None
    if pre_cfg.get('frame_mean_detrend', False):
        logger.info("Detrending frame means…")
        mean_chain = parse_smoother_chain(pre_cfg.get('mean_smooth_chain', 'none'))
        frame_means = video.mean(axis=(0, 1))[:, 0]  # (T,) raw, unsmoothed per-frame mean
        global_mean_trend = run_smoother_chain_1d(frame_means, mean_chain, None, 'mean_trend')
        # Subtract the raw per-frame mean so the residual fed to the wavelet transform is
        # exactly zero-mean per frame; the smoothed trend is added back at reconstruction,
        # replacing the noisy raw per-frame DC level with a denoised one.
        video = video - frame_means.reshape(1, 1, -1, 1)
        if cache_path is not None and pre_cfg.get('cache', False):
            _cache_write(cache_path, 'frame_means', frame_means)
            _cache_write(cache_path, 'global_mean_trend', global_mean_trend)
            _cache_write(cache_path, 'video_detrended', video[:, :, :, 0])

    # ── 3. Wavelet transform ─────────────────────────────────────────────
    level1_filter = tt_cfg.get('level1_filter', 'near_sym_a')
    level2p_filter = tt_cfg.get('level2p_filter', 'qshift_a')
    num_levels = tt_cfg.get('num_levels', -1)

    max_levels = pywt.dwt_max_level(T, _DTCWT_FILTER_LENGTH)
    temporal_levels = num_levels if num_levels > 0 else max_levels
    required_mult = 2 ** temporal_levels

    if T % required_mult != 0:
        sys.exit(
            f"ERROR: temporal_length={T} must be a multiple of 2**{temporal_levels}={required_mult}. "
            f"Remainder: {T % required_mult}. Trim the video or reduce num_levels."
        )

    logger.info(f"Wavelet: DTCWT (biort={level1_filter}, qshift={level2p_filter})  levels={temporal_levels}  T={T}")
    t0 = time.perf_counter()

    video_pt = torch.from_numpy(video).to(_DEVICE)
    batch = max(256, int(4 * 2**30 / (T * 32)))
    video_coeffs_t, coeff_lengths = compute_dtcwt_transform(
        video_pt, temporal_levels, level1_filter=level1_filter, level2p_filter=level2p_filter,
        batch_size=batch, output_device=torch.device('cpu'))
    del video_pt
    video_coeffs = video_coeffs_t.cpu().numpy()
    del video_coeffs_t

    # coeff_lengths is [n_approx, len_lvlJ, len_lvl(J-1), ..., len_lvl1] — the detail
    # bands are ordered coarsest (level temporal_levels) first, finest (level 1) last;
    # see wavelet.py's `for hp in highpasses[::-1]` stacking order. detail_levels lists
    # the actual level number for each band in that same order, so
    # zip(detail_levels, coeff_lengths[1:]) pairs each band with its physical level.
    detail_levels = list(range(temporal_levels, 0, -1))  # [J, J-1, ..., 1]
    starts = np.cumsum([0] + list(coeff_lengths))
    approx = video_coeffs[:, :, starts[0]:starts[1], :]
    detail_by_level = {
        lvl: video_coeffs[:, :, starts[i + 1]:starts[i + 2], :]
        for i, lvl in enumerate(detail_levels)
    }

    if np.iscomplexobj(approx):  # imag part is identically zero for the lowpass band
        approx = approx.real.astype(np.float32)
    del video_coeffs  # approx/detail_by_level are views; the underlying buffer stays alive via them

    logger.info(f"  Transform done in {time.perf_counter()-t0:.1f}s  coeff_lengths={coeff_lengths}"
                f"  detail_levels={detail_levels}")
    gc.collect()

    if cache_path is not None and tt_cfg.get('cache', False):
        _cache_write(cache_path, 'video_coeffs_approx', approx)
        for lvl in detail_levels:
            _cache_write(cache_path, f'video_coeffs_detail_lvl{lvl}', detail_by_level[lvl])

    # ── 4. Spatial processing: approx ────────────────────────────────────
    twopass = approx_cfg.get('twopass', True)
    pass1_chain = parse_smoother_chain(approx_cfg.get('pass1_smooth_chain', 'none'))
    pass2_chain = parse_smoother_chain(approx_cfg.get('pass2_smooth_chain', 'none'))

    cache_approx = cache_path is not None and approx_cfg.get('cache', False)

    logger.info("Smoothing approx (pass 1)…")
    t0 = time.perf_counter()
    approx_pass1 = _smooth_array(approx, pass1_chain, -1, 'approx_pass1')

    if twopass:
        # Subtract the per-pixel mean pass-1 residual before pass 2, so pass 2
        # denoises a signal that's already centered around zero noise.
        pass1_noise = approx - approx_pass1
        mean_noise = pass1_noise.mean(axis=2, keepdims=True)
        approx_noise_subtracted = approx - mean_noise
        logger.info("Smoothing approx (pass 2)…")
        approx_smoothed = _smooth_array(approx_noise_subtracted, pass2_chain, -1, 'approx_pass2')
        if cache_approx:
            _cache_write(cache_path, 'video_approx_pass1', approx_pass1)
            _cache_write(cache_path, 'video_approx_pass1_noise', pass1_noise)
            _cache_write(cache_path, 'video_approx_mean_noise', mean_noise)
            _cache_write(cache_path, 'video_approx_noise_subtracted', approx_noise_subtracted)
        del pass1_noise, mean_noise, approx_noise_subtracted
    else:
        approx_smoothed = approx_pass1
    del approx_pass1
    logger.info(f"  Approx smoothing done in {time.perf_counter()-t0:.1f}s")

    if cache_approx:
        _cache_write(cache_path, 'video_approx_smoothed', approx_smoothed)

    # ── 5. Spatial processing: detail ────────────────────────────────────
    # Each decomposition level is smoothed (and cached) separately for transparency —
    # the same smooth_chain/energy_threshold/magnitude_soft_threshold config applies
    # to every level, but keeping the levels apart makes each one's contribution
    # inspectable in the viewer instead of one opaque concatenated blob.
    detail_chain = parse_smoother_chain(detail_cfg.get('smooth_chain', 'none'))
    energy_threshold = detail_cfg.get('energy_threshold')
    detail_thr = float(energy_threshold) if energy_threshold is not None else -1.0
    soft_threshold = detail_cfg.get('magnitude_soft_threshold')
    soft_threshold = float(soft_threshold) if soft_threshold is not None else None

    cache_detail = cache_path is not None and detail_cfg.get('cache', False)

    t0 = time.perf_counter()
    detail_smoothed_by_level = {}
    for lvl in detail_levels:
        d = detail_by_level[lvl]
        logger.info(f"Smoothing detail level {lvl} ({d.shape[2]} coeffs)…")
        d_smoothed = _smooth_array(d, detail_chain, detail_thr, f'detail_lvl{lvl}')
        if cache_detail:
            _cache_write(cache_path, f'video_detail_smoothed_lvl{lvl}', d_smoothed)

        if soft_threshold is not None:
            mag = np.abs(d_smoothed)
            phase = np.angle(d_smoothed)
            d_smoothed = (np.maximum(mag - soft_threshold, 0.0) * np.exp(1j * phase)).astype(np.complex64)
        if cache_detail:
            _cache_write(cache_path, f'video_detail_smoothed_thresholded_lvl{lvl}', d_smoothed)

        detail_smoothed_by_level[lvl] = d_smoothed
        del d
    del detail_by_level
    logger.info(f"  Detail smoothing done in {time.perf_counter()-t0:.1f}s")
    gc.collect()

    # ── 6. Reconstruct ───────────────────────────────────────────────────
    logger.info("Reconstructing…")
    t0 = time.perf_counter()

    coeffs_np = np.concatenate(
        [approx_smoothed] + [detail_smoothed_by_level[lvl] for lvl in detail_levels], axis=2)
    coeffs_pt = torch.from_numpy(coeffs_np).to(_DEVICE)
    del coeffs_np, detail_smoothed_by_level

    rec = reconstruct_dtcwt_transform(
        coeffs_pt, coeff_lengths, temporal_levels, T,
        level1_filter=level1_filter, level2p_filter=level2p_filter)
    del coeffs_pt
    denoised = rec.cpu().numpy() if rec.device.type != 'cpu' else rec.numpy()
    del rec

    if global_mean_trend is not None:
        denoised = denoised + global_mean_trend.reshape(1, 1, -1, 1)

    logger.info(f"  Reconstruction done in {time.perf_counter()-t0:.1f}s")

    # ── 7. Write output ──────────────────────────────────────────────────
    logger.info(f"Writing {output_path}  shape=({H},{W},{T})…")

    with h5py.File(str(output_path), 'w') as f:
        ds = f.create_dataset(
            'denoised_baseline',
            shape=(H, W, T),
            dtype=np.float32,
            chunks=(H, W, 1),
            **hdf5plugin.Zstd(clevel=4),
        )
        for t in range(T):
            ds[:, :, t] = denoised[:, :, t, 0] * common_scale + common_offset

    logger.info(f"Done. Total: {time.perf_counter()-t0_total:.1f}s  →  {output_path}")


# ---------------------------------------------------------------------------

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('config', help='Path to YAML config file')
    parser.add_argument('--log-level', default='INFO',
                        choices=['DEBUG', 'INFO', 'WARNING', 'ERROR'],
                        help='Logging verbosity (default: INFO)')
    args = parser.parse_args()
    setup_logging(level=getattr(logging, args.log_level))
    run(args.config)
