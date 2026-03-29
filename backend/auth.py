import base64
import hashlib
import hmac
import json
import os
import secrets
import time
from typing import Literal, Optional, TypedDict

from fastapi import HTTPException, Request, WebSocket, status

AuthRole = Literal["admin", "viewer"]


class AuthSession(TypedDict):
    role: AuthRole
    exp: int


AUTH_SECRET = os.getenv("VISTA_AUTH_SECRET") or secrets.token_urlsafe(32)
ADMIN_PASSWORD = os.getenv("VISTA_ADMIN_PASSWORD", "")
VIEWER_PASSWORD = os.getenv("VISTA_VIEWER_PASSWORD", "")
TOKEN_TTL_SECONDS = max(300, int(os.getenv("VISTA_TOKEN_TTL_SECONDS", "43200")))
PUBLIC_HTTP_PATHS = {"/auth/mode", "/auth/login", "/health"}
VIEWER_HTTP_GET_SUFFIXES = (
    "/meta",
    "/config",
    "/status",
    "/summary",
    "/analytics",
    "/recommendations",
    "/clock",
)
VIEWER_HTTP_POST_SUFFIXES = (
    "/config",
    "/preset/load",
)


def auth_enabled() -> bool:
    return bool(ADMIN_PASSWORD or VIEWER_PASSWORD)


def admin_enabled() -> bool:
    return bool(ADMIN_PASSWORD)


def viewer_enabled() -> bool:
    return bool(VIEWER_PASSWORD)


def role_allows(granted_role: AuthRole, required_role: AuthRole) -> bool:
    return granted_role == "admin" or granted_role == required_role


def _b64encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64decode(raw: str) -> bytes:
    padding = "=" * (-len(raw) % 4)
    return base64.urlsafe_b64decode(f"{raw}{padding}".encode("ascii"))


def _sign(payload_b64: str) -> str:
    digest = hmac.new(
        AUTH_SECRET.encode("utf-8"),
        payload_b64.encode("ascii"),
        hashlib.sha256,
    ).digest()
    return _b64encode(digest)


def create_access_token(role: AuthRole, expires_at: Optional[int] = None) -> str:
    expiry = expires_at or (int(time.time()) + TOKEN_TTL_SECONDS)
    payload = {"role": role, "exp": expiry}
    payload_b64 = _b64encode(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    return f"{payload_b64}.{_sign(payload_b64)}"


def decode_access_token(token: str) -> AuthSession:
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentication required",
        )

    try:
        payload_b64, signature = token.split(".", 1)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token format",
        ) from exc

    expected_signature = _sign(payload_b64)
    if not hmac.compare_digest(signature, expected_signature):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token signature",
        )

    try:
        payload = json.loads(_b64decode(payload_b64).decode("utf-8"))
    except (json.JSONDecodeError, UnicodeDecodeError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token payload",
        ) from exc

    role = payload.get("role")
    if role not in ("admin", "viewer"):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token role",
        )

    exp = int(payload.get("exp") or 0)
    if exp <= int(time.time()):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token expired",
        )

    return {"role": role, "exp": exp}


def authenticate_password(password: str) -> AuthRole:
    if not auth_enabled():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentication is disabled",
        )

    candidate = password or ""
    if admin_enabled() and hmac.compare_digest(candidate, ADMIN_PASSWORD):
        return "admin"
    if viewer_enabled() and hmac.compare_digest(candidate, VIEWER_PASSWORD):
        return "viewer"

    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid password",
    )


def get_required_role_for_http(method: str, path: str) -> Optional[AuthRole]:
    normalized_method = method.upper()
    if normalized_method == "OPTIONS" or path in PUBLIC_HTTP_PATHS:
        return None

    if path.startswith("/matches/") and normalized_method == "GET":
        if any(path.endswith(suffix) for suffix in VIEWER_HTTP_GET_SUFFIXES):
            return "viewer"
    if path.startswith("/matches/") and normalized_method == "POST":
        if any(path.endswith(suffix) for suffix in VIEWER_HTTP_POST_SUFFIXES):
            return "viewer"

    return "admin"


def _extract_bearer_token(authorization: Optional[str]) -> Optional[str]:
    if not authorization:
        return None
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        return None
    return token.strip()


def require_http_auth(request: Request, required_role: AuthRole) -> AuthSession:
    if not auth_enabled():
        return {"role": "admin", "exp": int(time.time()) + TOKEN_TTL_SECONDS}

    token = _extract_bearer_token(request.headers.get("Authorization"))
    session = decode_access_token(token or "")
    if not role_allows(session["role"], required_role):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Insufficient permissions",
        )
    return session


async def authorize_websocket(
    websocket: WebSocket, required_role: AuthRole = "viewer"
) -> Optional[AuthSession]:
    if not auth_enabled():
        return {"role": "admin", "exp": int(time.time()) + TOKEN_TTL_SECONDS}

    token = websocket.query_params.get("token") or _extract_bearer_token(
        websocket.headers.get("authorization")
    )
    if not token:
        await websocket.close(code=4401, reason="Authentication required")
        return None

    try:
        session = decode_access_token(token)
    except HTTPException:
        await websocket.close(code=4401, reason="Invalid token")
        return None

    if not role_allows(session["role"], required_role):
        await websocket.close(code=4403, reason="Insufficient permissions")
        return None

    return session
