"""FastAPI route/endpoint definitions for the standalone video viewer.

_build_app() takes an already-populated PipelineState (see
viz/viewer.py::create_viz_app) and wires up the HTTP API around it — status,
variable listing, frame/heatmap rendering, MP4/PNG export, and side-by-side
compare.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

import numpy as np
from skimage.transform import resize as sk_resize
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from fastapi.staticfiles import StaticFiles

from viz.derivatives import VALID_DERIVATIVES, compute_derivative
from viz.renderers import (
    apply_component,
    extract_frame,
    extract_heatmap_slice,
    extract_pixel_series,
    extract_video_spatial_slice,
    get_frame_count,
    get_render_type,
    is_complex_array,
    render_compare_rgba,
    render_frame_rgba,
    render_heatmap_rgba,
)
from viz.state import PipelineState

# Cache for global (vmin, vmax) used by isocontours colormap.
# Key: (var_name, pmin, pmax, component). Cleared when intermediates change.
_global_stats_cache: dict = {}


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------

def _build_app(state: PipelineState) -> FastAPI:
    app = FastAPI(title="TSVP Viewer")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"], allow_credentials=True,
        allow_methods=["*"], allow_headers=["*"],
    )

    @app.middleware("http")
    async def _no_cache_static(request, call_next):
        response = await call_next(request)
        if request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    static_dir = Path(__file__).parent / "static"
    app.mount("/static", StaticFiles(directory=str(static_dir)), name="static")

    # ------------------------------------------------------------------
    # Static SPA root
    # ------------------------------------------------------------------

    @app.get("/")
    async def root():
        from fastapi.responses import FileResponse
        return FileResponse(str(static_dir / "index.html"))

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------

    @app.get("/api/status")
    async def api_status():
        steps = []
        for step_id in state.STEP_ORDER:
            var_names = [
                v for v in state.STEP_VARIABLES.get(step_id, [])
                if v in state.intermediates
                and get_render_type(v, state.intermediates[v]) is not None
            ]
            steps.append({
                'id': step_id,
                'label': state.STEP_LABELS[step_id],
                'variables': var_names,
            })
        pre_cfg = state.config_dict.get('pre_transform', {})
        return {
            'config_path': state.config_path,
            'scene_name': state.config_dict.get('scene_name', ''),
            'common_offset': pre_cfg.get('common_offset', 0.0),
            'common_scale':  pre_cfg.get('common_scale',  1.0),
            'steps': steps,
        }

    # ------------------------------------------------------------------
    # Variables
    # ------------------------------------------------------------------

    @app.get("/api/variables")
    async def list_variables():
        result = []
        for step_id in state.STEP_ORDER:
            for var_name in state.STEP_VARIABLES.get(step_id, []):
                arr = state.intermediates.get(var_name)
                rt = get_render_type(var_name, arr)
                if rt is None:
                    continue
                shape = list(arr.shape) if hasattr(arr, 'shape') else [len(arr)]
                result.append({
                    'name': var_name,
                    'step_id': step_id,
                    'step_label': state.STEP_LABELS[step_id],
                    'shape': shape,
                    'dtype': str(arr.dtype) if hasattr(arr, 'dtype') else 'list',
                    'render_type': rt,
                    'frame_count': get_frame_count(arr) if hasattr(arr, 'shape') else 1,
                    'is_complex': is_complex_array(arr),
                })
        return result

    # ------------------------------------------------------------------
    # Variable data endpoints
    # ------------------------------------------------------------------

    def _subtract_ref(arr, frame_2d, frame_index: int, ref_frame: str, component: str):
        """Subtract a reference frame (first or mid) from frame_2d if requested."""
        if ref_frame == 'none' or is_complex_array(arr):
            return frame_2d
        fc = get_frame_count(arr)
        if ref_frame == 'first':
            ref_idx = 0
        else:  # mid
            ref_idx = fc // 2
        if frame_index == ref_idx:
            return frame_2d
        return frame_2d - extract_frame(arr, ref_idx, component=component)

    def _subtract_rowcol_mean(frame_2d):
        """Subtract per-row and per-column means from frame_2d."""
        out = frame_2d - frame_2d.mean(axis=1, keepdims=True)
        out = out - out.mean(axis=0, keepdims=True)
        return out

    def _render_variable_frame_rgba(
        name: str,
        frame_index: int,
        cmap: str = 'inferno',
        pmin: float = 1.0,
        pmax: float = 99.0,
        component: str = 'magnitude',
        clahe: bool = False,
        histeq: bool = False,
        ref_frame: str = 'none',
        subtract_rowcol_mean: bool = False,
        isocontour_range: float = 1.0,
        vmin: Optional[float] = None,
        vmax: Optional[float] = None,
        derivative: str = 'none',
        deriv_sigma_s: float = 1.0,
        deriv_sigma_t: float = 1.0,
    ):
        """Compute (rgba_bytes, height, width, frame_count) for one frame of `name`.

        Shared by the single-frame endpoint and the MP4 export loop so exported
        video pixel-for-pixel matches what the GUI renders.
        """
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found or not an array")

        if derivative not in VALID_DERIVATIVES:
            raise HTTPException(400, f"Invalid derivative '{derivative}'. Valid: {sorted(VALID_DERIVATIVES)}")

        fc = get_frame_count(arr)
        frame_index = max(0, min(frame_index, fc - 1))

        if derivative != 'none':
            if derivative == 'dt':
                raw = arr  # compute_derivative slices the window itself
            else:
                # Spatial derivatives only need one frame
                raw = arr[:, :, frame_index, 0] if arr.ndim == 4 else arr[:, :, frame_index] if arr.ndim == 3 else np.asarray(arr)
                raw = np.asarray(raw).astype(np.float64)
            frame_2d = compute_derivative(raw, frame_index, derivative,
                                          sigma_s=deriv_sigma_s, sigma_t=deriv_sigma_t)
            if vmin is None and vmax is None:
                vlim = float(np.percentile(np.abs(frame_2d), 99))
                vmin, vmax = -vlim, vlim
            global_vmin, global_vmax = vmin, vmax
        else:
            frame_2d = extract_frame(arr, frame_index, component=component)
            frame_2d = _subtract_ref(arr, frame_2d, frame_index, ref_frame, component)
            if subtract_rowcol_mean:
                frame_2d = _subtract_rowcol_mean(frame_2d)
            global_vmin, global_vmax = vmin, vmax
            if global_vmin is None or global_vmax is None:
                if cmap == 'isocontours':
                    cache_key = (name, pmin, pmax, component)
                    if cache_key in _global_stats_cache:
                        global_vmin, global_vmax = _global_stats_cache[cache_key]
                    else:
                        flat = apply_component(np.asarray(arr), component).ravel()
                        global_vmin = float(np.percentile(flat, pmin))
                        global_vmax = float(np.percentile(flat, pmax))
                        _global_stats_cache[cache_key] = (global_vmin, global_vmax)

        rgba_bytes = render_frame_rgba(frame_2d, cmap=cmap, pmin=pmin, pmax=pmax, clahe=clahe,
                                       histeq=histeq, isocontour_range=isocontour_range,
                                       global_vmin=global_vmin, global_vmax=global_vmax)
        h, w = frame_2d.shape
        return rgba_bytes, h, w, fc, frame_index

    @app.get("/api/variable/{name}/frame-rgba")
    async def var_frame_rgba(
        name: str,
        frame_index: int = 0,
        cmap: str = 'inferno',
        pmin: float = 1.0,
        pmax: float = 99.0,
        component: str = 'magnitude',
        clahe: bool = False,
        histeq: bool = False,
        subtract_first_frame: bool = False,
        ref_frame: str = 'none',
        subtract_rowcol_mean: bool = False,
        isocontour_range: float = 1.0,
        vmin: Optional[float] = None,
        vmax: Optional[float] = None,
        derivative: str = 'none',
        deriv_sigma_s: float = 1.0,
        deriv_sigma_t: float = 1.0,
    ):
        # Support legacy subtract_first_frame param
        if subtract_first_frame and ref_frame == 'none':
            ref_frame = 'first'

        rgba_bytes, h, w, fc, frame_index = _render_variable_frame_rgba(
            name, frame_index, cmap=cmap, pmin=pmin, pmax=pmax, component=component,
            clahe=clahe, histeq=histeq, ref_frame=ref_frame,
            subtract_rowcol_mean=subtract_rowcol_mean, isocontour_range=isocontour_range,
            vmin=vmin, vmax=vmax, derivative=derivative,
            deriv_sigma_s=deriv_sigma_s, deriv_sigma_t=deriv_sigma_t,
        )
        headers = {
            'X-Frame-Width': str(w),
            'X-Frame-Height': str(h),
            'X-Frame-Count': str(fc),
            'X-Frame-Index': str(frame_index),
        }
        return Response(content=rgba_bytes, media_type='application/octet-stream',
                        headers=headers)

    @app.get("/api/variable/{name}/export-mp4")
    async def var_export_mp4(
        name: str,
        cmap: str = 'inferno',
        pmin: float = 1.0,
        pmax: float = 99.0,
        component: str = 'magnitude',
        clahe: bool = False,
        histeq: bool = False,
        ref_frame: str = 'none',
        subtract_rowcol_mean: bool = False,
        isocontour_range: float = 1.0,
        vmin: Optional[float] = None,
        vmax: Optional[float] = None,
        derivative: str = 'none',
        deriv_sigma_s: float = 1.0,
        deriv_sigma_t: float = 1.0,
        fps: float = 15.0,
        frame_start: int = 0,
        frame_end: Optional[int] = None,
        crop_x0: Optional[float] = None,
        crop_y0: Optional[float] = None,
        crop_x1: Optional[float] = None,
        crop_y1: Optional[float] = None,
        flip_h: bool = False,
    ):
        """Render every frame of `name` with the given display settings and encode as MP4.

        Reuses the exact same per-frame rendering path as /frame-rgba, so the
        exported video matches what is shown while scrubbing/playing in the GUI.
        The optional crop_* box (source-pixel coords, matching the GUI's current
        zoom/pan) restricts output to that region, mirroring the PNG viewport export.
        """
        import tempfile
        import os
        import imageio.v2 as imageio

        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found or not an array")
        fc = get_frame_count(arr)
        end = fc if frame_end is None else min(frame_end, fc)
        start = max(0, min(frame_start, end - 1))
        if end <= start:
            raise HTTPException(400, "Empty frame range")

        tmp_fd, tmp_path = tempfile.mkstemp(suffix='.mp4')
        os.close(tmp_fd)
        writer = None
        try:
            for i in range(start, end):
                rgba_bytes, h, w, _, _ = _render_variable_frame_rgba(
                    name, i, cmap=cmap, pmin=pmin, pmax=pmax, component=component,
                    clahe=clahe, histeq=histeq, ref_frame=ref_frame,
                    subtract_rowcol_mean=subtract_rowcol_mean, isocontour_range=isocontour_range,
                    vmin=vmin, vmax=vmax, derivative=derivative,
                    deriv_sigma_s=deriv_sigma_s, deriv_sigma_t=deriv_sigma_t,
                )
                frame_rgb = np.frombuffer(rgba_bytes, dtype=np.uint8).reshape(h, w, 4)[:, :, :3]

                if crop_x0 is not None and crop_y0 is not None and crop_x1 is not None and crop_y1 is not None:
                    cx0 = max(0, min(int(round(crop_x0)), w - 1))
                    cy0 = max(0, min(int(round(crop_y0)), h - 1))
                    cx1 = max(cx0 + 1, min(int(round(crop_x1)), w))
                    cy1 = max(cy0 + 1, min(int(round(crop_y1)), h))
                    frame_rgb = frame_rgb[cy0:cy1, cx0:cx1]

                if flip_h:
                    frame_rgb = frame_rgb[:, ::-1]

                # H.264 (yuv420p) requires even width/height; drop the last row/col if odd.
                fh, fw = frame_rgb.shape[:2]
                fh -= fh % 2
                fw -= fw % 2
                if fh < 2 or fw < 2:
                    raise HTTPException(400, "Cropped region too small to encode")
                frame_rgb = np.ascontiguousarray(frame_rgb[:fh, :fw])

                if writer is None:
                    writer = imageio.get_writer(tmp_path, format='FFMPEG', mode='I', fps=fps,
                                                codec='libx264', pixelformat='yuv420p')
                writer.append_data(frame_rgb)
        finally:
            if writer is not None:
                writer.close()

        try:
            with open(tmp_path, 'rb') as f:
                video_bytes = f.read()
        finally:
            os.remove(tmp_path)

        headers = {'Content-Disposition': f'attachment; filename="{name}.mp4"'}
        return Response(content=video_bytes, media_type='video/mp4', headers=headers)

    @app.get("/api/variable/{name}/export-png")
    async def var_export_png(
        name: str,
        cmap: str = 'inferno',
        pmin: float = 1.0,
        pmax: float = 99.0,
        component: str = 'magnitude',
        clahe: bool = False,
        histeq: bool = False,
        ref_frame: str = 'none',
        subtract_rowcol_mean: bool = False,
        isocontour_range: float = 1.0,
        vmin: Optional[float] = None,
        vmax: Optional[float] = None,
        derivative: str = 'none',
        deriv_sigma_s: float = 1.0,
        deriv_sigma_t: float = 1.0,
        frame_index: int = 0,
        crop_x0: Optional[float] = None,
        crop_y0: Optional[float] = None,
        crop_x1: Optional[float] = None,
        crop_y1: Optional[float] = None,
        flip_h: bool = False,
    ):
        """Render `name` at full source resolution and encode as PNG, cropped to crop_*.

        Reuses the same per-frame rendering path as /frame-rgba and /heatmap-rgba so the
        exported image matches the GUI exactly, with no client-side canvas interpolation.
        """
        import io
        import imageio.v2 as imageio

        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found or not an array")

        rt = get_render_type(name, arr)
        if rt == 'video':
            rgba_bytes, h, w, _, _ = _render_variable_frame_rgba(
                name, frame_index, cmap=cmap, pmin=pmin, pmax=pmax, component=component,
                clahe=clahe, histeq=histeq, ref_frame=ref_frame,
                subtract_rowcol_mean=subtract_rowcol_mean, isocontour_range=isocontour_range,
                vmin=vmin, vmax=vmax, derivative=derivative,
                deriv_sigma_s=deriv_sigma_s, deriv_sigma_t=deriv_sigma_t,
            )
        elif rt in ('heatmap', 'image'):
            arr_real = apply_component(arr.squeeze(), component) if is_complex_array(arr) else arr
            try:
                rgba_bytes, w, h = render_heatmap_rgba(arr_real, cmap=cmap, pmin=pmin, pmax=pmax, clahe=clahe,
                                                        histeq=histeq, isocontour_range=isocontour_range,
                                                        global_vmin=vmin, global_vmax=vmax)
            except ValueError as e:
                raise HTTPException(422, str(e))
        else:
            raise HTTPException(400, f"PNG export not supported for render type '{rt}'")

        frame_rgb = np.frombuffer(rgba_bytes, dtype=np.uint8).reshape(h, w, 4)[:, :, :3]

        if crop_x0 is not None and crop_y0 is not None and crop_x1 is not None and crop_y1 is not None:
            cx0 = max(0, min(int(round(crop_x0)), w - 1))
            cy0 = max(0, min(int(round(crop_y0)), h - 1))
            cx1 = max(cx0 + 1, min(int(round(crop_x1)), w))
            cy1 = max(cy0 + 1, min(int(round(crop_y1)), h))
            frame_rgb = frame_rgb[cy0:cy1, cx0:cx1]

        if flip_h:
            frame_rgb = frame_rgb[:, ::-1]

        frame_rgb = np.ascontiguousarray(frame_rgb)
        buf = io.BytesIO()
        imageio.imwrite(buf, frame_rgb, format='PNG')

        headers = {'Content-Disposition': f'attachment; filename="{name}.png"'}
        return Response(content=buf.getvalue(), media_type='image/png', headers=headers)

    @app.get("/api/variable/{name}/percentile-stats")
    async def var_percentile_stats(
        name: str,
        pmin: float = 1.0,
        pmax: float = 99.0,
        component: str = 'magnitude',
    ):
        """Return vmin/vmax for the full array at given percentiles (cached)."""
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found or not an array")
        cache_key = (name, pmin, pmax, component)
        if cache_key in _global_stats_cache:
            vmin, vmax = _global_stats_cache[cache_key]
        else:
            flat = apply_component(np.asarray(arr), component).ravel()
            flat = flat[np.isfinite(flat)]
            vmin = float(np.percentile(flat, pmin))
            vmax = float(np.percentile(flat, pmax))
            _global_stats_cache[cache_key] = (vmin, vmax)
        return {'vmin': vmin, 'vmax': vmax, 'name': name, 'pmin': pmin, 'pmax': pmax}

    @app.get("/api/variable/{name}/frame-stats")
    async def var_frame_stats(
        name: str,
        frame_index: int = 0,
        component: str = 'magnitude',
        subtract_first_frame: bool = False,
        ref_frame: str = 'none',
        subtract_rowcol_mean: bool = False,
        pmin: float = 1.0,
        pmax: float = 99.0,
    ):
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found or not an array")
        if subtract_first_frame and ref_frame == 'none':
            ref_frame = 'first'
        fc = get_frame_count(arr)
        frame_index = max(0, min(frame_index, fc - 1))
        frame_2d = extract_frame(arr, frame_index, component=component)
        frame_2d = _subtract_ref(arr, frame_2d, frame_index, ref_frame, component)
        if subtract_rowcol_mean:
            frame_2d = _subtract_rowcol_mean(frame_2d)
        flat = frame_2d.ravel()
        flat = flat[np.isfinite(flat)]
        # coeff_mag_max: max of downsampled (H//4 x W//4) absolute value of the frame,
        # matching the threshold computation in pipeline.py smooth step.
        H2d, W2d = frame_2d.shape[:2]
        h4, w4 = max(1, H2d // 4), max(1, W2d // 4)
        coeff_mag = sk_resize(np.abs(frame_2d), (h4, w4), order=2, anti_aliasing=True)
        return {
            "min":           float(np.min(flat)),
            "max":           float(np.max(flat)),
            "mean":          float(np.mean(flat)),
            "std":           float(np.std(flat)),
            "p1":            float(np.percentile(flat, 1)),
            "p99":           float(np.percentile(flat, 99)),
            "vmin":          float(np.percentile(flat, pmin)),
            "vmax":          float(np.percentile(flat, pmax)),
            "frobenius":     float(np.linalg.norm(flat)),
            "coeff_mag_max": float(coeff_mag.max()),
        }

    @app.get("/api/variable/{name}/heatmap-rgba")
    async def var_heatmap_rgba(
        name: str,
        cmap: str = 'inferno',
        pmin: float = 1.0,
        pmax: float = 99.0,
        component: str = 'magnitude',
        clahe: bool = False,
        histeq: bool = False,
        isocontour_range: float = 1.0,
        vmin: Optional[float] = None,
        vmax: Optional[float] = None,
    ):
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found")
        # Apply component transform before squeezing (handles complex heatmaps)
        arr_real = apply_component(arr.squeeze(), component) if is_complex_array(arr) else arr
        global_vmin = vmin
        global_vmax = vmax
        try:
            rgba_bytes, w, h = render_heatmap_rgba(arr_real, cmap=cmap, pmin=pmin, pmax=pmax, clahe=clahe,
                                                    histeq=histeq, isocontour_range=isocontour_range,
                                                    global_vmin=global_vmin, global_vmax=global_vmax)
        except ValueError as e:
            raise HTTPException(422, str(e))
        headers = {'X-Frame-Width': str(w), 'X-Frame-Height': str(h)}
        return Response(content=rgba_bytes, media_type='application/octet-stream',
                        headers=headers)

    @app.get("/api/compare/frame-rgba")
    async def compare_frame_rgba(
        name1: str,
        name2: str,
        frame_index: int = 0,
        cmap: str = 'inferno',
        pmin: float = 1.0,
        pmax: float = 99.0,
        component: str = 'magnitude',
        clahe: bool = False,
        histeq: bool = False,
        ref_frame: str = 'none',
        subtract_rowcol_mean: bool = False,
        isocontour_range: float = 1.0,
    ):
        """Render two video frames with shared contrast enhancement (joint HE or per-frame CLAHE).

        Returns both RGBA byte arrays concatenated: first W1*H1*4 bytes for frame1,
        then W2*H2*4 bytes for frame2. Headers carry dimensions for both.
        """
        arr1 = state.intermediates.get(name1)
        arr2 = state.intermediates.get(name2)
        if arr1 is None or not hasattr(arr1, 'shape'):
            raise HTTPException(404, f"Variable '{name1}' not found")
        if arr2 is None or not hasattr(arr2, 'shape'):
            raise HTTPException(404, f"Variable '{name2}' not found")
        fc1 = get_frame_count(arr1)
        fc2 = get_frame_count(arr2)
        idx1 = max(0, min(frame_index, fc1 - 1))
        idx2 = max(0, min(frame_index, fc2 - 1))
        frame1 = extract_frame(arr1, idx1, component=component)
        frame1 = _subtract_ref(arr1, frame1, idx1, ref_frame, component)
        if subtract_rowcol_mean:
            frame1 = _subtract_rowcol_mean(frame1)
        frame2 = extract_frame(arr2, idx2, component=component)
        frame2 = _subtract_ref(arr2, frame2, idx2, ref_frame, component)
        if subtract_rowcol_mean:
            frame2 = _subtract_rowcol_mean(frame2)
        rgba1, rgba2 = render_compare_rgba(frame1, frame2, cmap=cmap, pmin=pmin, pmax=pmax,
                                           clahe=clahe, histeq=histeq,
                                           isocontour_range=isocontour_range)
        h1, w1 = frame1.shape
        h2, w2 = frame2.shape
        headers = {
            'X-Frame-Width':  str(w1), 'X-Frame-Height':  str(h1),
            'X-Frame2-Width': str(w2), 'X-Frame2-Height': str(h2),
            'X-Frame-Count':  str(fc1), 'X-Frame-Count2': str(fc2),
        }
        return Response(content=rgba1 + rgba2, media_type='application/octet-stream',
                        headers=headers)

    @app.get("/api/compare/heatmap-rgba")
    async def compare_heatmap_rgba(
        name1: str,
        name2: str,
        cmap: str = 'inferno',
        pmin: float = 1.0,
        pmax: float = 99.0,
        component: str = 'magnitude',
        clahe: bool = False,
        histeq: bool = False,
        isocontour_range: float = 1.0,
    ):
        """Render two heatmaps with shared contrast enhancement."""
        arr1 = state.intermediates.get(name1)
        arr2 = state.intermediates.get(name2)
        if arr1 is None or not hasattr(arr1, 'shape'):
            raise HTTPException(404, f"Variable '{name1}' not found")
        if arr2 is None or not hasattr(arr2, 'shape'):
            raise HTTPException(404, f"Variable '{name2}' not found")
        f1 = apply_component(arr1.squeeze(), component) if is_complex_array(arr1) else arr1.squeeze().astype(np.float32)
        f2 = apply_component(arr2.squeeze(), component) if is_complex_array(arr2) else arr2.squeeze().astype(np.float32)
        if f1.ndim != 2 or f2.ndim != 2:
            raise HTTPException(422, "Arrays must be 2D after squeezing")
        rgba1, rgba2 = render_compare_rgba(f1, f2, cmap=cmap, pmin=pmin, pmax=pmax,
                                           clahe=clahe, histeq=histeq,
                                           isocontour_range=isocontour_range)
        h1, w1 = f1.shape
        h2, w2 = f2.shape
        headers = {
            'X-Frame-Width':  str(w1), 'X-Frame-Height':  str(h1),
            'X-Frame2-Width': str(w2), 'X-Frame2-Height': str(h2),
        }
        return Response(content=rgba1 + rgba2, media_type='application/octet-stream',
                        headers=headers)

    # input_baseline/denoised_baseline are already written in raw ADU units (see
    # run_tsvp.py) — rescaling them again here would double-apply common_scale/offset.
    _ALREADY_ADU_UNITS = {'input_baseline', 'denoised_baseline'}

    @app.get("/api/variable/{name}/series-json")
    async def var_series(name: str):
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404)
        a = np.asarray(arr)
        if np.iscomplexobj(a):
            real_flat = a.real.ravel().tolist()
            imag_flat = a.imag.ravel().tolist()
            return {'values': real_flat, 'imag_values': imag_flat,
                    'length': len(real_flat), 'name': name, 'is_complex': True}
        if name in _ALREADY_ADU_UNITS:
            flat = a.ravel().tolist()
        else:
            pre_cfg = state.config_dict.get('pre_transform', {})
            common_offset = float(pre_cfg.get('common_offset', 0.0))
            common_scale = float(pre_cfg.get('common_scale', 1.0))
            flat = (a.ravel() * common_scale + common_offset).tolist()
        return {'values': flat, 'length': len(flat), 'name': name}

    @app.get("/api/variable/{name}/barchart-json")
    async def var_barchart(name: str):
        arr = state.intermediates.get(name)
        if arr is None:
            raise HTTPException(404)
        if hasattr(arr, 'shape'):
            arr = arr[:].tolist() if hasattr(arr, '__getitem__') else np.asarray(arr).tolist()
        if not isinstance(arr, list):
            raise HTTPException(422, "Not a list")
        labels = [f"level_{i}" for i in range(len(arr))]
        return {'labels': labels, 'values': arr, 'name': name}

    @app.get("/api/variable/{name}/heatmap-slice")
    async def var_heatmap_slice(name: str, axis: str = 'row', index: int = 0, component: str = 'magnitude'):
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found")
        try:
            return extract_heatmap_slice(arr, axis, index, component)
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.get("/api/variable/{name}/video-spatial-slice")
    async def var_video_spatial_slice(name: str, axis: str = 'row', index: int = 0,
                                      frame: int = 0, component: str = 'magnitude'):
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found or not an array")
        try:
            return extract_video_spatial_slice(arr, axis, index, frame, component)
        except ValueError as e:
            raise HTTPException(422, str(e))

    @app.get("/api/variable/{name}/pixel-series")
    async def var_pixel_series(name: str, row: int = 0, col: int = 0):
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found or not an array")
        # Use the pixel-chunked companion dataset if available to avoid reading
        # every frame chunk just to extract a single pixel's time series.
        pixel_arr = state.intermediates.get(f"{name}_pixel")
        return extract_pixel_series(pixel_arr if pixel_arr is not None else arr, row, col)

    @app.get("/api/variable/{name}/frame-npy")
    async def var_frame_npy(
        name: str,
        frame_index: int = 0,
        component: str = 'magnitude',
        subtract_first_frame: bool = False,
        ref_frame: str = 'none',
        subtract_rowcol_mean: bool = False,
    ):
        """Return the current frame (or full array for non-video) as a .npy file."""
        import io
        arr = state.intermediates.get(name)
        if arr is None or not hasattr(arr, 'shape'):
            raise HTTPException(404, f"Variable '{name}' not found or not an array")
        if subtract_first_frame and ref_frame == 'none':
            ref_frame = 'first'

        rt = get_render_type(name, arr)
        if rt in ('video', 'heatmap', 'image'):
            fc = get_frame_count(arr)
            frame_index = max(0, min(frame_index, fc - 1))
            out = extract_frame(arr, frame_index, component=component)
            out = _subtract_ref(arr, out, frame_index, ref_frame, component)
            if subtract_rowcol_mean:
                out = _subtract_rowcol_mean(out)
        else:
            # line / barchart: export the full 1D array
            out = arr.ravel()

        buf = io.BytesIO()
        np.save(buf, out)
        npy_bytes = buf.getvalue()

        safe_name = name.replace('/', '_').replace('\\', '_')
        return Response(
            content=npy_bytes,
            media_type='application/octet-stream',
            headers={'Content-Disposition': f'attachment; filename="{safe_name}.npy"'},
        )

    @app.get("/api/variable/{name}/info")
    async def var_info(name: str):
        arr = state.intermediates.get(name)
        if arr is None:
            raise HTTPException(404)
        rt = get_render_type(name, arr)
        shape = list(arr.shape) if hasattr(arr, 'shape') else [len(arr)]
        fc = get_frame_count(arr) if hasattr(arr, 'shape') else 1
        return {
            'name': name,
            'render_type': rt,
            'shape': shape,
            'frame_count': fc,
        }

    return app
