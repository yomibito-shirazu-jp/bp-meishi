import os
from google.cloud import storage

def download_from_gcs(gcs_uri: str, local_path: str) -> None:
    """gs://bucket/path/file.pdf → /tmp/source.pdf"""
    if not gcs_uri.startswith("gs://"):
        print(f"Skipping download_from_gcs for local uri: {gcs_uri}")
        return
    client = storage.Client()
    bucket_name, blob_path = gcs_uri[5:].split("/", 1)
    bucket = client.bucket(bucket_name)
    bucket.blob(blob_path).download_to_filename(local_path)

def upload_to_gcs(local_path: str, gcs_uri: str) -> None:
    """Uploads local file to gs://bucket/path/file.json"""
    if not gcs_uri.startswith("gs://"):
        print(f"Skipping upload_to_gcs for local uri: {gcs_uri}")
        return
    client = storage.Client()
    bucket_name, blob_path = gcs_uri[5:].split("/", 1)
    bucket = client.bucket(bucket_name)
    bucket.blob(blob_path).upload_from_filename(local_path)
