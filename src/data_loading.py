import logging
import numpy as np
from tqdm import tqdm
import zstandard as zstd
from typing import Dict, Tuple, Union
from pathlib import Path
import io

logger = logging.getLogger(__name__)


# Telemetry byte index constants for FLIR/Boson thermal cameras.
# Boson telemetry is embedded as 2 extra rows at the top of each frame.
TELEM_ROWS = 2


def parse_telemetry(telemetry_bytes: np.ndarray) -> Dict[str, Union[np.ndarray, Tuple]]:
    """
    Parse telemetry header from a Boson thermal camera to extract metadata.

    The telemetry data is embedded in the raw thermal frames and contains information
    about sensor state, timestamps, and image statistics.

    Args:
        telemetry_bytes (np.ndarray): Array of telemetry bytes with shape (T, 2, W)
            where T is number of frames, 2 is telemetry row count, W is width.

    Returns:
        Dict[str, Union[np.ndarray, Tuple]]: Dictionary containing extracted metadata:
            - 'serial_number': Camera serial number (uint64)
            - 'frame_counter': Frame counter for each frame (ndarray)
            - 'frame_counter_last_FFC': Frame counter at last FFC calibration (ndarray)
            - 'fpa_temp_in_counts': Focal plane array temperature (sensor counts)
            - 'cam_temp_in_K': Camera body temperature (Kelvin)
            - 'cam_temp_last_FFC_in_K': Camera temp at last FFC (Kelvin)
            - 'core_temp_in_C': Core temperature (Celsius)
            - 'timestamp_in_ms': Timestamp in milliseconds (uint64)
            - 'image_stats_roi': ROI coordinates tuple (x_min, y_min, x_max, y_max)
            - 'mean_in_roi': Mean pixel value in ROI
            - 'min_in_roi': Minimum pixel value in ROI
            - 'max_in_roi': Maximum pixel value in ROI
    """
    metadata = {}
    metadata['serial_number'] = np.uint64(telemetry_bytes[0, 0, 1] * 2.0**16 + telemetry_bytes[0, 0, 2])
    metadata['frame_counter'] = np.uint64(telemetry_bytes[:, 0, 42] * 2.0**16 + telemetry_bytes[:, 0, 43])
    metadata['frame_counter_last_FFC'] = np.uint64(telemetry_bytes[:, 0, 44] * 2.0**16 + telemetry_bytes[:, 0, 45])
    metadata['fpa_temp_in_counts'] = telemetry_bytes[:, 0, 46]
    metadata['cam_temp_in_K'] = telemetry_bytes[:, 0, 47] / 10.0
    metadata['cam_temp_last_FFC_in_K'] = telemetry_bytes[:, 0, 48] / 10.0
    metadata['core_temp_in_C'] = telemetry_bytes[:, 0, 81] / 1000.0
    metadata['timestamp_in_ms'] = np.uint64(telemetry_bytes[:, 0, 140] * 2.0**16 + telemetry_bytes[:, 0, 141])
    metadata['image_stats_roi'] = (telemetry_bytes[:, 0, 29], telemetry_bytes[:, 0, 30],
                                   telemetry_bytes[:, 0, 31], telemetry_bytes[:, 0, 32])
    metadata['mean_in_roi'] = telemetry_bytes[:, 0, 33]
    metadata['min_in_roi'] = telemetry_bytes[:, 0, 34]
    metadata['max_in_roi'] = telemetry_bytes[:, 0, 35]
    return metadata


