"""Uninstall must never reach the shared library cache, and must not be anonymous.

Both properties were broken on 2026-09-01 by a change meant to make uninstall
and list agree about which sketchbook they see. On velxio.dev that sketchbook's
libraries/ is a symlink to the content-addressed cache shared by every user,
and DELETE /api/libraries/uninstall took no identity and was reachable
unauthenticated from the public internet. Caught in review before use.
"""
from __future__ import annotations

import os
import subprocess
from unittest.mock import patch

import pytest

from app.api.routes.libraries import _uninstall_allowed
from app.services.arduino_cli import ArduinoCLIService


class _Result:
    def __init__(self, code: int = 0, stdout: str = "", stderr: str = "") -> None:
        self.returncode = code
        self.stdout = stdout
        self.stderr = stderr


@pytest.mark.asyncio
async def test_uninstall_never_points_at_the_shared_cache_sketchbook() -> None:
    """The load-bearing one: no ARDUINO_DIRECTORIES_USER override, ever."""
    seen: dict = {}

    def fake_run(cmd, **kwargs):
        seen["cmd"] = cmd
        seen["env"] = kwargs.get("env")
        return _Result(0, "Uninstalling MyLib\n")

    with patch.dict(os.environ, {"VELXIO_FALLBACK_SKETCHBOOK": "/var/velxio/cache-sketchbook"}):
        with patch.object(subprocess, "run", side_effect=fake_run):
            out = await ArduinoCLIService().uninstall_library("MyLib")

    assert out["success"] is True
    # env=None means "inherit"; what must never happen is the override being
    # set to the fallback sketchbook, whose libraries/ IS the shared cache.
    env = seen["env"]
    assert env is None or env.get("ARDUINO_DIRECTORIES_USER") != "/var/velxio/cache-sketchbook"


@pytest.mark.asyncio
async def test_a_no_op_uninstall_is_reported_as_failure() -> None:
    """arduino-cli exits 0 for a library that is not installed."""
    with patch.object(
        subprocess, "run",
        return_value=_Result(0, "Library Ghost is not installed\n"),
    ):
        out = await ArduinoCLIService().uninstall_library("Ghost")

    assert out["success"] is False
    assert "not installed" in out["error"]
    assert "manifest" in out["error"]


@pytest.mark.asyncio
async def test_a_real_uninstall_still_succeeds() -> None:
    with patch.object(subprocess, "run", return_value=_Result(0, "Uninstalling Real\n")):
        out = await ArduinoCLIService().uninstall_library("Real")
    assert out["success"] is True


@pytest.mark.asyncio
async def test_an_unrelated_not_found_in_output_does_not_fake_a_no_op() -> None:
    """'not found' alone is too broad to mean 'nothing was removed'."""
    with patch.object(
        subprocess, "run",
        return_value=_Result(0, "Uninstalling Real\nwarning: changelog not found\n"),
    ):
        out = await ArduinoCLIService().uninstall_library("Real")
    assert out["success"] is True


def test_anonymous_uninstall_is_refused_where_accounts_exist() -> None:
    from app.core import hooks

    with patch.object(hooks, "_get_current_user_id_hook", lambda r: None):
        assert _uninstall_allowed(None) is False
        assert _uninstall_allowed("user-123") is True


def test_oss_self_host_keeps_working_without_accounts() -> None:
    from app.core import hooks

    with patch.object(hooks, "_get_current_user_id_hook", None):
        assert _uninstall_allowed(None) is True
