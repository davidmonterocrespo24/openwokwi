"""Capacity limits for the QEMU-Linux guests.

Every guest is a real process holding 1-2 GB and its own vCPU threads, so
the machine is the ceiling, not the code. These check that the ceiling is
enforced BEFORE a process is spawned and that the refusal says what the
user should do next.
"""
import app.services.qemu_manager as qm


class _Mgr(qm.QemuManager):
    """Manager with a fake instance table (no processes involved)."""

    def add(self, client_id: str, owner: str | None) -> None:
        inst = qm.PiInstance(client_id, lambda *_a, **_k: None,
                             board_type='raspberry-pi-3')
        inst.owner = owner
        self._instances[client_id] = inst


def test_room_when_empty():
    assert _Mgr().capacity_error('u:alice') is None


def test_global_ceiling(monkeypatch):
    monkeypatch.setattr(qm, 'MAX_INSTANCES', 2)
    monkeypatch.setattr(qm, 'MAX_INSTANCES_PER_OWNER', 99)
    mgr = _Mgr()
    mgr.add('a', 'u:alice')
    mgr.add('b', 'u:bob')
    msg = mgr.capacity_error('u:carol')
    assert msg and 'busy' in msg.lower()


def test_per_owner_ceiling(monkeypatch):
    monkeypatch.setattr(qm, 'MAX_INSTANCES', 99)
    monkeypatch.setattr(qm, 'MAX_INSTANCES_PER_OWNER', 2)
    mgr = _Mgr()
    mgr.add('tab1', 'u:alice')
    mgr.add('tab2', 'u:alice')
    # Alice's third tab is refused...
    msg = mgr.capacity_error('u:alice')
    assert msg and 'already have' in msg.lower()
    # ...while somebody else still gets in.
    assert mgr.capacity_error('u:bob') is None


def test_anonymous_owner_is_not_pooled(monkeypatch):
    """No identity (desktop sidecar, tests) only hits the global ceiling."""
    monkeypatch.setattr(qm, 'MAX_INSTANCES', 99)
    monkeypatch.setattr(qm, 'MAX_INSTANCES_PER_OWNER', 1)
    mgr = _Mgr()
    mgr.add('a', None)
    mgr.add('b', None)
    assert mgr.capacity_error(None) is None
