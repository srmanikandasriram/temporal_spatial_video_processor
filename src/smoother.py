"""Composable spatial smoother registry and chain executor.

Each elementary smoother has the signature:
    fn(arr: np.ndarray, **params) -> np.ndarray
where arr is a 1D or 2D float32 numpy array (already squeezed to spatial dims).

A chain is a list of single-key dicts:
    [{'median': {'size': 5}}, {'spline1d': {}}]

Use parse_smoother_chain() to convert a config value (string or list) to canonical
chain format, then run_smoother_chain_1d() or run_smoother_chain_2d() to execute.
"""
from __future__ import annotations

import functools
import inspect
import logging
from typing import Any, Callable, Dict, List, Optional

import numpy as np
from scipy.interpolate import make_splrep, RectBivariateSpline
from scipy.ndimage import gaussian_filter, median_filter

logger = logging.getLogger(__name__)

SmoothFn = Callable[..., np.ndarray]


# ---------------------------------------------------------------------------
# Spline-fitting helpers — used by the `spline1d`/`spline2d` smoother stages.
# ---------------------------------------------------------------------------

def _robust_sigma_1d(y: np.ndarray) -> float:
    y = np.asarray(y, dtype=float).ravel()
    d = np.diff(y)
    if d.size == 0:
        return 1e-8
    mad = np.median(np.abs(d - np.median(d)))
    return max(float(1.4826 * mad / np.sqrt(2.0)), 1e-8)


def _robust_sigma_2d(z: np.ndarray) -> float:
    z = np.asarray(z, dtype=float)
    dx = np.diff(z, axis=1).ravel()
    dy = np.diff(z, axis=0).ravel()
    d = np.concatenate([dx, dy]) if (dx.size + dy.size) > 0 else z.ravel()
    mad = np.median(np.abs(d - np.median(d)))
    return max(float(1.4826 * mad / np.sqrt(2.0)), 1e-8)


def fit_spline_and_eval(y, k: int = 3, min_sigma_hat: Optional[float] = None,
                        s: Optional[float] = None):
    y = np.asarray(y, dtype=float).ravel()
    m = len(y)
    x = np.arange(m, dtype=float)
    sigma_hat = _robust_sigma_1d(y)
    if min_sigma_hat is not None:
        sigma_hat = max(sigma_hat, min_sigma_hat)
    w = np.full(m, 1.0 / sigma_hat, dtype=float)
    s_val = float(m) if s is None else float(s)
    spl = make_splrep(x, y, w=w, k=k, s=s_val)
    y_est = spl(x)
    return y_est, spl, w, s_val, sigma_hat


def fit_spline2d_and_eval(z, kx: int = 3, ky: int = 3,
                          min_sigma_hat: Optional[float] = None,
                          s: Optional[float] = None):
    z = np.asarray(z, dtype=float)
    h, w_img = z.shape
    x = np.arange(w_img, dtype=float)
    y = np.arange(h, dtype=float)
    sigma_hat = _robust_sigma_2d(z)
    if min_sigma_hat is not None:
        sigma_hat = max(sigma_hat, min_sigma_hat)
    s_val = sigma_hat * sigma_hat * z.size
    tck = RectBivariateSpline(y, x, z, kx=kx, ky=ky, s=s_val)
    z_est = tck(y, x)
    return z_est, tck, s_val, sigma_hat


# ---------------------------------------------------------------------------
# NLM helper — shared by the plain `nlm` smoother and the axis-destripe NLM
# variants (real and complex-valued).
# ---------------------------------------------------------------------------

def denoise_nl_means(image: np.ndarray, fast_mode: bool = True, h: Optional[float] = None,
                     patch_size: int = 5, patch_distance: int = 6,
                     channel_axis: Optional[int] = None) -> np.ndarray:
    """Apply Non-Local Means denoising via scikit-image.

    Handles 1D (treated as single-column 2D) and 2D inputs. Pass channel_axis
    to jointly denoise stacked channels (e.g. real/imag parts stacked as two
    channels for complex-valued input) — patch similarity is then computed
    across all channels together.
    """
    from skimage.restoration import denoise_nl_means as _skimage_nlm, estimate_sigma

    squeezed = False
    if image.ndim == 1:
        image = image[:, None].astype(np.float32)
        squeezed = True
    else:
        image = np.asarray(image, dtype=np.float32)

    if h is None:
        h = 0.8 * float(np.mean(estimate_sigma(image, channel_axis=channel_axis)))

    result = _skimage_nlm(image, h=max(h, 1e-8), fast_mode=fast_mode,
                          patch_size=patch_size, patch_distance=patch_distance,
                          channel_axis=channel_axis)
    return result.ravel() if squeezed else result


# ---------------------------------------------------------------------------
# Elementary smoothers — all take (arr: np.ndarray, **params) -> np.ndarray
# ---------------------------------------------------------------------------

def _sm_median(arr: np.ndarray, size: int = 5) -> np.ndarray:
    return median_filter(arr.astype(float), size=size).astype(np.float32)


def _sm_gaussian(arr: np.ndarray, sigma: float = 3.0) -> np.ndarray:
    return gaussian_filter(arr.astype(float), sigma=sigma).astype(np.float32)


