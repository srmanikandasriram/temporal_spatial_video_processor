import numpy as np
from scipy.ndimage import gaussian_filter, gaussian_filter1d

VALID_DERIVATIVES = {'none', 'dt', 'dx', 'dy', 'd2x', 'd2y', 'dxdy', 'laplacian'}



def compute_derivative(
    arr: np.ndarray,
    frame_index: int,
    deriv: str,
    sigma_s: float = 1.0,
    sigma_t: float = 1.0,
) -> np.ndarray:
    """Return a 2D (H, W) derivative frame.

    Accepts (H, W, T) or (H, W, T, C) arrays; 4D arrays use channel 0.
    """
    if deriv not in VALID_DERIVATIVES:
        raise ValueError(f"Unknown derivative '{deriv}'. Valid: {VALID_DERIVATIVES}")

    if deriv == 'dt':
        T = arr.shape[2]
        pad = int(np.ceil(4 * sigma_t)) + 1  # Gaussian kernel has negligible weight beyond 4*sigma
        t0 = max(0, frame_index - pad)
        t1 = min(T, frame_index + pad + 1)
        if arr.ndim == 4:
            window = np.asarray(arr[:, :, t0:t1, 0]).astype(np.float64)
        else:
            window = np.asarray(arr[:, :, t0:t1]).astype(np.float64)
        smoothed = gaussian_filter1d(window, sigma=sigma_t, axis=2)
        grad = np.gradient(smoothed, axis=2)
        local_idx = frame_index - t0
        return grad[:, :, local_idx]

    # Spatial derivatives — work on single frame
    if arr.ndim == 4:
        frame = arr[:, :, frame_index, 0].astype(np.float64)
    elif arr.ndim == 3:
        frame = arr[:, :, frame_index].astype(np.float64)
    else:
        frame = arr.astype(np.float64)

    smoothed = gaussian_filter(frame, sigma=sigma_s)

    if deriv == 'dx':
        return np.gradient(smoothed, axis=1)
    if deriv == 'dy':
        return np.gradient(smoothed, axis=0)
    if deriv == 'd2x':
        return np.gradient(np.gradient(smoothed, axis=1), axis=1)
    if deriv == 'd2y':
        return np.gradient(np.gradient(smoothed, axis=0), axis=0)
    if deriv == 'dxdy':
        return np.gradient(np.gradient(smoothed, axis=1), axis=0)
    if deriv == 'laplacian':
        d2x = np.gradient(np.gradient(smoothed, axis=1), axis=1)
        d2y = np.gradient(np.gradient(smoothed, axis=0), axis=0)
        return d2x + d2y
