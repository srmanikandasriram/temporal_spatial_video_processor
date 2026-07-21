"""Rendering utilities: numpy arrays → RGBA bytes for the browser."""
from __future__ import annotations

from typing import Optional, Tuple
import numpy as np
import matplotlib.cm as cm
from skimage.exposure import equalize_adapthist, equalize_hist


VALID_CMAPS = {
    'inferno', 'magma', 'plasma', 'viridis',
    'hot', 'afmhot', 'gist_heat',
    'gray', 'bone', 'pink',
    'jet', 'turbo', 'rainbow',
    'coolwarm', 'bwr', 'RdBu', 'RdBu_r', 'BrBG', 'BrBG_r',
    'twilight', 'twilight_shifted',
    'isocontours',
}


def _normalize(arr: np.ndarray, pmin: float, pmax: float) -> np.ndarray:
    vmin = float(np.percentile(arr, pmin))
    vmax = float(np.percentile(arr, pmax))
    if vmax == vmin:
        vmax = vmin + 1e-8
    return np.clip((arr - vmin) / (vmax - vmin), 0.0, 1.0).astype(np.float32)


def _apply_clahe(normalized: np.ndarray) -> np.ndarray:
    """Apply CLAHE to a [0, 1] float32 2D image. Returns [0, 1] float32."""
    return equalize_adapthist(normalized, clip_limit=0.03).astype(np.float32)


def _apply_histeq(normalized: np.ndarray) -> np.ndarray:
    """Apply global histogram equalization to a [0, 1] float32 2D image. Returns [0, 1] float32."""
    return equalize_hist(normalized).astype(np.float32)


