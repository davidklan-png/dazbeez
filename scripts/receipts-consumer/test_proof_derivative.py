"""Tests for make_proof_derivative in consumer.py (PR 1).

Run:
  cd scripts/receipts-consumer && \\
  CF_ACCOUNT_ID=d CF_QUEUE_ID=d CF_API_TOKEN=d \\
  RECEIPTS_EXTRACT_URL=http://d RECEIPTS_PROCESSOR_KEY=d MLX_MODEL=d \\
  .venv/bin/python3 -m unittest test_proof_derivative -v
"""
from __future__ import annotations

import io
import os
import tempfile
import unittest

# consumer.py reads these at import time; default them so the test runs without
# the runtime env (mirrors test_permanent_failure.py).
os.environ.setdefault("CF_ACCOUNT_ID", "d")
os.environ.setdefault("CF_QUEUE_ID", "d")
os.environ.setdefault("CF_API_TOKEN", "d")
os.environ.setdefault("RECEIPTS_EXTRACT_URL", "http://d")
os.environ.setdefault("RECEIPTS_PROCESSOR_KEY", "d")
os.environ.setdefault("MLX_MODEL", "d")

import consumer  # type: ignore  # noqa: E402
from PIL import Image  # noqa: E402


def _write_jpeg(path: str, size: tuple[int, int], exif=None) -> None:
    img = Image.new("RGB", size, color=(120, 160, 200))
    if exif is not None:
        img.save(path, format="JPEG", exif=exif)
    else:
        img.save(path, format="JPEG")


class TestMakeProofDerivative(unittest.TestCase):
    def test_large_image_capped_at_max_dim(self):
        fd, path = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        try:
            _write_jpeg(path, (3000, 2000))
            data, ct = consumer.make_proof_derivative(path)
            self.assertEqual(ct, "image/jpeg")
            self.assertEqual(data[:2], b"\xff\xd8")  # JPEG SOI magic
            out = Image.open(io.BytesIO(data))
            self.assertLessEqual(max(out.size), consumer.PROOF_MAX_DIM)
            # Aspect ratio preserved (3:2), not distorted.
            self.assertAlmostEqual(out.width / out.height, 3000 / 2000, places=2)
        finally:
            os.unlink(path)

    def test_small_image_not_upscaled(self):
        fd, path = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        try:
            _write_jpeg(path, (800, 600))
            data, _ = consumer.make_proof_derivative(path)
            out = Image.open(io.BytesIO(data))
            self.assertEqual(out.size, (800, 600))  # thumbnail never upsizes
        finally:
            os.unlink(path)

    def test_portrait_orientation_capped_on_shorter_axis(self):
        # Portrait 2000x3000 → longest side (height) capped at PROOF_MAX_DIM.
        fd, path = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        try:
            _write_jpeg(path, (2000, 3000))
            data, _ = consumer.make_proof_derivative(path)
            out = Image.open(io.BytesIO(data))
            self.assertLessEqual(max(out.size), consumer.PROOF_MAX_DIM)
            self.assertAlmostEqual(out.width / out.height, 2000 / 3000, places=2)
        finally:
            os.unlink(path)

    def test_exif_metadata_stripped(self):
        fd, path = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        try:
            exif = Image.Exif()
            exif[0x010F] = "TestMake"  # Make tag — must not survive
            _write_jpeg(path, (2000, 1500), exif=exif)
            # The derivative is saved without an exif= arg → no APP1 segment.
            data, _ = consumer.make_proof_derivative(path)
            out = Image.open(io.BytesIO(data))
            self.assertFalse(dict(out.getexif()), "derivative must strip EXIF")
        finally:
            os.unlink(path)

    def test_pdf_passthrough_byte_identical(self):
        fd, path = tempfile.mkstemp(suffix=".pdf")
        payload = b"%PDF-1.4\n1 0 obj<<>>endobj\n%%EOF\n"
        os.write(fd, payload)
        os.close(fd)
        try:
            data, ct = consumer.make_proof_derivative(path)
            self.assertEqual(ct, "application/pdf")
            self.assertEqual(data, payload)  # unchanged, no re-encode
        finally:
            os.unlink(path)

    def test_unopenable_image_returns_none(self):
        fd, path = tempfile.mkstemp(suffix=".jpg")
        os.write(fd, b"this is not actually a JPEG")
        os.close(fd)
        try:
            # None = skip the proof for this receipt, not a failure.
            self.assertIsNone(consumer.make_proof_derivative(path))
        finally:
            os.unlink(path)

    def test_derivative_is_smaller_than_a_high_quality_save(self):
        # Recompression at PROOF_JPEG_QUALITY of a noisy image must beat q95 —
        # sanity check that the quality knob is actually applied (small bundle).
        fd, path = tempfile.mkstemp(suffix=".jpg")
        os.close(fd)
        try:
            img = Image.new("RGB", (2000, 2000))
            # px = (x*7 % 256, y*13 % 256, (x+y) % 256) — high-frequency noise.
            img.putdata(
                [
                    ((x * 7) % 256, (y * 13) % 256, (x + y) % 256)
                    for y in range(2000)
                    for x in range(2000)
                ]
            )
            img.save(path, format="JPEG", quality=95)
            hi = os.path.getsize(path)
            data, _ = consumer.make_proof_derivative(path)
            self.assertLess(len(data), hi)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
