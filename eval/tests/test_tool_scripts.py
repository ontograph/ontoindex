import pytest

OntoIndexDockerEnvironment = pytest.importorskip(
    "environments.ontoindex_docker"
).OntoIndexDockerEnvironment
tool_registry = pytest.importorskip("tool_registry")
TOOL_SPECS = tool_registry.TOOL_SPECS


def test_render_query_script_uses_endpoint_and_fallback():
    script = OntoIndexDockerEnvironment._render_tool_script(TOOL_SPECS["query"], "4848")
    assert "/tool/query" in script
    assert "ontoindex query" in script
    assert "ONTOINDEX_EVAL_PORT" in script


def test_render_augment_script_skips_curl():
    script = OntoIndexDockerEnvironment._render_tool_script(TOOL_SPECS["augment"], "4848")
    assert "/tool/" not in script
    assert "curl" not in script
    assert "ontoindex augment" in script