def load_npz_data(npz_path: Union[str, Path]) -> Dict[str, np.ndarray]:
    """
    Load NPZ data file, with support for Zstandard (ZST) compression.

    Args:
        npz_path (Union[str, Path]): Path to NPZ or compressed ZST file.

    Returns:
        Dict[str, np.ndarray]: Dictionary with NPZ contents as numpy arrays.

    Raises:
        FileNotFoundError: If the file does not exist.
        ValueError: If the file cannot be decompressed or loaded.
    """
    npz_path = Path(npz_path)
    if not npz_path.exists():
        raise FileNotFoundError(f"Data file not found: {npz_path}")

    if str(npz_path).endswith('.zst') or npz_path.suffix == '.zst':
        logger.info("Attempting to decompress data file...")
        try:
            dctx = zstd.ZstdDecompressor()

            with open(npz_path, 'rb') as compressed_file:
                with dctx.stream_reader(compressed_file) as reader:
                    decompressed_data = reader.read()

            # Load decompressed data using BytesIO
            with np.load(io.BytesIO(decompressed_data), allow_pickle=False) as npz_data:
                # Convert the NpzFile to a regular dictionary
                data = {key: npz_data[key] for key in npz_data.files}
            logger.info("Successfully loaded compressed data file")
        except Exception as e:
            raise ValueError(f"Failed to decompress data file: {e}")
    else:
        try:
            data = np.load(npz_path, allow_pickle=True)
            # Convert lazy-loaded data to dict
            if hasattr(data, 'files'):
                data = {key: data[key] for key in data.files}
        except Exception as e:
            raise ValueError(f"Failed to load NPZ file: {e}")

    return data


