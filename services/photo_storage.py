"""Mirror consented training photos in SQLite while retaining worker file formats."""
from pathlib import Path


class AccountPhotoStore:
    def __init__(self, database, user_id, purpose):
        self.database, self.user_id, self.purpose = database, user_id, purpose

    def sync(self, rows, manifest, photo_path, commit=lambda: None):
        manifest = Path(manifest)
        previous = manifest.read_bytes() if manifest.is_file() else None
        def read_photo(row):
            path = Path(photo_path(row))
            if path.stat().st_size > 12 * 1024 * 1024:
                raise ValueError("Training photo too large")
            return path.read_bytes()
        try:
            with self.database.sync_training_photos(self.user_id, self.purpose, rows, read_photo):
                commit()
        except Exception:
            # A failed SQL commit must not leave a new worker manifest behind.
            if previous is None:
                manifest.unlink(missing_ok=True)
            elif not manifest.is_file() or manifest.read_bytes() != previous:
                staged = manifest.with_suffix(".rollback.tmp")
                staged.write_bytes(previous)
                staged.replace(manifest)
            raise
