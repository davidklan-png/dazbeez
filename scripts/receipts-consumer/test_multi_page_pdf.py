"""Regression tests for complete multi-page PDF extraction.

Run:
  cd scripts/receipts-consumer && \
  CF_ACCOUNT_ID=d CF_QUEUE_ID=d CF_API_TOKEN=d \
  RECEIPTS_EXTRACT_URL=http://d RECEIPTS_PROCESSOR_KEY=d MLX_MODEL=d \
  .venv/bin/python3 -m unittest test_multi_page_pdf -v
"""
from __future__ import annotations

import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("CF_ACCOUNT_ID", "d")
os.environ.setdefault("CF_QUEUE_ID", "d")
os.environ.setdefault("CF_API_TOKEN", "d")
os.environ.setdefault("RECEIPTS_EXTRACT_URL", "http://d")
os.environ.setdefault("RECEIPTS_PROCESSOR_KEY", "d")
os.environ.setdefault("MLX_MODEL", "d")

import consumer  # type: ignore  # noqa: E402
import fitz  # noqa: E402
from PIL import Image  # noqa: E402


def _write_colored_pdf(path: str, colors: list[tuple[float, float, float]]) -> None:
    doc = fitz.open()
    try:
        for index, color in enumerate(colors):
            page = doc.new_page(width=144, height=72)
            page.draw_rect(page.rect, color=color, fill=color)
            page.insert_text((12, 36), f"PAGE {index + 1}", color=(0, 0, 0))
        doc.save(path)
    finally:
        doc.close()


class TestMultiPagePdf(unittest.TestCase):
    def test_single_page_pdf_renders_one_png_and_removes_pdf(self):
        fd, pdf_path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        _write_colored_pdf(pdf_path, [(1, 0, 0)])

        png_paths = consumer._rasterize_pdf_pages("receipt-1", pdf_path)
        try:
            self.assertEqual(len(png_paths), 1)
            self.assertFalse(os.path.exists(pdf_path))
            with Image.open(png_paths[0]) as image:
                self.assertEqual(image.format, "PNG")
                self.assertGreater(image.width, image.height)
        finally:
            consumer._unlink_paths(png_paths)

    def test_multi_page_pdf_renders_every_page_in_order(self):
        fd, pdf_path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        _write_colored_pdf(pdf_path, [(1, 0, 0), (0, 1, 0)])

        png_paths = consumer._rasterize_pdf_pages("receipt-2", pdf_path)
        try:
            self.assertEqual(len(png_paths), 2)
            self.assertFalse(os.path.exists(pdf_path))
            with Image.open(png_paths[0]) as first, Image.open(png_paths[1]) as second:
                first_pixel = first.convert("RGB").getpixel((5, 5))
                second_pixel = second.convert("RGB").getpixel((5, 5))
                self.assertGreater(first_pixel[0], first_pixel[1])
                self.assertGreater(second_pixel[1], second_pixel[0])
        finally:
            consumer._unlink_paths(png_paths)

    def test_partial_render_failure_removes_pdf_and_completed_pngs(self):
        fd, pdf_path = tempfile.mkstemp(suffix=".pdf")
        os.close(fd)
        _write_colored_pdf(pdf_path, [(1, 0, 0), (0, 1, 0)])

        original_get_pixmap = fitz.Page.get_pixmap
        original_mkstemp = tempfile.mkstemp
        created_pngs: list[str] = []

        def fail_second_page(page, *args, **kwargs):
            if page.number == 1:
                raise RuntimeError("synthetic second-page failure")
            return original_get_pixmap(page, *args, **kwargs)

        def track_tempfile(*args, **kwargs):
            descriptor, path = original_mkstemp(*args, **kwargs)
            if kwargs.get("suffix") == ".png":
                created_pngs.append(path)
            return descriptor, path

        with (
            patch.object(fitz.Page, "get_pixmap", new=fail_second_page),
            patch.object(consumer.tempfile, "mkstemp", side_effect=track_tempfile),
        ):
            with self.assertRaisesRegex(RuntimeError, "second-page failure"):
                consumer._rasterize_pdf_pages("receipt-3", pdf_path)

        self.assertFalse(os.path.exists(pdf_path))
        self.assertGreaterEqual(len(created_pngs), 1)
        self.assertTrue(all(not os.path.exists(path) for path in created_pngs))

    def test_run_mlx_sends_all_pages_and_records_page_count(self):
        output = SimpleNamespace(
            text='{"rawText":"PAGE 1\\nPAGE 2","merchant":null}'
        )
        with (
            patch.object(consumer, "_load_model", return_value=("model", "processor")),
            patch("mlx_vlm.utils.load_config", return_value={"model_type": "test"}),
            patch(
                "mlx_vlm.prompt_utils.apply_chat_template",
                return_value="formatted prompt",
            ) as apply_template,
            patch("mlx_vlm.generate", return_value=output) as generate,
        ):
            result = consumer.run_mlx(["page-1.png", "page-2.png"])

        apply_template.assert_called_once_with(
            "processor",
            {"model_type": "test"},
            consumer.PROMPT,
            num_images=2,
        )
        self.assertEqual(generate.call_args.args[3], ["page-1.png", "page-2.png"])
        self.assertEqual(generate.call_args.kwargs["max_tokens"], 3000)
        self.assertEqual(result["sourcePageCount"], 2)
        self.assertEqual(result["rawText"], "PAGE 1\nPAGE 2")

    def test_run_mlx_rejects_empty_image_list(self):
        with self.assertRaisesRegex(
            consumer.PermanentExtractionFailure,
            "no images available",
        ):
            consumer.run_mlx([])


if __name__ == "__main__":
    unittest.main()