def _sm_spline1d(arr: np.ndarray, k: int = 3, min_sigma_hat: float = 0.0002) -> np.ndarray:
    result, _, _, _, _ = fit_spline_and_eval(arr.ravel(), k=k, min_sigma_hat=min_sigma_hat)
    return result.astype(np.float32)


def _sm_spline2d(arr: np.ndarray, kx: int = 3, ky: int = 3,
                 min_sigma_hat: float = 0.0002) -> np.ndarray:
    arr2d = np.asarray(arr, dtype=float).squeeze()
    if arr2d.ndim != 2 or arr2d.shape[0] < 4 or arr2d.shape[1] < 4:
        # Fall back to gaussian for arrays too small for cubic bivariate spline
        return gaussian_filter(arr2d.astype(float), sigma=1.0).astype(np.float32)
    result, _, _, _ = fit_spline2d_and_eval(arr2d, kx=kx, ky=ky, min_sigma_hat=min_sigma_hat)
    return result.astype(np.float32)


def _sm_nlm(arr: np.ndarray, patch_size: int = 5, patch_distance: int = 6,
            h: Optional[float] = None) -> np.ndarray:
    result = denoise_nl_means(arr.astype(np.float32))
    return result.astype(np.float32)


def _sm_bm3d(arr: np.ndarray, noise_sigma: Optional[float] = None,
            noise_sigma_multiplier: float = 1.5) -> np.ndarray:
    import bm3d
    from skimage.restoration import estimate_sigma

    arr2d = np.asarray(arr, dtype=np.float32)
    was_1d = arr2d.ndim == 1
    if was_1d:
        arr2d = arr2d[:, None]

    arr_min = float(arr2d.min())
    arr_max = float(arr2d.max())
    scale = arr_max - arr_min if arr_max > arr_min else 1.0
    arr_norm = (arr2d - arr_min) / scale

    if noise_sigma is None:
        sigma_norm = noise_sigma_multiplier * float(np.mean(estimate_sigma(arr_norm, channel_axis=None)))
        logger.debug("[BM3D] Estimated noise sigma (normalized): %.6g", sigma_norm)
    else:
        sigma_norm = noise_sigma / scale

    result_norm = bm3d.bm3d(arr_norm, sigma_psd=sigma_norm).astype(np.float32)
    result = result_norm * scale + arr_min
    return result[:, 0] if was_1d else result


class BSplineTubeSolver:
    """Pre-built OSQP problem for fitting a minimal-bending-energy cubic B-spline
    within an epsilon tube around a 1D signal of fixed length N.

    The QP is factorized once at construction time.  Subsequent calls to
    ``solve(y, epsilon)`` only update the lower/upper bounds and re-solve,
    re-using the existing factorization and warm-starting from the previous
    solution — much faster than rebuilding from scratch each frame.

    Problem:
        minimize    (1/2) c^T (D2^T D2) c
        subject to  y - ε  ≤  B c  ≤  y + ε

    where B is the B-spline design matrix (N × n_ctrl) and D2 is the
    second-difference matrix of the control points (bending energy proxy).
    Knots are placed at every data point with clamped ends.
    """

    def __init__(self, N: int, degree: int = 3):
        import osqp
        import scipy.sparse as sp
        from scipy.interpolate import BSpline

        x = np.arange(N, dtype=float) / N
        knots = np.r_[[x[0]] * (degree + 1), x[1:-1], [x[-1]] * (degree + 1)]
        n_ctrl = len(knots) - degree - 1      # = N + 2

        B_sp = BSpline.design_matrix(x, knots, degree)   # sparse (N × n_ctrl)
        D2   = np.diff(np.eye(n_ctrl), n=2, axis=0)      # ((n_ctrl-2) × n_ctrl)

        P = sp.csc_matrix(D2.T @ D2)
        q = np.zeros(n_ctrl)
        A = sp.csc_matrix(B_sp)
        placeholder = np.zeros(N)

        self._osqp = osqp.OSQP()
        self._osqp.setup(
            P, q, A,
            l=placeholder, u=placeholder,
            warm_starting=False,
            verbose=False,
            eps_abs=1e-5, eps_rel=1e-5,
            max_iter=4000,
        )
        # Dense copy for fast evaluation: B_dense @ c_opt
        self._B = np.asarray(B_sp.toarray()) if sp.issparse(B_sp) else np.asarray(B_sp)
        self._n_ctrl = n_ctrl

    def solve(self, y: np.ndarray, epsilon) -> np.ndarray:
        """Fit the spline to signal y within ±epsilon.  Raises RuntimeError on failure.

        epsilon may be a scalar float or a 1-D array of length N for a
        position-varying tube width.
        """
        y = np.asarray(y, dtype=float)
        eps = np.asarray(epsilon, dtype=float)
        # Seed the primal variable from y: pad y with its boundary values to get
        # n_ctrl = N+2 control points.  This gives B @ c_init ≈ y, placing the
        # starting point inside (or very near) the feasible tube every call.
        c_init = np.r_[y[0], y, y[-1]]
        self._osqp.warm_start(x=c_init, y=np.zeros(len(y)))
        self._osqp.update(l=y - eps, u=y + eps)
        res = self._osqp.solve()
        if res.info.status in ('solved', 'solved inaccurate', 'solved_inaccurate') and res.x is not None:
            return (self._B @ res.x).astype(np.float32)
        elif res.x is not None:
            return (self._B @ res.x).astype(np.float32)
        else:
            print(f"[BSplineTubeSolver] OSQP failed: {res.info.status}, {res}", flush=True)
        raise RuntimeError(f"BSpline tube fitting failed: {res.info.status}")


