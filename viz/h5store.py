"""Numpy-compatible read-only proxy over HDF5 datasets for the viewer.

Wraps a dataset and satisfies numpy-style access
(shape/dtype/ndim/__getitem__) without loading the full array into RAM;
rendering endpoints issue only the per-frame slices they actually need.
"""
from __future__ import annotations

import numpy as np
import h5py
import hdf5plugin  # noqa: F401 — registers the Zstd decompression plugin with libhdf5


class H5ArrayProxy:
    """Numpy-compatible view over an h5py.Dataset — no full load until needed."""

    def __init__(self, dataset: h5py.Dataset) -> None:
        self._ds = dataset

    # --- numpy-compatible properties ---

    @property
    def shape(self) -> tuple:
        return self._ds.shape

    @property
    def dtype(self) -> np.dtype:
        return self._ds.dtype

    @property
    def ndim(self) -> int:
        return len(self._ds.shape)

    @property
    def nbytes(self) -> int:
        return int(np.prod(self._ds.shape)) * self._ds.dtype.itemsize

    # --- indexing ---

    def __getitem__(self, idx):
        return self._ds[idx]

    # --- force full load (e.g. torch.from_numpy(arr[:]) or np.array(proxy)) ---

    def __array__(self, dtype=None):
        arr = self._ds[:]
        if dtype is not None:
            arr = arr.astype(dtype)
        return arr

    # --- convenience ---

    def squeeze(self):
        return self._ds[:].squeeze()

    def ravel(self):
        return self._ds[:].ravel()

    def mean(self, axis=None):
        return np.asarray(self).mean(axis=axis)

    def copy(self):
        return self._ds[:].copy()

    def __repr__(self) -> str:
        return f"H5ArrayProxy(shape={self.shape}, dtype={self.dtype})"
