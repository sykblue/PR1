import base64
import io
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from .errors import ServiceError

Image.MAX_IMAGE_PIXELS = 20_000_000
MAX_FILE_BYTES = 10 * 1024 * 1024


def read_photo(upload, max_side=1280):
    if upload is None or not upload.filename:
        raise ServiceError("먼저 사진을 선택해 주세요.")
    data = upload.read(MAX_FILE_BYTES + 1)
    if len(data) > MAX_FILE_BYTES:
        raise ServiceError("사진은 10MB 이하로 올려 주세요.", 413, "file_too_large")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as source:
                if source.format not in {"JPEG", "PNG", "WEBP"}:
                    raise ServiceError("JPG, PNG, WEBP 사진만 사용할 수 있어요.")
                if getattr(source, "is_animated", False):
                    raise ServiceError("움직이는 이미지 대신 한 장의 사진을 올려 주세요.")
                if min(source.size) < 160:
                    raise ServiceError("가로와 세로가 각각 160px 이상인 사진을 올려 주세요.")
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((max_side, max_side), Image.Resampling.LANCZOS)
                # New image deliberately drops EXIF, GPS and other source metadata.
                return Image.frombytes("RGB", image.size, image.tobytes())
    except ServiceError:
        raise
    except (UnidentifiedImageError, OSError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning):
        raise ServiceError("사진을 읽을 수 없어요. 손상되지 않은 20MP 이하 사진을 올려 주세요.") from None


def image_bytes(image, fmt="PNG"):
    output = io.BytesIO()
    image.save(output, format=fmt)
    return output.getvalue()


def data_url(image):
    return "data:image/png;base64," + base64.b64encode(image_bytes(image)).decode("ascii")


def inline_image(image):
    return {"inlineData": {"mimeType": "image/jpeg", "data":
            base64.b64encode(image_bytes(image, "JPEG")).decode("ascii")}}
