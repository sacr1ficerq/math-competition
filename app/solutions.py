"""Shared validation for typed solutions and screenshot attachments."""

import base64
from io import BytesIO
from typing import Annotated

from PIL import Image
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator, model_validator


MAX_IMAGE_BYTES = 3 * 1024 * 1024
MAX_IMAGE_PIXELS = 20_000_000
IMAGE_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


class SolutionImage(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)] = "Screenshot"
    data_url: str = Field(max_length=4 * MAX_IMAGE_BYTES // 3 + 64)

    @field_validator("data_url")
    @classmethod
    def validate_image(cls, value: str) -> str:
        prefix, separator, encoded = value.partition(",")
        mime = prefix.removeprefix("data:").removesuffix(";base64")
        if not separator or mime not in IMAGE_FORMATS or prefix != f"data:{mime};base64":
            raise ValueError("Upload a PNG, JPEG, or WebP screenshot.")
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError:
            raise ValueError("Invalid screenshot encoding.") from None
        if not data or len(data) > MAX_IMAGE_BYTES:
            raise ValueError("Each screenshot must be at most 3 MiB.")
        try:
            with Image.open(BytesIO(data)) as image:
                if image.format != IMAGE_FORMATS[mime]:
                    raise ValueError("Screenshot content does not match its image type.")
                if image.width * image.height > MAX_IMAGE_PIXELS:
                    raise ValueError("Each screenshot must be at most 20 megapixels.")
                if getattr(image, "is_animated", False):
                    raise ValueError("Upload a still screenshot, not an animated image.")
                image.load()
        except (OSError, Image.DecompressionBombError):
            raise ValueError("The screenshot is not a valid readable image.") from None
        return value


class SolutionContent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    solution: Annotated[str, StringConstraints(strip_whitespace=True, max_length=50_000)] = ""
    images: list[SolutionImage] = Field(default_factory=list, max_length=4)

    @model_validator(mode="after")
    def require_solution(self):
        if not self.solution and not self.images:
            raise ValueError("Write a solution or attach at least one screenshot.")
        return self