@functools.lru_cache(maxsize=32)
def _get_bspline_solver(N: int, degree: int = 3) -> BSplineTubeSolver:
    """Return a cached BSplineTubeSolver for signals of length N.

    The cache holds one solver per (N, degree) pair, so the typical two-pass
    destriper (column width W and row height H) keeps exactly two live solvers.
    """
    return BSplineTubeSolver(N, degree)


def _estimate_noise_sigma(arr: np.ndarray) -> float:
    """Estimate noise std via MAD of db2 detail coefficients along the last axis.

    For batched inputs (..., N), computes per-element MAD along axis=-1 and
    returns the median over all batch dimensions as a single float.
    """
    import pywt
    coeffs = pywt.wavedec(arr, 'db2', level=1, axis=-1)
    per_element = np.median(np.abs(coeffs[-1]), axis=-1) / 0.6745
    return float(np.median(per_element))


def _destripe_one_axis(arr: np.ndarray, axis: int,
                       median_size: int = 3, min_noise_sigma: float = 0.5) -> tuple[np.ndarray, dict]:
    """Destripe one axis of a 2D image and return (result, intermediates).

    Normalises the mean profile to [0,1], median-filters it to get a
    reference, fits a B-spline tube to that reference within ±noise_sigma,
    maps back, and subtracts the bias (A - D) from the original.
    """
    A = arr.mean(axis=axis, keepdims=True)
    A = np.expand_dims(A, axis=axis)  # (H, 1) or (1, W)
    a_min, a_max = float(A.min()), float(A.max())
    a_range = a_max - a_min if a_max > a_min else 1.0
    A_norm = (A - a_min) / a_range
    min_noise_sigma_scaled = min_noise_sigma / a_range
    noise_sigma = max(_estimate_noise_sigma(A_norm.squeeze()), min_noise_sigma_scaled)

    bc_shape = (1, -1) if axis == 0 else (-1, 1)
    A_norm = A_norm.reshape(bc_shape)
    E_norm = median_filter(A_norm, size=median_size, mode='reflect').reshape(bc_shape)
    D_norm = _fit_bspline_tube(E_norm.squeeze(), epsilon=noise_sigma).reshape(bc_shape)
    D = D_norm * a_range + a_min
    A = A.reshape(bc_shape)

    result = arr - A + D
    inter = dict(A=A, A_norm=A_norm, D_norm=D_norm, E_norm=E_norm, D=D)
    return result.astype(np.float32), inter


def _destripe_one_axis_wavelet(
    arr: np.ndarray,
    axis: int,
    wavelet: str = 'bior3.3',
    mode: str = 'symmetric',
    level: int = 6,
    noise_sigma_multiplier: float = 1.5,
    min_noise_sigma: float = 1.0,
    median_size: int = 3,
    median_variance_threshold: float = 0.0,
) -> tuple[np.ndarray, dict]:
    """Destripe a 2D array along one axis using a wavelet-domain B-spline approach.

    Applies a 1D wavelet transform (bior4.4, symmetric, 5 levels) along ``axis``,
    smooths each row/column of the approximation band along the orthogonal axis
    with a minimal-bending-energy B-spline within an epsilon tube
    (epsilon = noise_sigma_multiplier * estimated_noise_sigma), leaves detail
    bands unchanged, then reconstructs with waverec.

    Args:
        arr: 2D float32 input image.
        axis: Axis along which to apply the wavelet transform.
        wavelet: PyWavelets wavelet name. Default: 'bior4.4'.
        mode: PyWavelets signal-extension mode. Default: 'symmetric'.
        level: Decomposition level. Default: 5.
        noise_sigma_multiplier: Multiplier for the epsilon tube half-width.

    Returns:
        (result, intermediates) where result is the destriped float32 image
        (same shape as arr) and intermediates is a dict containing:
          - 'approx_before': approximation band before smoothing
          - 'approx_after':  approximation band after B-spline smoothing
          - 'epsilons':      1-D array of per-slice epsilon values used
          - 'bias':          reconstructed image of the removed low-freq bias
                             (arr - result), same shape as arr
    """
    import pywt

    arr2d = np.asarray(arr, dtype=np.float64)

    coeffs = pywt.wavedec(arr2d, wavelet, mode=mode, level=level, axis=axis)

    approx = coeffs[0].copy()
    approx_before = approx.copy()
    n_slices = approx.shape[axis]
    smoothed_approx = np.empty_like(approx)
    reference_approx = np.empty_like(approx)
    epsilons = np.empty(n_slices, dtype=np.float64)

    for i in range(n_slices):
        coeff_1d = approx.take(indices=i, axis=axis)
        c_min = float(coeff_1d.min())
        c_max = float(coeff_1d.max())
        c_range = c_max - c_min if c_max > c_min else 1.0
        coeff_norm = (coeff_1d - c_min) / c_range

        sigma_norm = _estimate_noise_sigma(coeff_norm.astype(np.float32))
        eps_norm = max(noise_sigma_multiplier * sigma_norm, min_noise_sigma / c_range)
        epsilons[i] = eps_norm * c_range  # store in original units for diagnostics

        slice_variance = float(np.var(coeff_norm))
        if median_variance_threshold > 0.0 and slice_variance > median_variance_threshold:
            reference_norm = coeff_norm  # signal has structure — skip median pre-filter
        else:
            reference_norm = median_filter(coeff_norm, size=median_size, mode='reflect')

        smoothed_norm = _fit_bspline_tube(reference_norm.astype(np.float32), epsilon=eps_norm)
        smoothed_1d = smoothed_norm * c_range + c_min

        idx = [slice(None), slice(None)]
        idx[axis] = i
        smoothed_approx[tuple(idx)] = smoothed_1d
        reference_approx[tuple(idx)] = reference_norm * c_range + c_min

    coeffs[0] = smoothed_approx

    result = pywt.waverec(coeffs, wavelet, mode=mode, axis=axis)
    slices = tuple(slice(0, s) for s in arr2d.shape)
    result = result[slices].astype(np.float32)

    # Reconstruct a bias-only image to show what was removed
    bias_coeffs = [np.zeros_like(c) for c in coeffs]
    bias_coeffs[0] = smoothed_approx - approx_before
    bias_recon = pywt.waverec(bias_coeffs, wavelet, mode=mode, axis=axis)
    bias = bias_recon[slices].astype(np.float32)

    inter = dict(
        approx_before=approx_before.astype(np.float32),
        approx_after=smoothed_approx.astype(np.float32),
        reference=reference_approx.astype(np.float32),
        epsilons=epsilons.astype(np.float32),
        bias=bias,
    )
    return result, inter


