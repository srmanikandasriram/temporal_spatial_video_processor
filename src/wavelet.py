import torch
from dtcwt import torch as dtcwt_torch
from typing import Tuple, List, Optional
import tqdm


def compute_dtcwt_transform(
    data: torch.Tensor,
    temporal_levels: int,
    level1_filter: str = 'near_sym_a',
    level2p_filter: str = 'qshift_a',
    batch_size: Optional[int] = None,
    output_device: Optional[torch.device] = None
) -> Tuple[torch.Tensor, List[int]]:
    """
    Compute 1D Dual-Tree Complex Wavelet Transform across temporal dimension.

    The DTCWT provides near shift-invariant decomposition with good directional
    selectivity, useful for temporal motion analysis.

    Args:
        data (torch.Tensor): Temporal data of shape (H, W, T, C) where:
            - H, W: Spatial dimensions
            - T: Temporal dimension
            - C: Channels
        temporal_levels (int): Number of decomposition levels
        level1_filter (str): Biorthogonal filter pair used for the first
            decomposition level (dtcwt's `biort` parameter, e.g. 'near_sym_a').
        level2p_filter (str): Q-shift filter pair used for decomposition
            levels 2 and beyond (dtcwt's `qshift` parameter, e.g. 'qshift_a').
        batch_size (Optional[int]): Number of flattened temporal signals
            (from H*W*C) to process per DTCWT call. If None or <= 0,
            process all signals at once.

    Returns:
        Tuple[torch.Tensor, List[int]]:
            - stacked_coeffs: Stacked DTCWT coefficients shape (H, W, total_coeffs, C)
            - coeff_lengths: List of coefficient lengths for each level for reconstruction
    """
    import gc

    H, W, T, C = data.shape
    device = data.device
    xfm_1d = dtcwt_torch.Transform1d(biort=level1_filter, qshift=level2p_filter)

    total_signals = H * W * C

    # Default to smaller batch size if memory is tight
    if batch_size is None or batch_size <= 0:
        batch_size = max(256, total_signals // 10)  # Process ~10% at a time
    batch_size = min(batch_size, total_signals)

    # Process data in spatial chunks to avoid reshaping entire tensor at once
    lowpass_batches = []
    highpass_batches = [[] for _ in range(temporal_levels)]

    # Flatten spatial dimensions first: (H, W, T, C) -> (T, H*W*C)
    data_flat = data.reshape(H * W * C, T).T  # (T, H*W*C)

    for start_idx in tqdm.tqdm(range(0, total_signals, batch_size), desc="Processing DTCWT batches"):
        end_idx = min(start_idx + batch_size, total_signals)

        # Extract this batch of flattened signals
        batch_data = data_flat[:, start_idx:end_idx]  # (T, batch_size)

        # Compute DTCWT for this batch
        coeffs_batch = xfm_1d.forward(batch_data, nlevels=temporal_levels)

        # Move to CPU to free GPU memory
        lowpass_batches.append(coeffs_batch.lowpass.cpu())
        for level_idx, hp in enumerate(coeffs_batch.highpasses):
            highpass_batches[level_idx].append(hp.cpu())

        # Explicit cleanup
        del coeffs_batch, batch_data
        if device.type == 'cuda':
            torch.cuda.empty_cache()
        gc.collect()

    # Concatenate on CPU, then move back to original device if needed
    lowpass = torch.cat(lowpass_batches, dim=1)
    highpasses = [torch.cat(hp_level_batches, dim=1) for hp_level_batches in highpass_batches]

    # Move back to original device
    if output_device is not None and output_device.type != 'cpu':
        lowpass = lowpass.to(output_device)
        highpasses = [hp.to(output_device) for hp in highpasses]

    # Determine target dtype (use highpass dtype if available, else lowpass)
    target_dtype = highpasses[0].dtype if len(highpasses) > 0 else lowpass.dtype

    # Reshape and stack coefficients
    stacked_coeffs = [
        lowpass.T.reshape(H, W, -1, C).to(target_dtype)
    ]
    coeff_lengths = [stacked_coeffs[0].shape[2]]

    for hp in highpasses[::-1]:
        coeff = hp.T.reshape(H, W, -1, C).to(target_dtype)
        stacked_coeffs.append(coeff)
        coeff_lengths.append(coeff.shape[2])

    stacked_coeffs_pt = torch.cat(stacked_coeffs, dim=2)

    # Cleanup
    del lowpass, highpasses, stacked_coeffs
    if output_device is not None and output_device.type == 'cuda':
        torch.cuda.empty_cache()

    return stacked_coeffs_pt, coeff_lengths


def reconstruct_dtcwt_transform(
    data: torch.Tensor,
    coeff_lengths: List[int],
    temporal_levels: int,
    temporal_length: int,
    level1_filter: str = 'near_sym_a',
    level2p_filter: str = 'qshift_a',
    batch_size: Optional[int] = None,
) -> torch.Tensor:
    """
    Reconstruct time series from DTCWT coefficients.

    Inverts the forward DTCWT transform to recover the original signal.

    Args:
        data (torch.Tensor): Stacked DTCWT coefficients shape (H, W, total_coeffs, C)
        coeff_lengths (List[int]): Coefficient lengths for each level [lowpass, hp1, hp2, ..., hpN]
        temporal_levels (int): Number of decomposition levels used in forward transform
        temporal_length (int): Original temporal dimension to reconstruct
        level1_filter (str): Biorthogonal filter pair used at level 1 in the
            forward transform (dtcwt's `biort` parameter). Must match the
            forward transform for correct reconstruction.
        level2p_filter (str): Q-shift filter pair used at levels 2+ in the
            forward transform (dtcwt's `qshift` parameter). Must match the
            forward transform for correct reconstruction.
        batch_size (Optional[int]): Number of flattened temporal signals
            (from H*W*C) to process per inverse DTCWT call. If None or <= 0,
            process in automatic memory-aware chunks.

    Returns:
        torch.Tensor: Reconstructed data of shape (H, W, temporal_length, 1) with real dtype on CPU
    """
    import gc

    H, W, total_coeffs, C = data.shape
    device = data.device
    dtype = data.dtype
    xfm_1d = dtcwt_torch.Transform1d(biort=level1_filter, qshift=level2p_filter)

    total_signals = H * W * C
    if batch_size is None or batch_size <= 0:
        batch_size = max(256, total_signals // 10)
    batch_size = min(batch_size, total_signals)

    # Compute cumulative indices for proper coefficient extraction
    cumsum_coeff_lengths = [0]
    for length in coeff_lengths:
        cumsum_coeff_lengths.append(cumsum_coeff_lengths[-1] + length)

    # Flatten once for efficient batched extraction:
    # (H, W, total_coeffs, C) -> (total_coeffs, H*W*C)
    # Mirror the forward layout: permute so spatial dims are last, then flatten.
    coeffs_flat = data.permute(2, 0, 1, 3).reshape(total_coeffs, H * W * C)

    reconstructed_batches = []
    with torch.no_grad():
        for start_idx in tqdm.tqdm(range(0, total_signals, batch_size), desc="Reconstructing DTCWT batches"):
            end_idx = min(start_idx + batch_size, total_signals)

            # Extract lowpass coefficients (first in stacked array)
            lowpass_start = cumsum_coeff_lengths[0]
            lowpass_end = cumsum_coeff_lengths[1]
            lowpass_batch = coeffs_flat[lowpass_start:lowpass_end, start_idx:end_idx]

            # Extract highpass coefficients (stored after lowpass in stacked array)
            highpasses_batch = []
            for i in range(temporal_levels):
                hp_start = cumsum_coeff_lengths[1 + i]
                hp_end = cumsum_coeff_lengths[2 + i]
                hp_batch = coeffs_flat[hp_start:hp_end, start_idx:end_idx]
                highpasses_batch.append(hp_batch)

            # Ensure consistent dtype and device for Pyramid construction
            lowpass_batch = lowpass_batch.to(device=device, dtype=dtype)
            highpasses_batch = [hp.to(device=device, dtype=dtype) for hp in highpasses_batch]

            # Create pyramid and reconstruct this batch
            pyramid = dtcwt_torch.Pyramid(lowpass=lowpass_batch, highpasses=highpasses_batch[::-1])
            est_batch = xfm_1d.inverse(pyramid)

            if est_batch.is_complex():
                est_batch = est_batch.real

            # Move each reconstructed batch to CPU immediately
            reconstructed_batches.append(est_batch.cpu())

            del lowpass_batch, highpasses_batch, pyramid, est_batch
            if device.type == 'cuda':
                torch.cuda.empty_cache()
            gc.collect()

    # Concatenate reconstructed signals on CPU and reshape
    est_data = torch.cat(reconstructed_batches, dim=1)
    est_data = est_data.T.reshape(H, W, -1, C)
    est_data = est_data[:, :, :temporal_length, :]

    del coeffs_flat, reconstructed_batches
    if device.type == 'cuda':
        torch.cuda.empty_cache()

    return est_data
