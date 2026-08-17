import os
import unittest


class CorsOriginsTests(unittest.TestCase):
    def test_local_defaults_are_retained_with_configured_origin(self) -> None:
        old = os.environ.get("DATACASTER_ALLOWED_ORIGINS")
        os.environ["DATACASTER_ALLOWED_ORIGINS"] = "https://datacaster.vercel.app/, https://preview.example"
        try:
            from backend.config import cors_origins

            self.assertEqual(
                cors_origins(),
                [
                    "http://localhost:3000",
                    "http://127.0.0.1:3000",
                    "https://datacaster.vercel.app",
                    "https://preview.example",
                ],
            )
        finally:
            if old is None:
                os.environ.pop("DATACASTER_ALLOWED_ORIGINS", None)
            else:
                os.environ["DATACASTER_ALLOWED_ORIGINS"] = old