def _fit_bspline_tube(y: np.ndarray, epsilon, degree: int = 3) -> np.ndarray:
    """Fit a minimal-bending-energy cubic B-spline to 1D signal y, constrained
    within an epsilon tube around y.  Knots are placed at every data point.

    epsilon may be a scalar float or a 1-D array of length len(y) for a
    position-varying tube width.

    Delegates to a cached BSplineTubeSolver keyed on len(y), so the OSQP
    factorization is built once and reused across calls of the same length.

    Returns the evaluated spline (same length as y).
    Raises RuntimeError if OSQP fails or the problem is infeasible.
    """
    return _get_bspline_solver(len(y), degree).solve(y, epsilon)


def _destripe_one_axis_nlm(
    arr: np.ndarray,
    axis: int,
    fast_mode: bool = True,
    patch_size: int = 5,
    patch_distance: int = 6,
    h: Optional[float] = None,
) -> tuple[np.ndarray, dict]:
    """Destripe one axis of a 2D image using NLM to smooth the mean profile.

    Computes the mean profile along ``axis``, smooths it with NLM, then
    replaces the original mean with the smoothed version (subtracts old bias,
    adds smoothed bias back).

    Returns:
        (result, intermediates) where intermediates contains 'mean_before',
        'mean_after', and 'bias' (mean_after - mean_before broadcast to arr shape).
    """
    A = arr.mean(axis=axis)                            # 1D profile, length = arr.shape[1-axis]
    A_f = A.astype(np.float32)
    h_used = h if h is not None else _estimate_noise_sigma(A_f)
    A_smooth = denoise_nl_means(A_f,
                                fast_mode=fast_mode,
                                patch_size=patch_size,
                                patch_distance=patch_distance,
                                h=h_used)

    bc_shape = (1, -1) if axis == 0 else (-1, 1)
    A_bc = A.reshape(bc_shape)
    A_smooth_bc = A_smooth.reshape(bc_shape)
    result = (arr - A_bc + A_smooth_bc).astype(np.float32)

    inter = dict(
        mean_before=A_bc.astype(np.float32),
        mean_after=A_smooth_bc.astype(np.float32),
        bias=(A_smooth_bc - A_bc).astype(np.float32),
    )
    return result, inter


def _sm_axis_nlm_destripe(
    arr: np.ndarray,
    fast_mode: bool = True,
    patch_size: int = 5,
    patch_distance: int = 6,
    h: Optional[float] = None,
    intermediates_out: Optional[dict] = None,
    key_prefix: str = '',
) -> np.ndarray:
    """Remove axis-aligned stripe noise from a 2D image using NLM on mean profiles.

    Applies NLM destriping twice: first along axis=0 (column stripes),
    then along axis=1 (row stripes) on the column-corrected image.

    Args:
        arr:            2D float32 image (H × W).
        fast_mode:      Use fast NLM mode. Default: True.
        patch_size:     NLM patch size. Default: 5.
        patch_distance: NLM search window radius. Default: 6.
        h:              NLM filter strength (None = auto from sigma estimate). Default: None.

    Returns:
        Destriped image, same shape and dtype as input.
    """
    if np.iscomplexobj(arr):
        raise ValueError("Input array must be real-valued")
    arr = np.asarray(arr, dtype=np.float32)

    nlm_kwargs = dict(fast_mode=fast_mode, patch_size=patch_size,
                      patch_distance=patch_distance, h=h)

    arr, col_inter = _destripe_one_axis_nlm(arr, axis=0, **nlm_kwargs)
    result, row_inter = _destripe_one_axis_nlm(arr, axis=1, **nlm_kwargs)

    if intermediates_out is not None:
        pfx = f"{key_prefix}__axis_nlm_destripe" if key_prefix else "axis_nlm_destripe"
        for key, val in col_inter.items():
            if np.ndim(val) >= 1:
                intermediates_out[f"{pfx}__col_{key}"] = val
        for key, val in row_inter.items():
            if np.ndim(val) >= 1:
                intermediates_out[f"{pfx}__row_{key}"] = val

    return result


