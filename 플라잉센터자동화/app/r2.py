import httpx

from app.config import R2_ACCOUNT_ID, R2_API_TOKEN, R2_BUCKET_NAME

_BASE = "https://api.cloudflare.com/client/v4/accounts/{account}/r2/buckets/{bucket}/objects/{key}"


def _url(key: str) -> str:
    return _BASE.format(account=R2_ACCOUNT_ID, bucket=R2_BUCKET_NAME, key=key)


def r2_upload(path: str, data: bytes, content_type: str) -> None:
    headers = {"Authorization": f"Bearer {R2_API_TOKEN}", "Content-Type": content_type}
    resp = httpx.put(_url(path), headers=headers, content=data, timeout=30)
    resp.raise_for_status()


def r2_download(path: str) -> bytes:
    headers = {"Authorization": f"Bearer {R2_API_TOKEN}"}
    resp = httpx.get(_url(path), headers=headers, timeout=30)
    resp.raise_for_status()
    return resp.content


def r2_delete(paths: list[str]) -> None:
    headers = {"Authorization": f"Bearer {R2_API_TOKEN}"}
    for path in paths:
        if path:
            httpx.delete(_url(path), headers=headers, timeout=10)
