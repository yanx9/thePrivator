import json
import os
from pathlib import Path
import pytest
from theprivator_sidecar.desktop_data import command, settings, disk_usage
from theprivator_sidecar.profiles import ProfileStore
from theprivator_sidecar.protocol import SidecarError
from theprivator_sidecar import vault


def seed(root):
    store = ProfileStore(root)
    profile = store.create('Vault test')['profile']
    path = root / profile['storage']['userDataDir'] / 'Cookies'
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'private cookie session')
    (root / 'sync-state.json').write_text('{"private":"sync config"}')
    return store, profile, path


def test_settings_persist_and_invalid_input_keeps_previous(tmp_path):
    assert settings(tmp_path)['theme'] == 'system'
    command(tmp_path, 'settings.save', {'theme': 'dark'})
    assert settings(tmp_path)['theme'] == 'dark'
    with pytest.raises(SidecarError):
        command(tmp_path, 'settings.save', {'theme': 'unexpected'})
    assert json.loads((tmp_path / 'settings.json').read_text())['theme'] == 'dark'


def test_disk_usage_excludes_external_symlinks(tmp_path):
    (tmp_path / 'one').write_bytes(b'hello')
    (tmp_path / 'link').symlink_to('/tmp', target_is_directory=True)
    result = disk_usage(tmp_path)
    assert result['bytes'] == (tmp_path / 'one').stat().st_blocks * 512


def test_vault_roundtrip_wrong_password_and_latest_session(tmp_path):
    store, profile, path = seed(tmp_path)
    command(tmp_path, 'settings.save', {'theme': 'dark'})
    assert vault.command(tmp_path, 'enable', {'password': '123456'})['locked']
    assert not path.exists()
    assert not (tmp_path / 'sync-state.json').exists()
    assert b'private cookie' not in (tmp_path / 'vault.bin').read_bytes()
    with pytest.raises(SidecarError, match='Incorrect'):
        vault.command(tmp_path, 'unlock', {'password': 'badbad'})
    assert not path.exists()
    unlocked = vault.command(tmp_path, 'unlock', {'password': '123456'})
    assert path.read_bytes() == b'private cookie session'
    path.write_bytes(b'new session')
    # A crash while unlocked must preserve the latest data, not restore old snapshot.
    assert vault.status(tmp_path)['recoveryRequired']
    recovered = vault.command(tmp_path, 'unlock', {'password': '123456'})
    assert path.read_bytes() == b'new session'
    vault.command(tmp_path, 'lock', {'sessionKey': recovered['sessionKey']})
    vault.command(tmp_path, 'disable', {'password': '123456'})
    assert path.read_bytes() == b'new session'
    assert not (tmp_path / 'vault.json').exists()
    assert settings(tmp_path)['theme'] == 'dark'


def test_tampered_vault_never_extracts(tmp_path):
    _, _, path = seed(tmp_path)
    vault.command(tmp_path, 'enable', {'password': 'secret123'})
    encrypted = tmp_path / 'vault.bin'
    payload = bytearray(encrypted.read_bytes()); payload[50] ^= 1; encrypted.write_bytes(payload)
    with pytest.raises(SidecarError, match='integrity'):
        vault.command(tmp_path, 'unlock', {'password': 'secret123'})
    assert not path.exists()
    assert not (tmp_path / '.vault-restore').exists()


def test_partial_cleanup_retry_cannot_overwrite_complete_snapshot(tmp_path, monkeypatch):
    _, _, path = seed(tmp_path)
    vault.command(tmp_path, 'enable', {'password': 'secret123'})
    result = vault.command(tmp_path, 'unlock', {'password': 'secret123'})
    path.write_bytes(b'latest session')
    original = vault.remove_plaintext
    def interrupted(root):
        path.unlink()
        raise OSError('simulated cleanup interruption')
    monkeypatch.setattr(vault, 'remove_plaintext', interrupted)
    with pytest.raises(SidecarError):
        vault.command(tmp_path, 'lock', {'sessionKey': result['sessionKey']})
    assert vault.read_config(tmp_path)['phase'] == 'sealing'
    assert vault.status(tmp_path)['recoveryRequired']
    snapshot = (tmp_path / 'vault.bin').read_bytes()
    monkeypatch.setattr(vault, 'remove_plaintext', original)
    vault.command(tmp_path, 'lock', {'sessionKey': result['sessionKey']})
    assert (tmp_path / 'vault.bin').read_bytes() == snapshot
    vault.command(tmp_path, 'unlock', {'password': 'secret123'})
    assert path.read_bytes() == b'latest session'