def _destripe_one_axis_nlm_complex(
    arr: np.ndarray,
    axis: int,
    fast_mode: bool = True,
    patch_size: int = 5,
    patch_distance: int = 6,
    h: Optional[float] = None,
) -> tuple[np.ndarray, dict]:
    """Destripe one axis of a complex 2D image using NLM on the complex mean profile.

    Real and imaginary parts of the mean profile are stacked as channels and
    passed to NLM together (channel_axis=-1), so patch similarity is computed
    jointly. h defaults to the average of the noise sigma estimates for each part.

    Returns:
        (result, intermediates) where intermediates contains 'mean_before_re',
        'mean_before_im', 'mean_after_re', 'mean_after_im', 'bias_re', 'bias_im'.
    """
    A = arr.mean(axis=axis)                            # complex 1D, length N
    A_re = A.real.astype(np.float32)
    A_im = A.imag.astype(np.float32)

    if h is None:
        h_used = 0.5 * (_estimate_noise_sigma(A_re) + _estimate_noise_sigma(A_im))
    else:
        h_used = h

    # Stack as (N, 1, 2) — spatial=(N,1), channels=2 — for joint NLM denoising
    multichan = np.stack([A_re, A_im], axis=-1)[:, None, :]  # (N, 1, 2)
    smoothed = denoise_nl_means(multichan, h=h_used,
                                fast_mode=fast_mode,
                                patch_size=patch_size,
                                patch_distance=patch_distance,
                                channel_axis=-1).reshape(multichan.shape)             # (N, 1, 2)
    A_smooth_re = smoothed[:, 0, 0].astype(np.float32)
    A_smooth_im = smoothed[:, 0, 1].astype(np.float32)
    A_smooth = A_smooth_re + 1j * A_smooth_im

    bc_shape = (1, -1) if axis == 0 else (-1, 1)
    A_bc        = A.reshape(bc_shape)
    A_smooth_bc = A_smooth.reshape(bc_shape)
    result = arr - A_bc + A_smooth_bc

    inter = dict(
        mean_before_re=A_bc.real.astype(np.float32),
        mean_before_im=A_bc.imag.astype(np.float32),
        mean_after_re=A_smooth_bc.real.astype(np.float32),
        mean_after_im=A_smooth_bc.imag.astype(np.float32),
        bias_re=(A_smooth_bc.real - A_bc.real).astype(np.float32),
        bias_im=(A_smooth_bc.imag - A_bc.imag).astype(np.float32),
    )
    return result, inter


def _sm_axis_nlm_destripe_complex(
    arr: np.ndarray,
    fast_mode: bool = True,
    patch_size: int = 5,
    patch_distance: int = 6,
    h: Optional[float] = None,
    intermediates_out: Optional[dict] = None,
    key_prefix: str = '',
) -> np.ndarray:
    """Remove axis-aligned stripe noise from a complex 2D image using joint-channel NLM.

    Real and imaginary parts of each axis mean profile are destriped together
    so that NLM patch similarity is computed across both channels jointly.

    Falls back to the real-only NLM destriper if the input is not complex.

    Args:
        arr:            2D complex64 image (H × W).
        fast_mode:      Use fast NLM mode. Default: True.
        patch_size:     NLM patch size. Default: 5.
        patch_distance: NLM search window radius. Default: 6.
        h:              NLM filter strength (None = avg sigma of real+imag). Default: None.

    Returns:
        Destriped complex image, same shape and dtype as input.
    """
    if not np.iscomplexobj(arr):
        return _sm_axis_nlm_destripe(arr, fast_mode=fast_mode, patch_size=patch_size,
                                     patch_distance=patch_distance, h=h,
                                     intermediates_out=intermediates_out,
                                     key_prefix=key_prefix)

    nlm_kwargs = dict(fast_mode=fast_mode, patch_size=patch_size,
                      patch_distance=patch_distance, h=h)

    arr, col_inter = _destripe_one_axis_nlm_complex(arr, axis=0, **nlm_kwargs)
    result, row_inter = _destripe_one_axis_nlm_complex(arr, axis=1, **nlm_kwargs)

    if intermediates_out is not None:
        pfx = f"{key_prefix}__axis_nlm_destripe_complex" if key_prefix else "axis_nlm_destripe_complex"
        for key, val in col_inter.items():
            intermediates_out[f"{pfx}__col_{key}"] = val
        for key, val in row_inter.items():
            intermediates_out[f"{pfx}__row_{key}"] = val

    return result