def load_data(config: Dict) -> Dict:
    """
    Load raw thermal video data described by a pipeline config's `input` section.

    Reads a Boson-format NPZ capture (raw frames with an embedded 2-row telemetry
    header) and applies:
    - Telemetry parsing to recover per-frame hardware frame numbers
    - Frame resampling for uniform spacing (fills dropped frames via interpolation)
    - Start/end trimming and spatial cropping

    Note: this only loads and crops the *raw* video — offset/scale normalization
    and mean detrending are pipeline steps applied separately (see `run_tsvp.py`).

    Args:
        config (Dict): Fully-resolved pipeline config (see `src.config.load_config`).
            Reads its `input` section:
                - file_path: Path to NPZ (or .npz.zst) data file
                - data_format: Capture format; only 'boson_raw' is currently supported
                - video_key: Key for the raw frame stack in the NPZ
                - tstamps_key: Key for per-frame software timestamps in the NPZ
                - start_idx, end_idx: Frame range to keep (end_idx=-1 for full video)
                - crop_bbox: [x_min, y_min, x_max, y_max], or null for no crop
                - uniform_resample: Interpolate to fill dropped frames

    Returns:
        Dict: data_dict containing:
            - thermal_data_np: Raw thermal video, shape (H, W, T), un-normalized
            - frame_numbers: Hardware frame counter per frame
            - software_abs_timestamps: Absolute software timestamps per frame
            - height, width, temporal_length: Video dimensions
            - metadata: Parsed camera telemetry

    Raises:
        AssertionError: If frame spacing cannot be made uniform.
        KeyError: If required keys are missing from the NPZ or config.
        ValueError: If `data_format` is not supported.
    """
    if 'input' not in config:
        raise KeyError("Missing required config section: input")
    input_cfg = config['input']

    for key in ('file_path', 'data_format', 'video_key', 'tstamps_key'):
        if key not in input_cfg:
            raise KeyError(f"Missing required config key: input.{key}")

    data_format = input_cfg['data_format']
    if data_format != 'boson_raw':
        raise ValueError(f"Unsupported input.data_format: {data_format!r}. Only 'boson_raw' is supported.")

    uniform_resample = input_cfg.get('uniform_resample', True)
    start_idx = input_cfg.get('start_idx', 0)
    end_idx = input_cfg.get('end_idx', -1)
    crop_bbox = input_cfg.get('crop_bbox')

    npz_data = load_npz_data(input_cfg['file_path'])

    video_key = input_cfg['video_key']
    tstamps_key = input_cfg['tstamps_key']
    if video_key not in npz_data:
        raise KeyError(f"Video key '{video_key}' not found in NPZ file. Available keys: {list(npz_data.keys())}")
    if tstamps_key not in npz_data:
        raise KeyError(f"Timestamp key '{tstamps_key}' not found in NPZ file. Available keys: {list(npz_data.keys())}")

    raw_thr_frames = npz_data[video_key]  # (T, H, W)
    software_abs_timestamps = npz_data[tstamps_key]  # (T,)

    flat = raw_thr_frames[..., 0] if raw_thr_frames.ndim == 4 else raw_thr_frames  # (T, H, W)
    telem_slice = flat[:, :TELEM_ROWS, :]
    image_slice = flat[:, TELEM_ROWS:, :]

    metadata = parse_telemetry(telem_slice)
    frame_numbers = metadata['frame_counter']
    raw_video_data = image_slice  # (T, H, W)

    if uniform_resample:
        # Handle non-uniform frame spacing by filling dropped frames via interpolation
        if not np.unique(np.diff(frame_numbers)).size == 1:
            logger.warning(f"Frame numbers are not uniformly spaced. {np.where(np.diff(frame_numbers) != 1)[0][:10]}")
            uniformly_spaced_video = np.zeros(
                (int(frame_numbers[-1] - frame_numbers[0] + 1), raw_video_data.shape[1], raw_video_data.shape[2]),
                dtype=raw_video_data.dtype)
            uniformly_spaced_video[frame_numbers - frame_numbers[0]] = raw_video_data

            for i in tqdm(range(uniformly_spaced_video.shape[0])):
                if np.all(uniformly_spaced_video[i] == 0):
                    logger.debug(f"Filling missing frame at index {i}")
                    prev_idx = i - 1
                    next_idx = i + 1
                    while prev_idx >= 0 and np.all(uniformly_spaced_video[prev_idx] == 0):
                        prev_idx -= 1
                    while next_idx < uniformly_spaced_video.shape[0] and np.all(uniformly_spaced_video[next_idx] == 0):
                        next_idx += 1
                    if prev_idx >= 0 and next_idx < uniformly_spaced_video.shape[0]:
                        if next_idx - prev_idx > 1:
                            alpha = (i - prev_idx) / (next_idx - prev_idx)
                            uniformly_spaced_video[i] = (1 - alpha) * uniformly_spaced_video[prev_idx] + alpha * uniformly_spaced_video[next_idx]
                        else:
                            uniformly_spaced_video[i] = (uniformly_spaced_video[prev_idx] + uniformly_spaced_video[next_idx]) / 2
                    elif prev_idx >= 0:
                        uniformly_spaced_video[i] = uniformly_spaced_video[prev_idx]
                    elif next_idx < uniformly_spaced_video.shape[0]:
                        uniformly_spaced_video[i] = uniformly_spaced_video[next_idx]

            raw_video_data = uniformly_spaced_video
            frame_numbers = np.arange(frame_numbers[0], frame_numbers[0] + raw_video_data.shape[0])
            software_abs_timestamps = np.linspace(
                software_abs_timestamps[0],
                software_abs_timestamps[0] + (raw_video_data.shape[0] - 1) / 60.0,
                raw_video_data.shape[0])
            logger.info(f"Resampled video to uniform frame numbers from {frame_numbers[0]} to {frame_numbers[-1]} "
                        f"with shape {raw_video_data.shape}")

        assert np.unique(np.diff(frame_numbers)).size == 1, "Frame numbers are not uniformly spaced"
        logger.info(f"Frame number increment: {np.unique(np.diff(frame_numbers))[0]}")

    if end_idx == -1:
        end_idx = raw_video_data.shape[0]
    temporal_length = end_idx - start_idx
    logger.info(f"Raw thermal video length: {raw_video_data.shape[0]}, using temporal length: {temporal_length}")

    raw_video_data = raw_video_data[start_idx:end_idx]
    frame_numbers = frame_numbers[start_idx:end_idx]
    software_abs_timestamps = software_abs_timestamps[start_idx:end_idx]

    thermal_data_np = raw_video_data.astype(np.float32).transpose(1, 2, 0)  # (H, W, T)

    if crop_bbox is not None:
        thermal_data_np = thermal_data_np[crop_bbox[1]:crop_bbox[3], crop_bbox[0]:crop_bbox[2], :]
    height, width = thermal_data_np.shape[0], thermal_data_np.shape[1]

    return {
        'thermal_data_np': thermal_data_np,
        'frame_numbers': frame_numbers,
        'software_abs_timestamps': software_abs_timestamps,
        'temporal_length': temporal_length,
        'height': height,
        'width': width,
        'metadata': metadata,
    }
