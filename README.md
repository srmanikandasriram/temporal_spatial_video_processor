# Temporal Spatial Video Processor

Code release accompanying the ICCP 2026 paper **"Revealing Subtle Heat Flows All Around
Us Using Microbolometric Videos."**

**[Project Page](https://revealing-subtle-heat.github.io/) · [Dataset](https://huggingface.co/datasets/mani-ramanagopal/subtle-heat-flows) · [Citation](#citation)**

This repo contains two standalone tools:

1. **`run_tsvp.py`** — a config-driven script that runs the denoising pipeline
   (wavelet transform → coefficient smoothing → reconstruction) on a raw thermal
   capture and writes the result to a single `.h5` file.
2. **`viz/`** — a read-only browser viewer for inspecting `.h5` files
   (raw captures, pipeline output, or any other intermediate you point it at).

## Install

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

**Note on `dtcwt`:** the wavelet transform (`src/wavelet.py`) uses `dtcwt`'s torch
backend for GPU-accelerated batched decomposition, which the PyPI release of `dtcwt`
does not include. `requirements.txt` installs it straight from
[srmanikandasriram/dtcwt](https://github.com/srmanikandasriram/dtcwt), a fork that adds
the torch backend — `pip install -r requirements.txt` handles this automatically (no
separate step needed), as long as `git` is available and the repo is reachable.

## Getting the data

The raw thermal captures used in the paper are hosted on Hugging Face:
**[mani-ramanagopal/subtle-heat-flows](https://huggingface.co/datasets/mani-ramanagopal/subtle-heat-flows)**.
Download a capture from there (or use your own raw Boson capture using [srmanikandasriram/thermal-camera-driver](https://github.com/srmanikandasriram/thermal_camera_driver)).

Rather than hardcoding absolute paths into every config, symlink them into the repo root:

```bash
ln -s /path/to/your/raw_captures data
ln -s /path/to/your/output_cache output
```

## Running the pipeline

```bash
python run_tsvp.py configs/D01_bunny_wind_draft.yaml
```

`configs/default_config.yaml` holds every field that's typically shared across
scenes from the same capture rig — NPZ layout, normalization constants, and the
wavelet/denoising algorithm settings. A per-scene config sets `extends:
default_config.yaml` and overrides only what's actually scene-specific
(`scene_name`, `input.file_path`, `output.file_path`, and any algorithm fields
you want to tune for that scene) — see `configs/scene_example.yaml`. Nested
sections merge key-by-key; anything else (scalars, lists, smoother chains) is
replaced wholesale by the override. `extends` paths resolve relative to the
config file's own directory, and can chain (a config can extend another config
that itself extends a third). See `src/config.py` for the merge implementation.

Copy `configs/scene_example.yaml` per scene, point `input.file_path` at your
raw capture, and set `output.file_path`. The script:

1. Loads the raw capture (`src/data_loading.py`) and crops/resamples it to `(H, W, T)`,
   writing it unchanged (raw ADU units) to `input_video.h5` next to `output.file_path`
   (dataset `input_baseline`), so it's directly comparable with `denoised_baseline`.
2. Applies `pre_transform`: normalizes to working units (`common_offset`/`common_scale`)
   and, if `frame_mean_detrend` is enabled, subtracts each frame's raw spatial mean so the
   residual is zero-mean per frame, separately smooths that mean signal (`mean_smooth_chain`),
   and adds the smoothed (denoised) trend back after reconstruction.
3. Runs a forward DTCWT transform over the video (`src/wavelet.py`), using the filter
   pair named in `temporal_transform.level1_filter`/`level2p_filter`.
4. Smooths the approximation-band coefficients (`spatial_processing.approx`). With
   `twopass: true`, a first pass (`pass1_smooth_chain`) estimates per-pixel DC noise,
   which is subtracted before a second pass (`pass2_smooth_chain`) does the final smooth.
5. Smooths the detail-band coefficients (`spatial_processing.detail.smooth_chain`),
   optionally skipping spatially low-energy coefficients (`energy_threshold`), and
   optionally soft-thresholds coefficient magnitude (`magnitude_soft_threshold`). Each
   DTCWT decomposition level is smoothed and cached separately (same settings applied
   to every level) rather than concatenated into one array, so each level's
   contribution stays inspectable in the viewer.
6. Reconstructs the denoised video via the inverse DTCWT transform, re-adds the mean
   trend from step 2 if detrending was enabled, and writes `output.file_path`
   (dataset `denoised_baseline`, shape `(H, W, T)`, Zstd-compressed).

If `output.cache_dir` is set, an `intermediates.h5` is also written there with the
pre/post-smoothing coefficient arrays, for inspection with the viewer below.

Each smoothing chain is a list of one or more entries from the smoother registry in
`src/smoother.py` (`median`, `gaussian`, `spline1d`/`spline2d`, `nlm`, `bm3d`,
`axis_destripe`, `swt_axis_destripe`, ...). See `configs/default_config.yaml` for the
full set of options and their parameters.

**Input format.** `input.file_path` should point to a `.npz` (or `.npz.zst`) file.
Currently only `input.data_format: boson_raw` is supported — a raw FLIR Boson capture
with a 2-row telemetry header at the top of each frame, used to recover per-frame
hardware frame numbers (`input.video_key`/`tstamps_key` name the raw frame stack and
per-frame software timestamps).

**Note:** the temporal length `T` (after `input.start_idx`/`end_idx` trimming) must be
a multiple of `2 ** num_levels` for the DTCWT decomposition (set
`temporal_transform.num_levels` explicitly if the auto-computed value doesn't divide
your clip length evenly).

## Viewing results

```bash
python -m viz.viewer configs/D01_bunny_wind_draft.yaml
```

Pass the **same config file** you ran `run_tsvp.py` with. The viewer derives which
files to load from it and opens whichever currently exist:
- `input_video.h5` (next to `output.file_path`)
- `output.file_path` itself (e.g. `denoised_video.h5`)
- `output.cache_dir/intermediates.h5`, if `output.cache_dir` was set

All datasets from those files are loaded into one browser session — full-frame views,
pixel time-series, spatial/temporal derivatives, and wavelet-coefficient panels — and
grouped in the "add panel" menu by the pipeline stage that produced them (Input,
Pre-transform, Wavelet, Approx, Detail, Output). This grouping is cosmetic only; the
viewer doesn't run or re-run pipeline steps, it just displays whatever's on disk.

By default the server binds to `localhost`. Pass `--bind` to listen on all
interfaces — the viewer has no authentication, so only do this on a trusted network.

## Repo layout

```
run_tsvp.py       Standalone pipeline script (config → denoised_video.h5)
src/                  Pipeline algorithm code (config loading, data loading, wavelet transform, smoothers)
configs/              default_config.yaml (shared defaults) + scene_example.yaml (per-scene override)
viz/                  Standalone read-only HDF5 viewer (FastAPI + browser UI), driven by the same config
  viewer.py             CLI entry point + config -> loaded-files logic (`python -m viz.viewer`)
  routes.py             HTTP route/endpoint definitions
```

## License

The code in this repository is MIT-licensed (see `LICENSE`). That license covers only
this repository's own code — it does not extend to third-party dependencies this code
invokes, such as the spatial denoising algorithms (e.g. BM3D) or the DTCWT temporal
transform library, each of which carries its own license from its own upstream
repository. See `requirements.txt` for the full dependency list.

## Citation

If you use this code or the accompanying dataset, please cite:

```bibtex
@inproceedings{ramanagopal2026revealingsubtleheat,
  title     = {Revealing Subtle Heat Flows all around us using Microbolometric Videos},
  author    = {Ramanagopal, Mani and Oharazawa, Akihiko and Narayanan, Sriram and
               Yuan, Zeqing and Narasimhan, Srinivasa},
  booktitle = {IEEE International Conference on Computational Photography (ICCP)},
  year      = {2026}
}
```