def _sm_axis_bspline_destripe(arr: np.ndarray, median_size: int = 3,
                               intermediates_out: Optional[dict] = None,
                               key_prefix: str = '',
                               epsilon: float = 0.5,
                               method: str = 'wavelet',
                               wavelet: str = 'bior3.3', mode: str = 'symmetric',
                               level: int = 6, noise_sigma_multiplier: float = 1.5,
                               median_variance_threshold: float = 0.0) -> np.ndarray:
    """Remove axis-aligned stripe noise from a 2D image.

    Applies a destripe function twice: first along axis=0 (column stripes),
    then along axis=1 (row stripes) on the column-corrected image.

    Args:
        arr:                       2-D float32 image (H × W).
        method:                    Destripe method: 'wavelet' (default) uses
                                   _destripe_one_axis_wavelet; 'direct' uses
                                   _destripe_one_axis (spatial mean + B-spline tube).
        epsilon:                   Min epsilon (B-spline tube half-width). Default: 0.5.
        wavelet:                   PyWavelets wavelet for the 1D decomposition (wavelet method only). Default: 'bior3.3'.
        mode:                      PyWavelets signal-extension mode (wavelet method only). Default: 'symmetric'.
        level:                     Wavelet decomposition level (wavelet method only). Default: 6.
        noise_sigma_multiplier:    Multiplier for epsilon = multiplier * estimated_sigma. Default: 1.5.
        median_variance_threshold: Skip median pre-filter when slice variance exceeds this (wavelet method only). Default: 0.0.
        median_size:               Median filter size. Default: 3.

    Returns:
        Destriped image, same shape and dtype as input.
    """
    if np.iscomplexobj(arr):
        raise ValueError("Input array must be real-valued")
    arr = np.asarray(arr, dtype=np.float32)

    if method == 'direct':
        def _destripe(a, ax):
            return _destripe_one_axis(a, axis=ax,
                                      median_size=median_size,
                                      min_noise_sigma=epsilon)
    else:
        wavelet_kwargs = dict(wavelet=wavelet, mode=mode, level=level,
                              noise_sigma_multiplier=noise_sigma_multiplier,
                              min_noise_sigma=epsilon,
                              median_size=median_size,
                              median_variance_threshold=median_variance_threshold)
        def _destripe(a, ax):
            return _destripe_one_axis_wavelet(a, axis=ax, **wavelet_kwargs)

    arr, col_inter = _destripe(arr, 0)
    result, row_inter = _destripe(arr, 1)

    if intermediates_out is not None:
        pfx = f"{key_prefix}__axis_destripe" if key_prefix else "axis_destripe"
        for key, val in col_inter.items():
            if np.ndim(val) == 2:
                intermediates_out[f"{pfx}__col_{key}"] = val
        for key, val in row_inter.items():
            if np.ndim(val) == 2:
                intermediates_out[f"{pfx}__row_{key}"] = val

    return result


def _estimate_noise_sigma_complex(cD_re: np.ndarray, cD_im: np.ndarray) -> float:
    """MAD-based noise sigma from complex SWT detail coefficients via magnitude."""
    mag = np.sqrt(cD_re ** 2 + cD_im ** 2)
    return float(np.median(mag) / 0.6745)


def _swt_smooth_1d(signal: np.ndarray, wavelet: str, level: int,
                   noise_sigma: Optional[float],
                   shrinkage: str = 'wiener',
                   wiener_window: int = 7,
                   min_noise_sigma: Optional[float] = None) -> np.ndarray:
    """Smooth a real or complex signal by shrinking SWT detail bands along the last axis.

    Input shape: (N,) or (..., N). The SWT is applied along axis=-1; all batch
    dimensions are processed in one call. Output has the same shape and dtype.

    shrinkage='soft'   — subtract sigma from each coefficient magnitude (classic).
    shrinkage='wiener' — Wiener shrinkage with windowed local variance estimate:
                         local_var[t] = mean(|cD|² over wiener_window neighbors),
                         scale[t] = max(local_var[t] − σ², 0) / local_var[t].

    For complex inputs real and imag are decomposed separately and detail
    coefficients are shrunk jointly on their magnitude (preserving phase).
    If noise_sigma is None, it is estimated from the finest detail band via MAD.
    """
    from scipy.ndimage import uniform_filter1d
    import pywt

    signal = np.asarray(signal)
    n = signal.shape[-1]
    pad = n // 2
    pad_widths = [(0, 0)] * (signal.ndim - 1) + [(pad, pad)]

    if np.iscomplexobj(signal):
        padded_re = np.pad(signal.real.astype(np.float64), pad_widths, mode='symmetric')
        padded_im = np.pad(signal.imag.astype(np.float64), pad_widths, mode='symmetric')
        coeffs_re = pywt.swt(padded_re, wavelet=wavelet, level=level, axis=-1)
        coeffs_im = pywt.swt(padded_im, wavelet=wavelet, level=level, axis=-1)
        if noise_sigma is None:
            noise_sigma = _estimate_noise_sigma_complex(coeffs_re[-1][1], coeffs_im[-1][1])
        if min_noise_sigma is not None:
            noise_sigma = max(noise_sigma, min_noise_sigma)
        thresholded_re, thresholded_im = [], []
        for (cA_re, cD_re), (cA_im, cD_im) in zip(coeffs_re, coeffs_im):
            if shrinkage == 'wiener':
                local_var = uniform_filter1d(cD_re ** 2 + cD_im ** 2,
                                             size=wiener_window, mode='mirror', axis=-1)
                scale = np.maximum(local_var - noise_sigma ** 2, 0.0) / np.maximum(local_var, 1e-12)
            else:
                mag = np.sqrt(cD_re ** 2 + cD_im ** 2)
                scale = np.maximum(mag - noise_sigma, 0.0) / np.where(mag > 0, mag, 1.0)
            thresholded_re.append((cA_re, cD_re * scale))
            thresholded_im.append((cA_im, cD_im * scale))
        re = pywt.iswt(thresholded_re, wavelet=wavelet, axis=-1)[..., pad:pad + n]
        im = pywt.iswt(thresholded_im, wavelet=wavelet, axis=-1)[..., pad:pad + n]
        return (re + 1j * im).astype(np.complex64)
    else:
        padded = np.pad(signal.astype(np.float64), pad_widths, mode='symmetric')
        coeffs = pywt.swt(padded, wavelet=wavelet, level=level, axis=-1)
        if noise_sigma is None:
            noise_sigma = _estimate_noise_sigma(signal.astype(np.float32))
        if min_noise_sigma is not None:
            noise_sigma = max(noise_sigma, min_noise_sigma)
        if shrinkage == 'wiener':
            thresholded = []
            for cA, cD in coeffs:
                local_var = uniform_filter1d(cD ** 2, size=wiener_window, mode='mirror', axis=-1)
                scale = np.maximum(local_var - noise_sigma ** 2, 0.0) / np.maximum(local_var, 1e-12)
                thresholded.append((cA, cD * scale))
        else:
            thresholded = [
                (cA, np.sign(cD) * np.maximum(np.abs(cD) - noise_sigma, 0.0))
                for cA, cD in coeffs
            ]
        smoothed = pywt.iswt(thresholded, wavelet=wavelet, axis=-1)
        return smoothed[..., pad:pad + n].astype(np.float32)