def test_failed_archive_preserves_plaintext_and_allows_recovery(tmp_path, monkeypatch):
    _, _, path = seed(tmp_path)
    def disk_full(*args, **kwargs):
        raise OSError('disk full')
    monkeypatch.setattr(vault.tarfile, 'open', disk_full)
    with pytest.raises(SidecarError):
        vault.command(tmp_path, 'enable', {'password': 'secret123'})
    assert path.read_bytes() == b'private cookie session'
    assert vault.status(tmp_path)['recoveryRequired']
    assert not vault.command(tmp_path, 'unlock', {'password': 'secret123'})['locked']


def test_proxy_revision_survives_tag_edits_and_tracks_password_changes(tmp_path):
    store, profile, _ = seed(tmp_path)
    proxy = {'proxyVersion': 1, 'mode': 'fixedServer', 'protocol': 'http', 'host': 'proxy.example', 'port': 8080,
             'credentials': {'username': 'user', 'password': 'pass'}}
    changed = store.update_proxy(profile['id'], proxy)['profile']
    revision = changed['proxyRevision']
    tagged = store.update_organization(profile['id'], {**changed['organization'], 'tags': ['work']})['profile']
    assert tagged['proxyRevision'] == revision
    assert ProfileStore(tmp_path).get(profile['id']).proxyRevision == revision
    proxy['credentials']['password'] = 'newpass'
    assert store.update_proxy(profile['id'], proxy)['profile']['proxyRevision'] != revision


def test_launch_history_persists_without_changing_proxy_revision(tmp_path):
    store, profile, _ = seed(tmp_path)
    store.record_launch(profile['id'], '2026-10-12T12:00:00Z')
    result = ProfileStore(tmp_path).get(profile['id'])
    assert result.lifecycle['lastLaunchedAt'] == '2026-10-12T12:00:00Z'
    assert result.lifecycle['launchCount'] == 1
    assert result.proxyRevision == profile['proxyRevision']


def test_independent_activity_prevents_sealing(tmp_path):
    from theprivator_sidecar.storage_access import activity_lock
    _, _, path = seed(tmp_path)
    with activity_lock(tmp_path):
        with pytest.raises(SidecarError, match='another process'):
            vault.command(tmp_path, 'enable', {'password': 'secret123'})
    assert path.exists()
    assert not (tmp_path / 'vault.json').exists()


def test_sealed_store_rejects_commands_without_recreating_profiles(tmp_path):
    from theprivator_sidecar.main import handle_request_line
    seed(tmp_path)
    vault.command(tmp_path, 'enable', {'password': 'secret123'})
    response, _ = handle_request_line(json.dumps({'id': 'locked-test', 'method': 'profiles.list', 'params': {'storeRoot': str(tmp_path)}}))
    assert response['error']['code'] == 'VAULT_LOCKED'
    assert response['id'] == 'locked-test'
    assert not (tmp_path / 'profile-store').exists()


def test_v4_migration_preserves_organization_lifecycle_and_proxy(tmp_path):
    store, profile, path = seed(tmp_path)
    store.update_organization(profile['id'], {**profile['organization'], 'notes': 'keep notes', 'tags': ['tag']})
    store.record_launch(profile['id'], '2026-10-12T12:00:00Z')
    file = tmp_path / 'profile-store' / 'profiles.json'
    payload = json.loads(file.read_text()); payload['storeVersion'] = 4
    for item in payload['profiles']:
        item.pop('proxyRevision', None)
    file.write_text(json.dumps(payload))
    result = ProfileStore(tmp_path).list()
    assert result['storeVersion'] == 5
    assert result['profiles'][0]['organization']['notes'] == 'keep notes'
    assert result['profiles'][0]['lifecycle']['launchCount'] == 1
    assert path.read_bytes() == b'private cookie session'


def test_desktop_operations_through_ndjson_dispatch(tmp_path):
    from theprivator_sidecar.main import handle_request_line
    for index, params in enumerate([{'action': 'settings.save', 'theme': 'dark'}, {'action': 'settings.get'}, {'action': 'vault.status'}, {'action': 'storage.usage'}]):
        response, _ = handle_request_line(json.dumps({'id': index, 'method': 'desktop.data', 'params': {**params, 'storeRoot': str(tmp_path)}}))
        assert response['ok'], response
        assert response['id'] == index
    assert settings(tmp_path)['theme'] == 'dark'
