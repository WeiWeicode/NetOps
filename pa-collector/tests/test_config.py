"""設定:缺少必要設定時啟動失敗;正式區只接受 _FILE;兩個開關預設關閉。"""

from __future__ import annotations

import pytest

from netops_pa.config import ConfigError, load_config

BASE = {"GW_ENV": "test", "REDIS_URL": "redis://netops-redis:6379/0"}


def test_defaults_disable_poll_and_receive():
    cfg = load_config(BASE)
    assert cfg.poll is None and cfg.receive is None and cfg.top_n == 200


@pytest.mark.parametrize(
    "env, msg",
    [
        ({"GW_ENV": "qa", "REDIS_URL": "redis://x"}, "GW_ENV"),
        ({"GW_ENV": "test"}, "REDIS_URL"),
        ({**BASE, "REDIS_URL": "http://x"}, "REDIS_URL"),
        ({**BASE, "PA_POLL_ENABLED": "yes"}, "PA_POLL_ENABLED"),
        ({**BASE, "PA_POLL_ENABLED": "1"}, "PA_HOST"),
        ({**BASE, "PA_POLL_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY": "k", "PA_POLL_SECONDS": "5"}, "PA_POLL_SECONDS"),
        ({**BASE, "PA_RECEIVE_ENABLED": "1", "PA_HTTP_TOKEN": "x" * 40}, "PA_ALLOWED_SOURCES"),
        ({**BASE, "PA_RECEIVE_ENABLED": "1", "PA_HTTP_TOKEN": "short", "PA_ALLOWED_SOURCES": "10.0.0.1"}, "太短"),
        ({**BASE, "PA_RECEIVE_ENABLED": "1", "PA_HTTP_TOKEN": "x" * 40, "PA_ALLOWED_SOURCES": "0.0.0.0/0"}, "0.0.0.0/0"),
        ({**BASE, "PA_RECEIVE_ENABLED": "1", "PA_HTTP_TOKEN": "x" * 40, "PA_ALLOWED_SOURCES": "bad"}, "格式錯誤"),
    ],
)
def test_invalid(env, msg):
    with pytest.raises(ConfigError, match=msg):
        load_config(env)


def test_prod_rejects_plaintext_and_insecure(tmp_path):
    prod = {"GW_ENV": "prod", "REDIS_URL": "redis://x", "PA_POLL_ENABLED": "1", "PA_HOST": "pa"}
    with pytest.raises(ConfigError, match="PA_API_KEY_FILE"):
        load_config({**prod, "PA_API_KEY": "k"})
    key = tmp_path / "k"
    key.write_text("secret-api-key\n")
    with pytest.raises(ConfigError, match="PA_TLS_INSECURE"):
        load_config({**prod, "PA_API_KEY_FILE": str(key), "PA_TLS_INSECURE": "1"})
    cfg = load_config({**prod, "PA_API_KEY_FILE": str(key)})
    assert cfg.poll.api_key == "secret-api-key" and cfg.poll.port == 443 and cfg.poll.interval == 15


def test_missing_secret_file_message_has_no_content():
    with pytest.raises(ConfigError, match="無法讀取 PA_API_KEY_FILE") as e:
        load_config({**BASE, "PA_POLL_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": "/nonexistent/key"})
    assert "/nonexistent" not in str(e.value)


def test_receive_config(tmp_path):
    tok = tmp_path / "t"
    tok.write_text("y" * 48)
    cfg = load_config({**BASE, "PA_RECEIVE_ENABLED": "true", "PA_HTTP_TOKEN_FILE": str(tok), "PA_ALLOWED_SOURCES": "10.10.1.1, 172.17.0.0/16"})
    assert cfg.receive.http_port == 51293 and cfg.receive.syslog_port == 51294
    assert [str(n) for n in cfg.receive.allowed] == ["10.10.1.1/32", "172.17.0.0/16"]
    with pytest.raises(ConfigError, match="一起設定"):
        load_config({**BASE, "PA_RECEIVE_ENABLED": "1", "PA_HTTP_TOKEN_FILE": str(tok), "PA_ALLOWED_SOURCES": "10.0.0.1",
                     "PA_TLS_CERT_FILE": str(tok)})


def test_prod_receive_requires_tls_unless_plaintext_set(tmp_path):
    tok = tmp_path / "t"
    tok.write_text("y" * 48)
    env = {"GW_ENV": "prod", "REDIS_URL": "redis://x", "PA_RECEIVE_ENABLED": "1", "PA_HTTP_TOKEN_FILE": str(tok),
           "PA_ALLOWED_SOURCES": "10.0.0.1"}
    with pytest.raises(ConfigError, match="TLS"):
        load_config(env)
    assert load_config({**env, "PA_RECEIVE_PLAINTEXT": "1"}).receive.tls_cert == ""


def test_query_config(tmp_path):
    key = tmp_path / "key"
    key.write_text("k" * 20)
    assert load_config(BASE).query is None
    cfg = load_config({**BASE, "PA_QUERY_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": str(key)})
    assert cfg.query is not None and cfg.query.max_mgmt_cpu == 50 and cfg.poll is None
    with pytest.raises(ConfigError, match="PA_HOST"):
        load_config({**BASE, "PA_QUERY_ENABLED": "1", "PA_API_KEY_FILE": str(key)})
    # E4:門檻實測前不放寬(上限 50)
    with pytest.raises(ConfigError):
        load_config({**BASE, "PA_QUERY_ENABLED": "1", "PA_HOST": "pa", "PA_API_KEY_FILE": str(key), "PA_QUERY_MAX_MGMT_CPU": "80"})