def _swt_destripe_one_axis_wavelet_approx(
    arr2d: np.ndarray,
    axis: int,
    wavelet: str,
    level: int,
    smooth_kwargs: dict,
) -> tuple[np.ndarray, dict]:
    """Destripe one axis by smoothing wavedec approximation coefficients.

    Applies wavedec along ``axis``, passes the approximation band to
    _swt_smooth_1d (transposing first for axis=1 so smoothing is always
    along the last dimension), reconstructs with waverec, and crops to the
    original shape. Supports real and complex inputs.
    """
    import pywt

    coeffs = pywt.wavedec(arr2d, wavelet=wavelet, level=level, axis=axis, mode='symmetric')
    approx = coeffs[0]
    approx_before = approx.copy()

    if axis == 1:
        approx_smoothed = _swt_smooth_1d(approx.T, **smooth_kwargs).T
    else:
        approx_smoothed = _swt_smooth_1d(approx, **smooth_kwargs)

    coeffs[0] = approx_smoothed
    reconstructed = pywt.waverec(coeffs, wavelet=wavelet, axis=axis)
    slices = tuple(slice(0, s) for s in arr2d.shape)
    result = reconstructed[slices]

    out_dtype = np.complex64 if np.iscomplexobj(arr2d) else np.float32
    inter = dict(
        approx_before=approx_before.astype(out_dtype),
        approx_after=approx_smoothed.astype(out_dtype),
    )
    return result.astype(out_dtype), inter


def _sm_swt_axis_destripe(
    arr: np.ndarray,
    wavelet: str = 'bior4.4',
    level: int = 5,
    noise_sigma: Optional[float] = None,
    min_noise_sigma: Optional[float] = None,
    shrinkage: str = 'wiener',
    wiener_window: int = 7,
    use_wavelet_approx: bool = False,
    intermediates_out: Optional[dict] = None,
    key_prefix: str = '',
) -> np.ndarray:
    """Remove axis-aligned stripe noise via SWT-based smoothing.

    use_wavelet_approx=False (default):
        Computes the global column mean (W,) and row mean (H,), smooths each
        with _swt_smooth_1d, and broadcasts the correction back.

    use_wavelet_approx=True:
        For each axis, applies wavedec along that axis, passes the approximation
        band to _swt_smooth_1d (which operates along the last dimension), then
        reconstructs with waverec. This avoids contamination of the mean profile
        by localized high-energy content.

    Supports both real and complex inputs.
    """
    is_complex = np.iscomplexobj(arr)
    arr2d = np.asarray(arr, dtype=np.complex64 if is_complex else np.float32)

    smooth_kwargs = dict(
        wavelet=wavelet, level=level, noise_sigma=noise_sigma,
        shrinkage=shrinkage, wiener_window=wiener_window,
        min_noise_sigma=min_noise_sigma,
    )

    pfx = f"{key_prefix}__swt_axis_destripe" if key_prefix else "swt_axis_destripe"

    if use_wavelet_approx:
        result, col_inter = _swt_destripe_one_axis_wavelet_approx(
            arr2d, axis=0, wavelet=wavelet, level=level, smooth_kwargs=smooth_kwargs)
        result, row_inter = _swt_destripe_one_axis_wavelet_approx(
            result, axis=1, wavelet=wavelet, level=level, smooth_kwargs=smooth_kwargs)

        if intermediates_out is not None:
            for key, val in col_inter.items():
                intermediates_out[f"{pfx}__col_{key}"] = val
            for key, val in row_inter.items():
                intermediates_out[f"{pfx}__row_{key}"] = val
    else:
        col_mean = arr2d.mean(axis=0)   # (W,)
        row_mean = arr2d.mean(axis=1)   # (H,)

        col_smoothed = _swt_smooth_1d(col_mean, **smooth_kwargs)
        row_smoothed = _swt_smooth_1d(row_mean, **smooth_kwargs)

        col_correction = col_smoothed - col_mean
        row_correction = row_smoothed - row_mean

        result = arr2d + col_correction[np.newaxis, :] + row_correction[:, np.newaxis]

        if intermediates_out is not None:
            intermediates_out[f"{pfx}__col_mean"]       = col_mean
            intermediates_out[f"{pfx}__col_smoothed"]   = col_smoothed
            intermediates_out[f"{pfx}__col_correction"] = col_correction
            intermediates_out[f"{pfx}__row_mean"]       = row_mean
            intermediates_out[f"{pfx}__row_smoothed"]   = row_smoothed
            intermediates_out[f"{pfx}__row_correction"] = row_correction

    return result.astype(np.complex64 if is_complex else np.float32)