def _apply_joint_histeq(a: np.ndarray, b: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    """Apply histogram equalization using a joint CDF computed from both images.

    Both inputs must be [0, 1] float32 2D arrays. The same CDF mapping (derived
    from pooled pixels) is applied to each, so relative brightness is preserved
    across the two images.
    """
    nbins = 256
    # Compute joint histogram from pooled pixels
    combined = np.concatenate([a.ravel(), b.ravel()])
    hist, bin_edges = np.histogram(combined, bins=nbins, range=(0.0, 1.0))
    cdf = hist.cumsum().astype(np.float64)
    cdf /= cdf[-1]  # normalize to [0, 1]
    bin_centers = 0.5 * (bin_edges[:-1] + bin_edges[1:])
    # Apply the same mapping to both arrays via linear interpolation
    out_a = np.interp(a.ravel(), bin_centers, cdf).reshape(a.shape).astype(np.float32)
    out_b = np.interp(b.ravel(), bin_centers, cdf).reshape(b.shape).astype(np.float32)
    return out_a, out_b


def _normalize_frame(
    frame: np.ndarray,
    pmin: float,
    pmax: float,
    global_vmin: Optional[float],
    global_vmax: Optional[float],
) -> np.ndarray:
    """Percentile-normalize a 2D float frame to [0, 1]."""
    f32 = frame.astype(np.float32)
    if global_vmin is not None and global_vmax is not None:
        span = global_vmax - global_vmin
        if span < 1e-8:
            span = 1e-8
        return np.clip((f32 - global_vmin) / span, 0.0, 1.0).astype(np.float32)
    return _normalize(f32, pmin, pmax)


def _colormap_bytes(normalized: np.ndarray, cmap: str) -> bytes:
    return (cm.get_cmap(cmap)(normalized) * 255).astype(np.uint8).tobytes()


def render_frame_rgba(
    frame: np.ndarray,
    cmap: str = 'inferno',
    pmin: float = 1.0,
    pmax: float = 99.0,
    clahe: bool = False,
    histeq: bool = False,
    isocontour_range: float = 1.0,
    global_vmin: Optional[float] = None,
    global_vmax: Optional[float] = None,
) -> bytes:
    """Convert a 2D float array to packed RGBA bytes (4 bytes/pixel, row-major)."""
    if cmap not in VALID_CMAPS:
        cmap = 'inferno'
    if cmap == 'isocontours':
        rng = max(float(isocontour_range), 1e-6)
        f = frame.astype(np.float32)
        if global_vmin is not None and global_vmax is not None:
            span = global_vmax - global_vmin
            if span < 1e-8:
                span = 1e-8
            f = (f - global_vmin) / span
        modded = (f % rng) / rng
        rgba = (cm.get_cmap('turbo')(modded) * 255).astype(np.uint8)
        return rgba.tobytes()
    normalized = _normalize_frame(frame, pmin, pmax, global_vmin, global_vmax)
    if clahe:
        normalized = _apply_clahe(normalized)
    elif histeq:
        normalized = _apply_histeq(normalized)
    return _colormap_bytes(normalized, cmap)


def render_compare_rgba(
    frame1: np.ndarray,
    frame2: np.ndarray,
    cmap: str = 'inferno',
    pmin: float = 1.0,
    pmax: float = 99.0,
    clahe: bool = False,
    histeq: bool = False,
    isocontour_range: float = 1.0,
) -> Tuple[bytes, bytes]:
    """Render two frames with shared contrast enhancement.

    When histeq=True, the CDF is computed from the pooled pixels of both frames
    and the same mapping is applied to each, preserving relative brightness.
    When clahe=True, each frame gets independent CLAHE (CLAHE has no meaningful
    joint mode since it operates on local tiles).
    Returns (rgba_bytes_1, rgba_bytes_2).
    """
    if cmap not in VALID_CMAPS:
        cmap = 'inferno'
    if cmap == 'isocontours':
        # Harmonize ranges by taking the envelope of each frame's percentile bounds,
        # avoiding the cost of sorting a pooled array.
        f1 = frame1.astype(np.float32)
        f2 = frame2.astype(np.float32)
        shared_vmin = min(float(np.percentile(f1, pmin)), float(np.percentile(f2, pmin)))
        shared_vmax = max(float(np.percentile(f1, pmax)), float(np.percentile(f2, pmax)))
        return (
            render_frame_rgba(frame1, cmap=cmap, pmin=pmin, pmax=pmax,
                              isocontour_range=isocontour_range,
                              global_vmin=shared_vmin, global_vmax=shared_vmax),
            render_frame_rgba(frame2, cmap=cmap, pmin=pmin, pmax=pmax,
                              isocontour_range=isocontour_range,
                              global_vmin=shared_vmin, global_vmax=shared_vmax),
        )
    norm1 = _normalize_frame(frame1, pmin, pmax, None, None)
    norm2 = _normalize_frame(frame2, pmin, pmax, None, None)
    if histeq:
        norm1, norm2 = _apply_joint_histeq(norm1, norm2)
    elif clahe:
        norm1 = _apply_clahe(norm1)
        norm2 = _apply_clahe(norm2)
    return _colormap_bytes(norm1, cmap), _colormap_bytes(norm2, cmap)


def render_heatmap_rgba(
    arr: np.ndarray,
    cmap: str = 'inferno',
    pmin: float = 1.0,
    pmax: float = 99.0,
    clahe: bool = False,
    histeq: bool = False,
    isocontour_range: float = 1.0,
    global_vmin: Optional[float] = None,
    global_vmax: Optional[float] = None,
) -> Tuple[bytes, int, int]:
    """Squeeze a multi-dim array to 2D and render as RGBA.

    Returns (rgba_bytes, width, height).
    """
    squeezed = arr.squeeze()
    if squeezed.ndim == 1:
        # Make a tall narrow image
        squeezed = squeezed[:, None]
    if squeezed.ndim != 2:
        raise ValueError(f"Cannot render array of shape {arr.shape} as 2D heatmap")
    height, width = squeezed.shape
    rgba_bytes = render_frame_rgba(squeezed, cmap=cmap, pmin=pmin, pmax=pmax, clahe=clahe,
                                   histeq=histeq, isocontour_range=isocontour_range,
                                   global_vmin=global_vmin, global_vmax=global_vmax)
    return rgba_bytes, width, height


def get_render_type(name: str, arr) -> Optional[str]:
    """Infer the best panel type for a variable from its value."""
    if arr is None:
        return None
    if isinstance(arr, dict):
        return None
    if isinstance(arr, (int, float, str)):
        return None
    if isinstance(arr, list):
        if all(isinstance(x, (int, float)) for x in arr):
            return 'barchart'
        return None
    if not hasattr(arr, 'shape') or not hasattr(arr, 'dtype'):
        return None

    shape = arr.shape
    ndim = arr.ndim

    # Count non-singleton dimensions; effectively-1D arrays are always 'line'
    n_effective = sum(1 for d in shape if d > 1)
    if n_effective <= 1:
        return 'line'

    if ndim == 4:
        H, W, T, C = shape
        if H > 1 and W > 1 and T > 1:
            return 'video'
        if (H == 1 or W == 1) and T > 1:
            return 'heatmap'
        return 'image'

    if ndim == 3:
        H, W, T = shape
        if H > 1 and W > 1 and T > 1:
            return 'video'
        if (H == 1 or W == 1) and T > 1:
            return 'heatmap'
        return 'image'

    if ndim == 2:
        H, W = shape
        if H > 1 and W > 1:
            return 'heatmap'
        return 'line'

    return None


def get_frame_count(arr: np.ndarray) -> int:
    """Return the number of 'frames' in a video/heatmap array."""
    if arr.ndim >= 3:
        return arr.shape[2]
    if arr.ndim == 2:
        return arr.shape[1]
    return 1


def is_complex_array(arr) -> bool:
    dtype = getattr(arr, 'dtype', None)
    return dtype is not None and np.issubdtype(dtype, np.complexfloating)


def apply_component(arr: np.ndarray, component: str) -> np.ndarray:
    """Convert an array (possibly complex) to float32 by extracting a component."""
    if not np.iscomplexobj(arr):
        return arr.astype(np.float32)
    if component == 'real':
        return arr.real.astype(np.float32)
    elif component == 'imag':
        return arr.imag.astype(np.float32)
    elif component == 'phase':
        phase = np.angle(arr).astype(np.float32)
        phase[np.abs(arr) == 0] = 0.0  # zero-magnitude has undefined phase; map to 0
        return phase
    else:  # 'magnitude' or default
        return np.abs(arr).astype(np.float32)


def extract_frame(arr: np.ndarray, frame_index: int, component: str = 'magnitude') -> np.ndarray:
    """Extract a 2D spatial slice at the given frame/coefficient index."""
    if arr.ndim == 4:
        frame = arr[:, :, frame_index, 0]
    elif arr.ndim == 3:
        frame = arr[:, :, frame_index]
    else:
        frame = arr
    return apply_component(frame, component)


def extract_heatmap_slice(arr: np.ndarray, axis: str, index: int, component: str = 'magnitude') -> dict:
    """Return a 1D slice of the squeezed heatmap along axis='row' or axis='col'."""
    squeezed = apply_component(arr.squeeze(), component)
    if squeezed.ndim == 1:
        squeezed = squeezed[:, None]
    if squeezed.ndim != 2:
        raise ValueError(f"Cannot slice array of shape {arr.shape}")
    H, W = squeezed.shape
    if axis == 'col':
        index = max(0, min(index, W - 1))
        values = squeezed[:, index].astype(np.float32).tolist()
        length = H
    else:
        index = max(0, min(index, H - 1))
        values = squeezed[index, :].astype(np.float32).tolist()
        length = W
    return {'values': values, 'axis': axis, 'index': index, 'length': length}


def extract_video_spatial_slice(arr: np.ndarray, axis: str, index: int,
                                frame: int, component: str = 'magnitude') -> dict:
    """Extract a spatial row or column profile from a video array at a specific frame.

    For a (H, W, T, C) or (H, W, T) video array:
      axis='row', index=5, frame=10  →  arr[5, :, 10, 0]  — W values along the row
      axis='col', index=20, frame=10 →  arr[:, 20, 10, 0] — H values along the column

    Returns dict with 'values', 'axis', 'index', 'frame', 'length', 'is_complex',
    plus 'real'/'imag'/'phase' when the array is complex.
    """
    if arr.ndim == 4:
        H, W, T, _ = arr.shape
        frame = max(0, min(frame, T - 1))
        frame_data = arr[:, :, frame, 0]
    elif arr.ndim == 3:
        H, W, T = arr.shape
        frame = max(0, min(frame, T - 1))
        frame_data = arr[:, :, frame]
    else:
        raise ValueError(f"Expected 3D or 4D video array, got shape {arr.shape}")

    frame_data = apply_component(frame_data, component)

    if axis == 'col':
        index = max(0, min(index, W - 1))
        series = frame_data[:, index]
        length = H
    else:
        index = max(0, min(index, H - 1))
        series = frame_data[index, :]
        length = W

    result: dict = {
        'is_complex': bool(np.iscomplexobj(series)),
        'axis': axis, 'index': index, 'frame': frame, 'length': int(length),
    }
    if np.iscomplexobj(series):
        result['real']      = series.real.astype(np.float32).tolist()
        result['imag']      = series.imag.astype(np.float32).tolist()
        result['magnitude'] = np.abs(series).astype(np.float32).tolist()
        result['phase']     = np.angle(series).astype(np.float32).tolist()
    else:
        result['magnitude'] = series.astype(np.float32).tolist()
    return result


def extract_pixel_series(arr: np.ndarray, row: int, col: int) -> dict:
    """Extract all signal components for a single pixel along the third dimension.

    Returns a dict with keys: 'magnitude', and optionally 'real', 'imag', 'phase'
    if the array is complex.  Also includes 'is_complex', 'length', 'row', 'col'.
    """
    if arr.ndim == 4:
        H, W = arr.shape[0], arr.shape[1]
        row, col = max(0, min(row, H - 1)), max(0, min(col, W - 1))
        series = arr[row, col, :, 0]
    elif arr.ndim == 3:
        H, W = arr.shape[0], arr.shape[1]
        row, col = max(0, min(row, H - 1)), max(0, min(col, W - 1))
        series = arr[row, col, :]
    else:
        series = arr.ravel()

    result: dict = {'is_complex': bool(np.iscomplexobj(series)),
                    'length': int(len(series)), 'row': row, 'col': col}
    if np.iscomplexobj(series):
        result['real']      = series.real.astype(np.float32).tolist()
        result['imag']      = series.imag.astype(np.float32).tolist()
        result['magnitude'] = np.abs(series).astype(np.float32).tolist()
        result['phase']     = np.angle(series).astype(np.float32).tolist()
    else:
        result['magnitude'] = series.astype(np.float32).tolist()
    return result
