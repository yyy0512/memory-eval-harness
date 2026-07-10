```python
"""
vitalops_orchestrator.vitalops.interfaces.api
================================================

FastAPI-driven REST interface for VitalOps Orchestrator.  This module
constitutes the “View” (UI) layer of the MVVM architecture and acts as
an adapter between external callers (SRE web consoles, DevOps CLI,
third-party observability tools) and the orchestration ViewModels that
implement business logic.

The API is intentionally slim: it focuses on request/response parsing,
authentication, serialization, and error handling while delegating all
domain concerns to the corresponding coordinator classes.

The file is entirely self-contained and runnable, falling back to local
stub implementations when the full project is not installed.  This
makes it suitable for unit-testing in isolation or running a demo
server via::

    $ uvicorn vitalops_orchestrator.vitalops.interfaces.api:app --reload
"""
from __future__ import annotations

import asyncio
import datetime as _dt
import logging
import os
import secrets
from typing import Any, Dict, List, Optional, Union

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    HTTPException,
    Request,
    status,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field, validator

# ---------------------------------------------------------------------------#
# Logging setup
# ---------------------------------------------------------------------------#
logger = logging.getLogger("vitalops.api")
_handler = logging.StreamHandler()
_handler.setFormatter(
    logging.Formatter(
        "[%(asctime)s] [%(levelname)s] [%(name)s] %(message)s", "%Y-%m-%d %H:%M:%S"
    )
)
logger.addHandler(_handler)
logger.setLevel(os.environ.get("VITALOPS_LOG_LEVEL", "INFO").upper())


# ---------------------------------------------------------------------------#
# Dependency-Injected Authentication
# ---------------------------------------------------------------------------#
class AuthContext(BaseModel):
    """Light-weight model for request authentication context."""

    user_id: str
    token_scopes: List[str] = Field(default_factory=list)

    def require(self, *scopes: str) -> None:
        """Raise HTTP 403 if any of the *scopes is missing."""
        missing = [s for s in scopes if s not in self.token_scopes]
        if missing:
            logger.warning(
                "Authorization failure: missing scopes=%s for user_id=%s",
                missing,
                self.user_id,
            )
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Missing authorization scope(s): {', '.join(missing)}",
            )


def _verify_token(auth_header: str | None) -> AuthContext:
    """
    Very small stand-in for real OAuth/JWT verification.

    In production this would call the hospital’s IAM/OIDC system.
    """
    if not auth_header or not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or missing Authorization header",
        )
    token = auth_header.split(" ", 1)[1]
    # Demo implementation: tokens starting with `clinician-` map to
    # read-only scopes, tokens starting with `sre-` are privileged.
    if token.startswith("sre-") and len(token) > 10:
        return AuthContext(
            user_id=token, token_scopes=["read:metrics", "write:ops", "admin"]
        )
    if token.startswith("clinician-") and len(token) > 14:
        return AuthContext(user_id=token, token_scopes=["read:metrics"])
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Bad token")


async def get_auth_ctx(request: Request) -> AuthContext:
    """FastAPI dependency that yields an AuthContext instance."""
    header = request.headers.get("Authorization")
    # Token verification can be IO-bound (calling IAM); run in thread executor.
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _verify_token, header)


# ---------------------------------------------------------------------------#
# Fallback stub implementations (removed when importing real project)
# ---------------------------------------------------------------------------#
# The try/except guards make the module runnable without the full code-base.
# They will automatically switch to “real” classes when available.
# ---------------------------------------------------------------------------#
try:
    from vitalops_orchestrator.vitalops.viewmodels.performance import (
        PerformanceCoordinator,
    )
    from vitalops_orchestrator.vitalops.viewmodels.recovery import RecoveryCoordinator
    from vitalops_orchestrator.vitalops.viewmodels.deployment import (
        DeploymentCoordinator,
    )
    from vitalops_orchestrator.vitalops.viewmodels.load_balancer import (
        LoadBalancerCoordinator,
    )

except ImportError:  # pragma: no cover

    class _BaseStub:
        """Common helper to log stub usage."""

        def __init__(self) -> None:
            cls = self.__class__.__name__
            logger.warning(
                "%s not installed; falling back to stub implementation", cls
            )

    class PerformanceCoordinator(_BaseStub):  # type: ignore
        async def get_live_metrics(
            self, service_id: Optional[str] = None
        ) -> Dict[str, Union[str, float]]:
            await asyncio.sleep(0.05)
            return {
                "timestamp": _dt.datetime.utcnow().isoformat(),
                "service_id": service_id or "all",
                "cpu_util": round(secrets.randbelow(4000) / 100.0, 2),
                "mem_mb": secrets.randbelow(4096),
            }

    class LoadBalancerCoordinator(_BaseStub):  # type: ignore
        async def rebalance(self) -> Dict[str, Any]:
            await asyncio.sleep(0.1)
            return {"status": "ok", "rebalanced_at": _dt.datetime.utcnow().isoformat()}

    class RecoveryCoordinator(_BaseStub):  # type: ignore
        async def initiate_backup(self, service_id: str) -> str:
            await asyncio.sleep(0.05)
            return f"backup-{service_id}-{secrets.token_hex(4)}"

    class DeploymentCoordinator(_BaseStub):  # type: ignore
        async def deploy(
            self, service_id: str, version: str, dry_run: bool = False
        ) -> Dict[str, Any]:
            await asyncio.sleep(0.05)
            return {
                "service_id": service_id,
                "version": version,
                "dry_run": dry_run,
                "deployment_id": secrets.token_hex(5),
                "submitted_at": _dt.datetime.utcnow().isoformat(),
            }


# ---------------------------------------------------------------------------#
# Pydantic request/response models
# ---------------------------------------------------------------------------#
class MetricsResponse(BaseModel):
    timestamp: _dt.datetime
    service_id: str
    cpu_util: float = Field(..., ge=0.0, le=100.0, description="CPU utilization %")
    mem_mb: int = Field(..., ge=0, description="Memory usage in MB")


class RebalanceResponse(BaseModel):
    status: str
    rebalanced_at: _dt.datetime


class BackupRequest(BaseModel):
    service_id: str = Field(..., min_length=1)

    @validator("service_id")
    def _validate_service_id(cls, v: str) -> str:  # noqa: D401
        if not v.isidentifier():
            raise ValueError("service_id must be a valid identifier")
        return v


class BackupResponse(BaseModel):
    backup_id: str
    service_id: str
    scheduled_at: _dt.datetime


class DeploymentRequest(BaseModel):
    service_id: str
    version: str = Field(..., regex=r"^[\w.\-]+$")
    dry_run: bool = False


class DeploymentResponse(BaseModel):
    deployment_id: str
    service_id: str
    version: str
    dry_run: bool
    submitted_at: _dt.datetime


# ---------------------------------------------------------------------------#
# Router definitions
# ---------------------------------------------------------------------------#
router = APIRouter(prefix="/api/v1", tags=["vitalops"])


@router.get(
    "/metrics",
    response_model=MetricsResponse,
    summary="Get live performance metrics",
)
async def get_metrics(
    service_id: Optional[str] = None,
    auth: AuthContext = Depends(get_auth_ctx),
    coordinator: PerformanceCoordinator = Depends(PerformanceCoordinator),
) -> MetricsResponse:
    """
    Return the latest live metrics for *service_id*.  If *service_id* is omitted,
    aggregate metrics are returned.
    """
    auth.require("read:metrics")

    raw = await coordinator.get_live_metrics(service_id=service_id)
    return MetricsResponse(**raw)


@router.post(
    "/rebalance",
    response_model=RebalanceResponse,
    summary="Trigger immediate rebalancing of workloads",
)
async def rebalance(
    background_tasks: BackgroundTasks,
    auth: AuthContext = Depends(get_auth_ctx),
    coordinator: LoadBalancerCoordinator = Depends(LoadBalancerCoordinator),
) -> RebalanceResponse:
    """
    Manually trigger the LoadBalancerCoordinator to redistribute container
    workloads.  The heavy lifting runs in a background task so the caller gets
    a fast acknowledgment.
    """

    auth.require("write:ops")

    async def _execute() -> Dict[str, Any]:
        try:
            return await coordinator.rebalance()
        except Exception as exc:  # noqa: BLE001
            logger.exception("Rebalance failed: %s", exc)
            raise

    # Schedule the task and immediately respond with 202 Accepted semantics.
    scheduled_at = _dt.datetime.utcnow()

    async def _bg_wrapper() -> None:
        await _execute()

    background_tasks.add_task(_bg_wrapper)
    return RebalanceResponse(status="scheduled", rebalanced_at=scheduled_at)


@router.post(
    "/backup",
    response_model=BackupResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Initiate service backup",
)
async def initiate_backup(
    req: BackupRequest,
    background_tasks: BackgroundTasks,
    auth: AuthContext = Depends(get_auth_ctx),
    coordinator: RecoveryCoordinator = Depends(RecoveryCoordinator),
) -> BackupResponse:
    """
    Initiate an out-of-band backup for a given micro-service.  The call is
    asynchronous and returns a *backup_id* that can be used to track progress.
    """
    auth.require("write:ops")

    async def _do_backup() -> str:
        return await coordinator.initiate_backup(req.service_id)

    backup_future: asyncio.Future[str] = asyncio.ensure_future(_do_backup())

    async def _bg_set_result() -> None:
        try:
            await backup_future
        except Exception:  # pragma: no cover
            # Already logged in the coordinator; nothing to do here
            pass

    background_tasks.add_task(_bg_set_result)

    backup_id: str = await backup_future
    return BackupResponse(
        backup_id=backup_id,
        service_id=req.service_id,
        scheduled_at=_dt.datetime.utcnow(),
    )


@router.post(
    "/deploy",
    response_model=DeploymentResponse,
    status_code=status.HTTP_202_ACCEPTED,
    summary="Deploy or rollout a new version",
)
async def deploy(
    req: DeploymentRequest,
    auth: AuthContext = Depends(get_auth_ctx),
    coordinator: DeploymentCoordinator = Depends(DeploymentCoordinator),
) -> DeploymentResponse:
    """
    Deploy a new container image version to the hospital’s on-prem cluster.
    """
    auth.require("write:ops")

    try:
        result = await coordinator.deploy(
            service_id=req.service_id, version=req.version, dry_run=req.dry_run
        )
    except ValueError as exc:
        logger.warning(
            "Deployment validation failed for service=%s version=%s: %s",
            req.service_id,
            req.version,
            exc,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)
        ) from exc
    except Exception as exc:  # pragma: no cover
        logger.exception("Deployment error: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Deployment internal error",
        ) from exc

    return DeploymentResponse(**result)


# ---------------------------------------------------------------------------#
# FastAPI application assembly
# ---------------------------------------------------------------------------#
app = FastAPI(
    title="VitalOps Orchestrator API",
    version="1.0.0",
    description=(
        "RESTful interface to the VitalOps Orchestrator automation platform. "
        "See https://example-hospital.org/docs for full documentation."
    ),
    default_response_class=JSONResponse,
    docs_url="/apidocs",
    redoc_url="/redoc",
)

# Security headers, CORS etc.
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.environ.get("VITALOPS_CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(router)


# ---------------------------------------------------------------------------#
# Health-check endpoint (excluded from router to avoid auth)
# ---------------------------------------------------------------------------#
@app.get("/healthz", summary="Liveness probe")
async def healthz() -> Dict[str, str]:
    """Simple liveness probe used by Kubernetes/Service Mesh."""
    return {"status": "ok", "ts": _dt.datetime.utcnow().isoformat()}


# ---------------------------------------------------------------------------#
# Run via `python -m vitalops_orchestrator.vitalops.interfaces.api`
# ---------------------------------------------------------------------------#
if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "vitalops_orchestrator.vitalops.interfaces.api:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", 8000)),
        reload=True,
    )
```