SMOOTHER_REGISTRY: Dict[str, SmoothFn] = {
    'median':                    _sm_median,
    'gaussian':                  _sm_gaussian,
    'spline1d':                  _sm_spline1d,
    'spline2d':                  _sm_spline2d,
    'nlm':                       _sm_nlm,
    'bm3d':                      _sm_bm3d,
    'swt_axis_destripe':         _sm_swt_axis_destripe,
    'axis_destripe':             _sm_axis_bspline_destripe,
    'axis_nlm_destripe':         _sm_axis_nlm_destripe,
    'axis_nlm_destripe_complex': _sm_axis_nlm_destripe_complex,
}

# Smoothers in this set receive the raw complex (H, W) array directly.
# All others receive real and imaginary parts separately.
COMPLEX_AWARE_SMOOTHERS: set[str] = {
    'axis_nlm_destripe_complex',
}


# ---------------------------------------------------------------------------
# Chain parsing
# ---------------------------------------------------------------------------

def parse_smoother_chain(raw: Any) -> List[Dict[str, dict]]:
    """Convert a config value to canonical chain format.

    - None / 'none'  → []  (pass-through, no smoothing)
    - 'spline1d'     → [{'spline1d': {}}]
    - [{'median': {'size': 5}}, {'spline1d': {}}]  → returned as-is
    """
    if raw is None or raw == 'none':
        return []
    if isinstance(raw, str):
        return [{raw: {}}]
    if isinstance(raw, list):
        return raw
    raise ValueError(f"Cannot parse smoother chain from {raw!r}")


# ---------------------------------------------------------------------------
# Chain executors
# ---------------------------------------------------------------------------

def _run_chain(arr: np.ndarray, chain: List[Dict[str, dict]],
               intermediates_out: Optional[dict], key_prefix: str) -> np.ndarray:
    current = arr.astype(np.float32)
    for i, stage_spec in enumerate(chain):
        name, params = next(iter(stage_spec.items()))
        fn = SMOOTHER_REGISTRY.get(name)
        if fn is None:
            raise ValueError(f"Unknown smoother: {name!r}. Available: {list(SMOOTHER_REGISTRY)}")
        sig = inspect.signature(fn)
        try:
            _extra: dict = {}
            if 'intermediates_out' in sig.parameters:
                _extra['intermediates_out'] = intermediates_out
                _extra['key_prefix'] = f"{key_prefix}__s{i}_{name}"
            current = fn(current, **params, **_extra)
        except TypeError as e:
            valid = [p for p in sig.parameters if p not in ('arr', 'intermediates_out', 'key_prefix')]
            raise TypeError(
                f"Smoother '{name}' got unexpected params {params!r}. "
                f"Valid params: {valid}"
            ) from e
        if intermediates_out is not None:
            key = f"{key_prefix}__s{i}_{name}"
            # Re-expand to (H, W, 1, 1) shape if 2D, or (N, 1, 1, 1) if 1D — store as-is (squeezed)
            intermediates_out[key] = current.copy()
    return current


def run_smoother_chain_1d(signal_1d: np.ndarray, chain: List[Dict[str, dict]],
                          intermediates_out: Optional[dict], key_prefix: str) -> np.ndarray:
    """Execute a smoother chain on a 1D spatial signal (shape: (N,)).

    Stage intermediates are written to intermediates_out under keys
    '{key_prefix}__s{i}_{name}'. Pass intermediates_out=None to suppress storage.
    Returns the final smoothed 1D array.
    """
    arr = np.asarray(signal_1d, dtype=np.float32).ravel()
    return _run_chain(arr, chain, intermediates_out, key_prefix)


def run_smoother_chain_2d(image_2d: np.ndarray, chain: List[Dict[str, dict]],
                          intermediates_out: Optional[dict], key_prefix: str) -> np.ndarray:
    """Execute a smoother chain on a 2D spatial image (shape: (H, W)).

    Stage intermediates are written to intermediates_out under keys
    '{key_prefix}__s{i}_{name}'. Pass intermediates_out=None to suppress storage.
    Returns the final smoothed 2D array.
    """
    arr = np.asarray(image_2d, dtype=np.float32).squeeze()
    if arr.ndim == 1:
        # Degenerate case: single row or column squeezed to 1D — treat as 1D
        return run_smoother_chain_1d(arr, chain, intermediates_out, key_prefix)
    return _run_chain(arr, chain, intermediates_out, key_prefix)
